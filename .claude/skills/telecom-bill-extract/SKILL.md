---
name: telecom-bill-extract
description: Turn a telecom invoice PDF from any carrier (Optus, Telstra, TPG, Vodafone, TCA, anything) into the Tele-Sense workbook (Summary sheet plus one row per service) by writing or fixing a deterministic parser. Use when bill-extract finds no parser for a bill's format, or a parser FAILs reconciliation.
---

# Telecom bill -> Tele-Sense workbook

Any carrier, any format. A bill is read by a deterministic parser,
`scripts/parsers/<name>_bill_to_xlsx.py`; your job is to write the parser for a format nobody has
seen yet, or fix one that broke. One parser per bill *format*, not per carrier: a carrier with two
layouts gets two parsers (`optus`, `optus_fixed`).

## Non-negotiables
1. **You never read the bill yourself to produce numbers.** Bills run to 20k+ pages. Write or fix
   the parser and run it. Never edit values in an output workbook by hand.
2. **No silent drops.** A parser run counts only when it prints `"status": "PASS"`: every service
   parsed once, every check equal, `|inc-GST difference| <= tolerance`.
3. **Never `cat` the extracted text** (a 23k-page bill is 165 MB). Use `grep -n`, `grep -c`,
   `sed -n 'A,Bp'`, `pdftotext -layout -f N -l M`.
4. **This repo is public. Nothing from the bill leaves the runner:** no line, name, address,
   account, invoice or service number in a parser, a test, a carrier note or your final message.
   Regexes match labels and shapes (`Total Charges \(Ex GST\)`, `\d{10}`), never a customer's value.
   Test fixtures are synthetic: you type them, with made-up names and numbers, in the bill's layout.
   A patch with any line or long number from the bill is thrown away.
5. Leave your changes in the working tree. Do not commit, push or open a PR: the workflow checks
   the patch and opens the PR itself.

## Step 1 - what kind of bill
```bash
python3 scripts/parsers/detect.py bill.pdf      # kind=digital|scanned parser=<name>|none
pdfinfo bill.pdf | grep -E 'Pages|Producer'
```
- `kind=scanned` (no text layer): stop. Scans go to the vision path (process-invoice.yml); a
  parser cannot read them.
- `parser=<name>`: that parser exists and FAILed. Go to "Fixing a FAIL".
- `parser=none`: a new format. Write a parser (Step 2 and 3).

Extract once, then work on the file: `pdftotext -layout bill.pdf bill.txt` (pages split on `\f`).

## Step 2 - learn the layout (page 1, the summary pages, a few service blocks)
- **Page 1 / invoice summary**: account number, invoice number, issue date, period, the bill's
  total (New Charges, Total Due, Amount Payable this bill: inc GST, not counting the previous
  balance), and every subtotal it prints (recurring / usage / other / one-off / GST). Those are your
  reconciliation targets: each one becomes a check.
- **Service summary pages** (per plan or per service, counts and totals): another set of checks.
- **Service blocks**: how one service starts (its number and total), what follows (plan, user,
  location), the charge sections and their totals, and how a block continues on the next page.
  Count every header variant before you trust one regex:
  `grep -nE 'Service|Total' bill.txt | sed -E 's/^[0-9]+://; s/[0-9]/9/g' | sort | uniq -c | sort -rn | head -40`
- **Itemised usage** (call and data records) is usually most of the pages and is not needed for
  the workbook: find where it starts and skip it.

## Step 3 - the parser
Copy the shape of `scripts/parsers/optus_bill_to_xlsx.py`. The shared contract is
`scripts/parsers/common.py` (do not change it; say so in your final message if it cannot express
a format):
- `FINGERPRINT`: a regex that matches page 1 of this format and no other parser's bills (run
  detect.py on the bill after you add it). Prefer the carrier's legal entity name plus a layout
  label over a lone carrier name.
- `parse(pages) -> Parsed(invoice, rows, checks, errors, count_column)`.
  - `invoice`: the keys listed in `Parsed`, `new_charges` as a Decimal inc GST.
  - `rows`: `row(...)` once per service, plus one row per account-level charge.
  - `checks`: name -> (parsed, printed) for every subtotal the bill prints. Two or more checks
    from different parts of the bill (page 1 subtotals, section totals, service counts) is what
    catches a dropped service.
  - `errors`: every line that looks like a service header but did not parse, every block whose
    items do not add up to its printed total. Never `continue` past a line you did not understand
    without recording it.
- End with `if __name__ == "__main__": main(parse)`.
- Money is `Decimal`, never float, until `row()`.

## Gotchas seen across carriers
- Headers can be **indented**: anchor with `^\s*`, not `^` (missing this dropped 5 services, $409.10).
- **Continuation** headers repeat a service on the next page: never count it twice.
- **Credits** print as `credit 20.53`, `-20.53`, `20.53CR` or `(20.53)`: all negative.
- **GST-free** lines are flagged (`*`, `GST free`, a separate column): inc GST = taxable x 1.1 +
  GST-free. Some carriers print GST per line: use it rather than x 1.1.
- **Rounding**: carriers compute GST on aggregates. Keep row values at 4 dp (`inc_gst()` does),
  display 2 dp, or the total drifts about $0.002 per service.
- Several services per page, and a page break inside a section: keep the parse a state machine
  over lines, not a per-page regex.
- Per-carrier notes live in `carriers/<name>.md`. Add one for a new format: layout facts only.

## Output contract (common.py writes it; matches Telstra-*.xlsx)
- Sheet `Summary`: B1..C9 invoice details, row 12/13 workbook details incl. "Difference to
  invoice", row 16+ category totals.
- Sheet `<account number>`: 22 columns - `Identifiying #, Account #, Description, Location, Inc
  GST, Extra, Total, Ex GST, Extra, Total, Ex GST, Extra, Total, Page Number, <count column>,
  Name, Equipment, Notes, Category, Std Category, Charge Kind, Included`.
  - E = recurring inc GST, F = usage/other inc GST, G = E+F, N = page of the service header,
    P = user name.
  - Category / Std Category, the platform's workbook labels (InfralabsIQ
    `src/config/canonical-categories.ts`): `Mobile Phones` / `Mobile`, `Mobile Data` / `Data`,
    `Landlines`, `Indial`, `Phonewords` or `1300/1800` / `Voice`, `Equipment` / `Hardware`,
    `NBN` / `NBN`, `ADSL` / `ADSL`, `M2M/Vehicle Tracking` / `M2M`, `SDWAN` / `SD-WAN`,
    `Internet Other` / `Other`; account-level rows `Other` / `Other`. Charge Kind `Usage-based`
    if F != 0 else `Recurring` (row() does it). Included `Yes`.

## Fixing a FAIL
1. Run the parser with `--report out/report.json` and read `reconciliation`: `errors`,
   `duplicate_ids`, `checks` (which `ok` is false), `total_inc_gst.difference`.
2. Find the offending pages with grep/sed, fix the regex or the state machine, rerun.
3. Add a synthetic test in `tests/test_parsers.py` (or `tests/test_<name>.py`) that fails without
   your fix: typed pages in the bill's layout, made-up values (see the Optus tests).
4. Loop until `python3 -m pytest -q tests` passes and the parser prints PASS on bill.pdf. Your
   final message: the parser name, what was wrong, the before/after status and counts. No
   customer names or numbers.
