// ner.js — PixelGuard NER-Augmented PII Detection (on-device via Transformers.js)
// Catches unstructured PII that regex can't: names without labels, addresses, DOB in prose.
// Graceful fallback: if Transformers.js not vendored, returns empty hits (non-fatal).
//
// Entity → PII category mapping:
//   PER     → name (0.70 default, 0.85 if regex agrees)
//   ORG     → (ignored — not PII in our scope)
//   LOC     → address (0.65)
//   DATE    → dob (0.65)
//   MISC    → (ignored)

let nerPipeline = null;
let nerReady = false;
let initMs = 0;

const ENTITY_MAP = {
  PER: { category: "name", confidence: 0.70 },
  LOC: { category: "address", confidence: 0.65 },
  DATE: { category: "dob", confidence: 0.65 },
};

export async function initNER() {
  const t0 = performance.now();
  try {
    const tfUrl = chrome.runtime.getURL("vendor/transformers/transformers.min.js");
    const tf = await import(tfUrl);

    tf.env.allowRemoteModels = false;
    tf.env.localModelPath = chrome.runtime.getURL("models/");

    nerPipeline = await tf.pipeline(
      "token-classification",
      "Xenova/bert-base-NER",
      { quantized: true }
    );

    nerReady = true;
    initMs = Math.round(performance.now() - t0);
    console.log(`NER initialized in ${initMs}ms (bert-base-NER quantized)`);
    return true;
  } catch (err) {
    console.warn("ner.js: Transformers.js / NER model not available (non-fatal).", err.message);
    nerReady = false;
    initMs = Math.round(performance.now() - t0);
    return false;
  }
}

export function isNERReady() {
  return nerReady;
}

export async function detectEntities(text) {
  if (!nerReady || !nerPipeline || !text) return [];

  try {
    const output = await nerPipeline(text);
    const entities = [];

    for (const ent of output) {
      const mapping = ENTITY_MAP[ent.entity];
      if (!mapping) continue;

      entities.push({
        category: mapping.category,
        match: ent.word.replace(/^##/, ""),
        confidence: Math.min(mapping.confidence + (ent.score || 0) * 0.1, 0.99),
        source: "ner",
        index: text.indexOf(ent.word.replace(/^##/, "")),
      });
    }

    return entities;
  } catch (err) {
    console.warn("ner.js: detection error:", err);
    return [];
  }
}

export function getNERStats() {
  return { ready: nerReady, init_ms: initMs, model: "Xenova/bert-base-NER (quantized)" };
}
