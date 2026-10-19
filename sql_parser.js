// sql_parser.js
// Shared SQL-statement-to-item parser, used by both sql_to_csv.js and
// generate_report.js (when handed a .sql file directly instead of a CSV).
//
// Splits a .sql file into statements, then derives a Heading + Description
// per statement from whatever comment is attached to it, in order of
// preference:
//   1. A `--` or /* */ comment block directly above the statement — its
//      first non-decorative line (skipping ==== / ---- style dividers)
//      becomes the Heading. Any further lines in that block are kept as a
//      comment preamble in the Description, nothing is dropped.
//   2. A trailing `--` or /* */ comment on the same line as the statement's
//      closing ';'.
//   3. No comment either side — falls back to the statement's own first
//      line, truncated to 60 characters.
//
// Comments and quoted strings are scanned properly, so a ';' inside a
// comment or a string literal is never mistaken for the end of a statement.

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

  let start = -1; // char offset where the current statement's own text began

  function finish(trailing, end) {
    const trimmed = sql.trim();
    if (trimmed) statements.push({ leading, trailing, sql: trimmed, start, end });
    sql = "";
    leading = [];
    start = -1;
  }

  while (i < n) {
    const c = text[i], c2 = text[i + 1];
    if (start === -1 && sql.trim() === "" && c !== "-" && !(c === "/" && c2 === "*") && !/\s/.test(c)) {
      start = i;
    }

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
      finish(trailing, i);
      continue;
    }

    sql += c;
    i++;
  }
  finish("", n);
  return statements;
}

// Decorative divider lines (====, ----, ****, ...) make lousy headings —
// skip them and use the first line that actually has content instead.
const DECORATIVE = /^[-=_*#~]{3,}$/;

// A commented-out `-- COMMIT;` / `-- ROLLBACK;` (see findCheckpointMarker
// below) is scaffolding for a human running the script manually, not
// documentation — it belongs to no statement in particular and would just
// contaminate the heading/description of whatever statement happens to
// follow it, so it's dropped entirely rather than kept like other comments.
const MARKER_LINE = /^(commit|rollback)\s*;?$/i;

function statementToItem(st, sno) {
  const leading = st.leading.filter(l => !MARKER_LINE.test(l.trim()));
  const headingIdx = leading.findIndex(l => l.trim() && !DECORATIVE.test(l.trim()));
  const heading = headingIdx !== -1
    ? leading[headingIdx]
    : (st.trailing || st.sql.split("\n")[0].slice(0, 60));

  // every leading comment line other than the one used as heading (dividers,
  // blank spacer lines, extra detail) is kept in the description so nothing
  // gets silently dropped.
  const extra = headingIdx !== -1 ? leading.filter((_, i) => i !== headingIdx) : leading;
  const preamble = extra.length ? extra.map(l => `-- ${l}`).join("\n") + "\n" : "";
  const trailingNote = headingIdx !== -1 && st.trailing ? `\n-- ${st.trailing}` : "";
  const description = preamble + st.sql + trailingNote;

  return { sno: String(sno), heading, description, screenshot: "", format: "code" };
}

// Parses raw .sql text straight into the item shape generate_report.js
// works with (sno, heading, description, screenshot, format).
function sqlTextToItems(text) {
  const statements = parseStatements(text.replace(/\r\n/g, "\n"));
  return statements.map((st, i) => statementToItem(st, i + 1));
}

// Finds the conventional "decide here" marker for a BEGIN...COMMIT/ROLLBACK
// block that's been left commented out on purpose, e.g.:
//   -- COMMIT;
//   -- ROLLBACK;
// Returns the character offset of the first such line, or -1 if there isn't
// one. Used by run_sql_report.js to know where to pause and ask before
// actually running a COMMIT or ROLLBACK.
function findCheckpointMarker(text) {
  const re = /^[ \t]*--[ \t]*(commit|rollback)[ \t]*;?[ \t]*$/im;
  const m = re.exec(text);
  return m ? m.index : -1;
}

module.exports = { parseStatements, statementToItem, sqlTextToItems, findCheckpointMarker };
