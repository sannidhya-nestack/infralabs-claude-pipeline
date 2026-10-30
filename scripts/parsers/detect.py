#!/usr/bin/env python3
"""
Which parser reads this bill: prints one line, `kind=<digital|scanned> parser=<name|none>`.

A parser registers itself by existing: scripts/parsers/<name>_bill_to_xlsx.py with a FINGERPRINT
regex matched against page 1. The first match wins, in file name order. No match prints
parser=none, and the bill-extract workflow asks Claude to write one.

usage: scripts/parsers/detect.py BILL.pdf
"""
import importlib, pathlib, sys

from common import extract_text


def detect(page1):
    # ponytail: a near-empty page 1 means no text layer; pdffonts if a bill ever has a blank cover page
    if len(page1.strip()) < 50:
        return "scanned", "none"
    here = pathlib.Path(__file__).parent
    for path in sorted(here.glob("*_bill_to_xlsx.py")):
        mod = importlib.import_module(path.stem)
        if mod.FINGERPRINT.search(page1):
            return "digital", path.stem.removesuffix("_bill_to_xlsx")
    return "digital", "none"


if __name__ == "__main__":
    pages = extract_text(sys.argv[1], first=1, last=1)
    kind, parser = detect(pages[0] if pages else "")
    print(f"kind={kind} parser={parser}")
