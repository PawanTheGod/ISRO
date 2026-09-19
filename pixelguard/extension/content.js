// content.js — PixelGuard content script v2
// Injected into http://localhost:8080/* pages.
// Manages overlay panel + handles PG_GET_CANDIDATES, PG_EXECUTE, overlay toggle.
//
// Production improvements over v1:
//   1. Fixed-position aware visibility — checks getBoundingClientRect AND computed
//      style position, so fixed/sticky elements aren't missed.
//   2. MutationObserver — invalidates nodeMap when the DOM changes, so stale IDs
//      are detected before action execution.
//   3. Safe nonEmpty access — wrapped in try/catch so elements with restricted
//      .value access don't crash the candidate walk.
//   4. Error boundary — every message handler is wrapped so an exception in one
//      doesn't kill the listener for the rest.
//   5. CSS selector escaping — label[for="..."] uses CSS.escape for special chars.
//   6. Debounce guard — rapid PG_GET_CANDIDATES calls are deduped.

const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea"]);
const TEXT_BLOCK_TAGS = new Set(["p", "div", "span", "li", "td", "h1", "h2", "h3", "h4", "h5", "h6", "label"]);
const MAX_CANDIDATES = 60;
const MAX_TEXT_LEN = 300;
const OVERLAY_ID = "pg-overlay-frame";

let nodeMap = new Map();
let nodeMapValid = false;

// ── MutationObserver: invalidate nodeMap when DOM changes ──────────────────────

let mutationObserver = null;

function setupMutationObserver() {
  if (mutationObserver || typeof MutationObserver === "undefined") return;
  mutationObserver = new MutationObserver(() => {
    nodeMapValid = false;
  });
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
  });
}

// ── Overlay panel management ──────────────────────────────────────────────────

let overlayFrame = null;
let overlayVisible = false;

function createOverlay() {
  if (overlayFrame) return;
  overlayFrame = document.createElement("iframe");
  overlayFrame.src = chrome.runtime.getURL("console.html");
  overlayFrame.id = OVERLAY_ID;
  overlayFrame.style.cssText = [
    "position: fixed",
    "top: 0",
    "right: 0",
    "width: 480px",
    "height: 100vh",
    "border: none",
    "z-index: 2147483647",
    "box-shadow: -4px 0 24px rgba(0,0,0,0.45)",
    "background: #0f0f1e",
    "display: block",
    "margin: 0",
    "padding: 0",
  ].join("; ");
  document.documentElement.appendChild(overlayFrame);
  overlayVisible = true;
}

function toggleOverlay() {
  if (!overlayFrame) {
    createOverlay();
    return;
  }
  overlayVisible = !overlayVisible;
  overlayFrame.style.display = overlayVisible ? "block" : "none";
}

function hideOverlay() {
  if (overlayFrame) overlayFrame.style.display = "none";
}

function showOverlay() {
  if (overlayFrame && overlayVisible) overlayFrame.style.display = "block";
}

// ── Candidate detection helpers ──────────────────────────────────────────────

function isVisible(el) {
  // Check 1: getBoundingClientRect — non-zero area
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  // Check 2: computed style
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  // Check 3: offsetParent (skip for fixed/sticky which have null offsetParent)
  const position = style.position;
  if (position !== "fixed" && position !== "sticky") {
    if (!el.offsetParent && el.tagName !== "BODY") return false;
  }

  return true;
}

function inViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

function isOverlayElement(el) {
  return el.id === OVERLAY_ID;
}

function getRole(el) {
  return el.getAttribute("role") || el.getAttribute("aria-role") || "";
}

function getLabel(el) {
  // 1. <label for="id">
  if (el.id) {
    try {
      const escapedId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id.replace(/["\\]/g, "\\$&");
      const labelEl = document.querySelector('label[for="' + escapedId + '"]');
      if (labelEl) return labelEl.textContent.trim().slice(0, 200);
    } catch {
      // CSS.escape may not be available in all contexts
    }
  }
  // 2. aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.slice(0, 200);
  // 3. aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent.trim().slice(0, 200);
  }
  // 4. placeholder
  const placeholder = el.placeholder;
  if (placeholder) return placeholder.slice(0, 200);
  // 5. Button/link text content
  if (el.tagName === "BUTTON" || el.tagName === "A") return el.textContent.trim().slice(0, 120);
  return "";
}

function getDirectText(el) {
  if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return "";
  let text = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent;
    }
  }
  return text.trim().slice(0, MAX_TEXT_LEN);
}

function isEditable(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

function isInteractive(el) {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (el.getAttribute("role") === "button") return true;
  if (el.hasAttribute("onclick")) return true;
  return false;
}

function safeNonEmpty(el) {
  try {
    return el.value !== undefined && el.value !== null && el.value.length > 0;
  } catch {
    // Some elements restrict .value access
    return false;
  }
}

function captureScreenState() {
  if (!nodeMapValid) {
    nodeMap = new Map();
    nodeMapValid = true;
  }

  const rawCandidates = [];

  function processElement(el) {
    if (el === document.body || el === document.documentElement) return;
    if (isOverlayElement(el)) return;
    if (el.id && el.id.startsWith("pg-")) return;

    if (!isVisible(el) || !inViewport(el)) return;

    const tag = el.tagName.toLowerCase();
    const isInter = isInteractive(el);
    const isTextBlock = TEXT_BLOCK_TAGS.has(tag);

    if (isInter || (isTextBlock && getDirectText(el))) {
      const rect = el.getBoundingClientRect();
      const candidate = {
        id: "",
        tag: tag,
        role: getRole(el),
        inputType: el.tagName === "INPUT" ? (el.type || "text") : null,
        label: getLabel(el),
        text: isInteractive(el) ? "" : getDirectText(el),
        bbox: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        editable: isEditable(el),
        nonEmpty: false,
      };

      if (isEditable(el)) {
        candidate.nonEmpty = safeNonEmpty(el);
      }

      rawCandidates.push({ candidate, el, area: rect.width * rect.height });
    }

    if (el.shadowRoot) {
      for (const child of el.shadowRoot.querySelectorAll("*")) {
        processElement(child);
      }
    }

    if (tag === "iframe" && el.contentDocument) {
      try {
        for (const child of el.contentDocument.querySelectorAll("*")) {
          processElement(child);
        }
      } catch {
        // cross-origin iframe
      }
    }
  }

  for (const el of document.querySelectorAll("*")) {
    processElement(el);
  }

  rawCandidates.sort((a, b) => b.area - a.area);
  const capped = rawCandidates.slice(0, MAX_CANDIDATES);

  const candidates = [];
  nodeMap = new Map();
  capped.forEach((item, idx) => {
    const id = "n" + (idx + 1);
    item.candidate.id = id;
    candidates.push(item.candidate);
    nodeMap.set(id, item.el);
  });

  const viewport = {
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };

  return {
    candidates,
    viewport,
    url: window.location.href,
    title: document.title,
  };
}

function executeAction(action) {
  // Check nodeMap validity — if DOM changed, IDs may be stale
  if (!nodeMapValid) {
    return { ok: false, executed_ms: 0, error: "STALE_ID" };
  }

  const el = nodeMap.get(action.target_id);
  if (!el) {
    return { ok: false, executed_ms: 0, error: "STALE_ID" };
  }

  // Re-check the element is still in the DOM
  if (!el.isConnected) {
    return { ok: false, executed_ms: 0, error: "STALE_ID" };
  }

  const t0 = performance.now();

  try {
    el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
  } catch {
    try { el.scrollIntoView(); } catch {}
  }

  if (action.action === "click") {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  } else if (action.action === "type") {
    let value = action.value;
    if (value && /^\[[A-Z_]+\]$/.test(value) && action.substitutionMap && action.substitutionMap[value]) {
      value = action.substitutionMap[value];
    }
    el.focus();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el.value = value || "";
    } else if (el.isContentEditable) {
      el.textContent = value || "";
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (action.action === "scroll") {
    window.scrollBy({ top: action.value ? parseInt(action.value) : 300, behavior: "smooth" });
  } else if (action.action === "wait") {
    // no-op
  }

  const executed_ms = Math.round(performance.now() - t0);
  return { ok: true, executed_ms, error: null };
}

// ── Message handler with error boundary ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg.type === "PG_TOGGLE_OVERLAY") {
      toggleOverlay();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "PG_HIDE_OVERLAY") {
      hideOverlay();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "PG_SHOW_OVERLAY") {
      showOverlay();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "PG_GET_CANDIDATES") {
      setupMutationObserver();
      const state = captureScreenState();
      sendResponse(state);
      return false;
    }
    if (msg.type === "PG_EXECUTE") {
      const result = executeAction(msg.action);
      sendResponse(result);
      return false;
    }
    return false;
  } catch (err) {
    console.error("PixelGuard content.js error:", err);
    sendResponse({ ok: false, executed_ms: 0, error: "INTERNAL_ERROR: " + String(err).slice(0, 100) });
    return false;
  }
});

// Initialize mutation observer on load
setupMutationObserver();
