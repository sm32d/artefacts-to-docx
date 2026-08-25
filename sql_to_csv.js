// sql_to_csv.js
// Turns a .sql file of patch/verification statements into the CSV format
// generate_report.js expects (SNo, Heading, Description, Screenshot, Format).
//
// Heading is picked up from a comment attached to the statement, in order
// of preference:
//   1. A `--` or /* */ comment block directly above the statement — its
//      first line becomes the Heading. Any further lines in that block are
//      kept as a comment preamble in the Description, nothing is dropped.
//   2. A trailing `--` or /* */ comment on the same line as the statement's
//      closing ';'.
//   3. No comment either side — falls back to the statement's own first
//      line, truncated to 60 characters.
//
// Comments and quoted strings are scanned properly, so a ';' inside a
// comment or a string literal will NOT be mistaken for the end of a
// statement.
//
// The Screenshot column is left blank — you still have to capture evidence
// and fill in the filenames yourself before running generate_report.js.
//
// Usage:
//   node sql_to_csv.js patch.sql [items.csv]

const fs = require("fs");

const [sqlPath, outCsvPath = "items.csv"] = process.argv.slice(2);
if (!sqlPath) {
  console.error("Usage: node sql_to_csv.js <patch.sql> [items.csv]");
  process.exit(1);
}

const text = fs.readFileSync(sqlPath, "utf8").replace(/\r\n/g, "\n");

// ---------- parse into statements, tracking leading/trailing comments ----------
function parseStatements(text) {
  const statements = [];
  const n = text.length;
  let i = 0;

  let sql = "";
  let leading = [];

  const blockCommentLines = (raw) =>
    raw.replace(/^\/\*/, "").replace(/\*\/$/, "")
      .split("\n").map(l => l.replace(/^\s*\*?\s?/, "").trim()).filter(Boolean);

  function finish(trailing) {
    const trimmed = sql.trim();
    if (trimmed) statements.push({ leading, trailing, sql: trimmed });
    sql = "";
    leading = [];
  }

  while (i < n) {
    const c = text[i], c2 = text[i + 1];

    if (c === "-" && c2 === "-") {
      let end = text.indexOf("\n", i);
      if (end === -1) end = n;
      if (sql.trim() === "") {
        leading.push(text.slice(i + 2, end).trim());
      } else {
        sql += text.slice(i, end);
      }
      i = end;
      continue;
    }

    if (c === "/" && c2 === "*") {
      let close = text.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      const raw = text.slice(i, end);
      if (sql.trim() === "") {
        leading.push(...blockCommentLines(raw));
      } else {
        sql += raw;
      }
      i = end;
      continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c) j++;
      sql += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }

    if (c === ";") {
      sql += c;
      i++;
      // look for a comment trailing right after this ';' on the same line
      let k = i;
      while (k < n && (text[k] === " " || text[k] === "\t")) k++;
      let trailing = "";
      if (text[k] === "-" && text[k + 1] === "-") {
        let end = text.indexOf("\n", k);
        if (end === -1) end = n;
        trailing = text.slice(k + 2, end).trim();
        i = end;
      } else if (text[k] === "/" && text[k + 1] === "*") {
        let close = text.indexOf("*/", k + 2);
        const end = close === -1 ? n : close + 2;
        trailing = text.slice(k + 2, Math.max(k + 2, end - 2)).trim();
        i = end;
      }
      finish(trailing);
      continue;
    }

    sql += c;
    i++;
  }
  finish("");
  return statements;
}

const statements = parseStatements(text);
if (statements.length === 0) {
  console.error(`No SQL statements found in ${sqlPath}`);
  process.exit(1);
}

// Decorative divider lines (====, ----, ****, ...) make lousy headings —
// skip them and use the first line that actually has content instead.
const DECORATIVE = /^[-=_*#~]{3,}$/;

function buildRow(st, sno) {
  const headingIdx = st.leading.findIndex(l => l.trim() && !DECORATIVE.test(l.trim()));
  const heading = headingIdx !== -1
    ? st.leading[headingIdx]
    : (st.trailing || st.sql.split("\n")[0].slice(0, 60));

  // every leading comment line other than the one used as heading (dividers,
  // blank spacer lines, extra detail) is kept in the description so nothing
  // gets silently dropped.
  const extra = headingIdx !== -1 ? st.leading.filter((_, i) => i !== headingIdx) : st.leading;
  const preamble = extra.length ? extra.map(l => `-- ${l}`).join("\n") + "\n" : "";
  const trailingNote = headingIdx !== -1 && st.trailing ? `\n-- ${st.trailing}` : "";
  const description = preamble + st.sql + trailingNote;

  return [sno, heading, description, "", "code"];
}

// ---------- RFC4180 CSV writer (quote on comma/quote/newline, double up embedded quotes) ----------
function csvField(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const header = ["SNo", "Heading", "Description", "Screenshot", "Format"];
const rows = statements.map((st, i) => buildRow(st, i + 1));

const csv = [header, ...rows].map(r => r.map(csvField).join(",")).join("\n") + "\n";
fs.writeFileSync(outCsvPath, csv);
console.log(`Wrote ${outCsvPath} (${statements.length} statement${statements.length === 1 ? "" : "s"})`);
console.log("Screenshot column left blank — fill in filenames as you capture evidence.");
