#!/usr/bin/env node
// eval_pii.mjs — PixelGuard PII detection precision/recall/F1 evaluator
// Imports detection.js (pure ESM) and runs against data/pii_test_set.json
// Usage: node eval/eval_pii.mjs
// Writes: eval/results/pii_metrics.json

import { detectInText } from "../extension/detection.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const dataPath = join(repoRoot, "data", "pii_test_set.json");
const outDir = join(repoRoot, "eval", "results");
mkdirSync(outDir, { recursive: true });

const rows = JSON.parse(readFileSync(dataPath, "utf-8"));

const categories = ["email", "phone", "card", "aadhaar_like", "pan", "ssn", "passport", "cvv", "ip", "dob", "ifsc", "bank_account", "driving_license", "device_id", "url", "name"];
const stats = {};
for (const c of categories) {
  stats[c] = { tp: 0, fp: 0, fn: 0, support: 0 };
}

let micro_tp = 0, micro_fp = 0, micro_fn = 0;

for (const row of rows) {
  const hits = detectInText(row.text);
  const expected = row.category;
  const detected = hits.map((h) => h.category);

  if (expected) {
    stats[expected].support++;
    const matched = detected.includes(expected);
    if (matched) {
      stats[expected].tp++;
      micro_tp++;
    } else {
      stats[expected].fn++;
      micro_fn++;
    }
    for (const h of hits) {
      if (h.category !== expected) {
        stats[h.category].fp++;
        micro_fp++;
      }
    }
  } else {
    for (const h of hits) {
      stats[h.category].fp++;
      micro_fp++;
    }
  }
}

function calcMetrics(s) {
  const precision = s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : 0;
  const recall = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, support: s.support };
}

console.log("\n┌──────────────┬───────────┬──────────┬────────┬─────────┐");
console.log("│ Category     │ Precision │ Recall   │ F1     │ Support │");
console.log("├──────────────┼───────────┼──────────┼────────┼─────────┤");

const results = {};
let allPass = true;
for (const cat of categories) {
  const m = calcMetrics(stats[cat]);
  results[cat] = m;
  console.log(
    `│ ${cat.padEnd(12)} │ ${m.precision.toFixed(4).padEnd(9)} │ ${m.recall.toFixed(4).padEnd(8)} │ ${m.f1.toFixed(4).padEnd(6)} │ ${String(m.support).padEnd(7)} │`
  );
  if (cat === "card" && m.precision < 0.99) allPass = false;
  if (cat === "email" && m.precision < 0.99) allPass = false;
}

const microP = micro_tp + micro_fp > 0 ? micro_tp / (micro_tp + micro_fp) : 0;
const microR = micro_tp + micro_fn > 0 ? micro_tp / (micro_tp + micro_fn) : 0;
const microF = microP + microR > 0 ? (2 * microP * microR) / (microP + microR) : 0;

console.log("├──────────────┼───────────┼──────────┼────────┼─────────┤");
console.log(
  `│ ${"MICRO AVG".padEnd(12)} │ ${microP.toFixed(4).padEnd(9)} │ ${microR.toFixed(4).padEnd(8)} │ ${microF.toFixed(4).padEnd(6)} │ ${String(micro_tp + micro_fn).padEnd(7)} │`
);
console.log("└──────────────┴───────────┴──────────┴────────┴─────────┘");

const output = {
  per_category: results,
  micro_avg: { precision: microP, recall: microR, f1: microF },
  total_rows: rows.length,
  generated_at: new Date().toISOString(),
};

writeFileSync(join(outDir, "pii_metrics.json"), JSON.stringify(output, null, 2) + "\n");
console.log(`\nResults written to eval/results/pii_metrics.json`);

if (!allPass) {
  console.error("\nTRIPWIRE: card or email precision < 0.99!");
  process.exit(1);
}
