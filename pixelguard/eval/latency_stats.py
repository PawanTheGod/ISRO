#!/usr/bin/env python3
"""latency_stats.py — PixelGuard latency statistics.
Reads eval/results/latency_runs.csv (header per C2.4) and computes p50/p95 per stage.
Usage: python eval/latency_stats.py
Writes: eval/results/latency_summary.json
"""
from __future__ import annotations

import csv
import json
import statistics
from pathlib import Path

HERE = Path(__file__).parent
RESULTS = HERE / "results"
CSV_PATH = RESULTS / "latency_runs.csv"
OUT_PATH = RESULTS / "latency_summary.json"

STAGES = [
    "capture_ms",
    "vision_ms",
    "detect_ms",
    "redact_ms",
    "server_ms",
    "vlm_ms",
    "execute_ms",
    "total_ms",
]


def percentile(data, pct):
    if not data:
        return 0
    sorted_data = sorted(data)
    k = (len(sorted_data) - 1) * (pct / 100)
    f = int(k)
    c = min(f + 1, len(sorted_data) - 1)
    if f == c:
        return sorted_data[f]
    return sorted_data[f] + (sorted_data[c] - sorted_data[f]) * (k - f)


def main():
    if not CSV_PATH.exists():
        print(f"Error: {CSV_PATH} not found. Run the extension and export CSV first.")
        return 1

    rows = []
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    if not rows:
        print("No data rows in CSV.")
        return 1

    print(f"Loaded {len(rows)} runs from {CSV_PATH}\n")
    print(f"{'Stage':<15} {'p50':>8} {'p95':>8} {'mean':>8} {'min':>8} {'max':>8}")
    print("-" * 55)

    summary = {}
    for stage in STAGES:
        values = []
        for row in rows:
            try:
                values.append(float(row.get(stage, 0)))
            except (ValueError, KeyError):
                values.append(0.0)

        p50 = percentile(values, 50)
        p95 = percentile(values, 95)
        mean = statistics.mean(values) if values else 0
        mn = min(values) if values else 0
        mx = max(values) if values else 0

        summary[stage] = {"p50": p50, "p95": p95, "mean": mean, "min": mn, "max": mx}
        print(f"{stage:<15} {p50:>8.1f} {p95:>8.1f} {mean:>8.1f} {mn:>8.1f} {mx:>8.1f}")

    summary["n_runs"] = len(rows)

    RESULTS.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"\nWritten to {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
