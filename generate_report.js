// generate_report.js
// Turns items.csv + screenshots/ into a formatted, reviewer-ready .docx
// Generic evidence/artifact report — not tied to SQL patches specifically.
//
// Usage:
//   node generate_report.js [inputPath] [outputPath] [--title "..."] [--ref "..."]
//        [--env "..."] [--author "..."] [--date "..."] [--label "Item"] [--template]
//
// inputPath can be a CSV (default items.csv) or a .sql file of patch
// statements — .sql is detected by extension and parsed straight into items
// (see sql_parser.js), no intermediate CSV needed. Use sql_to_csv.js instead
// when you want to review/hand-edit the items (headings, descriptions) before
// generating the doc.
//
// Defaults: inputPath=items.csv, outputPath=report.docx, label="Item"
// Requires: npm install docx   (already present in this environment)
//
// --template: skip embedding images for rows with no Screenshot filename set
// (or file not found) and leave an empty bordered "paste zone" there instead —
// for when you'd rather build the doc skeleton first, then paste screenshots
// straight into Word as you capture them. Rows that DO have a screenshot on
// disk still get it embedded automatically either way. Implied automatically
// when the input is a .sql file, since there's no Screenshot column at all.

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun,
  ShadingType, BorderStyle, AlignmentType, PageBreak, Table, TableRow,
  TableCell, WidthType, VerticalAlign,
} = require("docx");
const { sqlTextToItems } = require("./sql_parser");

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

const { positional, flags } = parseArgs(process.argv.slice(2));
const inputPath = positional[0] || "items.csv";
const outPath = positional[1] || "report.docx";
const SCREENSHOT_DIR = flags.screenshots || path.join(path.dirname(inputPath), "screenshots");
const IS_SQL_INPUT = path.extname(inputPath).toLowerCase() === ".sql";
// .sql input has no Screenshot column at all, so template mode is implied.
const TEMPLATE_MODE = !!flags.template || IS_SQL_INPUT;

const meta = {
  title: flags.title || "Verification Report",
  ref: flags.ref || "",
  env: flags.env || "Non-Production",
  author: flags.author || "",
  date: flags.date || new Date().toISOString().slice(0, 10),
  // e.g. "Patch", "Test Case", "Change" — prefix for each section heading.
  // --label "" (explicitly empty) means "no prefix, just the number".
  label: flags.label !== undefined ? flags.label : "Item",
};

// ---------- minimal RFC4180 CSV parser (handles quoted multiline fields, "" escapes) ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0;
  text = text.replace(/\r\n/g, "\n");
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ""));
}

// Column matching is by header NAME (not position), tolerant of common variants
// (spacing, punctuation, case) — "s/no", "SQL Query", "Screenshot Filename" etc.
// all resolve, and column order in the CSV doesn't matter.
const norm = s => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const ALIASES = {
  sno: ["sno", "s/no", "serialno", "serial", "no", "#", "sn"],
  heading: ["heading", "title", "header", "name"],
  description: ["description", "desc", "details", "notes"],
  shot: ["screenshot", "screenshotfilename", "screenshotfile", "image", "img"],
};
const OPTIONAL_ALIASES = {
  format: ["format", "type", "style", "codeblock"], // per-row: "code" -> monospace shaded block
};
const FRIENDLY = { sno: "SNo", heading: "Heading", description: "Description", shot: "Screenshot" };

function findColumn(normalizedHeaders, aliasList) {
  const aliases = aliasList.map(norm);
  let i = normalizedHeaders.findIndex(h => aliases.includes(h));
  if (i === -1) i = normalizedHeaders.findIndex(h => aliases.some(a => h.includes(a)));
  return i;
}

function loadItems(csvPath) {
  const raw = fs.readFileSync(csvPath, "utf8");
  const rows = parseCSV(raw);
  const rawHeader = rows[0];
  const normalizedHeaders = rawHeader.map(norm);

  const idx = {};
  const missing = [];
  for (const field of Object.keys(ALIASES)) {
    const i = findColumn(normalizedHeaders, ALIASES[field]);
    if (i === -1) missing.push(FRIENDLY[field]); else idx[field] = i;
  }
  if (missing.length) {
    throw new Error(
      `CSV is missing required column(s): ${missing.join(", ")}.\n` +
      `Headers found in your file: ${rawHeader.join(" | ")}\n` +
      `Expected something matching: SNo, Heading, Description, Screenshot ` +
      `(column order doesn't matter, and close variants like "s/no" or "Screenshot Filename" are fine).`
    );
  }
  for (const field of Object.keys(OPTIONAL_ALIASES)) {
    const i = findColumn(normalizedHeaders, OPTIONAL_ALIASES[field]);
    if (i !== -1) idx[field] = i;
  }

  // A blank cell in a row should never abort the whole batch — flag that one
  // item instead and keep going, so nothing you've already got is lost.
  return rows.slice(1).map((r, i) => {
    const cell = (field) => (idx[field] !== undefined ? (r[idx[field]] || "").trim() : "");
    return {
      sno: cell("sno") || String(i + 1), // auto-number if left blank
      heading: cell("heading"),
      description: cell("description"),
      screenshot: cell("shot"),
      format: cell("format").toLowerCase(), // "code"/"sql" -> monospace block; anything else -> plain text
    };
  });
}

// ---------- image sizing (reads PNG/JPEG/GIF headers directly — no external deps) ----------
function getImageDims(filePath) {
  const buf = fs.readFileSync(filePath);

  // PNG: 8-byte signature, then IHDR chunk with width/height as big-endian uint32s
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }

  // GIF: little-endian uint16 width/height right after the header
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }

  // JPEG: walk markers looking for a start-of-frame segment
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const isSOF = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
                    (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }

  return { w: 900, h: 500 }; // unrecognized format — safe fallback
}
const MAX_WIDTH_PX = 560;
function scaledImageDims(filePath) {
  const { w, h } = getImageDims(filePath);
  if (w <= MAX_WIDTH_PX) return { width: w, height: h };
  const ratio = MAX_WIDTH_PX / w;
  return { width: MAX_WIDTH_PX, height: Math.round(h * ratio) };
}

// ---------- doc building blocks ----------
function codeBlock(text) {
  const lines = text.trim().length ? text.split("\n") : ["-- no content provided --"];
  return lines.map((line, i) => new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
    border: {
      top: i === 0 ? { style: BorderStyle.SINGLE, size: 4, color: "D0D0D0" } : undefined,
      bottom: i === lines.length - 1 ? { style: BorderStyle.SINGLE, size: 4, color: "D0D0D0" } : undefined,
      left: { style: BorderStyle.SINGLE, size: 4, color: "D0D0D0" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "D0D0D0" },
    },
    spacing: { before: 0, after: 0, line: 264 },
    children: [new TextRun({ text: line.length ? line : " ", font: "Consolas", size: 20 })],
  }));
}

function textBlock(text) {
  if (!text.trim()) {
    return [new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: "(no description provided)", italics: true, color: "888888" })],
    })];
  }
  return text.split("\n").map(line => new Paragraph({
    spacing: { after: 120, line: 276 },
    children: [new TextRun({ text: line.length ? line : " ", size: 22 })],
  }));
}

function pasteZone() {
  return new Paragraph({
    border: {
      top: { style: BorderStyle.DASHED, size: 6, color: "AAAAAA" },
      bottom: { style: BorderStyle.DASHED, size: 6, color: "AAAAAA" },
      left: { style: BorderStyle.DASHED, size: 6, color: "AAAAAA" },
      right: { style: BorderStyle.DASHED, size: 6, color: "AAAAAA" },
    },
    spacing: { before: 120, after: 120, line: 600 },
    children: [],
  });
}

function labelParagraph(text) {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, size: 20, color: "444444" })],
  });
}

function itemSection(item, isFirst) {
  const children = [];
  if (!isFirst) children.push(new Paragraph({ children: [new PageBreak()] }));

  const headingText = item.heading || "(no heading provided)";
  const headingPrefix = meta.label ? `${meta.label} ${item.sno}` : `${item.sno}`;
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 0, after: 160 },
    children: [new TextRun(`${headingPrefix} — ${headingText}`)],
  }));

  const isCode = item.format === "code" || item.format === "sql";
  children.push(...(isCode ? codeBlock(item.description) : textBlock(item.description)));

  children.push(labelParagraph(TEMPLATE_MODE ? "Screenshot(s)" : "Screenshot"));

  const imgPath = item.screenshot ? path.join(SCREENSHOT_DIR, item.screenshot) : null;
  const hasImage = imgPath && fs.existsSync(imgPath) && !fs.statSync(imgPath).isDirectory();

  if (hasImage) {
    const dims = scaledImageDims(imgPath);
    const ext = path.extname(imgPath).slice(1).toLowerCase();
    const type = ext === "jpg" ? "jpeg" : ext;
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({
        type,
        data: fs.readFileSync(imgPath),
        transformation: { width: dims.width, height: dims.height },
      })],
    }));
  } else if (TEMPLATE_MODE) {
    children.push(pasteZone());
  } else if (!imgPath) {
    children.push(new Paragraph({
      children: [new TextRun({ text: "[No screenshot provided for this item]", italics: true, color: "B00020" })],
    }));
  } else {
    children.push(new Paragraph({
      children: [new TextRun({ text: `[Missing screenshot file: ${item.screenshot}]`, italics: true, color: "B00020" })],
    }));
  }
  return children;
}

function titlePage() {
  const metaRows = [
    ["Reference", meta.ref || "—"],
    ["Environment", meta.env],
    ["Prepared by", meta.author || "—"],
    ["Date", meta.date],
  ];
  return [
    new Paragraph({ spacing: { before: 2000, after: 0 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: meta.title, bold: true, size: 44 })],
      spacing: { after: 400 },
    }),
    new Table({
      alignment: AlignmentType.CENTER,
      width: { size: 5000, type: WidthType.DXA },
      columnWidths: [2000, 3000],
      rows: metaRows.map(([k, v]) => new TableRow({
        children: [
          new TableCell({
            width: { size: 2000, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            children: [new Paragraph({ children: [new TextRun({ text: k, bold: true })] })],
          }),
          new TableCell({
            width: { size: 3000, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            children: [new Paragraph({ children: [new TextRun(v)] })],
          }),
        ],
      })),
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

// ---------- main ----------
function main() {
  const items = IS_SQL_INPUT
    ? sqlTextToItems(fs.readFileSync(inputPath, "utf8"))
    : loadItems(inputPath);
  if (items.length === 0) throw new Error(`No ${IS_SQL_INPUT ? "statements" : "rows"} found in ${inputPath}.`);

  const body = [...titlePage()];
  items.forEach((it, i) => body.push(...itemSection(it, i === 0)));

  const doc = new Document({
    sections: [{
      properties: {
        page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
      },
      children: body,
    }],
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
  });

  Packer.toBuffer(doc).then(buf => {
    fs.writeFileSync(outPath, buf);
    console.log(`Wrote ${outPath} (${items.length} items)`);
  });
}

main();
