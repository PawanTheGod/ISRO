// console.js — PixelGuard Console orchestrator v3
// Runs in console.html (extension page, ES module).
//
// v3 improvements over v2:
//   1. Real-time animated metric bars (capture/vision/detect/redact/server/vlm/execute)
//   2. Action-type color badges in response header
//   3. Confidence pill (high/medium/low) color coding
//   4. Candidate count + payload KB live counters in section headers
//   5. Health check on startup — populates provider + circuit-breaker badges
//   6. Run button spinner animation during execution
//   7. Empty-state rows cleared on first data
//   8. Status indicator dot class synced with status state

import { detectAll, detectInText } from "./detection.js";
import { redact } from "./redaction.js";
import { buildSanitizedPayload, PayloadPrivacyError } from "./payload.js";
import { initFaces, detectFaces, deviceToCss } from "./vision.js";
import { getProfile, resolveValue } from "./profile.js";
import { ResourceMonitor, MODEL_SIZES } from "./resource_monitor.js";
import { initNER, detectEntities, isNERReady } from "./ner.js";
import { initOCR, detectPIIInImage, isOCRReady } from "./ocr.js";

// ─── Constants ──────────────────────────────────────────────────────────────
const SERVER_URL          = "http://localhost:8000";
const SERVER_TIMEOUT_MS   = 30_000;
const MAX_STEPS           = 6;
const MAX_RETRIES         = 2;
const CONFIDENCE_GATE     = 0.6;
const CONSECUTIVE_FAIL_LIMIT = 3;

// ─── State ───────────────────────────────────────────────────────────────────
let sourceTabId       = null;
let sessionId         = "s-" + Math.random().toString(36).slice(2, 10);
let step              = 0;
let history           = [];
let timingRows        = [];
let lastPayload       = null;
let running           = false;
let visionReady       = false;
let consecutiveFailures = 0;
let abortController   = null;
const monitor         = ResourceMonitor.getInstance();

// ─── DOM helpers ─────────────────────────────────────────────────────────────
const $   = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// ─── Action metadata ─────────────────────────────────────────────────────────
const ACTION_ICONS = {
  click:    "🖱️",
  type:     "⌨️",
  scroll:   "↕️",
  wait:     "⏳",
  done:     "✅",
  ask_user: "❓",
};

// ─── Metric bar configuration ─────────────────────────────────────────────────
// Order defines how bars are normalised relative to the slowest stage
const BAR_STAGES = ["capture", "vision", "detect", "redact", "server", "vlm", "execute"];

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Resolve source tab
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

  // Health check — populate provider & CB badges
  fetchHealth();

  // Vision / NER / OCR init (non-fatal)
  try {
    const tV = performance.now();
    await initFaces();
    visionReady = true;
    const initMs = Math.round(performance.now() - tV);
    monitor.recordModelLoad("blaze_face_short_range.tflite", MODEL_SIZES["blaze_face_short_range.tflite"] || 224400, initMs);
    monitor.recordModelLoad("vision_wasm", MODEL_SIZES["vision_wasm_internal.wasm"] || 11_750_000, initMs);
    monitor.setBackend("mediapipe-wasm");
  } catch (err) {
    console.warn("Vision init failed (non-fatal):", err);
    visionReady = false;
    monitor.setBackend("none");
  }

  try {
    const nerReady = await initNER();
    if (nerReady) monitor.recordModelLoad("bert-base-NER", 110_000, 0);
  } catch (err) {
    console.warn("NER init failed (non-fatal):", err);
  }

  try {
    const ocrReady = await initOCR();
    if (ocrReady) monitor.recordModelLoad("tesseract-eng", 11_000_000, 0);
  } catch (err) {
    console.warn("OCR init failed (non-fatal):", err);
  }

  monitor.getHeapSnapshot();

  // Event listeners
  $("pg-run-btn").addEventListener("click", () => { if (!running) runLoop(); });
  $("pg-export-csv").addEventListener("click", exportCSV);
  $("pg-save-payload").addEventListener("click", savePayload);
  $("pg-resource-btn")?.addEventListener("click", showResourceReport);
}

// ─── Health check (badges) ────────────────────────────────────────────────────
async function fetchHealth() {
  try {
    const resp = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return;
    const data = await resp.json();
    const pText = $("pg-provider-text");
    const cbText = $("pg-cb-text");
    if (pText) pText.textContent = `${data.provider ?? "?"}/${(data.model ?? "").split("/").pop()}`;
    if (cbText) cbText.textContent = `cb: ${data.circuit_breaker?.state ?? "?"}`;
  } catch {
    // server offline — badges stay default
  }
}

// ─── Main run loop ────────────────────────────────────────────────────────────
async function runLoop() {
  if (running) return;
  running = true;
  step = 0;
  history = [];
  consecutiveFailures = 0;
  const autoRun = $("pg-auto-run").checked;
  const goal = $("pg-goal").value.trim() || "Fill the application form with my profile and submit";

  const runBtn = $("pg-run-btn");
  runBtn.textContent = "Running…";
  runBtn.disabled = true;
  runBtn.classList.add("is-running");

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      let result = null;
      let retries = 0;

      while (retries <= MAX_RETRIES) {
        try {
          result = await runCycle(goal, autoRun);
          consecutiveFailures = 0;
          break;
        } catch (err) {
          retries++;
          if (err instanceof PayloadPrivacyError) {
            setStatus("blocked", `BLOCKED: PII leak — ${err.leakedValues.length} value(s) not sent.`);
            console.error("Privacy violation:", err);
            result = null;
            break;
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
          await sleep(1000 * retries);
        }
      }

      if (!result) break;
      if (result.action === "done") {
        setStatus("ok", `✅ Done: ${result.reasoning}`);
        break;
      }
      if (result.action === "ask_user") {
        setStatus("idle", `❓ Ask user: ${result.reasoning}`);
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
    runBtn.textContent = "▶ Run";
    runBtn.disabled = false;
    runBtn.classList.remove("is-running");
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    // Refresh health badge after each run
    fetchHealth();
  }
}

// ─── Single perception-action cycle ──────────────────────────────────────────
async function runCycle(goal, autoRun) {
  const t0 = performance.now();
  step++;
  setStatus("running", `Step ${step} — capturing screenshot…`);

  // 1. Capture
  const capResp = await chrome.runtime.sendMessage({ type: "PG_CAPTURE", tabId: sourceTabId });
  if (capResp.error) throw new Error(capResp.error);
  const screenshotDataUrl = capResp.screenshotDataUrl;
  const capture_ms = Math.round(performance.now() - t0);
  $("pg-original").src = screenshotDataUrl;

  // 2. DOM candidates
  setStatus("running", `Step ${step} — scanning DOM…`);
  const candResp = await chrome.tabs.sendMessage(sourceTabId, { type: "PG_GET_CANDIDATES" });
  if (!candResp?.candidates) throw new Error("No candidates from content script");
  const candidates = candResp.candidates;
  const viewport   = candResp.viewport;

  // 3. Face detection
  let faceHits = [], vision_ms = 0;
  if (visionReady) {
    setStatus("running", `Step ${step} — face detection…`);
    const vt0 = performance.now();
    try {
      const bitmap = await createImageBitmap(await (await fetch(screenshotDataUrl)).blob());
      const faces  = await detectFaces(bitmap);
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
  setStatus("running", `Step ${step} — PII detection…`);
  const dt0 = performance.now();
  const { hits: piiHits } = await detectAll(candidates);
  let allHits = [...piiHits, ...faceHits];

  // 4b. NER augmentation
  if (isNERReady()) {
    setStatus("running", `Step ${step} — NER augmentation…`);
    for (const c of candidates) {
      if (c.text && !c.editable && !allHits.some((h) => h.targetId === c.id)) {
        const nerHits = await detectEntities(c.text);
        for (const h of nerHits) allHits.push({ ...h, targetId: c.id, bbox: c.bbox });
      }
    }
  }

  // 4c. OCR
  if (isOCRReady()) {
    setStatus("running", `Step ${step} — OCR scan…`);
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
  setStatus("running", `Step ${step} — redacting PII…`);
  const rt0 = performance.now();
  const regions = allHits
    .filter((h) => h.confidence >= 0.5)
    .map((h) => ({ bbox: h.bbox, category: h.category, style: h.category === "face" ? "pixelate" : "block" }));
  for (const c of candidates) {
    if (c.nonEmpty && c.editable) regions.push({ bbox: c.bbox, category: "input", style: "block" });
  }
  const redactionResult = await redact(screenshotDataUrl, regions, viewport.dpr);
  const redact_ms = Math.round(performance.now() - rt0);
  $("pg-sanitized").src = redactionResult.redactedDataUrl;

  // 5b. Compress
  setStatus("running", `Step ${step} — compressing screenshot…`);
  const compressedScreenshot = await compressScreenshot(redactionResult.redactedDataUrl, 640, 0.8);

  // 6. Build sanitized payload
  setStatus("running", `Step ${step} — building payload…`);
  const filteredCandidates = preFilterCandidates(candidates, 25);
  const payload = buildSanitizedPayload({
    goal, sessionId, step,
    candidates: filteredCandidates,
    hits: allHits,
    redactedDataUrl: compressedScreenshot,
    viewport, history,
    clientMeta: {
      backend: visionReady ? "mediapipe" : "none",
      capture_ms, vision_ms, detect_ms, redact_ms,
      redaction_verified: redactionResult.verification?.passed || false,
    },
    useImage: true,
  });
  lastPayload = payload;
  renderPayload(payload);
  renderCandidates(payload.candidates);

  const payload_kb = Math.round(JSON.stringify(payload).length / 1024);
  const kbEl = $("pg-payload-kb");
  if (kbEl) kbEl.textContent = `${payload_kb} KB`;

  // 7. Server call (with timeout)
  setStatus("running", `Step ${step} — querying VLM (timeout ${SERVER_TIMEOUT_MS / 1000}s)…`);
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
    if (err.name === "AbortError") throw new Error(`Server timeout after ${SERVER_TIMEOUT_MS / 1000}s`);
    throw new Error(`Server connection failed: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
    abortController = null;
  }

  if (!validateActionResponse(actionResp)) throw new Error("Invalid server response: missing required fields");

  const server_ms = Math.round(performance.now() - st0);
  const vlm_ms    = actionResp.server_meta?.vlm_ms || 0;
  renderAction(actionResp);

  // 8. Execute
  let execute_ms = 0;
  if (!["done", "ask_user", "wait"].includes(actionResp.action)) {
    setStatus("running", `Step ${step} — executing: ${actionResp.action}…`);
    const profile       = await getProfile();
    const resolvedValue = await resolveValue(actionResp.value, profile);
    const execResp = await chrome.tabs.sendMessage(sourceTabId, {
      type: "PG_EXECUTE",
      action: { ...actionResp, value: resolvedValue, substitutionMap: profile },
    });
    if (!execResp.ok) setStatus("error", `Execute failed: ${execResp.error}`);
    execute_ms = execResp.executed_ms || 0;
  }

  const total_ms = Math.round(performance.now() - t0);

  // 9. Update metric bars
  renderMetricBars({ capture_ms, vision_ms, detect_ms, redact_ms, server_ms, vlm_ms, execute_ms, total_ms });

  // 10. Timing log row
  const timingRow = {
    run_id: `r${String(timingRows.length + 1).padStart(3, "0")}`,
    ts_iso: new Date().toISOString(),
    capture_ms, vision_ms, detect_ms, redact_ms,
    payload_kb, server_ms, vlm_ms, execute_ms, total_ms,
    backend: visionReady ? "mediapipe" : "none",
    use_image: payload.use_image,
    action: actionResp.action,
    confidence: actionResp.confidence,
  };
  timingRows.push(timingRow);
  appendTimingLogRow(timingRow);
  $("pg-run-count").textContent = `${timingRows.length} run${timingRows.length !== 1 ? "s" : ""}`;

  // Resource monitor
  monitor.recordStage("capture", capture_ms);
  monitor.recordStage("vision",  vision_ms);
  monitor.recordStage("detect",  detect_ms);
  monitor.recordStage("redact",  redact_ms);
  monitor.recordStage("server",  server_ms);
  monitor.recordStage("execute", execute_ms);
  monitor.recordStage("total",   total_ms);
  monitor.getHeapSnapshot();

  // History
  history.push({ action: actionResp.action, target_id: actionResp.target_id, value: actionResp.value });

  return actionResp;
}

// ─── Validators ──────────────────────────────────────────────────────────────
function validateActionResponse(resp) {
  if (!resp || typeof resp !== "object") return false;
  if (!resp.action || typeof resp.action !== "string") return false;
  if (typeof resp.confidence !== "number") return false;
  if (typeof resp.reasoning !== "string") return false;
  return true;
}

// ─── Status ──────────────────────────────────────────────────────────────────
function setStatus(cls, msg) {
  const el  = $("pg-status");
  const dot = $("pg-status-dot");
  el.textContent = msg;
  el.className   = cls;
  if (dot) dot.className = `pg-status-indicator ${cls}`;
}

// ─── Metric Bars ─────────────────────────────────────────────────────────────
function renderMetricBars({ capture_ms, vision_ms, detect_ms, redact_ms, server_ms, vlm_ms, execute_ms, total_ms }) {
  const stages = { capture: capture_ms, vision: vision_ms, detect: detect_ms, redact: redact_ms, server: server_ms, vlm: vlm_ms, execute: execute_ms };
  const maxVal = Math.max(1, ...Object.values(stages));

  for (const [name, val] of Object.entries(stages)) {
    const bar    = $(`bar-${name}`);
    const valEl  = $(`val-${name}`);
    if (bar)   bar.style.width   = `${Math.round((val / maxVal) * 100)}%`;
    if (valEl) valEl.textContent = val > 0 ? `${val}ms` : "—";
  }

  const totalEl = $("pg-total-ms");
  if (totalEl) totalEl.innerHTML = `${total_ms}<span>ms total</span>`;
}

// ─── Payload render ───────────────────────────────────────────────────────────
function renderPayload(payload) {
  const display = { ...payload };
  if (display.screenshot) display.screenshot = display.screenshot.slice(0, 50) + "…[REDACTED IMAGE]";
  $("pg-payload").textContent = JSON.stringify(display, null, 2);
}

// ─── Candidates table ─────────────────────────────────────────────────────────
function renderCandidates(candidates) {
  const tbody = $("pg-candidates-body");
  tbody.innerHTML = "";

  if (!candidates.length) {
    tbody.innerHTML = `<tr class="pg-empty-row"><td colspan="7">No candidates found</td></tr>`;
    $("pg-candidate-count").textContent = "0 elements";
    return;
  }

  $("pg-candidate-count").textContent = `${candidates.length} element${candidates.length !== 1 ? "s" : ""}`;

  for (const c of candidates) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(c.id)}</td>
      <td><span class="pg-tag-pill">${esc(c.tag)}</span></td>
      <td>${esc(c.label || "")}</td>
      <td>${esc(c.inputType || "")}</td>
      <td>${esc(c.masked_text || "")}</td>
      <td>[${c.bbox.map((v) => Math.round(v)).join(", ")}]</td>
      <td>${c.editable ? "✓" : "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ─── Action response render ────────────────────────────────────────────────────
function renderAction(resp) {
  $("pg-action").textContent = JSON.stringify(resp, null, 2);

  // Action badge + confidence pill in section header
  const badgesEl = $("pg-action-header-badges");
  if (!badgesEl) return;

  const action = resp.action || "done";
  const conf   = typeof resp.confidence === "number" ? resp.confidence : 0;
  const confClass = conf >= 0.8 ? "high" : conf >= 0.6 ? "medium" : "low";

  badgesEl.innerHTML = `
    <span class="pg-action-badge ${action}" style="margin-right:6px;">
      ${ACTION_ICONS[action] ?? "•"} ${action}
    </span>
    <span class="pg-confidence-pill ${confClass}">
      conf: ${conf.toFixed(2)}
    </span>
  `;
}

// ─── Timing log row ───────────────────────────────────────────────────────────
function appendTimingLogRow(row) {
  const tbody = $("pg-timing-log-body");

  // Clear the empty-state row on first real entry
  const empty = tbody.querySelector(".pg-empty-row");
  if (empty) empty.remove();

  const action = row.action || "done";
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${esc(row.run_id)}</td>
    <td class="ms-value">${row.capture_ms}</td>
    <td class="ms-value">${row.vision_ms}</td>
    <td class="ms-value">${row.detect_ms}</td>
    <td class="ms-value">${row.redact_ms}</td>
    <td class="ms-value">${row.payload_kb}</td>
    <td class="ms-value">${row.server_ms}</td>
    <td class="ms-value">${row.execute_ms}</td>
    <td class="ms-value">${row.total_ms}</td>
    <td class="action-cell"><span class="pg-action-badge ${action}">${action}</span></td>
    <td class="ms-value">${row.confidence.toFixed(2)}</td>
  `;
  tbody.appendChild(tr);
  tr.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ─── CSV export ───────────────────────────────────────────────────────────────
function exportCSV() {
  const header = "run_id,ts_iso,capture_ms,vision_ms,detect_ms,redact_ms,payload_kb,server_ms,vlm_ms,execute_ms,total_ms,backend,use_image,action,confidence";
  const rows = timingRows.map((r) =>
    [r.run_id, r.ts_iso, r.capture_ms, r.vision_ms, r.detect_ms, r.redact_ms, r.payload_kb,
     r.server_ms, r.vlm_ms, r.execute_ms, r.total_ms, r.backend, r.use_image, r.action, r.confidence].join(",")
  );
  downloadBlob([header, ...rows].join("\n"), "text/csv", "latency_runs.csv");
}

// ─── Payload save ─────────────────────────────────────────────────────────────
function savePayload() {
  if (!lastPayload) return;
  downloadBlob(JSON.stringify(lastPayload, null, 2), "application/json", "last_payload.json");
}

// ─── Resource report ──────────────────────────────────────────────────────────
function showResourceReport() {
  const report = monitor.getReportText();
  downloadBlob(report + "\n\n" + JSON.stringify(monitor.getReport(), null, 2), "text/plain", "resource_report.txt");
  console.log(report);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
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
      const scale  = Math.min(1, maxW / (img.naturalWidth || img.width));
      const w      = Math.round((img.naturalWidth  || img.width)  * scale);
      const h      = Math.round((img.naturalHeight || img.height) * scale);
      const canvas = document.createElement("canvas");
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
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
    if (c.editable &&  c.nonEmpty) score += 50;
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

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
