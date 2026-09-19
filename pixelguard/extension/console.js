// console.js — PixelGuard Console orchestrator v2
// Runs in console.html (extension page, ES module). Imports all detection/redaction/payload/vision modules.
// Orchestrates: capture → candidates → face detect → PII detect → redact → payload → server → execute → timing
//
// Production improvements over v1:
//   1. Error recovery — failed cycles retry up to 2 times before aborting the loop
//   2. Server call timeout — AbortController with 30s timeout on /select-action
//   3. Progress indication — status banner shows each stage as it runs
//   4. Response validation — verifies server response has required fields
//   5. Privacy error handling — PayloadPrivacyError shows a red BLOCKED banner
//   6. Auto-run with step counting and cycle abort on consecutive failures

import { detectAll, detectInText } from "./detection.js";
import { redact } from "./redaction.js";
import { buildSanitizedPayload, PayloadPrivacyError } from "./payload.js";
import { initFaces, detectFaces, deviceToCss } from "./vision.js";
import { getProfile, resolveValue } from "./profile.js";
import { ResourceMonitor, MODEL_SIZES } from "./resource_monitor.js";
import { initNER, detectEntities, isNERReady } from "./ner.js";
import { initOCR, detectPIIInImage, isOCRReady } from "./ocr.js";

const SERVER_URL = "http://localhost:8000";
const SERVER_TIMEOUT_MS = 30000;
const MAX_STEPS = 6;
const MAX_RETRIES = 2;
const CONFIDENCE_GATE = 0.6;
const CONSECUTIVE_FAIL_LIMIT = 3;

let sourceTabId = null;
let sessionId = "s-" + Math.random().toString(36).slice(2, 10);
let step = 0;
let history = [];
let timingRows = [];
let lastPayload = null;
let running = false;
let visionReady = false;
let consecutiveFailures = 0;
let abortController = null;
const monitor = ResourceMonitor.getInstance();

const $ = (id) => document.getElementById(id);

async function init() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "PG_GET_SOURCE_TAB" });
    sourceTabId = resp.tabId;
  } catch {
    const allTabs = await chrome.tabs.query({});
    const demo = allTabs.find((t) => t.url && t.url.includes("localhost:8080"));
    if (demo) sourceTabId = demo.id;
  }

  if (!sourceTabId) {
    setStatus("error", "No demo tab found. Open http://localhost:8080/demo_form.html first.");
  } else {
    setStatus("idle", "Idle — enter a goal and click Run");
  }

  try {
    const tVisionInit = performance.now();
    await initFaces();
    visionReady = true;
    const initMs = Math.round(performance.now() - tVisionInit);
    monitor.recordModelLoad("blaze_face_short_range.tflite", MODEL_SIZES["blaze_face_short_range.tflite"] || 224400, initMs);
    monitor.recordModelLoad("vision_wasm", MODEL_SIZES["vision_wasm_internal.wasm"] || 11750000, initMs);
    monitor.setBackend("mediapipe-wasm");
  } catch (err) {
    console.warn("Vision init failed (non-fatal):", err);
    visionReady = false;
    monitor.setBackend("none");
  }

  let nerReady = false;
  try {
    nerReady = await initNER();
    if (nerReady) monitor.recordModelLoad("bert-base-NER", 110000, 0);
  } catch (err) {
    console.warn("NER init failed (non-fatal):", err);
  }

  let ocrReady = false;
  try {
    ocrReady = await initOCR();
    if (ocrReady) monitor.recordModelLoad("tesseract-eng", 11000000, 0);
  } catch (err) {
    console.warn("OCR init failed (non-fatal):", err);
  }

  monitor.getHeapSnapshot(); // record initial heap

  $("pg-run-btn").addEventListener("click", () => {
    if (!running) runLoop();
  });
  $("pg-export-csv").addEventListener("click", exportCSV);
  $("pg-save-payload").addEventListener("click", savePayload);
  $("pg-resource-btn")?.addEventListener("click", showResourceReport);
}

async function runLoop() {
  if (running) return;
  running = true;
  step = 0;
  history = [];
  consecutiveFailures = 0;
  const autoRun = $("pg-auto-run").checked;
  const goal = $("pg-goal").value.trim() || "Fill the application form with my profile and submit";

  $("pg-run-btn").textContent = "Running...";
  $("pg-run-btn").disabled = true;

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      let result = null;
      let retries = 0;

      // Retry loop for this cycle
      while (retries <= MAX_RETRIES) {
        try {
          result = await runCycle(goal, autoRun);
          consecutiveFailures = 0;
          break;
        } catch (err) {
          retries++;
          if (err instanceof PayloadPrivacyError) {
            setStatus("blocked", `BLOCKED: PII leak detected — ${err.leakedValues.length} value(s). Not sent.`);
            console.error("Privacy violation:", err);
            result = null;
            break; // Don't retry privacy violations
          }
          if (retries > MAX_RETRIES) {
            consecutiveFailures++;
            setStatus("error", `Step ${step} failed after ${MAX_RETRIES + 1} attempts: ${err.message}`);
            console.error(err);
            if (consecutiveFailures >= CONSECUTIVE_FAIL_LIMIT) {
              setStatus("error", `Aborting: ${CONSECUTIVE_FAIL_LIMIT} consecutive failures.`);
              result = null;
            }
            break;
          }
          setStatus("running", `Step ${step} retry ${retries}/${MAX_RETRIES}: ${err.message}`);
          await sleep(1000 * retries); // exponential backoff
        }
      }

      if (!result) break;
      if (result.action === "done") {
        setStatus("ok", `Done: ${result.reasoning}`);
        break;
      }
      if (result.action === "ask_user") {
        setStatus("idle", `Ask user: ${result.reasoning}`);
        if (autoRun && !confirm(`Server asks: ${result.reasoning}\nContinue?`)) break;
      }
      if (result.confidence < CONFIDENCE_GATE && result.action !== "ask_user") {
        if (autoRun && !confirm(`Low confidence (${result.confidence.toFixed(2)}): ${result.reasoning}\nExecute anyway?`)) break;
      }
      if (!autoRun) break;
    }
  } catch (err) {
    setStatus("error", `Fatal: ${err.message}`);
    console.error(err);
  } finally {
    running = false;
    $("pg-run-btn").textContent = "Run";
    $("pg-run-btn").disabled = false;
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }
}

async function runCycle(goal, autoRun) {
  const t0 = performance.now();
  step++;
  setStatus("running", `Step ${step} — capturing...`);

  // 1. Capture screenshot
  const capResp = await chrome.runtime.sendMessage({ type: "PG_CAPTURE", tabId: sourceTabId });
  if (capResp.error) throw new Error(capResp.error);
  const screenshotDataUrl = capResp.screenshotDataUrl;
  const capture_ms = Math.round(performance.now() - t0);
  $("pg-original").src = screenshotDataUrl;

  // 2. Get candidates from content script
  setStatus("running", `Step ${step} — scanning DOM...`);
  const candResp = await chrome.tabs.sendMessage(sourceTabId, { type: "PG_GET_CANDIDATES" });
  if (!candResp || !candResp.candidates) throw new Error("No candidates received from content script");
  const candidates = candResp.candidates;
  const viewport = candResp.viewport;

  // 3. Face detection
  let faceHits = [];
  let vision_ms = 0;
  if (visionReady) {
    setStatus("running", `Step ${step} — face detection...`);
    const vt0 = performance.now();
    try {
      const bitmap = await createImageBitmap(await (await fetch(screenshotDataUrl)).blob());
      const faces = await detectFaces(bitmap);
      faceHits = faces.map((f) => ({
        targetId: null,
        category: "face",
        confidence: f.score,
        source: "face",
        bbox: deviceToCss(f.bbox, viewport.dpr),
        match: null,
      }));
    } catch (err) {
      console.warn("Face detection failed:", err);
    }
    vision_ms = Math.round(performance.now() - vt0);
  }

  // 4. PII detection
  setStatus("running", `Step ${step} — PII detection...`);
  const dt0 = performance.now();
  const { hits: piiHits, stats } = await detectAll(candidates);
  let allHits = [...piiHits, ...faceHits];

  // 4b. NER augmentation for text without regex hits
  if (isNERReady()) {
    setStatus("running", `Step ${step} — NER augmentation...`);
    for (const c of candidates) {
      if (c.text && !c.editable && !allHits.some((h) => h.targetId === c.id)) {
        const nerHits = await detectEntities(c.text);
        for (const h of nerHits) {
          allHits.push({ ...h, targetId: c.id, bbox: c.bbox });
        }
      }
    }
  }

  // 4c. OCR for image/canvas candidates
  if (isOCRReady()) {
    setStatus("running", `Step ${step} — OCR scanning...`);
    try {
      const bitmap = await createImageBitmap(await (await fetch(screenshotDataUrl)).blob());
      for (const c of candidates) {
        if (c.tag === "img" || c.tag === "canvas") {
          const ocrHits = await detectPIIInImage(bitmap, c.bbox);
          allHits = [...allHits, ...ocrHits];
        }
      }
    } catch (err) {
      console.warn("OCR detection failed:", err);
    }
  }

  const detect_ms = Math.round(performance.now() - dt0);

  // 5. Redaction
  setStatus("running", `Step ${step} — redacting...`);
  const rt0 = performance.now();
  const regions = allHits
    .filter((h) => h.confidence >= 0.5)
    .map((h) => ({
      bbox: h.bbox,
      category: h.category,
      style: h.category === "face" ? "pixelate" : "block",
    }));
  for (const c of candidates) {
    if (c.nonEmpty && c.editable) {
      regions.push({ bbox: c.bbox, category: "input", style: "block" });
    }
  }
  const redactionResult = await redact(screenshotDataUrl, regions, viewport.dpr);
  const redact_ms = Math.round(performance.now() - rt0);
  $("pg-sanitized").src = redactionResult.redactedDataUrl;

  // 5b. Compress screenshot for VLM (PNG→JPEG 80%, downscale to 640px wide)
  setStatus("running", `Step ${step} — compressing screenshot...`);
  const compressedScreenshot = await compressScreenshot(redactionResult.redactedDataUrl, 640, 0.8);

  // 6. Build sanitized payload (may throw PayloadPrivacyError)
  setStatus("running", `Step ${step} — building sanitized payload...`);
  const filteredCandidates = preFilterCandidates(candidates, 25);
  const payload = buildSanitizedPayload({
    goal,
    sessionId,
    step,
    candidates: filteredCandidates,
    hits: allHits,
    redactedDataUrl: compressedScreenshot,
    viewport,
    history,
    clientMeta: {
      backend: visionReady ? "mediapipe" : "none",
      capture_ms,
      vision_ms,
      detect_ms,
      redact_ms,
      redaction_verified: redactionResult.verification?.passed || false,
    },
    useImage: true,
  });
  lastPayload = payload;
  renderPayload(payload);
  renderCandidates(payload.candidates);

  const payload_kb = Math.round(JSON.stringify(payload).length / 1024);

  // 7. Send to server (with timeout)
  setStatus("running", `Step ${step} — asking server (timeout ${SERVER_TIMEOUT_MS / 1000}s)...`);
  const st0 = performance.now();
  abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), SERVER_TIMEOUT_MS);

  let actionResp;
  try {
    const resp = await fetch(`${SERVER_URL}/select-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `Server returned ${resp.status}`);
    }

    actionResp = await resp.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Server timeout after ${SERVER_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Server connection failed: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
    abortController = null;
  }

  // Validate server response
  if (!validateActionResponse(actionResp)) {
    throw new Error("Invalid server response: missing required fields");
  }

  const server_ms = Math.round(performance.now() - st0);
  const vlm_ms = actionResp.server_meta?.vlm_ms || 0;
  renderAction(actionResp);

  // 8. Execute action
  let execute_ms = 0;
  if (actionResp.action !== "done" && actionResp.action !== "ask_user" && actionResp.action !== "wait") {
    setStatus("running", `Step ${step} — executing action: ${actionResp.action}...`);
    const profile = await getProfile();
    const resolvedValue = await resolveValue(actionResp.value, profile);
    const execResp = await chrome.tabs.sendMessage(sourceTabId, {
      type: "PG_EXECUTE",
      action: {
        ...actionResp,
        value: resolvedValue,
        substitutionMap: profile,
      },
    });
    if (!execResp.ok) {
      setStatus("error", `Execute failed: ${execResp.error}`);
      if (execResp.error === "STALE_ID") {
        // Next cycle will re-capture
      }
    }
    execute_ms = execResp.executed_ms || 0;
  }

  const total_ms = Math.round(performance.now() - t0);

  // 9. Log timing
  const timingRow = {
    run_id: `r${String(timingRows.length + 1).padStart(3, "0")}`,
    ts_iso: new Date().toISOString(),
    capture_ms,
    vision_ms,
    detect_ms,
    redact_ms,
    payload_kb,
    server_ms,
    vlm_ms,
    execute_ms,
    total_ms,
    backend: visionReady ? "mediapipe" : "none",
    use_image: payload.use_image,
    action: actionResp.action,
    confidence: actionResp.confidence,
  };
  timingRows.push(timingRow);
  renderTiming(timingRow);
  appendTimingLogRow(timingRow);

  // Record stage timings for resource monitor
  monitor.recordStage("capture", capture_ms);
  monitor.recordStage("vision", vision_ms);
  monitor.recordStage("detect", detect_ms);
  monitor.recordStage("redact", redact_ms);
  monitor.recordStage("server", server_ms);
  monitor.recordStage("execute", execute_ms);
  monitor.recordStage("total", total_ms);
  monitor.getHeapSnapshot(); // track heap after each cycle

  // Update history
  history.push({
    action: actionResp.action,
    target_id: actionResp.target_id,
    value: actionResp.value,
  });

  return actionResp;
}

function validateActionResponse(resp) {
  if (!resp || typeof resp !== "object") return false;
  if (!resp.action || typeof resp.action !== "string") return false;
  if (typeof resp.confidence !== "number") return false;
  if (typeof resp.reasoning !== "string") return false;
  return true;
}

function setStatus(cls, msg) {
  const el = $("pg-status");
  el.textContent = msg;
  el.className = `pg-status ${cls}`;
}

function renderPayload(payload) {
  const display = { ...payload };
  if (display.screenshot) display.screenshot = display.screenshot.slice(0, 50) + "...[REDACTED IMAGE]";
  $("pg-payload").textContent = JSON.stringify(display, null, 2);
}

function renderCandidates(candidates) {
  const tbody = $("pg-candidates-body");
  tbody.innerHTML = "";
  for (const c of candidates) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${c.id}</td><td>${c.tag}</td><td>${c.label || ""}</td><td>${c.inputType || ""}</td><td>${c.masked_text || ""}</td><td>[${c.bbox.join(", ")}]</td><td>${c.editable}</td>`;
    tbody.appendChild(tr);
  }
}

function renderAction(resp) {
  $("pg-action").textContent = JSON.stringify(resp, null, 2);
}

function renderTiming(row) {
  const strip = $("pg-timings");
  const items = [
    ["capture", row.capture_ms],
    ["vision", row.vision_ms],
    ["detect", row.detect_ms],
    ["redact", row.redact_ms],
    ["payload_kb", row.payload_kb],
    ["server", row.server_ms],
    ["vlm", row.vlm_ms],
    ["execute", row.execute_ms],
    ["total", row.total_ms],
  ];
  strip.innerHTML = items
    .map(([k, v]) => `<div class="pg-timing-item"><span class="label">${k}</span><span class="value">${v}</span></div>`)
    .join("");
}

function appendTimingLogRow(row) {
  const tbody = $("pg-timing-log-body");
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${row.run_id}</td><td>${row.capture_ms}</td><td>${row.vision_ms}</td><td>${row.detect_ms}</td><td>${row.redact_ms}</td><td>${row.payload_kb}</td><td>${row.server_ms}</td><td>${row.execute_ms}</td><td>${row.total_ms}</td><td>${row.action}</td><td>${row.confidence.toFixed(2)}</td>`;
  tbody.appendChild(tr);
}

function exportCSV() {
  const header = "run_id,ts_iso,capture_ms,vision_ms,detect_ms,redact_ms,payload_kb,server_ms,vlm_ms,execute_ms,total_ms,backend,use_image,action,confidence";
  const rows = timingRows.map((r) =>
    [r.run_id, r.ts_iso, r.capture_ms, r.vision_ms, r.detect_ms, r.redact_ms, r.payload_kb, r.server_ms, r.vlm_ms, r.execute_ms, r.total_ms, r.backend, r.use_image, r.action, r.confidence].join(",")
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "latency_runs.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function savePayload() {
  if (!lastPayload) return;
  const blob = new Blob([JSON.stringify(lastPayload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "last_payload.json";
  a.click();
  URL.revokeObjectURL(url);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function compressScreenshot(dataUrl, maxW, quality) {
  if (!dataUrl) return "";
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / (img.naturalWidth || img.width));
      const w = Math.round((img.naturalWidth || img.width) * scale);
      const h = Math.round((img.naturalHeight || img.height) * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function preFilterCandidates(candidates, maxCount) {
  const scored = candidates.map((c, i) => {
    let score = 0;
    if (c.editable && !c.nonEmpty) score += 100;
    if (c.editable && c.nonEmpty) score += 50;
    if (c.tag === "button" || c.tag === "a") score += 80;
    if (c.tag === "select") score += 70;
    if (c.text) score += 30;
    score += Math.min(20, (c.bbox[2] * c.bbox[3]) / 5000);
    score -= i * 0.1;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map((s) => s.c);
}

function showResourceReport() {
  const report = monitor.getReportText();
  const blob = new Blob([report + "\n\n" + JSON.stringify(monitor.getReport(), null, 2)], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "resource_report.txt";
  a.click();
  URL.revokeObjectURL(url);
  console.log(report);
}

init();
