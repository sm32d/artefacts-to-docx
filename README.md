# Verification Report Generator

Generic evidence-pack generator — data patches, config changes, access reviews,
test runs, anything that's "here's what I did + a screenshot proving it." You edit
one CSV + drop screenshots in a folder; the script builds a formatted Word doc
(heading, description, screenshot per item, one item per page).

## Quick start

```bash
npm install docx
node generate_report.js items.csv report.docx --title "UAT Evidence Pack" --ref "CHG0012345"
```

1. Fill in `items.csv` — one row per item (see [CSV format](#csv-format)).
2. Put the matching screenshots in `screenshots/`.
3. Run the command above (see [CLI reference](#cli-reference) for all flags).
4. Open `report.docx`, check it, send it to your reviewer.

## CSV format

| Column | Required | Notes |
|---|---|---|
| `SNo` | optional | Item number. Auto-fills from row position if left blank. |
| `Heading` | **yes** | Short title — becomes the section heading. |
| `Description` | **yes** | The write-up. Multi-line is fine as long as the cell is quoted (Excel/Sheets do this automatically with Alt+Enter). |
| `Screenshot` | **yes** | Filename only, e.g. `01.png` — the file itself lives in `screenshots/`. |
| `Format` | optional | Leave blank for a normal paragraph. Set to `code` (or `sql`) to render that row's `Description` as a shaded monospace block instead. |

Column names are matched flexibly and by name, not position — `s/no`, `SQL Query`,
`Screenshot Filename`, etc. all resolve fine, and columns can be in any order.

A missing whole column (e.g. no `Screenshot` header at all) stops generation with a
clear error listing what's missing and what headers were actually found. A blank
cell in one row (e.g. a screenshot not captured yet) does **not** abort the batch —
that one item is flagged in red inline and every other item still generates.

## CLI reference

```
node generate_report.js [csvPath] [outputPath] [flags]
```

| Argument | Default | Description |
|---|---|---|
| `csvPath` (positional 1) | `items.csv` | Input CSV file. |
| `outputPath` (positional 2) | `report.docx` | Output Word file. |
| `--screenshots <dir>` | `<csvPath dir>/screenshots` | Folder to look up `Screenshot` filenames in. |
| `--title <text>` | `Verification Report` | Title on the cover page. |
| `--ref <text>` | *(blank)* | Reference/ticket number, e.g. a change or Jira ID. |
| `--env <text>` | `Non-Production` | Environment the work was verified in. |
| `--author <text>` | *(blank)* | "Prepared by" name on the cover page. |
| `--date <text>` | today's date | Cover page date (`YYYY-MM-DD`). |
| `--label <text>` | `Item` | Word used before each number in section headings — e.g. `Patch 1`, `Test Case 1`. |

All flags are optional.

## Examples

**Default files, minimal flags** — reads `items.csv`, writes `report.docx`:

```bash
node generate_report.js
```

**Data patch batch**, with SQL rows rendered as code blocks via `Format,code` and a
custom label so headings read "Patch 1", "Patch 2", ...:

```bash
node generate_report.js patches.csv patch_report.docx \
  --title "Customer Status Backfill" \
  --ref "CHG0012345" \
  --env "Production" \
  --author "Dominik" \
  --label "Patch"
```

**Access review**, custom label and a different screenshots folder:

```bash
node generate_report.js access_review.csv review.docx \
  --title "Q3 Access Review" \
  --ref "SEC-4471" \
  --author "Dominik" \
  --label "Finding" \
  --screenshots ./review_screenshots
```

**Test run**, headings read "Test Case 1", "Test Case 2", ...:

```bash
node generate_report.js test_cases.csv test_report.docx \
  --title "Regression Test Evidence" \
  --env "Staging" \
  --label "Test Case"
```

## Output

- Each item starts on a new page — easy for a reviewer to flag/comment one at a time.
- Screenshots are auto-scaled to fit the page width, so any resolution works.
- Cover page shows the title plus a Reference / Environment / Prepared by / Date table.

## Requirements

- Node.js with the `docx` package (`npm install docx`).
- That's it — no other dependencies for generation. (Image dimensions are auto-read
  via ImageMagick's `identify` if present; if not, images just fall back to a default
  size, so it still works without it.)

If you don't want to run Node locally, just send the filled CSV and the
`screenshots/` folder and I'll generate the `.docx` for you.
