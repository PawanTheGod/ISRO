#!/usr/bin/env node
// eval_independent.mjs — Run detection against hand-labeled independent test set.
// This is NOT self-referential — the test data was written by hand with messy,
// real-world prose that doesn't match the detector's regex patterns exactly.
// Usage: node eval/eval_independent.mjs

import { detectInText } from "../extension/detection.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const dataPath = join(repoRoot, "data", "independent_test_set.json");
const outDir = join(repoRoot, "eval", "results");
mkdirSync(outDir, { recursive: true });

const rows = JSON.parse(readFileSync(dataPath, "utf-8"));

const categories = new Set();
for (const r of rows) {
  if (r.category) categories.add(r.category);
}

const stats = {};
for (const c of categories) {
  stats[c] = { tp: 0, fp: 0, fn: 0, support: 0 };
}

let micro_tp = 0, micro_fp = 0, micro_fn = 0;
let totalRows = 0;
let correctRows = 0;

console.log("\n┌─────────────────────────────────────────────────────────────────────────┐");
console.log("│  INDEPENDENT TEST SET EVALUATION (hand-labeled, not self-generated)     │");
console.log("└─────────────────────────────────────────────────────────────────────────┘\n");

for (const row of rows) {
  totalRows++;
  const hits = detectInText(row.text);
  const expected = row.category;
  const detected = hits.map((h) => h.category);

  let rowCorrect = false;
  if (expected) {
    stats[expected].support++;
    if (detected.includes(expected)) {
      stats[expected].tp++;
      micro_tp++;
      rowCorrect = true;
    } else {
      stats[expected].fn++;
      micro_fn++;
      console.log(`  FN: expected=${expected}, got=[${detected.join(",")}] — "${row.text.slice(0, 60)}..."`);
    }
    for (const h of hits) {
      if (h.category !== expected) {
        stats[h.category] = stats[h.category] || { tp: 0, fp: 0, fn: 0, support: 0 };
        stats[h.category].fp++;
        micro_fp++;
      }
    }
  } else {
    if (hits.length === 0) {
      rowCorrect = true;
    } else {
      for (const h of hits) {
        stats[h.category] = stats[h.category] || { tp: 0, fp: 0, fn: 0, support: 0 };
        stats[h.category].fp++;
        micro_fp++;
      }
      console.log(`  FP: expected=null, got=[${detected.join(",")}] — "${row.text.slice(0, 60)}..."`);
    }
  }

  if (rowCorrect) correctRows++;
}

function calc(s) {
  const p = s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : 0;
  const r = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : 0;
  const f = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  return { precision: p, recall: r, f1: f, support: s.support };
}

console.log("\n┌──────────────┬───────────┬──────────┬────────┬─────────┐");
console.log("│ Category     │ Precision │ Recall   │ F1     │ Support │");
console.log("├──────────────┼───────────┼──────────┼────────┼─────────┤");

const results = {};
for (const cat of [...categories].sort()) {
  const m = calc(stats[cat] || { tp: 0, fp: 0, fn: 0, support: 0 });
  results[cat] = m;
  console.log(
    `│ ${cat.padEnd(12)} │ ${m.precision.toFixed(4).padEnd(9)} │ ${m.recall.toFixed(4).padEnd(8)} │ ${m.f1.toFixed(4).padEnd(6)} │ ${String(m.support).padEnd(7)} │`
  );
}

const microP = micro_tp + micro_fp > 0 ? micro_tp / (micro_tp + micro_fp) : 0;
const microR = micro_tp + micro_fn > 0 ? micro_tp / (micro_tp + micro_fn) : 0;
const microF = microP + microR > 0 ? (2 * microP * microR) / (microP + microR) : 0;

console.log("├──────────────┼───────────┼──────────┼────────┼─────────┤");
console.log(
  `│ ${"MICRO AVG".padEnd(12)} │ ${microP.toFixed(4).padEnd(9)} │ ${microR.toFixed(4).padEnd(8)} │ ${microF.toFixed(4).padEnd(6)} │ ${String(micro_tp + micro_fn).padEnd(7)} │`
);
console.log("└──────────────┴───────────┴──────────┴────────┴─────────┘");

console.log(`\nRow-level accuracy: ${correctRows}/${totalRows} (${((correctRows / totalRows) * 100).toFixed(1)}%)`);
console.log(`\nNOTE: This is an INDEPENDENT test set (hand-labeled, messy prose).`);
console.log(`Scores here will be lower than the synthetic test set — that's expected and honest.`);

const output = {
  test_type: "independent_hand_labeled",
  per_category: results,
  micro_avg: { precision: microP, recall: microR, f1: microF },
  total_rows: totalRows,
  row_accuracy: correctRows / totalRows,
  generated_at: new Date().toISOString(),
};

writeFileSync(join(outDir, "independent_metrics.json"), JSON.stringify(output, null, 2) + "\n");
console.log(`\nResults written to eval/results/independent_metrics.json`);
