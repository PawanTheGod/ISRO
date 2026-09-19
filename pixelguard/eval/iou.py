#!/usr/bin/env python3
"""iou.py — PixelGuard redaction IoU evaluator.
Compares ground-truth redaction regions against applied redaction regions.
Usage: python eval/iou.py --gt ground_truth.json --applied applied.json
Writes: eval/results/redaction_iou.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

HERE = Path(__file__).parent
RESULTS = HERE / "results"


def iou(box_a, box_b):
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b

    ax2, ay2 = ax + aw, ay + ah
    bx2, by2 = bx + bw, by + bh

    ix = max(ax, bx)
    iy = max(ay, by)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    iw = max(0, ix2 - ix)
    ih = max(0, iy2 - iy)
    intersection = iw * ih

    area_a = aw * ah
    area_b = bw * bh
    union = area_a + area_b - intersection

    if union <= 0:
        return 0.0
    return intersection / union


def main():
    parser = argparse.ArgumentParser(description="Compute redaction IoU")
    parser.add_argument("--gt", required=True, help="Ground truth JSON: [{category, bbox}]")
    parser.add_argument("--applied", required=True, help="Applied JSON: [{category, bbox}]")
    args = parser.parse_args()

    gt = json.loads(Path(args.gt).read_text(encoding="utf-8-sig"))
    applied = json.loads(Path(args.applied).read_text(encoding="utf-8-sig"))

    gt_by_cat = {}
    for g in gt:
        cat = g["category"]
        gt_by_cat.setdefault(cat, []).append(g["bbox"])

    ap_by_cat = {}
    for a in applied:
        cat = a.get("category", a.get("category", "unknown"))
        ap_by_cat.setdefault(cat, []).append(a.get("bboxDevicePx", a.get("bbox")))

    all_cats = sorted(set(list(gt_by_cat.keys()) + list(ap_by_cat.keys())))

    total_ious = []
    matched_count = 0
    miss_count = 0
    per_cat = {}

    for cat in all_cats:
        gt_boxes = gt_by_cat.get(cat, [])
        ap_boxes = ap_by_cat.get(cat, [])
        cat_ious = []
        for gb in gt_boxes:
            best = 0.0
            for ab in ap_boxes:
                score = iou(gb, ab)
                if score > best:
                    best = score
            cat_ious.append(best)
            total_ious.append(best)
            if best > 0:
                matched_count += 1
            else:
                miss_count += 1
        per_cat[cat] = {
            "mean_iou": sum(cat_ious) / len(cat_ious) if cat_ious else 0,
            "count": len(cat_ious),
            "matched": sum(1 for x in cat_ious if x > 0),
            "missed": sum(1 for x in cat_ious if x == 0),
        }

    mean_iou = sum(total_ious) / len(total_ious) if total_ious else 0
    pct_above_07 = sum(1 for x in total_ious if x >= 0.7) / len(total_ious) * 100 if total_ious else 0

    result = {
        "mean_iou": round(mean_iou, 4),
        "pct_above_0.7": round(pct_above_07, 2),
        "matched": matched_count,
        "missed": miss_count,
        "total_gt": len(total_ious),
        "per_category": per_cat,
    }

    print(f"Mean IoU: {result['mean_iou']:.4f}")
    print(f"% IoU >= 0.7: {result['pct_above_0.7']:.1f}%")
    print(f"Matched: {matched_count}, Missed: {miss_count}, Total GT: {result['total_gt']}")
    for cat, m in per_cat.items():
        print(f"  {cat}: mean_iou={m['mean_iou']:.4f}, matched={m['matched']}/{m['count']}")

    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "redaction_iou.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"\nWritten to {RESULTS / 'redaction_iou.json'}")


if __name__ == "__main__":
    main()
