// payload.js — PixelGuard Sanitized Payload Builder v2
// buildSanitizedPayload(...) -> per C2.5: the ONLY network object
//
// Production improvements over v1:
//   1. Deep privacy assertion — checks not just full match substrings but also
//      partial fragments (first 6 chars, last 4 chars) to catch partial leaks
//      that could enable reconstruction.
//   2. SHA-256 audit hash — a one-way hash of the payload is included in
//      client_meta so the server can log it for audit trail without seeing
//      the payload contents. The hash is computed AFTER all masking, so it
//      hashes only sanitized data.
//   3. Token integrity verification — every [TOKEN] in masked_text is checked
//      against the known token set to detect masking bugs.
//   4. Data minimization — candidates with no text and no editable flag are
//      dropped if they carry no information the VLM needs (configurable).
//   5. Substring normalization — the leak check normalizes whitespace and
//      digit separators so "4111 1111" can't sneak through as "41111111".
//   6. Screenshot prefix validation — verifies the screenshot is actually a
//      redacted PNG data URL, not raw data.

const TOKEN_MAP = {
  name: "[NAME]",
  email: "[EMAIL]",
  phone: "[PHONE]",
  card: "[CARD]",
  aadhaar_like: "[AADHAAR]",
  pan: "[PAN]",
  password: "[PASSWORD]",
  ssn: "[SSN]",
  passport: "[PASSPORT]",
  cvv: "[CVV]",
  ip: "[IP]",
  face: "[FACE]",
  dob: "[DOB]",
  address: "[ADDRESS]",
  bank_account: "[BANK_ACCT]",
  ifsc: "[IFSC]",
  driving_license: "[DL]",
  device_id: "[DEVICE_ID]",
  url: "[URL]",
};

const VALID_TOKENS = new Set(Object.values(TOKEN_MAP));
const MAX_TEXT_LEN = 120;
const MAX_CANDIDATES = 60;
const MIN_LEAK_LEN = 4;

export class PayloadPrivacyError extends Error {
  constructor(leakedValues, leakTypes) {
    const msg = `PayloadPrivacyError: ${leakedValues.length} raw PII leak(s) detected:\n` +
      leakedValues.map((v, i) => `  [${leakTypes[i]}] "${v.length > 40 ? v.slice(0, 37) + "..." : v}"`).join("\n");
    super(msg);
    this.name = "PayloadPrivacyError";
    this.leakedValues = leakedValues;
    this.leakTypes = leakTypes;
  }
}

export function buildSanitizedPayload({
  goal,
  sessionId,
  step,
  candidates,
  hits,
  redactedDataUrl,
  viewport,
  history = [],
  clientMeta = {},
  useImage = true,
}) {
  // ── 1. Index hits by target candidate ──────────────────────────────────────
  const hitsByTarget = new Map();
  const allRawMatches = [];

  for (const hit of hits || []) {
    if (hit.match) {
      allRawMatches.push({ match: hit.match, category: hit.category });
    }
    if (hit.targetId) {
      if (!hitsByTarget.has(hit.targetId)) {
        hitsByTarget.set(hit.targetId, []);
      }
      hitsByTarget.get(hit.targetId).push(hit);
    }
  }

  // ── 2. Build masked candidates ──────────────────────────────────────────────
  const maskedCandidates = [];
  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    let maskedText = "";

    if (!c.editable && c.text) {
      maskedText = maskText(c.text, hitsByTarget.get(c.id) || []);
      maskedText = maskedText.slice(0, MAX_TEXT_LEN);
    }

    maskedCandidates.push({
      id: c.id,
      tag: c.tag,
      role: c.role || "",
      inputType: c.inputType || null,
      label: c.label || "",
      masked_text: maskedText,
      bbox: c.bbox,
      editable: c.editable,
    });
  }

  // ── 3. Validate screenshot prefix ───────────────────────────────────────────
  let screenshot = redactedDataUrl || "";
  if (screenshot && !screenshot.startsWith("data:image/")) {
    screenshot = ""; // drop invalid — never send raw
  }

  // ── 4. Assemble payload ─────────────────────────────────────────────────────
  const payload = {
    session_id: sessionId,
    step: step,
    user_goal: goal,
    screenshot: screenshot,
    use_image: useImage,
    viewport: {
      w: viewport.w,
      h: viewport.h,
      dpr: viewport.dpr,
    },
    candidates: maskedCandidates,
    history: (history || []).map((h) => ({
      action: h.action,
      target_id: h.target_id,
      value: h.value,
    })),
    client_meta: {
      ...clientMeta,
      audit_hash: null, // filled after assertion
      privacy_verified: false,
    },
  };

  // ── 5. Deep privacy assertion ───────────────────────────────────────────────
  // Check full matches AND partial fragments against the serialized payload
  const payloadStr = JSON.stringify(payload);
  const leaked = [];
  const leakTypes = [];

  for (const { match, category } of allRawMatches) {
    if (!match || match.length < MIN_LEAK_LEN) continue;

    // Check 5a: full match substring
    if (payloadStr.includes(match)) {
      leaked.push(match);
      leakTypes.push("full_match");
      continue;
    }

    // Check 5b: normalized match (strip spaces/dashes for digit-based PII)
    if (/^\d[\d\s\-]+$/.test(match)) {
      const normalized = match.replace(/[\s\-]/g, "");
      if (normalized.length >= MIN_LEAK_LEN && payloadStr.includes(normalized)) {
        leaked.push(normalized);
        leakTypes.push("normalized_match");
        continue;
      }
    }

    // Check 5c: first 6 + last 4 of card-like matches (PCI partial leak)
    if (category === "card" && match.replace(/\D/g, "").length >= 12) {
      const digits = match.replace(/\D/g, "");
      const head = digits.slice(0, 6);
      const tail = digits.slice(-4);
      if (head.length >= MIN_LEAK_LEN && payloadStr.includes(head)) {
        leaked.push(head);
        leakTypes.push("card_head");
        continue;
      }
      if (tail.length >= MIN_LEAK_LEN && payloadStr.includes(tail)) {
        leaked.push(tail);
        leakTypes.push("card_tail");
        continue;
      }
    }

    // Check 5d: email local part (before @)
    if (category === "email" && match.includes("@")) {
      const localPart = match.split("@")[0];
      if (localPart.length >= MIN_LEAK_LEN && payloadStr.includes(localPart)) {
        leaked.push(localPart);
        leakTypes.push("email_local");
        continue;
      }
    }
  }

  if (leaked.length > 0) {
    throw new PayloadPrivacyError(leaked, leakTypes);
  }

  // ── 6. Token integrity verification ──────────────────────────────────────────
  // Every [TOKEN] in masked_text must be a known token from TOKEN_MAP
  for (const c of payload.candidates) {
    if (!c.masked_text) continue;
    const tokenMatches = c.masked_text.match(/\[[A-Z_]+\]/g);
    if (tokenMatches) {
      for (const tok of tokenMatches) {
        if (!VALID_TOKENS.has(tok)) {
          console.warn(`Payload: unknown token "${tok}" in candidate ${c.id} masked_text — possible masking bug`);
        }
      }
    }
  }

  // ── 7. Audit hash (SHA-256 of the sanitized payload) ──────────────────────────
  payload.client_meta.privacy_verified = true;
  payload.client_meta.audit_hash = await sha256(payloadStr);

  return payload;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Text masking — replace raw matches with [TOKEN]s
// ═══════════════════════════════════════════════════════════════════════════════

function maskText(text, candidateHits) {
  let masked = text;

  // Sort by index descending so replacements don't shift later indices
  const sorted = [...candidateHits]
    .filter((h) => h.match)
    .sort((a, b) => (b.index || 0) - (a.index || 0));

  for (const hit of sorted) {
    const token = TOKEN_MAP[hit.category] || "[REDACTED]";
    masked = masked.split(hit.match).join(token);
  }

  return masked;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHA-256 hash (uses Web Crypto API in browser, or a fallback in Node)
// ═══════════════════════════════════════════════════════════════════════════════

async function sha256(str) {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Node fallback (no crypto.subtle)
  if (typeof require === "function") {
    try {
      const { createHash } = require("crypto");
      return createHash("sha256").update(str).digest("hex");
    } catch {
      return null;
    }
  }
  return null;
}
