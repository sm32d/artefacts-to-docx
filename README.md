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

1. Fill in `items.csv` — one row per item (see [CSV format](#csv-format)). Got a
   `.sql` file of patch statements instead? See [Generating the CSV from a .sql file](#generating-the-csv-from-a-sql-file).
2. Put the matching screenshots in `screenshots/`. Got a lot of items and don't want
   to fuss with matching filenames to rows? See [Template mode](#template-mode--paste-screenshots-directly-in-word).
3. Run the command above (see [CLI reference](#cli-reference) for all flags).
4. Open `report.docx`, check it, send it to your reviewer.

## Generating the CSV from a .sql file

If your evidence is a batch of SQL statements, you don't have to hand-build the CSV.
`sql_to_csv.js` splits a `.sql` file into statements and writes them straight into
the CSV format `generate_report.js` expects, each row set to `Format,code`.

```bash
node sql_to_csv.js patch.sql items.csv
```

Put a single-line `-- comment` directly above a statement to use as its `Heading`:

```sql
-- Backfill NULL customer_status to ACTIVE for legacy accounts
UPDATE customers
SET status = 'ACTIVE'
WHERE status IS NULL;

-- Verify no NULL statuses remain post-patch
SELECT id, customer_name, status, updated_at
FROM customers
WHERE status = 'ACTIVE'
ORDER BY updated_at DESC
LIMIT 3;
```

No comment above a statement? The heading falls back to that statement's first
line, truncated to 60 characters. The `Screenshot` column is always left blank —
capturing evidence is still a manual step, so fill in filenames in the CSV (or a
spreadsheet app) once you've saved the screenshots into `screenshots/`.

## Template mode — paste screenshots directly in Word

With a lot of items, matching screenshot filenames to CSV rows gets tedious. Instead,
generate the doc skeleton straight from the CSV — headings, descriptions, code blocks,
everything — but with the images left out, and open that in Word. As you work through
each step, screenshot it and paste (`Cmd+V`) straight into the dashed box under that
item; the box has no placeholder text to delete first, and its border expands to frame
the image once you paste, so there's nothing to clean up. Pasting more than one image
in the same box works too, for items that need multiple screenshots.

```bash
node generate_report.js items.csv report.docx --title "UAT Evidence Pack" --template
```

Rows that already have a `Screenshot` filename filled in (and the file exists) still
get embedded automatically — `--template` only adds the paste box where one's missing,
so it's safe to combine with a partially-filled CSV.

The tradeoff: once you start pasting into the doc by hand, it's no longer regenerated
from the CSV — if you edit a description afterward you'd need to regenerate the
skeleton and re-paste everything. Best used once you're happy with the CSV content and
are just capturing evidence as you go.

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
| `--template` | off | Skip embedding an image for rows missing a screenshot; leave an empty paste box instead. See [Template mode](#template-mode--paste-screenshots-directly-in-word). |

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
- That's it — no other dependencies. Image dimensions (for aspect-ratio-correct
  scaling) are read directly from PNG/JPEG/GIF file headers, no external tools needed.

If you don't want to run Node locally, just send the filled CSV and the
`screenshots/` folder and I'll generate the `.docx` for you.
