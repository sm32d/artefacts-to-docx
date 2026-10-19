// run_sql_report.js
// Executes a .sql patch file against a LIVE Postgres database, one statement
// at a time on a single persistent session, and captures each statement's
// real output (rows / row-count) as evidence in the generated .docx —
// instead of relying on manually pasted screenshots.
//
// Requires: npm install pg   (already installed in this project)
//
// DB credentials: standard libpq/psql environment variables — PGHOST, PGPORT,
// PGDATABASE, PGUSER, PGPASSWORD — or a single DATABASE_URL. Set them in your
// shell before running. Never hardcode credentials or commit them anywhere.
//
// Safety:
//   - Before touching anything, prints which host/database it's about to run
//     against and requires you to type "yes" to continue.
//   - If the script opens a transaction (BEGIN) and the .sql file never
//     actually runs a COMMIT/ROLLBACK (they're left commented out, e.g.
//     `-- COMMIT;` / `-- ROLLBACK;` — the common "decide here" convention),
//     execution pauses right before that point and asks you, in the
//     terminal, to type "commit" or "rollback" yourself. Nothing commits
//     without that explicit, typed confirmation.
//   - Any statement that errors triggers an automatic ROLLBACK, aborts the
//     run, and still writes a partial report showing what ran and the error
//     — never leaves a transaction hanging or half-applied.
//   - Every statement in the file becomes its own item in the report, in
//     the order it actually ran — a full, literal transcript of the session.
//
// Usage:
//   node run_sql_report.js patch.sql [report.docx] [--title "..."] [--ref "..."]
//        [--env "..."] [--author "..."] [--date "..."] [--label "Patch"]
//        [--max-rows 50] [--no-page-breaks]

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Client, types } = require("pg");
const { parseStatements, statementToItem, findCheckpointMarker } = require("./sql_parser");
const { buildDocx, MAX_TABLE_COLUMNS } = require("./generate_report");

// A wide (key-value-per-row) result costs far more vertical space per row
// than a normal table, so it gets a much smaller row cap by default.
const KV_MAX_ROWS = 10;

// pg parses date/timestamp columns into JS Date objects by default, which
// are timezone-less internally — rendering one (e.g. via toISOString()) always
// comes out in UTC, silently discarding whatever `SET TIME ZONE` the session
// used. Keep them as the raw text Postgres already formatted for the current
// session timezone instead — more faithful for an evidence report anyway,
// since it's exactly what running the statement in psql would show you.
types.setTypeParser(types.builtins.DATE, v => v);
types.setTypeParser(types.builtins.TIMESTAMP, v => v);
types.setTypeParser(types.builtins.TIMESTAMPTZ, v => v);

// ---------- CLI args ----------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { flags[a.slice(2)] = true; }
      else { flags[a.slice(2)] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

// One shared readline interface for the whole run, with our own line queue —
// readline's built-in .question() only catches a line if it arrives WHILE
// that question is pending; since real async work (DB queries) happens
// between our prompts, an answer that arrives early gets silently dropped
// otherwise. Queuing every 'line' event ourselves means nothing is lost
// regardless of timing.
let rl = null;
let lineQueue = [];
let lineWaiters = [];
function getRL() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line) => {
      if (lineWaiters.length) lineWaiters.shift()(line);
      else lineQueue.push(line);
    });
  }
  return rl;
}
function nextLine() {
  getRL();
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  return new Promise(resolve => lineWaiters.push(resolve));
}
async function promptLine(question) {
  getRL().output.write(question);
  const answer = await nextLine();
  return answer.trim();
}

async function promptDecision() {
  let answer;
  do {
    answer = (await promptLine('Review the results above. Type "commit" or "rollback": ')).toLowerCase();
  } while (answer !== "commit" && answer !== "rollback");
  return answer;
}

function describeTarget() {
  if (process.env.DATABASE_URL) {
    try {
      const u = new URL(process.env.DATABASE_URL);
      return `${u.hostname}:${u.port || 5432}${u.pathname} as ${u.username || "(default user)"}`;
    } catch {
      return "DATABASE_URL (unparseable — pg will report the connection error)";
    }
  }
  const host = process.env.PGHOST || "localhost";
  const port = process.env.PGPORT || "5432";
  const db = process.env.PGDATABASE || "(default)";
  const user = process.env.PGUSER || "(default)";
  return `${host}:${port}/${db} as ${user}`;
}

// ---------- RFC4180 CSV writer, for the full-results sidecar file on a truncated result ----------
function csvField(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeResultCsv(filePath, columns, rows) {
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) lines.push(columns.map(c => csvField(row[c])).join(","));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

// ---------- pg QueryResult -> docx-renderable result ----------
// maxRows caps how many rows get EMBEDDED in the doc — a wide (>MAX_TABLE_COLUMNS
// column) result uses a much smaller cap since it renders one stacked block per
// row. Either way, a truncated result's FULL row set is written to a CSV file
// next to the report so nothing is actually lost, just not embedded.
function toResult(pgResult, maxRows, csvPath) {
  if (pgResult.fields && pgResult.fields.length > 0) {
    const columns = pgResult.fields.map(f => f.name);
    const cap = columns.length > MAX_TABLE_COLUMNS ? Math.min(maxRows, KV_MAX_ROWS) : maxRows;
    const truncated = pgResult.rows.length > cap;
    if (truncated && csvPath) writeResultCsv(csvPath, columns, pgResult.rows);
    return {
      kind: "rows",
      columns,
      rows: truncated ? pgResult.rows.slice(0, cap) : pgResult.rows,
      rowCount: pgResult.rows.length,
      truncated,
      csvFile: truncated && csvPath ? path.basename(csvPath) : undefined,
    };
  }
  if (pgResult.rowCount !== null && pgResult.rowCount !== undefined) {
    return { kind: "count", command: pgResult.command, rowCount: pgResult.rowCount };
  }
  return { kind: "command", command: pgResult.command };
}

function isBegin(sql) { return /^\s*begin\b/i.test(sql); }
function isCommitOrRollback(sql) { return /^\s*(commit|rollback)\b/i.test(sql); }

// pg (unlike psql/libpq) does NOT auto-negotiate TLS for discrete PG* env
// vars — you have to opt in explicitly, or a server that requires encryption
// (common for managed/internal Postgres reached through a bastion or tunnel)
// rejects the connection with "no encryption" before pg_hba.conf even gets
// to the non-SSL rule. Honor PGSSLMODE the way libpq does when set; default
// to "encrypt, don't verify the cert" otherwise, since that's what most
// internal setups need and matches psql's own default ("prefer" = try TLS).
function resolveSSL() {
  const mode = (process.env.PGSSLMODE || "").toLowerCase();
  if (mode === "disable") return false;
  if (mode === "verify-ca" || mode === "verify-full") return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const sqlPath = positional[0];
  const outPath = positional[1] || "report.docx";
  if (!sqlPath) {
    console.error("Usage: node run_sql_report.js <patch.sql> [report.docx] [flags]");
    process.exit(1);
  }
  const maxRows = flags["max-rows"] ? parseInt(flags["max-rows"], 10) : 50;
  const pageBreaks = !flags["no-page-breaks"];

  const meta = {
    title: flags.title || "Verification Report",
    ref: flags.ref || "",
    env: flags.env || "Non-Production",
    author: flags.author || "",
    date: flags.date || new Date().toISOString().slice(0, 10),
    label: flags.label !== undefined ? flags.label : "Patch",
  };

  const text = fs.readFileSync(sqlPath, "utf8").replace(/\r\n/g, "\n");
  const statements = parseStatements(text);
  if (statements.length === 0) {
    console.error(`No SQL statements found in ${sqlPath}`);
    process.exit(1);
  }

  const markerOffset = findCheckpointMarker(text);

  const target = describeTarget();
  const ssl = resolveSSL();
  const sslNote = ssl === false ? "no TLS" : `TLS${ssl.rejectUnauthorized ? ", verified cert" : ", cert not verified"}`;
  const confirm = await promptLine(
    `About to run "${sqlPath}" (${statements.length} statements) against ${target} (${sslNote}).\n` +
    `Type "yes" to proceed: `
  );
  if (confirm.toLowerCase() !== "yes") {
    console.error("Aborted — nothing was run.");
    process.exit(1);
  }

  const client = new Client({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
    ssl,
  });
  try {
    await client.connect();
  } catch (err) {
    if (/password must be a string/i.test(err.message)) {
      console.error(
        "No database password was provided — PGPASSWORD (or a password in DATABASE_URL / ~/.pgpass) isn't set in this shell.\n" +
        "Set it in the same terminal you run this from, and make sure it's exported:\n" +
        "  read -s PGPASSWORD && export PGPASSWORD"
      );
      process.exit(1);
    }
    throw err;
  }
  console.log(`Connected to ${target}.`);

  const items = [];
  let inTxn = false;
  let aborted = false;

  async function runOne(st) {
    const sno = items.length + 1;
    const item = statementToItem(st, sno);
    try {
      const pgResult = await client.query(st.sql);
      const csvPath = path.join(path.dirname(outPath), path.basename(outPath, path.extname(outPath)) + `.item${sno}.csv`);
      item.result = toResult(pgResult, maxRows, csvPath);
      console.log(`  [${sno}] ${item.heading} — ${describeResultLine(item.result)}`);
      if (isBegin(st.sql)) inTxn = true;
    } catch (err) {
      item.result = { kind: "error", text: err.message };
      console.error(`  [${sno}] ${item.heading} — ERROR: ${err.message}`);
      items.push(item);
      throw err;
    }
    items.push(item);
    return item;
  }

  function describeResultLine(r) {
    if (r.kind === "rows") return `${r.rowCount} row(s)`;
    if (r.kind === "count") return `${r.command} ${r.rowCount}`;
    return r.kind === "command" ? r.command : r.kind;
  }

  // Always pause and ask before an open transaction actually gets closed —
  // whether that's because the .sql file has a real, uncommented COMMIT or
  // ROLLBACK statement (fileSaid tells you what it says, but your typed
  // answer is what actually runs, not the file's), or because it's the
  // commented-out `-- COMMIT;` placeholder convention with nothing to
  // intercept (fileSaid is null — falls back to the marker position, or
  // end of file if there's no marker either).
  async function doCheckpoint(fileSaid) {
    // A terminal summary line per statement isn't enough to actually review
    // by — especially for wide `SELECT *` results, which render as stacked
    // key-value blocks, not something you can eyeball as text. Write what's
    // run so far as a real .docx so it can be opened and reviewed properly.
    const reviewPath = path.join(path.dirname(outPath), path.basename(outPath, path.extname(outPath)) + ".review.docx");
    const reviewBuf = await buildDocx(items, { meta, templateMode: false, screenshotDir: "screenshots", pageBreaks });
    fs.writeFileSync(reviewPath, reviewBuf);
    console.log(`\nWrote ${reviewPath} — open it to review the actual results before deciding.`);
    if (fileSaid) console.log(`(The script itself has "${fileSaid};" here — that's not run automatically; type your own decision below.)`);
    console.log("");

    const decision = await promptDecision();
    const decisionSql = decision === "commit" ? "COMMIT" : "ROLLBACK";
    await client.query(decisionSql);
    items.push({
      sno: String(items.length + 1),
      heading: "Transaction decision",
      description: `${decisionSql};`,
      format: "code",
      result: { kind: "notice", text: `Transaction ${decision === "commit" ? "COMMITTED" : "ROLLED BACK"} (${new Date().toISOString()})` },
    });
    console.log(`Transaction ${decision === "commit" ? "COMMITTED" : "ROLLED BACK"}.`);
    inTxn = false;
  }

  try {
    console.log(`Running ${statements.length} statements...`);
    for (const st of statements) {
      if (inTxn && markerOffset !== -1 && st.start > markerOffset) {
        await doCheckpoint(null);
      }
      if (inTxn && isCommitOrRollback(st.sql)) {
        await doCheckpoint(/^\s*commit\b/i.test(st.sql) ? "COMMIT" : "ROLLBACK");
        continue; // the human's decision already ran; don't also run the file's own statement
      }
      await runOne(st);
    }

    if (inTxn) {
      await doCheckpoint(null); // transaction never closed anywhere in the file
    }
  } catch (err) {
    aborted = true;
    if (inTxn) {
      try {
        await client.query("ROLLBACK");
        console.error("Statement failed — transaction ROLLED BACK automatically.");
      } catch (rollbackErr) {
        console.error(`Statement failed, and ROLLBACK also failed: ${rollbackErr.message}`);
      }
    } else {
      console.error("Statement failed.");
    }
  } finally {
    await client.end();
    if (rl) rl.close();
  }

  const buf = await buildDocx(items, { meta, templateMode: false, screenshotDir: "screenshots", pageBreaks });
  fs.writeFileSync(outPath, buf);
  const reviewPath = path.join(path.dirname(outPath), path.basename(outPath, path.extname(outPath)) + ".review.docx");
  if (fs.existsSync(reviewPath)) fs.unlinkSync(reviewPath); // superseded by the final report
  console.log(`Wrote ${outPath} (${items.length} items)${aborted ? " — RUN ABORTED, partial report" : ""}`);

  if (aborted) process.exit(1);
}

module.exports = { toResult, isBegin, isCommitOrRollback, describeTarget, resolveSSL };

if (require.main === module) {
  main().catch(err => { console.error(err.message || err); process.exit(1); });
}
