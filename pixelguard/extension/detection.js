// detection.js — PixelGuard PII Detection Engine v2 (PURE ESM, no chrome.*, no DOM in core)
// Importable from Node (eval_pii.mjs) and browser (console.js).
//
// Exports: luhnCheck, detectInText, classifyCandidate, detectAll, refineTextHitRects,
//          resolveOverlaps, getPatternRegistry
//
// Architecture:
//   1. Pattern Registry — declarative, extensible, each pattern carries its own
//      confidence, source, validator, and context keywords for boosting/suppression.
//   2. Overlap Resolution — when two patterns match overlapping text, the higher-
//      confidence (then longer) match wins; losers are dropped to avoid double-counting.
//   3. Context Analysis — positive keywords near a match boost confidence (cap 0.99);
//      negative keywords suppress it (floor 0.0). This is what separates "Aadhaar: 2345
//      6789 0123" from "Order ID: 2345 6789 0123".
//   4. Attribute Classification — DOM-level signals (inputType, autocomplete, label)
//      are higher-confidence than text regex because they're structural, not heuristic.

// ═══════════════════════════════════════════════════════════════════════════════
// Luhn check (from scratch — validates credit card checksums)
// ═══════════════════════════════════════════════════════════════════════════════

export function luhnCheck(digitsStr) {
  const digits = digitsStr.replace(/\s|-/g, "");
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pattern Registry — declarative, each entry is self-describing
// ═══════════════════════════════════════════════════════════════════════════════

const PII_PATTERNS = [
  {
    name: "email",
    category: "email",
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    confidence: 0.90,
    source: "regex",
    context: { positive: ["email", "mail", "contact"], negative: [] },
    minLen: 5,
  },
  {
    name: "phone_indian",
    category: "phone",
    regex: /(?<!\w)(?:\+91[\s-]?|0)?([6-9]\d{4}[\s-]?\d{5}|[6-9]\d{9})(?!\w)/g,
    confidence: 0.85,
    source: "regex",
    context: {
      positive: ["phone", "mobile", "call", "contact", "number"],
      negative: ["order", "id", "reference", "pincode", "pin"],
    },
  },
  {
    name: "card_16",
    category: "card",
    regex: /(?<!\d)(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})(?![\s-]?\d)/g,
    confidence: 0.95,
    source: "luhn",
    validator: luhnCheck,
    context: {
      positive: ["card", "credit", "debit", "payment", "visa", "master"],
      negative: ["order", "id", "reference", "tracking"],
    },
  },
  {
    name: "card_amex_15",
    category: "card",
    regex: /(?<!\d)(\d{4}[\s-]?\d{6}[\s-]?\d{5})(?![\s-]?\d)/g,
    confidence: 0.95,
    source: "luhn",
    validator: luhnCheck,
    context: {
      positive: ["card", "credit", "amex", "american express", "payment"],
      negative: ["order", "id", "reference"],
    },
  },
  {
    name: "aadhaar_grouped",
    category: "aadhaar_like",
    regex: /(?<!\d)(?<!\d\s)(?<!\d-)([2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4})(?![\s-]?\d)/g,
    confidence: 0.80,
    source: "regex",
    context: {
      positive: ["aadhaar", "uid", "aadhar", "unique id"],
      negative: ["order", "id", "reference", "tracking", "receipt"],
    },
  },
  {
    name: "pan_indian",
    category: "pan",
    regex: /\b([A-Z]{5}\d{4}[A-Z])\b/g,
    confidence: 0.85,
    source: "regex",
    context: {
      positive: ["pan", "tax", "income", "permanent account"],
      negative: [],
    },
  },
  {
    name: "ssn",
    category: "ssn",
    regex: /\b(\d{3}-\d{2}-\d{4})\b/g,
    confidence: 0.90,
    source: "regex",
    context: {
      positive: ["ssn", "social security"],
      negative: [],
    },
  },
  {
    name: "passport",
    category: "passport",
    regex: /\b([A-Z]\d{7})\b/g,
    confidence: 0.70,
    source: "regex",
    context: {
      positive: ["passport", "travel", "document"],
      negative: ["order", "id", "reference"],
    },
  },
  {
    name: "cvv",
    category: "cvv",
    regex: /(?:cvv|cvc|security\s+code|cv csc)[^0-9]{0,20}(\d{3,4})\b/gi,
    confidence: 0.80,
    source: "regex",
    context: {
      positive: ["cvv", "cvc", "security code", "back", "code"],
      negative: [],
    },
  },
  {
    name: "ip_address",
    category: "ip",
    regex: /\b((?:\d{1,3}\.){3}\d{1,3})\b/g,
    confidence: 0.70,
    source: "regex",
    context: {
      positive: ["ip", "address", "server", "host"],
      negative: ["version", "v"],
    },
    validator: (s) => {
      const parts = s.split(".").map(Number);
      return parts.length === 4 && parts.every((p) => p >= 0 && p <= 255);
    },
  },
  {
    name: "dob",
    category: "dob",
    regex: /(?<!\d)(?:(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})|(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})|(\d{1,2})\.(\d{1,2})\.(\d{4}))(?!\d)/g,
    confidence: 0.60,
    source: "regex",
    context: {
      positive: ["dob", "date of birth", "born", "birthday", "birth date"],
      negative: ["order", "invoice", "receipt", "ip", "server", "address"],
    },
  },
  {
    name: "ifsc",
    category: "ifsc",
    regex: /\b([A-Z]{4}0[A-Z0-9]{6})\b/g,
    confidence: 0.85,
    source: "regex",
    context: {
      positive: ["ifsc", "branch", "bank", "code"],
      negative: [],
    },
  },
  {
    name: "bank_account",
    category: "bank_account",
    regex: /(?<!\d)(\d{14,18})(?!\d)/g,
    confidence: 0.55,
    source: "regex",
    context: {
      positive: ["account", "a/c", "a/c no", "bank account", "acct"],
      negative: ["order", "id", "reference", "tracking", "phone", "mobile", "card", "aadhaar"],
    },
  },
  {
    name: "driving_license",
    category: "driving_license",
    regex: /\b([A-Z]{2}[-\s]?\d{2}[-\s]?\d{4}[-\s]?\d{7})\b/g,
    confidence: 0.80,
    source: "regex",
    context: {
      positive: ["driving", "license", "dl", "dl no", "permit"],
      negative: [],
    },
  },
  {
    name: "mac_address",
    category: "device_id",
    regex: /\b((?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2})\b/g,
    confidence: 0.90,
    source: "regex",
    context: {
      positive: ["mac", "address", "device", "hardware"],
      negative: [],
    },
  },
  {
    name: "imei",
    category: "device_id",
    regex: /(?<!\d)(\d{15})(?!\d)/g,
    confidence: 0.70,
    source: "regex",
    context: {
      positive: ["imei", "device id", "serial", "esn"],
      negative: ["order", "id", "reference", "account"],
    },
  },
  {
    name: "url_with_params",
    category: "url",
    regex: /\b(https?:\/\/[^\s<>"']+\?[^\s<>"']+)\b/g,
    confidence: 0.65,
    source: "regex",
    context: {
      positive: ["url", "link", "token", "key", "session", "api"],
      negative: [],
    },
  },
  {
    name: "name_after_label",
    category: "name",
    regex: /(?:Name|Applicant|Candidate|Full\s+name)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g,
    confidence: 0.60,
    source: "heuristic",
    context: {
      positive: ["name", "applicant", "candidate"],
      negative: [],
    },
  },
  {
    name: "name_in_prose",
    category: "name",
    regex: /(?:my\s+name\s+is|contact\s+person\s*[:\-]?|reach\s+(?:out\s+to\s+)?|this\s+is\s+)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/gi,
    confidence: 0.55,
    source: "heuristic",
    context: {
      positive: ["name", "contact", "person"],
      negative: [],
    },
  },
  {
    name: "dob_natural_language",
    category: "dob",
    regex: /(?:\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b)/gi,
    confidence: 0.70,
    source: "regex",
    context: {
      positive: ["dob", "date of birth", "born", "birthday"],
      negative: ["order", "invoice"],
    },
  },
];

export function getPatternRegistry() {
  return PII_PATTERNS.map((p) => ({ name: p.name, category: p.category, confidence: p.confidence, source: p.source }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Context Analysis — boost or suppress confidence based on surrounding words
// ═══════════════════════════════════════════════════════════════════════════════

const CONTEXT_WINDOW = 60;
const BOOST_AMOUNT = 0.05;
const SUPPRESS_AMOUNT = 0.40;
const MIN_CONFIDENCE = 0.0;
const MAX_CONFIDENCE = 0.99;

function analyzeContext(text, hit, pattern) {
  if (!pattern.context) return hit.confidence;

  const window = text
    .slice(
      Math.max(0, hit.index - CONTEXT_WINDOW),
      hit.index + hit.match.length + CONTEXT_WINDOW
    )
    .toLowerCase();

  let confidence = hit.confidence;

  for (const kw of pattern.context.positive || []) {
    if (window.includes(kw)) {
      confidence = Math.min(MAX_CONFIDENCE, confidence + BOOST_AMOUNT);
    }
  }

  for (const kw of pattern.context.negative || []) {
    if (window.includes(kw)) {
      confidence = Math.max(MIN_CONFIDENCE, confidence - SUPPRESS_AMOUNT);
    }
  }

  return confidence;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Overlap Resolution — when patterns compete for the same text span
// ═══════════════════════════════════════════════════════════════════════════════

export function resolveOverlaps(hits) {
  const sorted = [...hits].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return (b.match?.length || 0) - (a.match?.length || 0);
  });

  const accepted = [];
  for (const hit of sorted) {
    if (!hit.match || hit.index === undefined) {
      accepted.push(hit);
      continue;
    }
    const hitStart = hit.index;
    const hitEnd = hit.index + hit.match.length;
    const overlaps = accepted.some((a) => {
      if (!a.match || a.index === undefined) return false;
      const aStart = a.index;
      const aEnd = a.index + a.match.length;
      return hitStart < aEnd && hitEnd > aStart;
    });
    if (!overlaps) {
      accepted.push(hit);
    }
  }
  return accepted;
}

// ═══════════════════════════════════════════════════════════════════════════════
// detectInText — run all text patterns, validate, context-analyze, resolve overlaps
// ═══════════════════════════════════════════════════════════════════════════════

export function detectInText(text) {
  if (!text || typeof text !== "string") return [];

  const rawHits = [];

  for (const pattern of PII_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m;
    while ((m = pattern.regex.exec(text)) !== null) {
      const matchStr = m[0];
      const matchValue = m[1] || m[0];
      const index = m.index + (m[0].indexOf(matchValue) >= 0 ? m[0].indexOf(matchValue) : 0);

      if (pattern.minLen && matchValue.length < pattern.minLen) continue;

      if (pattern.validator && !pattern.validator(matchValue.replace(/\s|-/g, ""))) continue;

      let confidence = analyzeContext(text, { match: matchValue, index, confidence: pattern.confidence }, pattern);

      if (confidence <= 0) continue;

      rawHits.push({
        category: pattern.category,
        match: matchValue,
        index: index,
        confidence: confidence,
        source: pattern.source,
      });
    }
  }

  return resolveOverlaps(rawHits);
}

// ═══════════════════════════════════════════════════════════════════════════════
// classifyCandidate — DOM-level structural classification (higher confidence than text)
// ═══════════════════════════════════════════════════════════════════════════════

export function classifyCandidate(c) {
  const hits = [];
  if (!c) return hits;

  const inputType = (c.inputType || "").toLowerCase();
  const label = (c.label || "").toLowerCase();
  const tag = (c.tag || "").toLowerCase();
  const autocomplete = (c.autocomplete || "").toLowerCase();

  if (inputType === "password") {
    hits.push({ category: "password", confidence: 1.0, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (inputType === "email" || autocomplete === "email" || label.includes("email")) {
    hits.push({ category: "email", confidence: 0.95, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (inputType === "tel" || autocomplete === "tel" || label.includes("mobile") || label.includes("phone")) {
    hits.push({ category: "phone", confidence: 0.90, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (autocomplete === "cc-number" || autocomplete.includes("cc-") || label.includes("card number")) {
    hits.push({ category: "card", confidence: 1.0, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (autocomplete === "cc-csc" || label.includes("cvv") || label.includes("cvc") || label.includes("security code")) {
    hits.push({ category: "cvv", confidence: 0.95, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (label.includes("aadhaar") || label.includes("uid")) {
    hits.push({ category: "aadhaar_like", confidence: 0.95, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (label.includes("pan") && (label.includes("card") || label.includes("number") || label.includes("tax"))) {
    hits.push({ category: "pan", confidence: 0.90, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (label.includes("passport")) {
    hits.push({ category: "passport", confidence: 0.90, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (label.includes("ssn") || label.includes("social security")) {
    hits.push({ category: "ssn", confidence: 0.90, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (label.includes("date of birth") || label.includes("dob") || label.includes("birthday") || inputType === "date") {
    hits.push({ category: "dob", confidence: 0.90, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (label.includes("ifsc") || label.includes("branch code")) {
    hits.push({ category: "ifsc", confidence: 0.90, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (label.includes("account number") || label.includes("bank account") || label.includes("a/c")) {
    hits.push({ category: "bank_account", confidence: 0.90, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (label.includes("driving license") || label.includes("dl number") || label.includes("licence")) {
    hits.push({ category: "driving_license", confidence: 0.90, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  if (label.includes("address") || autocomplete === "street-address" || autocomplete === "address-line1") {
    hits.push({ category: "address", confidence: 0.85, source: "dom", targetId: c.id, bbox: c.bbox, match: null });
  }

  return hits;
}

// ═══════════════════════════════════════════════════════════════════════════════
// detectAll — full pipeline: attribute classification + text detection + merge
// ═══════════════════════════════════════════════════════════════════════════════

export function detectAll(candidates) {
  const hits = [];
  const stats = {
    total: 0,
    byCategory: {},
    bySource: {},
    byConfidence: { high: 0, medium: 0, low: 0 },
  };

  for (const c of candidates) {
    const attrHits = classifyCandidate(c);
    for (const h of attrHits) {
      hits.push(h);
      _recordStat(stats, h);
    }

    if (c.text && !c.editable) {
      const textHits = detectInText(c.text);
      for (const h of textHits) {
        hits.push({
          targetId: c.id,
          category: h.category,
          confidence: h.confidence,
          source: h.source,
          bbox: c.bbox,
          match: h.match,
        });
        _recordStat(stats, h);
      }
    }
  }

  return { hits, stats };
}

function _recordStat(stats, h) {
  stats.total++;
  stats.byCategory[h.category] = (stats.byCategory[h.category] || 0) + 1;
  stats.bySource[h.source] = (stats.bySource[h.source] || 0) + 1;
  if (h.confidence >= 0.85) stats.byConfidence.high++;
  else if (h.confidence >= 0.6) stats.byConfidence.medium++;
  else stats.byConfidence.low++;
}

// ═══════════════════════════════════════════════════════════════════════════════
// refineTextHitRects — browser-only: use Range API for tight bboxes around text matches
// ═══════════════════════════════════════════════════════════════════════════════

export function refineTextHitRects(candidateEl, hit) {
  if (typeof document === "undefined") {
    return [hit.bbox];
  }
  try {
    const range = document.createRange();
    const textNode = Array.from(candidateEl.childNodes).find(
      (n) => n.nodeType === Node.TEXT_NODE
    );
    if (!textNode) return [hit.bbox];

    const text = textNode.textContent;
    const start = text.indexOf(hit.match);
    if (start < 0) return [hit.bbox];

    range.setStart(textNode, start);
    range.setEnd(textNode, start + hit.match.length);

    const rects = range.getClientRects();
    const bboxes = [];
    for (const r of rects) {
      bboxes.push([
        Math.round(r.x),
        Math.round(r.y),
        Math.round(r.width),
        Math.round(r.height),
      ]);
    }
    return bboxes.length > 0 ? bboxes : [hit.bbox];
  } catch {
    return [hit.bbox];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Inline unit tests (runnable via: node extension/detection.js --test)
// ═══════════════════════════════════════════════════════════════════════════════

function runTests() {
  const tests = [
    ["Luhn: 4111111111111111 (valid)", luhnCheck("4111111111111111") === true],
    ["Luhn: 4012888888881881 (valid)", luhnCheck("4012888888881881") === true],
    ["Luhn: 4111111111111112 (invalid)", luhnCheck("4111111111111112") === false],
    ["Luhn: 1234567812345678 (invalid)", luhnCheck("1234567812345678") === false],
    ["Luhn: Amex 378282246310005 (valid 15-digit)", luhnCheck("378282246310005") === true],
    ["Email: rohan@example.com", detectInText("Contact rohan@example.com now").some((h) => h.category === "email" && h.match === "rohan@example.com")],
    ["Phone: +91 98765 43210", detectInText("Call +91 98765 43210 today").some((h) => h.category === "phone")],
    ["Phone: 9876543210 (10-digit)", detectInText("Reach me at 9876543210").some((h) => h.category === "phone")],
    ["Aadhaar with context boost", detectInText("Aadhaar: 2345 6789 0123").some((h) => h.category === "aadhaar_like" && h.confidence >= 0.85)],
    ["Aadhaar without context (lower conf)", detectInText("Value: 2345 6789 0123").some((h) => h.category === "aadhaar_like" && h.confidence < 0.85)],
    ["Card: 4111 1111 1111 1111 (Luhn valid)", detectInText("Card: 4111 1111 1111 1111").some((h) => h.category === "card")],
    ["Card: 4111 1111 1111 1112 (Luhn FAIL — not flagged)", !detectInText("Ref: 4111 1111 1111 1112").some((h) => h.category === "card")],
    ["PAN: ABCDE1234F", detectInText("PAN: ABCDE1234F").some((h) => h.category === "pan")],
    ["SSN: 123-45-6789", detectInText("SSN: 123-45-6789").some((h) => h.category === "ssn")],
    ["IP: 192.168.1.1", detectInText("Server IP: 192.168.1.1").some((h) => h.category === "ip")],
    ["Name: Rohan Sharma (after label)", detectInText("Name: Rohan Sharma").some((h) => h.category === "name" && h.match === "Rohan Sharma")],
    ["Clean sentence (zero hits)", detectInText("The weather is nice today.").length === 0],
    ["Order ID NOT flagged as phone (context suppress)", !detectInText("Order #9876543210").some((h) => h.category === "phone" && h.confidence > 0.5)],
    ["Overlap: card wins over aadhaar in 16-digit", (() => {
      const hits = detectInText("Card: 4111 1111 1111 1111");
      return hits.filter((h) => h.category === "card").length === 1 && hits.filter((h) => h.category === "aadhaar_like").length === 0;
    })()],
    ["CVV near card keyword", detectInText("CVV: 123").some((h) => h.category === "cvv")],
    ["DOB: 15/03/1990", detectInText("Date of birth: 15/03/1990").some((h) => h.category === "dob")],
    ["IFSC: SBIN0001234", detectInText("IFSC code: SBIN0001234").some((h) => h.category === "ifsc")],
    ["Bank account with context", detectInText("Account number: 12345678901234").some((h) => h.category === "bank_account")],
    ["Driving license: MH-12-2010-1234567", detectInText("DL: MH-12-2010-1234567").some((h) => h.category === "driving_license")],
    ["MAC address: 00:1A:2B:3C:4D:5E", detectInText("MAC: 00:1A:2B:3C:4D:5E").some((h) => h.category === "device_id")],
    ["URL with params", detectInText("Link: https://example.com/api?token=secret123").some((h) => h.category === "url")],
  ];

  let passed = 0;
  for (const [name, ok] of tests) {
    if (ok) {
      passed++;
      console.log(`  PASS: ${name}`);
    } else {
      console.error(`  FAIL: ${name}`);
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
  return passed === tests.length;
}

if (typeof process !== "undefined" && process.argv && process.argv.includes("--test")) {
  runTests();
}
