"""
The part every carrier parser shares: text extraction, money helpers, the Tele-Sense workbook
(same layout as Telstra-*.xlsx) and the PASS/FAIL report.

A parser is scripts/parsers/<name>_bill_to_xlsx.py. It defines FINGERPRINT (a regex that
matches page 1 of the bills it reads, see detect.py) and parse(pages) -> Parsed, then ends with
`if __name__ == "__main__": main(parse)`. Everything carrier-specific lives in the parser; this
file never names a carrier.

stdout carries only the status and counts, because CI logs are public. The full report (with
account names and the offending lines) goes to --report.
"""
import argparse, json, os, re, subprocess, sys, tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP

D = Decimal
C2 = D("0.01")
C4 = D("0.0001")
GST_RATE = D("0.10")
# An amount as bills print it: "$1,234.56", "-12.00", "credit 20.53" (a credit is negative).
AMT = r"(credit\s+)?\$?(-?[\d,]+\.\d{2})"
RE_PAGE = re.compile(r"Page (\d+) of (\d+)")


def headers(count_column=None):
    return ["Identifiying #", "Account #", "Description", "Location", "Inc GST", "Extra", "Total",
            "Ex GST", "Extra", "Total", "Ex GST", "Extra", "Total", "Page Number",
            count_column, "Name", "Equipment", "Notes",
            "Category", "Std Category", "Charge Kind", "Included"]


def money(credit, num):
    v = D(num.replace(",", ""))
    return -v if credit else v


def q(v):
    return v.quantize(C2, rounding=ROUND_HALF_UP)


def grab(pattern, text, group=1, default=None):
    m = re.search(pattern, text, re.M)
    return m.group(group).strip() if m else default


def inc_gst(items):
    """Inc GST of (description, ex GST, gst_free) items. Kept at 4 dp: carriers compute GST on
    the aggregate, so rounding each row to 2 dp drifts about $0.002 per service."""
    return sum(((v if free else v * (1 + GST_RATE)) for _, v, free in items), D(0)).quantize(C4)


def extract_text(pdf, first=None, last=None):
    """pdftotext -layout pages (poppler; xpdf's layout differs). Never print the result: a
    23k-page bill is 165 MB of customer data."""
    out = tempfile.NamedTemporaryFile(suffix=".txt", delete=False).name
    cmd = ["pdftotext", "-layout"]
    if first:
        cmd += ["-f", str(first)]
    if last:
        cmd += ["-l", str(last)]
    subprocess.run(cmd + [pdf, out], check=True)
    with open(out, encoding="utf-8", errors="replace") as f:
        pages = f.read().split("\f")
    os.unlink(out)
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def row(ident, account, description, inc, extra, page, *, name=None, notes=None,
        category, std_category, charge_kind=None, included="Yes"):
    """One workbook row. inc = recurring inc GST (E), extra = usage/other inc GST (F)."""
    if charge_kind is None:
        charge_kind = "Usage-based" if extra != 0 else "Recurring"
    return [ident, account, description, None, float(inc), float(extra), float(inc + extra),
            None, None, None, None, None, None, page, None, name, None, notes,
            category, std_category, charge_kind, included]


@dataclass
class Parsed:
    """What a parser returns.

    invoice: vendor, account_number, invoice_number, issue_date, invoice_period, account_name,
             total_pages (int), new_charges (Decimal, inc GST, the bill's own total), and
             optionally month (shown above the Ex GST column).
    rows:    built with row(), one per service plus account-level rows.
    checks:  name -> (parsed, printed on the invoice). Every pair must be equal: this is where
             a parser proves it dropped nothing (section totals, page 1 subtotals, counts).
    errors:  lines it could not parse, row-level mismatches. Any entry fails the bill.
    """
    invoice: dict
    rows: list
    checks: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)
    count_column: str = None


def report(parsed, gst_tolerance):
    inv, rows = parsed.invoice, parsed.rows
    ids = [r[0] for r in rows]
    total = q(sum((D(str(r[6])) for r in rows), D(0)))
    diff = q(total - inv["new_charges"])
    checks = {k: {"parsed": str(a), "invoice": str(b), "ok": a == b} for k, (a, b) in parsed.checks.items()}
    dupes = sorted(str(i) for i, n in Counter(ids).items() if n > 1)
    ok = (not parsed.errors and not dupes and all(c["ok"] for c in checks.values())
          and abs(diff) <= gst_tolerance)
    return {
        "rows": len(rows),
        "duplicate_ids": dupes[:50],
        "checks": checks,
        "total_inc_gst": {"workbook": str(total), "invoice": str(inv["new_charges"]), "difference": str(diff)},
        "errors": parsed.errors[:50],
        "error_count": len(parsed.errors),
        "status": "PASS" if ok else "FAIL",
    }


def write_xlsx(path, parsed, headers_at_bottom=False):
    from openpyxl import Workbook

    inv, rows = parsed.invoice, parsed.rows
    wb = Workbook()
    sm = wb.active
    sm.title = "Summary"
    sheet = inv["account_number"]
    ws = wb.create_sheet(sheet)
    sub = [None] * 7 + [inv.get("month")] + [None] * 14
    head = [headers(parsed.count_column), sub]
    for r in (rows + head if headers_at_bottom else head + rows):
        ws.append(r)
    for line in ws.iter_rows(min_col=5, max_col=7):
        for c in line:
            if isinstance(c.value, float):
                c.number_format = "0.00"  # values keep 4dp so totals reconcile; display 2dp

    total = q(sum((D(str(r[6])) for r in rows), D(0)))
    inc = q(sum((D(str(r[4])) for r in rows), D(0)))
    extra = q(sum((D(str(r[5])) for r in rows), D(0)))
    cells = {
        "B1": "Summary Page", "B3": "Invoice Details",
        "B4": "Account Name", "C4": inv["account_name"],
        "B5": "Account Number", "C5": inv["account_number"],
        "B6": "Total (Inc GST)", "C6": float(inv["new_charges"]),
        "B7": "Total Pages", "C7": float(inv["total_pages"]),
        "B8": "Vendor Name", "C8": inv["vendor"],
        "B9": "Bill Issued Date", "C9": inv["issue_date"],
        "B11": "Workbook Details", "B12": "Number", "C12": "Name", "D12": "Inc Gst", "E12": "Extra",
        "F12": "Total", "H12": "Difference to invoice",
        "B13": 1.0, "C13": sheet, "D13": float(inc), "E13": float(extra), "F13": float(total),
        "H13": float(q(total - inv["new_charges"])),
        "B15": "Category Totals", "B16": "Category", "C16": "Services", "D16": "Inc Gst",
        "E16": "Extra", "F16": "Total",
    }
    for k, v in cells.items():
        sm[k] = v
    cats = defaultdict(lambda: [0, D(0), D(0), D(0)])
    for r in rows:
        c = cats[r[19]]
        c[0] += 1; c[1] += D(str(r[4])); c[2] += D(str(r[5])); c[3] += D(str(r[6]))
    for n, (cat, (cnt, a, b, t)) in enumerate(sorted(cats.items()), 17):
        sm[f"B{n}"], sm[f"C{n}"] = cat, float(cnt)
        sm[f"D{n}"], sm[f"E{n}"], sm[f"F{n}"] = float(q(a)), float(q(b)), float(q(t))
    wb.save(path)


def main(parse):
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("out")
    ap.add_argument("--report", default=None)
    ap.add_argument("--headers-at-bottom", action="store_true", help="mimic legacy Telstra export (header rows last)")
    ap.add_argument("--gst-tolerance", default="1.00", help="max |inc-GST diff| vs invoice (per-line rounding)")
    a = ap.parse_args()

    pages = extract_text(a.pdf)
    parsed = parse(pages)
    if len(pages) != parsed.invoice["total_pages"]:
        sys.exit(f"FATAL: extracted {len(pages)} pages, invoice says {parsed.invoice['total_pages']}")
    recon = report(parsed, D(a.gst_tolerance))
    write_xlsx(a.out, parsed, a.headers_at_bottom)
    if a.report:
        with open(a.report, "w") as f:
            json.dump({"invoice": {k: str(v) for k, v in parsed.invoice.items()}, "reconciliation": recon}, f, indent=2)
    failed = [k for k, c in recon["checks"].items() if not c["ok"]]
    print(json.dumps({"status": recon["status"], "pages": len(pages), "rows": recon["rows"],
                      "errors": recon["error_count"], "duplicate_ids": len(recon["duplicate_ids"]),
                      "failed_checks": failed}))
    sys.exit(0 if recon["status"] == "PASS" else 2)
