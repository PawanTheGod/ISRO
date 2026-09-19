#!/usr/bin/env python3
"""check_payload.py — PixelGuard payload privacy auditor.
Asserts that NO raw PII string from raw_values.txt appears anywhere in a saved payload JSON.
Usage: python eval/check_payload.py payload.json raw_values.txt
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Check payload for raw PII leakage")
    parser.add_argument("payload", help="Path to saved payload JSON")
    parser.add_argument("raw_values", help="Path to raw_values.txt (one value per line)")
    args = parser.parse_args()

    payload_text = Path(args.payload).read_text(encoding="utf-8-sig")
    raw_values = [line.strip() for line in Path(args.raw_values).read_text(encoding="utf-8-sig").splitlines() if line.strip()]

    # Also check: warn if screenshot is missing data: prefix
    try:
        payload = json.loads(payload_text)
        if isinstance(payload, dict):
            screenshot = payload.get("screenshot", "")
            if screenshot and not screenshot.startswith("data:image"):
                print(f"WARNING: payload.screenshot is missing 'data:image' prefix!")
    except json.JSONDecodeError:
        pass

    leaked = []
    for val in raw_values:
        if val and len(val) >= 4 and val in payload_text:
            leaked.append(val)

    if leaked:
        print("FAIL: Raw PII values found in payload:")
        for v in leaked:
            print(f"  - {v}")
        sys.exit(1)
    else:
        print(f"PASS: No raw PII values found in payload (checked {len(raw_values)} values)")
        sys.exit(0)


if __name__ == "__main__":
    main()
