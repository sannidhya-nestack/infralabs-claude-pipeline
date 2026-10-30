#!/usr/bin/env python3
"""
Optus (Amdocs "Dox PDF") mobile invoice -> Tele-Sense workbook. Deterministic: pdftotext text
layer, no OCR, no LLM. Exits 2 if anything fails to reconcile, so CI goes red instead of
shipping a workbook with silently dropped rows. Layout notes: .claude/skills/telecom-bill-extract/carriers/optus.md

usage: scripts/parsers/optus_bill_to_xlsx.py BILL.pdf OUT.xlsx [--report report.json] [--headers-at-bottom]
"""
import re
from collections import defaultdict

from common import AMT, C4, D, GST_RATE, RE_PAGE, Parsed, grab, inc_gst, main, money, q, row

# Page 1 of the bills this parser reads (detect.py).
FINGERPRINT = re.compile(r"Optus Billing Services")

RE_SVC_START = re.compile(r"^\s*Service Details\s*$")
RE_SVC_CONT = re.compile(r"^\s*Service Details \(continued\)\s*$")
RE_SVC_HDR = re.compile(r"^\s*(\S+)\s+Total Charges \(Ex GST\)\s+" + AMT)
RE_SECTION = re.compile(r"^\s*(Recurring Charges|Usage Charges)\s{2,}.*Total\s+" + AMT + r"\s*$")
RE_RESET = re.compile(r"^\s*(Charge Types|Allowances|Usage Details)\b")
RE_ITEM = re.compile(r"^(\s*\*?)\s*(\S.*?)\s{2,}.*?" + AMT + r"\s*$")


def parse_invoice(pages):
    p1 = pages[0]
    inv = {
        "vendor": "Optus",
        "account_number": grab(r"ACCOUNT NUMBER\s+(\d+)", p1),
        "invoice_number": grab(r"Invoice No:\s+(\S+)", p1),
        "issue_date": grab(r"Issue Date:\s+(.+?)\s*$", p1),
        "invoice_period": grab(r"Invoice Period:\s+(.+?)\s*$", p1),
        "account_name": grab(r"^\s{4,}(\S.*?(PTY|LTD|LIMITED).*?)\s*$", p1),
        "total_pages": int(RE_PAGE.search(p1).group(2)),
    }
    inv["month"] = inv["invoice_period"].split(" to ")[0].split()[1] if inv["invoice_period"] else None
    for key, label in [("new_charges", "New Charges"), ("recurring", "Recurring Charges"),
                       ("usage", "Usage Charges"), ("other", "Other Charges and Credits"),
                       ("gst", "GST")]:
        m = re.search(r"^\s*" + re.escape(label) + r"\s{2,}" + AMT + r"\s*$", p1, re.M)
        inv[key] = money(m.group(1), m.group(2)) if m else D(0)
    # account-level charges (Account Charge Breakdown), first ~10 pages only
    head = "\f".join(pages[:10])
    m = re.search(r"Total Account Charges\s+" + AMT, head)
    inv["account_charges"] = money(m.group(1), m.group(2)) if m else D(0)
    inv["account_charge_desc"] = grab(r"Other Account Charges\s*\n\s+\S+ \S+ \S+\s+(.+?)\s{2,}", head) or "Account Charges"
    return inv


def parse_services(pages):
    services, cur, section, errors = [], None, None, []
    for pno, page in enumerate(pages, 1):
        lines = page.splitlines()
        i = 0
        while i < len(lines):
            line = lines[i]
            if RE_SVC_START.match(line) or RE_SVC_CONT.match(line):
                cont = bool(RE_SVC_CONT.match(line))
                m = RE_SVC_HDR.match(lines[i + 1]) if i + 1 < len(lines) else None
                if not m:
                    errors.append(f"p{pno}: service header not parseable: {lines[i+1:i+2]}")
                    i += 1
                    continue
                number = m.group(1)
                if cont:
                    if not cur or cur["number"] != number:
                        errors.append(f"p{pno}: continuation for {number} but current is {cur and cur['number']}")
                else:
                    cur = {"number": number, "header_total": money(m.group(2), m.group(3)),
                           "plan": lines[i + 2].strip(), "name": lines[i + 3].strip(), "page": pno,
                           "sections": {}, "items": defaultdict(list)}
                    services.append(cur)
                section = None
                i += 4
                continue
            s = RE_SECTION.match(line)
            if s and cur:
                section = s.group(1)
                cur["sections"][section] = money(s.group(2), s.group(3))
            elif RE_RESET.match(line):
                section = None
            elif section and cur:
                it = RE_ITEM.match(line)
                if it:
                    gst_free = it.group(1).strip() == "*"
                    cur["items"][section].append((it.group(2), money(it.group(3), it.group(4)), gst_free))
            i += 1
    return services, errors


def parse(pages):
    inv = parse_invoice(pages)
    services, errors = parse_services(pages)
    acct = inv["account_number"]
    rows = []
    for s in services:
        rec_ex = s["sections"].get("Recurring Charges", D(0))
        use_ex = s["sections"].get("Usage Charges", D(0))
        if q(rec_ex + use_ex) != s["header_total"]:
            errors.append(f"{s['number']} p{s['page']}: sections {rec_ex}+{use_ex} != header {s['header_total']}")
        for sec in ("Recurring Charges", "Usage Charges"):
            got = q(sum((v for _, v, _ in s["items"][sec]), D(0)))
            if got != s["sections"].get(sec, D(0)):
                errors.append(f"{s['number']} p{s['page']}: {sec} items {got} != total {s['sections'].get(sec, D(0))}")
        s.update(rec_ex=rec_ex, use_ex=use_ex)
        rows.append(row(s["number"], acct, s["plan"], inc_gst(s["items"]["Recurring Charges"]),
                        inc_gst(s["items"]["Usage Charges"]), s["page"], name=s["name"],
                        category="Mobile Phones", std_category="Mobile"))
    if inv["account_charges"]:
        ac = (inv["account_charges"] * (1 + GST_RATE)).quantize(C4)
        rows.append(row(acct, acct, inv["account_charge_desc"], D(0), ac, 4, notes="Account-level charge",
                        category="Other", std_category="Other", charge_kind="Usage-based"))
    checks = {
        "recurring_ex_gst": (q(sum((s["rec_ex"] for s in services), D(0))), inv["recurring"]),
        "usage_ex_gst": (q(sum((s["use_ex"] for s in services), D(0))), inv["usage"]),
        "account_charges_ex_gst": (inv["account_charges"], inv["other"]),
    }
    return Parsed(inv, rows, checks, errors, count_column="Calls to 13 Numbers - Discount (count)")


if __name__ == "__main__":
    main(parse)
