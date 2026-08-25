// sql_to_csv.js
// Turns a .sql file of patch/verification statements into the CSV format
// generate_report.js expects (SNo, Heading, Description, Screenshot, Format).
// Useful when you want to review or hand-edit the items before generating
// the doc — otherwise generate_report.js can now take a .sql file directly.
//
// See sql_parser.js for how Heading/Description get derived from comments.
//
// The Screenshot column is left blank — you still have to capture evidence
// and fill in the filenames yourself before running generate_report.js.
//
// Usage:
//   node sql_to_csv.js patch.sql [items.csv]

const fs = require("fs");
const { sqlTextToItems } = require("./sql_parser");

const [sqlPath, outCsvPath = "items.csv"] = process.argv.slice(2);
if (!sqlPath) {
  console.error("Usage: node sql_to_csv.js <patch.sql> [items.csv]");
  process.exit(1);
}

const text = fs.readFileSync(sqlPath, "utf8");
const items = sqlTextToItems(text);
if (items.length === 0) {
  console.error(`No SQL statements found in ${sqlPath}`);
  process.exit(1);
}

// ---------- RFC4180 CSV writer (quote on comma/quote/newline, double up embedded quotes) ----------
function csvField(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const header = ["SNo", "Heading", "Description", "Screenshot", "Format"];
const rows = items.map(it => [it.sno, it.heading, it.description, it.screenshot, it.format]);

const csv = [header, ...rows].map(r => r.map(csvField).join(",")).join("\n") + "\n";
fs.writeFileSync(outCsvPath, csv);
console.log(`Wrote ${outCsvPath} (${items.length} statement${items.length === 1 ? "" : "s"})`);
console.log("Screenshot column left blank — fill in filenames as you capture evidence.");
