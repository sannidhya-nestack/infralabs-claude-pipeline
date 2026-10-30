#!/usr/bin/env python3
"""
May a parser patch from the repair job become a public PR? Exit 0 yes, 1 no.

Runs in the propose job, from a fresh checkout: the repair job ran code Claude wrote, so nothing
it checked counts. Prints only counts, never the offending content: this log is public.

usage: scripts/patch_guard.py PATCH BILL.pdf
"""
import re, subprocess, sys

# Parsers (not the shared contract), tests, carrier notes. Nothing else may change.
ALLOWED = re.compile(r"(scripts/parsers/(?!common\.py$|detect\.py$)[a-z0-9_]+\.py"
                     r"|tests/test_[a-z0-9_]+\.py"
                     r"|\.claude/skills/telecom-bill-extract/carriers/[a-z0-9_-]+\.md)")
MAX_BYTES = 300_000


def problems(patch, bill_text):
    if len(patch) > MAX_BYTES:
        return [f"patch is {len(patch)} bytes, over {MAX_BYTES}"]
    if "GIT binary patch" in patch or re.search(r"^(deleted file|rename from|old mode)", patch, re.M):
        return ["binary, deleted, renamed or mode-changed files"]
    files = re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch, re.M)
    if not files:
        return ["no files"]
    outside = sum(1 for a, b in files if a != b or not ALLOWED.fullmatch(b))
    if outside:
        return [f"{outside} file(s) outside the parser, test and carrier-note paths"]
    added = [l[1:] for l in patch.splitlines() if l.startswith("+") and not l.startswith("+++")]
    # ponytail: whole-line and long-number matches only; a name pasted inside a longer line
    # passes. Shingle the bill's lines if that ever happens.
    numbers = set(re.findall(r"\d{6,}", bill_text))
    lines = {s for s in (l.strip() for l in bill_text.splitlines()) if len(s) >= 25}
    n = sum(1 for l in added for x in re.findall(r"\d{6,}", l) if x in numbers)
    m = sum(1 for l in added if l.strip() in lines)
    return [f"{n} number(s) and {m} line(s) copied from the bill"] if n or m else []


if __name__ == "__main__":
    patch = open(sys.argv[1], encoding="utf-8").read()
    bill = subprocess.run(["pdftotext", "-layout", sys.argv[2], "-"], capture_output=True,
                          check=True).stdout.decode("utf-8", "replace")
    found = problems(patch, bill)
    print("; ".join(found) or "ok")
    sys.exit(1 if found else 0)
