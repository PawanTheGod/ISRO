// vision.js — PixelGuard on-device face detection (MediaPipe FaceDetector)
// PART 1 (MUST): initFaces() + detectFaces(imageBitmap) using vendored @mediapipe/tasks-vision
// PART 2 (SHOULD, stretch): CLIP zero-shot classifier — stubbed, time-boxed
// Graceful fallback: if MediaPipe not vendored yet, returns empty hits (non-fatal).

let faceDetector = null;
let initMs = 0;
let lastVisionMs = 0;
let visionBackend = "none";

// PART 2 stretch state
let clipPipeline = null;
let clipBackend = null;
let clipBackendReport = { webgpu_ms: null, wasm_ms: null, chosen: null };

export async function initFaces() {
  const t0 = performance.now();
  try {
    // Try dynamic import of vendored MediaPipe tasks-vision
    const visionUrl = chrome.runtime.getURL("vendor/tasks-vision/vision_bundle.mjs");
    const vision = await import(visionUrl);
    const { FilesetResolver, FaceDetector } = vision;

    const wasmPath = chrome.runtime.getURL("vendor/tasks-vision/wasm");
    const filesetResolver = await FilesetResolver.forVisionTasks(wasmPath);

    const modelPath = chrome.runtime.getURL("models/blaze_face_short_range.tflite");
    faceDetector = await FaceDetector.createFromModelPath(filesetResolver, modelPath, {
      runningMode: "IMAGE",
    });
    visionBackend = "mediapipe";
  } catch (err) {
    console.warn("vision.js: MediaPipe not available, face detection disabled (non-fatal).", err);
    visionBackend = "none";
    faceDetector = null;
  }
  initMs = Math.round(performance.now() - t0);
  return faceDetector !== null;
}

export async function detectFaces(imageBitmap) {
  if (!faceDetector) {
    lastVisionMs = 0;
    return [];
  }

  const t0 = performance.now();
  try {
    const result = faceDetector.detect(imageBitmap);
    lastVisionMs = Math.round(performance.now() - t0);

    const faces = (result.detections || [])
      .map((d) => {
        const bb = d.boundingBox;
        return {
          bbox: [
            Math.round(bb.originX),
            Math.round(bb.originY),
            Math.round(bb.width),
            Math.round(bb.height),
          ],
          score: d.categories?.[0]?.score ?? 0,
        };
      })
      .filter((f) => f.score >= 0.5);

    return faces;
  } catch (err) {
    console.warn("vision.js: detectFaces error:", err);
    lastVisionMs = Math.round(performance.now() - t0);
    return [];
  }
}

export function deviceToCss(bbox, dpr) {
  if (!dpr || dpr === 0) return bbox;
  return [
    Math.round(bbox[0] / dpr),
    Math.round(bbox[1] / dpr),
    Math.round(bbox[2] / dpr),
    Math.round(bbox[3] / dpr),
  ];
}

export function getVisionStats() {
  return { init_ms: initMs, last_vision_ms: lastVisionMs, backend: visionBackend };
}

export async function selfTest() {
  if (!faceDetector) {
    console.log("vision self-test: no face detector initialized");
    return false;
  }
  try {
    const imgUrl = chrome.runtime.getURL("demo/assets/person.jpg");
    const resp = await fetch(imgUrl);
    const bitmap = await createImageBitmap(await resp.blob());
    const faces = await detectFaces(bitmap);
    console.log(`vision self-test: detected ${faces.length} face(s)`, faces);
    return faces.length > 0;
  } catch (err) {
    console.warn("vision self-test failed:", err);
    return false;
  }
}

// ── PART 2 (SHOULD, stretch): CLIP zero-shot classifier ──────────────────────
// Time-boxed. If not available, returns null — never blocks the main pipeline.

export async function initVisionModel() {
  // Stretch goal: vendor transformers.min.js + clip model
  // If not vendored, return null (non-fatal)
  try {
    const transformersUrl = chrome.runtime.getURL("vendor/transformers/transformers.min.js");
    const transformers = await import(transformersUrl);

    transformers.env.allowRemoteModels = false;
    transformers.env.localModelPath = chrome.runtime.getURL("models/");

    const labels = ["a button", "a text input field", "a block of text", "a photo of a person", "an image", "a checkbox", "a link"];

    const report = { webgpu_ms: null, wasm_ms: null, chosen: null };
    let pipeline = null;

    // Try webgpu
    try {
      const t0 = performance.now();
      const webgpuPipe = await transformers.pipeline("zero-shot-image-classification", "Xenova/clip-vit-base-patch32", { device: "webgpu" });
      for (let i = 0; i < 3; i++) {
        await webgpuPipe(await createTestCanvas());
      }
      report.webgpu_ms = Array.from({ length: 3 }, (_, i) => Math.round((performance.now() - t0) / 3));
      pipeline = webgpuPipe;
      report.chosen = "webgpu";
    } catch {
      report.webgpu_ms = null;
    }

    // Try wasm (mandatory)
    const t1 = performance.now();
    const wasmPipe = await transformers.pipeline("zero-shot-image-classification", "Xenova/clip-vit-base-patch32", { device: "wasm" });
    for (let i = 0; i < 3; i++) {
      await wasmPipe(await createTestCanvas());
    }
    report.wasm_ms = Array.from({ length: 3 }, (_, i) => Math.round((performance.now() - t1) / 3));

    if (!pipeline) {
      pipeline = wasmPipe;
      report.chosen = "wasm";
    }

    clipPipeline = pipeline;
    clipBackend = report.chosen;
    clipBackendReport = report;
    return report;
  } catch (err) {
    console.warn("vision.js: CLIP not available (stretch goal), returning null.", err);
    return null;
  }
}

export function getBackendReport() {
  return clipBackendReport;
}

export async function classifyCandidateType(screenshotBitmap, bboxCssPx, dpr) {
  if (!clipPipeline) return { visualType: null, confidence: 0 };

  const labels = ["a button", "a text input field", "a block of text", "a photo of a person", "an image", "a checkbox", "a link"];

  try {
    const crop = cropBitmap(screenshotBitmap, bboxCssPx, dpr);
    const result = await clipPipeline(crop, labels);
    if (result && result.length > 0) {
      return { visualType: result[0].label, confidence: result[0].score };
    }
  } catch (err) {
    console.warn("vision.js: classifyCandidateType failed:", err);
  }
  return { visualType: null, confidence: 0 };
}

async function createTestCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#888";
  ctx.fillRect(0, 0, 4, 4);
  return canvas.toDataURL();
}

function cropBitmap(bitmap, bboxCssPx, dpr) {
  const [x, y, w, h] = bboxCssPx;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    bitmap,
    Math.round(x * dpr), Math.round(y * dpr), Math.round(w * dpr), Math.round(h * dpr),
    0, 0, w, h
  );
  return canvas.toDataURL();
}
