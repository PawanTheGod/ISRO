// ocr.js — PixelGuard OCR-Based Text Redaction (on-device via Tesseract.js)
// Detects PII rendered as text inside images (scanned docs, screenshots, photos of forms).
// Graceful fallback: if Tesseract.js not vendored, returns empty hits (non-fatal).
//
// Pipeline: crop image region → Tesseract OCR → detectInText on OCR output → merge hits

let tesseractWorker = null;
let ocrReady = false;
let initMs = 0;

export async function initOCR() {
  const t0 = performance.now();
  try {
    const tesseractUrl = chrome.runtime.getURL("vendor/tesseract/tesseract.min.js");
    const Tesseract = await import(tesseractUrl);

    const workerUrl = chrome.runtime.getURL("vendor/tesseract/worker.min.js");
    const coreUrl = chrome.runtime.getURL("vendor/tesseract/tesseract-core.wasm.js");
    const langUrl = chrome.runtime.getURL("vendor/tesseract/eng.traineddata");

    tesseractWorker = await Tesseract.createWorker(langUrl, "eng", {
      workerPath: workerUrl,
      corePath: coreUrl,
      logger: () => {},
    });

    ocrReady = true;
    initMs = Math.round(performance.now() - t0);
    console.log(`OCR initialized in ${initMs}ms (Tesseract.js)`);
    return true;
  } catch (err) {
    console.warn("ocr.js: Tesseract.js not available (non-fatal).", err.message);
    ocrReady = false;
    initMs = Math.round(performance.now() - t0);
    return false;
  }
}

export function isOCRReady() {
  return ocrReady;
}

export async function detectTextInImage(imageBitmap, bbox) {
  if (!ocrReady || !tesseractWorker) return [];

  try {
    const [x, y, w, h] = bbox;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imageBitmap, x, y, w, h, 0, 0, w, h);

    const dataUrl = canvas.toDataURL("image/png");
    const { data } = await tesseractWorker.recognize(dataUrl);

    const textBlocks = [];
    for (const word of data.words || []) {
      if (word.text && word.text.trim().length >= 2) {
        textBlocks.push({
          text: word.text,
          bbox: [x + word.bbox.x0, y + word.bbox.y0, word.bbox.x1 - word.bbox.x0, word.bbox.y1 - word.bbox.y0],
          confidence: word.confidence / 100,
        });
      }
    }
    return textBlocks;
  } catch (err) {
    console.warn("ocr.js: detection error:", err);
    return [];
  }
}

export async function detectPIIInImage(imageBitmap, candidateBbox) {
  if (!ocrReady) return [];

  const textBlocks = await detectTextInImage(imageBitmap, candidateBbox);
  if (textBlocks.length === 0) return [];

  const { detectInText } = await import("./detection.js");
  const allHits = [];

  for (const block of textBlocks) {
    const hits = detectInText(block.text);
    for (const h of hits) {
      allHits.push({
        targetId: null,
        category: h.category,
        confidence: Math.min(h.confidence * 0.9, 0.99),
        source: "ocr",
        bbox: block.bbox,
        match: h.match,
      });
    }
  }

  return allHits;
}

export function getOCRStats() {
  return { ready: ocrReady, init_ms: initMs, engine: "Tesseract.js WASM" };
}
