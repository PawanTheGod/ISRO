# PixelGuard — SIH 26171

**Privacy-First Visual Perception for Browser Agents**
Smart India Hackathon 2026 · College Internal Round · Team of 6
Problem Statement 26171 — *On-Device Visual Perception for Lightweight Browser Agents* — ISRO, Department of Space, Software / Smart Automation

> **"Everyone else ships the screen to the cloud. We don't."**

This README is the **front door** to the project. Read this first — top to bottom — before opening anything else. It tells you what we're building, why, who owns what, and exactly which prompt to paste into your coding agent to start. The full engineering detail (contracts, API schemas, hour-by-hour clock, failure playbooks, Q&A prep) lives in **`docs/PixelGuard_Blueprint.docx`** — this file always points you to the right section instead of repeating it.

---

## 1. What we are building (read this even if you read nothing else)

> A Chrome (Manifest V3) extension that captures the active browser tab, **locally detects and redacts sensitive fields, text, and faces on-device**, sends only a **redacted screenshot plus an anonymized candidate-element list** to a local FastAPI + open-weight VLM server that **selects** the next UI action (never generates pixel coordinates), which the extension then executes on the real page — with **live DevTools proof** that no raw sensitive data ever left the browser, backed by **measured** precision/recall, redaction-IoU, and latency numbers.

**Why this problem statement rewards this design:** the judging rubric weighs visual-context accuracy (25%), PII detection recall/precision (20%), redaction precision (20%), client resource use (20%), and end-to-end latency (15%). Accuracy + PII quality alone are 45% of the score — so the local perception → detection → redaction pipeline gets the most engineering hours, not UI polish. Full rubric mapping: **Blueprint Part A1**.

**The one non-negotiable idea, the thing that must survive any scope cut:** detection and redaction happen **on-device, before the network boundary**, and the server only ever *selects* an action by candidate ID — it never sees or returns raw pixels/coordinates. Everything else is negotiable under time pressure; this is not.

### The demo, in one paragraph
A synthetic "Seva Portal" form is open with a fake name, email, phone, Aadhaar-format number, card number, password field, and a photo with a face. The presenter types a goal into the PixelGuard Console and clicks Run. The Console shows the original capture next to the **redacted** version — card/Aadhaar/email/phone blacked out with labels, face pixelated, password boxed. DevTools is opened live on the one outbound network request to prove only sanitized data left the machine. The local VLM responds with a candidate-ID action (e.g. "type `[NAME]` into `n3`"), the extension resolves it locally and types the real value from a local profile store, and the cycle repeats until the form submits. Then: measured metrics, honest limits, roadmap. Full script: **Blueprint Part B2**.

---

## 2. Architecture at a glance

```
[Browser Tab]
     │  capture (screenshot + DOM walk)
     ▼
[content.js] → candidate list + id→node map
     │
     ▼
[detection.js]  ── deterministic PII detection (DOM attrs, regex, Luhn, Aadhaar-format)
     │
     ▼
[vision.js]     ── on-device face detection (MediaPipe, <1MB model)
     │
     ▼
[redaction.js]  ── canvas redaction: black boxes + labels, face pixelation
     │
     ▼
[payload.js]    ── builds sanitized payload {redacted image, tokenized candidates}
     │
     ═══════════════ HTTPS/localhost boundary — only sanitized data crosses ═══════════════
     │
     ▼
[server/main.py] → [vlm_client.py] → local open-weight VLM (Ollama)
     │
     ▼
  {action, target_id, value, confidence, reasoning}   ← SELECTS by ID, never coordinates
     │
     ▼
[content.js executeAction()] → resolves target_id → real click/type on the page
     │
     ▼
[console.js] loops, times every stage, logs metrics
```

Full repo tree and file ownership: **Blueprint Part C1**. Frozen API contracts (payload shape, action schema): **Blueprint Part C2** — treat these as law; if generated code disagrees with a contract, the contract wins.

---

## 3. Team, missions, and where your prompt lives

Six roles, six people, one shared clock. Read your row, then go straight to your linked section — each one is self-contained with a task table, files you own, acceptance criteria, and a ready-to-paste prompt for your coding agent (Claude Code / Cursor).

| Member | Role | Mission (by H23 unless noted) | Owns (files) | Your section |
|---|---|---|---|---|
| **Pushp** | Integration, Demo & Presentation Lead — owns `main`, contracts, the clock | Repo scaffold exists first; demo page + assets are real and lockstepped with Aditya's data; runs the Command Center at every gate; owns final freeze, video, and slides | scaffold, `demo/demo_form.html`, `console.html/css` (with Vinit), CONTRACTS.md | Mission: Blueprint Part D0 · Task table: Part D (Pushp block) · Prompt: **D11 "PROMPT — PUSHP"** · Full playbook: **D12.6** |
| **Vinit** | Extension & Frontend Lead | A judge can click Run in the Console and watch a real click/typed value land on the demo page, end-to-end | `manifest.json`, `background.js`, `content.js`, `console.js` (orchestration half), `profile.js` | Mission + task table: Part D (Vinit block) · Prompt: **D11 "PROMPT — VINIT"** · Full playbook: **D12.1** |
| **Aditya** | Data & Evaluation Lead | Synthetic PII dataset, sample payloads, and every measured metric (precision/recall, IoU, latency) exist as files in `eval/results/` before any number goes on a slide | `data/generate_pii_samples.py`, `eval/*` | Mission + task table: Part D (Aditya block) · Prompt: **D11 "PROMPT — ADITYA"** · Full playbook: **D12.2** |
| **Vedika** | PII Detection & Redaction Engineer | Deterministic-first detection (DOM attrs → regex → Luhn/Aadhaar-format) and precise canvas redaction, measured by IoU | `detection.js`, `redaction.js`, `payload.js` | Mission + task table: Part D (Vedika block) · Prompt: **D11 "PROMPT — VEDIKA"** · Full playbook: **D12.3** |
| **Atman** | On-Device ML Engineer | Local face detection running under a strict size/latency budget (+ CLIP verifier as stretch) | `vision.js`, `extension/models/`, `extension/vendor/` | Mission + task table: Part D (Atman block) · Prompt: **D11 "PROMPT — ATMAN"** · Full playbook: **D12.4** |
| **Pawan** | Backend & VLM Engineer | FastAPI server that is redaction-aware, calls the local VLM, and returns a valid `{action, target_id, value, confidence, reasoning}` — selection only, never coordinates | `server/main.py`, `server/vlm_client.py`, `server/schema.py` | Mission + task table: Part D (Pawan block) · Prompt: **D11 "PROMPT — PAWAN"** · Full playbook: **D12.5** |

**Dependency order (who blocks whom):** Pushp's scaffold and demo page unblock everyone → Vinit's capture/candidates feed Vedika's detection → Vedika's detection feeds redaction feeds payload → Atman's face detection feeds into redaction alongside Vedika's → Aditya's synthetic dataset feeds Vedika's tuning and Pawan's testing → Pawan's server response feeds Vinit's executor → the full loop feeds Aditya's latency logging → everything feeds Pushp's integration, video, and slides. Diagram: **Blueprint Part D0**.

### How to actually start
1. Everyone together, Hour 0–1 (30 min): read Blueprint **Part B** (what we're building), **Part C5** (end-to-end workflow), **Part E3** (gates), **Part I5** (what not to waste time on).
2. Alone (20 min): read your own block in **Part D**, plus every contract in **Part C** your files touch.
3. Before you write a line of code: paste the **Common Prompt Header** below into your agent session, then **your own prompt from Section 3a below**, then follow your **Step-by-Step Execution Playbook (D12.x in the Blueprint)** — ordered as "YOUR FIRST 60 MINUTES" onward.
4. When something breaks: paste the header again, then the **Debug Prompt** below, filled in. Max 2 retry attempts (~20 min) before escalating to the named teammate, then Pushp. If still blocked past the step's due hour, apply the cut ladder in Blueprint **E4** — don't invent a new fallback.
5. Before any public claim on a slide: check **Part G4** (allowed privacy language) and **Part F2** (what each metric actually means). No number in the deck without a matching file in `eval/results/`.

---

## 3a. The actual prompts — paste these into your coding agent

**Paste order, every time:** Common Header → your role prompt (only once, at the start of your step) → the Step-by-Step Playbook for your name in Blueprint Part D12. If a step fails twice, paste the Header again, then the Debug Prompt filled in.

These prompts are mutually compatible and already contain the frozen contracts. **If generated code ever conflicts with a contract in Blueprint Part C, the contract wins — fix the code, not the contract.**

### Common Prompt Header — paste this above every prompt below, every time

```
=== PIXELGUARD COMMON HEADER ===
You are implementing ONLY this step of the PixelGuard MVP (SIH 26171). Nothing else.
Repo: pixelguard/ -> extension/ (Chrome MV3, vanilla ES modules), server/ (FastAPI),
demo/ (synthetic Seva Portal page), data/ + eval/ (test data and harnesses).
Contracts are FROZEN in docs/CONTRACTS.md: Candidate C2.1, DetectionHit C2.2,
RedactionRegion C2.3, timing row C2.4, SanitizedPayload C2.5, ActionResponse C2.6,
messages C2.7 (PG_CAPTURE / PG_GET_CANDIDATES / PG_EXECUTE).

Hard architecture rules:
- The VLM SELECTS a target_id from an enumerated candidate list. Never pixel coordinates.
- Input element .value is NEVER read into any serialized object (nonEmpty boolean only).
- Raw text/pixels never cross the network; only payload.js builds the network object.
- Allowed deps ONLY: fastapi uvicorn pydantic requests faker (Python);
  vendored @mediapipe/tasks-vision + vendored transformers.min.js (JS). Nothing new.

You must NOT: redesign architecture, modify files you were not given, change any
contract, add dependencies or features, rewrite working code, or touch other modules.

Finish with a report: files changed, functions added, how you tested, contract
deviations (must be: none).
=== END HEADER ===
```

### PROMPT — PUSHP (scaffold + demo page)

```
You are building the scaffold for 'PixelGuard', a Manifest V3 Chrome extension + FastAPI
server, repo tree exactly as follows: extension/{manifest.json, background.js, content.js,
console.html, console.css, console.js, detection.js, redaction.js, vision.js, payload.js,
profile.js}, server/{main.py, schema.py, vlm_client.py, requirements.txt}, demo/, data/,
eval/results/, docs/. TASKS: (1) manifest.json: MV3; permissions tabs, scripting, storage,
activeTab; host_permissions http://localhost:8080/*, http://localhost:8000/*,
http://127.0.0.1/*; content script matched to http://localhost:8080/*; action opens
console.html in a NEW TAB via background.js; content_security_policy.extension_pages =
"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'". (2) console.html: two-column
layout (Original | Sanitized), a goal input, Run button, candidates table, payload <pre>,
timings strip, status banner area. (3) Each module file exports stub functions with the
exact signatures from our CONTRACTS (detectAll, redact, buildSanitizedPayload,
detectFaces, executeAction) returning typed dummies. (4) server/main.py: FastAPI with
GET /health -> {status:'ok'} and POST /select-action returning hardcoded {action:'click',
target_id:'n1', value:null, confidence:0.9, reasoning:'stub'}; CORS allow all. (5)
demo/demo_form.html: page titled 'Seva Portal — TRAINING SANDBOX (ALL DATA SYNTHETIC)'
with: a records paragraph containing EXACTLY these strings — Rohan Sharma,
rohan.sharma@example.com, +91 98765 43210, 2345 6789 0123, 4111 1111 1111 1111,
SBIN0001234 — an <img src='assets/person.jpg'> with caption 'synthetic image', and a form:
Full name(text), Email(type=email), Mobile(type=tel), Aadhaar number(text), Card number
(autocomplete='cc-number'), Create password(type=password), Remarks(textarea), Submit
button showing a success banner 'Application ARN-2026-DEMO submitted' on click (prevent
default). Wrap every sensitive value/field in data-pg-sensitive='<category>' using
categories name,email,phone,aadhaar_like,card,password,face and add
window.__pgGroundTruth() returning [{category, bbox:[x,y,w,h]}] from those attributes
via getBoundingClientRect. (6) README quickstart: load unpacked, python -m http.server
8080 in demo/, uvicorn server.main:app --port 8000. Tell me exact commands to verify
all three run. Plain JS only, no build step, no external CDNs.
```

### PROMPT — VINIT (capture, candidates, executor, cycle)

```
Work ONLY in extension/{background.js, content.js, console.js, profile.js} of PixelGuard.
Contracts are law: Candidate {id:'n'+k, tag, role, inputType, label, text, bbox:[x,y,w,h]
CSS px, editable, nonEmpty}; messages PG_CAPTURE (console->background ->
{screenshotDataUrl} via chrome.tabs.captureVisibleTab of the demo tab), PG_GET_CANDIDATES
(console->content -> {candidates, viewport:{w,h,dpr}, url, title}), PG_EXECUTE
(console->content -> {ok, executed_ms, error?}). RULES: never read input .value into any
string (nonEmpty = el.value.length>0 boolean only); text only for NON-inputs, trimmed
<=300 chars; visible+in-viewport elements; interactive tags always included; text-bearing
blocks included; cap 60 candidates by area desc; keep module-level nodeMap id->element,
rebuilt each PG_GET_CANDIDATES. IMPLEMENT: (1) background.js: on action click open
console.html tab remembering the source tabId; handle PG_CAPTURE with
chrome.tabs.captureVisibleTab({format:'png'}). (2) content.js captureScreenState() per
above + executeAction(action): resolve nodeMap[action.target_id]; if missing return
{ok:false,error:'STALE_ID'}; scrollIntoView; click => dispatch real
MouseEvent('click',{bubbles:true,cancelable:true,view:window}); type => focus, if
action.value matches ^\[[A-Z_]+\]$ ask console-provided substitution map first, set
.value, dispatch InputEvent('input',{bubbles:true}) then Event('change',{bubbles:true}).
(3) profile.js: get/set token map in chrome.storage.local, defaults {'[NAME]':'Asha
Verma','[EMAIL]':'asha.verma@example.org','[PHONE]':'+91 90000 11111','[AADHAAR]':'2345
1234 5123','[CARD]':'4012 8888 8888 1881','[PASSWORD]':'Demo@12345'}. (4) console.js
runCycle(): t0; PG_CAPTURE; PG_GET_CANDIDATES; await vision.detectFaces(bitmap); await
detection.detectAll(candidates); redaction.redact(dataUrl, regions, dpr); payload =
buildSanitizedPayload(...); render panels; POST http://localhost:8000/select-action;
if confidence<0.6 or action==='ask_user' -> confirm(reasoning); PG_EXECUTE; push timing
row {capture_ms, vision_ms, detect_ms, redact_ms, payload_kb, server_ms, execute_ms,
total_ms}; 'Export CSV' and 'Save last payload' buttons download files. Auto-run checkbox
loops runCycle up to 6 steps, stopping on done/ask_user/error. Acceptance: on the demo
page a hardcoded action {action:'type',target_id:<full-name id>,value:'[NAME]'} visibly
types 'Asha Verma'; 10 consecutive Run cycles need no reload.
```

### PROMPT — VEDIKA (detection, redaction, payload)

```
Work ONLY in extension/{detection.js, redaction.js, payload.js}. detection.js must be
PURE ESM (no chrome.*, no DOM assumptions in exported core fns) so eval_pii.mjs can
import it from Node. EXPORTS: luhnCheck(digitsString)->bool implemented from scratch;
detectInText(text)->[{category,match,index,confidence,source}] for categories email
(regex, 0.90), phone (Indian mobile: optional +91/0 then [6-9]\d{9}, word-bounded, 0.85),
card (13-19 digits allowing spaces/dashes; strip; MUST pass Luhn else NOT flagged; 0.95),
aadhaar_like (12 digits first [2-9], optional 4-4-4 grouping; 0.80; 0.95 if
contextLabel mentions aadhaar/uid), name (heuristic: capitalized bigram after
Name/Applicant label; 0.60; source 'heuristic'); classifyCandidate(c) using attribute
rules: inputType password->password 1.0; email/tel types or autocomplete email/tel;
autocomplete cc-number->card 1.0; label contains aadhaar->aadhaar_like 0.95;
detectAll(candidates)->{hits,stats} where text hits carry the candidate's bbox for now.
INCLUDE >=8 inline unit tests runnable via 'node extension/detection.js --test': valid
cards 4111111111111111 and 4012888888881881 flagged; 4111111111111112 and
1234567812345678 NOT flagged; one email, one phone, one aadhaar_like (2345 6789 0123),
one clean sentence with zero hits. Then in a browser-only helper (may live in
detection.js behind a typeof-document guard) refineTextHitRects(candidateEl, hit) using
a Range over the match -> getClientRects() -> tight bboxes. redaction.js: async
redact(originalDataUrl, regions:[{bbox CSS px, category, style:'block'|'pixelate'}], dpr)
-> draw image on OFFSCREEN canvas; for 'block' fillRect black scaled by dpr then white
10px '[CATEGORY]' label; for 'pixelate' draw the region to a 1/16-size temp canvas and
back with imageSmoothingEnabled=false; return {redactedDataUrl, applied, counts};
NEVER mutate the source image; caller nulls the original. payload.js:
buildSanitizedPayload({goal, sessionId, step, candidates, hits, redactedDataUrl,
viewport, history, clientMeta, useImage}) -> per CONTRACTS C2.5: masked_text = text with
each hit.match replaced by its [TOKEN] (map name->[NAME], email->[EMAIL], phone->[PHONE],
card->[CARD], aadhaar_like->[AADHAAR], password->[PASSWORD]); inputs masked_text '';
strip name/id/class/href/src; truncate 120 chars; cap 60 candidates; FINAL ASSERT:
JSON.stringify(payload) contains NO hit.match substring — on violation throw
PayloadPrivacyError (console shows red BLOCKED banner instead of sending).
```

### PROMPT — ATMAN (faces MUST, CLIP+benchmark SHOULD)

```
Work ONLY in extension/vision.js + extension/vendor/ + extension/models/. Everything
loads from LOCAL vendored files (no CDN at runtime; CSP already allows
'wasm-unsafe-eval'). PART 1 (MUST): using the vendored @mediapipe/tasks-vision bundle
and models/blaze_face_short_range.tflite, implement initFaces() (FilesetResolver ->
FaceDetector.createFromModelPath, runningMode IMAGE) and detectFaces(imageBitmap) ->
[{bbox:[x,y,w,h] in the bitmap's DEVICE pixels, score}] filtered score>=0.5, plus a
deviceToCss(bbox,dpr) helper. Provide a self-test callable from console.js that runs on
demo/assets/person.jpg and draws the box on a debug canvas. Record init_ms and
per-image vision_ms. PART 2 (SHOULD, hard time-box — if not green in 6 focused hours,
delete cleanly and report): vendor transformers.min.js + the Xenova/clip-vit-base-patch32
model files under models/clip; configure env.allowRemoteModels=false and
env.localModelPath=chrome.runtime.getURL('models/'); initVisionModel(): build the
zero-shot-image-classification pipeline twice — device 'webgpu' then 'wasm' — running 3
warmup inferences each on a tiny canvas, record ms arrays, pick the faster backend for
the session, and expose getBackendReport() -> {webgpu_ms:[..]|null, wasm_ms:[..],
chosen}; classifyCandidateType(screenshotBitmap, bboxCssPx, dpr) -> crop via canvas ->
classify against labels ['a button','a text input field','a block of text','a photo of
a person','an image','a checkbox','a link'] -> {visualType, confidence}. Wire an
OPTIONAL enrichment: for the 10 largest candidates set candidate.visualType. Acceptance:
(a) face box correct on person.jpg and on a full demo-page screenshot; (b) backend
report logged with real numbers for both backends (wasm mandatory; webgpu null if
unsupported — never fake it); (c) removing PART 2 leaves PART 1 untouched.
```

### PROMPT — PAWAN (server, VLM, fallbacks)

```
Work ONLY in server/{main.py, schema.py, vlm_client.py, requirements.txt}. Python 3.10,
FastAPI + Pydantic v2 + requests. schema.py: models mirroring EXACTLY — request:
session_id str, step int, user_goal str, screenshot str, use_image bool=True, viewport
{w:int,h:int,dpr:float}, candidates list[{id,tag,role,inputType|None,label,masked_text,
bbox[list[float,4]],editable bool}] (forbid extra fields), history list, client_meta
dict; response: action Literal['click','type','scroll','wait','done','ask_user'],
target_id str|None, value str|None, confidence float ge 0 le 1, reasoning str,
server_meta dict; error envelope {error:{code,message,retry_attempted}}. main.py: CORS
allow-all (demo); GET /health -> {status, provider, model, ollama_reachable} (probe
http://localhost:11434/api/tags with 1s timeout); POST /warmup -> tiny generate call,
return vlm_ms; POST /select-action -> validate (422 SCHEMA_INVALID) -> vlm_client.plan()
-> validate response semantics: action in enum; if action in {click,type} target_id MUST
be in the request's candidate ids else violation; confidence bounds. vlm_client.py:
PG_PROVIDER env in {ollama,hosted,stub} (default ollama), PG_MODEL default 'llava'.
ollama path: build prompt = SYSTEM (verbatim from CONTRACTS C3.1 with {{ID_LIST}}
substituted) + 'USER GOAL: ...' + candidate digest lines "n3: input(text) 'Full name'
at [412,262,280,36] text='[EMAIL]-style masked text'" + history; POST
http://localhost:11434/api/generate with format='json', stream=False,
options={'temperature':0}, images=[base64-sans-prefix] ONLY if use_image; timeouts 120s
first call then 60s. Parse JSON; on any semantic violation retry ONCE appending
'Your previous output was invalid because: <reason>. Choose target_id strictly from:
<ids>.'; second failure -> HTTP 502 VLM_INVALID_OUTPUT. stub path: deterministic — first
editable empty text-like candidate -> type '[NAME]'/'[EMAIL]'/'[PHONE]' by label match,
else the Submit-labeled button -> click, else done; reasoning MUST start 'STUB PLANNER:'.
NO logging of screenshot or masked_text bodies — log sizes/counts/ms only; add a
comment-marked LOGGING POLICY block. Give me: uvicorn run command, curl for /health,
and curl -d @eval/sample_payload.json for /select-action, plus a forced-invalid test
(monkeypatch model output 'n99') proving exactly one retry then 502.
```

### PROMPT — ADITYA (data + eval harness)

```
Work ONLY in data/ and eval/. (1) data/generate_pii_samples.py: argparse --per-category
(default 200) --seed 26171; Faker('en_IN'); emit data/pii_test_set.json rows
{text, category|null}: email (fake.email embedded in sentences), phone (Indian mobile in
+91 XXXXX XXXXX and 10-digit forms), card (fake.credit_card_number spaced 4-4-4-4 —
verify Luhn-valid with a local luhn() and regenerate if not), aadhaar_like (first digit
random 2-9 + 11 digits, 4-4-4 spaced, sentence mentions Aadhaar for half the samples),
name ('Name: '+fake.name()); negatives (category null): Luhn-FAILING 16-digit strings,
12-digit starting 0/1, 10-digit order ids prefixed 'Order #', 6-digit pincodes near
words, plain sentences. Deterministic under --seed. (2) eval/eval_pii.mjs: import
../extension/detection.js; for each row run detectInText; TP if any hit.category ==
row.category; FP per hit on null rows or wrong category; FN if labeled row got no
matching hit; print an aligned table precision/recall/F1 + support per category and
micro avg; write eval/results/pii_metrics.json; exit nonzero if card or email precision
< 0.99 (tripwire for Vedika). (3) eval/latency_stats.py: read
eval/results/latency_runs.csv (header per CONTRACTS C2.4); print p50/p95 per stage and
total, n runs; write latency_summary.json. (4) eval/iou.py: args gt.json applied.json;
match per category by max IoU; report mean IoU, %>=0.7, misses; write
redaction_iou.json. (5) eval/check_payload.py: args payload.json raw_values.txt; fail
loudly listing any raw string found anywhere in the JSON (also base64-decode nothing —
string scan only — but ALSO warn if payload.screenshot is missing the 'data:image'
prefix). (6) eval/sample_payload.json: handcraft one valid SanitizedPayload matching
CONTRACTS C2.5 for Pawan's curl test (synthetic values only, tokens in masked_text).
All scripts runnable from repo root; no network.
```

### Debug Prompt — paste header first, then this, when a step fails twice

```
Step <STEP-ID> is failing. Find the SMALLEST fix. Do not rewrite the module.
SYMPTOM: <paste the exact error text / wrong output>
EXPECTED (per contract <C2.x / C3.x>): <paste what should happen>
WHAT I RAN: <exact commands>
FILES INVOLVED: <paths>
Work step by step: (1) restate what the code must do, (2) list the 3 most likely causes
ranked, (3) give the minimal diff for the top cause only, (4) give the exact command to
re-verify. Keep every contract and every file I did not list untouched.
```

### Shared commit pre-flight (check before every commit, any role)
- [ ] The step's VERIFY check passes right now (not from memory).
- [ ] `git status` shows ONLY files this step is allowed to change.
- [ ] No contract field was added/renamed/removed (`git diff docs/CONTRACTS.md` is empty).
- [ ] Extension reloads / server restarts cleanly after the change.
- [ ] The handoff artifact named in the step exists at its exact path.

**Escalation ladder:** retry with the Debug Prompt (max 2 attempts, ~20 min) → named teammate for that step → Pushp → if the step is on the critical path and blocked past its due hour, apply the cut ladder in Blueprint Part E4. Do not invent new fallbacks.

---

## 4. Repository layout (exact — do not deviate)

```
pixelguard/
├── extension/
│   ├── manifest.json          # MV3, permissions, CSP, host perms
│   ├── background.js          # opens Console; captureVisibleTab
│   ├── content.js             # DOM walk → candidates + id→node map; executeAction()
│   ├── console.html/css/js    # orchestrator UI: run cycle, panels, timings
│   ├── detection.js           # pure isomorphic PII detectors
│   ├── redaction.js           # canvas redact(dataUrl, regions, dpr)
│   ├── vision.js              # on-device face detection (+ CLIP verify, stretch)
│   ├── payload.js             # buildSanitizedPayload(); token masking
│   ├── profile.js             # local [TOKEN]→value store
│   ├── vendor/                # vendored tasks-vision + transformers (offline-safe)
│   └── models/                # blaze_face_short_range.tflite, CLIP (stretch)
├── server/
│   ├── main.py                # FastAPI: /health /warmup /select-action; no-persist
│   ├── vlm_client.py          # Ollama call, retry-once, provider switch
│   ├── schema.py              # Pydantic models mirroring Part C2
│   └── requirements.txt
├── demo/
│   ├── demo_form.html         # "Seva Portal" synthetic page with GT attributes
│   └── assets/person.jpg      # synthetic, AI-generated face — no real people
├── data/
│   ├── generate_pii_samples.py
│   ├── pii_test_set.json
│   └── raw_values.txt
├── eval/
│   ├── eval_pii.mjs           # precision/recall/F1 per category
│   ├── latency_stats.py       # p50/p95 per stage + total
│   ├── iou.py                 # redaction IoU
│   ├── check_payload.py       # asserts no raw PII string ever appears in a saved payload
│   └── results/               # committed evidence: json, csv, charts
└── docs/
    ├── PixelGuard_Blueprint.docx   # the full 48-hour execution blueprint (this repo's source of truth)
    └── CONTRACTS.md                # Part C, pasted, with an amendment log
```
Full contract for every file's exported function signatures: **Blueprint Part C1–C2**.

---

## 5. Setup — do this before anything else

**Install now (H0–H2):**
```bash
# Python side (server + eval)
python -m venv venv && source venv/bin/activate
pip install fastapi uvicorn pydantic requests faker

# Node side (extension tooling)
node -v   # must be >= 18

# Vision model
npm i @mediapipe/tasks-vision
# copy dist/ → extension/vendor/tasks-vision/
# download blaze_face_short_range.tflite from the official MediaPipe model page → extension/models/
```
- Chrome, current stable, developer mode on at `chrome://extensions`.
- Local VLM served via Ollama (`ollama run llava` or equivalent open-weight model) — server-side only, no cloud API for this step.
- One test `git push` per person before H2 to confirm repo access.

**Verify as each piece lands:**
```bash
curl localhost:8000/health          # → 200 {"status":"ok"}
node extension/detection.js --test  # → green
# Extension loads and Console opens with Wi-Fi off (proves no cloud dependency for local steps)
```

Full resource table (what to obtain, where from, who by when): **Blueprint Part D7**.

---

## 6. What "done" looks like

By the end of the build window, a judge can:
1. Watch the extension capture a real page and show, side by side, the original and the **redacted** version — face pixelated, card/Aadhaar/email/phone blacked out with category labels, password field boxed.
2. Open DevTools on the single outbound request and read the actual bytes — a redacted image and tokenized candidates, no raw PII anywhere.
3. Watch the local VLM select an action by candidate ID, and watch the extension execute it for real on the page, repeating until the form submits.
4. See a metrics panel with **measured** per-category precision/recall, redaction IoU, and p50/p95 latency — every number traceable to a file in `eval/results/`.
5. Hear the honest-limits slide before Q&A, naming what's out of scope for this round (fine-tuning, arbitrary-site generalization, Firefox/mobile, OCR-based text redaction) as clearly labeled roadmap items, not gaps we hope nobody notices.

Full Definition of Done checklist and Command Center script: **Blueprint Part I**. Failure matrix and fallback ladder: **Blueprint Part G**. Presentation structure and anticipated Q&A: **Blueprint Part H**.

**Top things not to spend time on this round** (each has a one-line reason in Blueprint Part I5): training/fine-tuning any model, downloading public datasets (RICO/Mind2Web/WIDER — synthetic data only), making the VLM emit pixel coordinates, Firefox/Safari/mobile support, UI theming beyond legibility, auth/TLS/Redis/WebSockets for the demo, chasing 100% NER accuracy, generalizing to arbitrary real websites, any new dependency after the H34 freeze, and arguing about cuts at 3 a.m. instead of executing the pre-agreed ladder.

---

## 7. Document map

| You need... | Go to |
|---|---|
| The one-page problem + rubric | Blueprint Part A1 |
| What we're building, in detail | Blueprint Part B |
| Repo structure & frozen API contracts | Blueprint Part C |
| Your mission, task table, and prompt | Blueprint Part D (find your name) + D11 |
| Your hour-by-hour execution playbook | Blueprint Part D12.1–D12.6 (one per person) |
| The 48-hour clock and gates | Blueprint Part E |
| How we test and what counts as evidence | Blueprint Part F |
| What broke, and what we're allowed to fall back to | Blueprint Part G |
| Slides, demo script, Q&A prep | Blueprint Part H |
| Definitions of done, checklists, command center | Blueprint Part I |

**Golden rule:** if this README and the Blueprint ever disagree on a contract or a number, the Blueprint's Part C wins — fix the README, not the code.
