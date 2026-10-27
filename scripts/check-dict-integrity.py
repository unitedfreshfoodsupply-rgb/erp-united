#!/usr/bin/env python3
"""Dictionary integrity checker for UNITED ERP localization.
Usage: python3 scripts/check-dict-integrity.py
Returns exit code 0 on pass, 1 on failure (missing keys)."""
import re, os, sys

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DICT_PATH = os.path.join(PROJECT, 'lib', 'locale', 'dictionary.ts')
COMPONENTS_DIR = os.path.join(PROJECT, 'components')
SCAN_DIRS = [COMPONENTS_DIR, os.path.join(PROJECT, 'app')]

def main():
    if not os.path.exists(DICT_PATH):
        print(f"Dictionary not found at {DICT_PATH}")
        return 1

    with open(DICT_PATH) as f:
        dict_text = f.read()

    # Extract all dictionary keys (case-insensitive to handle camelCase keys like nameAr)
    dict_keys = set()
    for m in re.finditer(r'"([a-z_]+(?:\.[a-z0-9_.-]+)+)"\s*:', dict_text, re.IGNORECASE):
        dict_keys.add(m.group(1).lower())

    print(f"Dictionary keys: {len(dict_keys)}")

    missing = {}
    for root, _, files in (w for d in SCAN_DIRS for w in os.walk(d)):
        for fn in files:
            if not fn.endswith(".tsx"):
                continue
            fp = os.path.join(root, fn)
            with open(fp) as f:
                text = f.read()
            # t("key") and t("key", { params }) — keys called with parameters were
            # previously skipped, so a missing one could render as its raw key.
            for m in re.finditer(r'\bt\("([^"]+)"\s*[,)]', text):
                key = m.group(1)
                if "." not in key or key.startswith("/"):
                    continue  # skip URL paths and non-key strings
                if key.lower() not in dict_keys:
                    if key not in missing:
                        missing[key] = []
                    line = text[: m.start()].count("\n") + 1
                    loc = f"{os.path.relpath(fp, PROJECT)}:{line}"
                    if loc not in missing[key]:
                        missing[key].append(loc)

    if missing:
        print(f"\n❌ MISSING KEYS: {len(missing)}")
        for k in sorted(missing):
            locs = "; ".join(missing[k][:3])
            print(f"  {k}  ({locs})")
        return 1
    else:
        print(f"\n✅ ALL KEYS PRESENT — integrity check PASS")
        return 0

if __name__ == "__main__":
    sys.exit(main())