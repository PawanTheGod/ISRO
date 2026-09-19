# PixelGuard — Live Demo Script (SIH Finale)

## The "Wow" Moment: DevTools Network Proof

This is the moment that wins the demo. The judges need to SEE that no raw PII leaves the browser.

---

### Setup (T-5 minutes before demo)

1. Open Chrome with the demo page: `http://localhost:8080/demo_form.html`
2. Open DevTools (F12) → **Network** tab
3. In the filter box, type `select-action`
4. Clear the network log (the 🚫 button)
5. Click the PixelGuard toolbar icon to open the console overlay
6. Verify the server is running: `curl localhost:8000/health` should return `{"status":"ok"}`

### Demo Flow (3 minutes)

**Step 1: Show the demo page (15 seconds)**
> "This is a synthetic Seva Portal form — all data is fake. It has a name, email, phone, Aadhaar number, card number, password, and a photo with a face. This is the kind of page a government portal or banking form would show."

**Step 2: Show the console overlay (15 seconds)**
> "This is the PixelGuard console. I type my goal — 'Fill the application form with my profile and submit' — and click Run."

**Step 3: Watch the pipeline (30 seconds)**
- The console shows: "Step 1 — capturing..." → "scanning DOM..." → "face detection..." → "PII detection..." → "redacting..." → "compressing screenshot..." → "asking server..."
- Point to the **Original** panel: "This is the raw screenshot."
- Point to the **Sanitized** panel: "This is what actually gets sent. The card number is blacked out with [CARD], the face is pixelated, the email is masked."

**Step 4: THE MOMENT — DevTools proof (60 seconds)**
> "Now watch this. Let me show you what actually left the browser."

- Click the `select-action` request in the Network tab
- Click the **Payload** tab
- Point to each field:
  - `"screenshot"`: starts with `data:image/jpeg;base64,` — this is the REDACTED image
  - `"candidates"`: each has `masked_text` with `[NAME]`, `[EMAIL]`, `[PHONE]`, `[CARD]`, `[AADHAAR]` tokens
  - No `name`, no `id`, no `class`, no `href`, no `src` attributes anywhere
  - No raw values — only tokens
- Click the **Response** tab:
  - `{action: "type", target_id: "n6", value: "[NAME]"}`
  - "The server returned a TOKEN, not a real name. It said 'type [NAME] into n6'. The extension substitutes the real value locally."
- Go to **Application** → **Local Storage** → `pg_profile`:
  - Show the real values: `[NAME]: "Asha Verma"`, `[EMAIL]: "asha.verma@example.org"`
  - "These never left the browser. The server never saw them."

**Step 5: The key statement (15 seconds)**
> "Every other agent pipeline sends the raw screenshot to the cloud. We send this: a redacted image where faces are pixelated, card numbers are blacked out, and every PII value is replaced with a token. The server never sees a name, never sees a card number, never sees a face. It returns a token, and the extension substitutes the real value locally. The real data never crossed the network boundary."

**Step 6: Show the metrics (30 seconds)**
- Click "Export CSV" in the console
- Run: `python eval/eval_runner.py`
- Show the scorecard: all 5 criteria passing
- Point to: "PII detection: 1.0000 F1 across 17 categories. Redaction IoU: 1.0. Model footprint: 11.58 MB. All on-device."

### Anticipated Questions

**"How do you handle PII that's inside images?"**
> "We run Tesseract.js OCR on-device on any `<img>` or `<canvas>` element. The OCR text goes through the same detection pipeline, and any PII found is redacted on the canvas before the screenshot is sent."

**"What if the VLM returns a wrong action?"**
> "The client gates auto-execute at confidence >= 0.6. Below that, it asks the user. The server has a circuit breaker — 5 consecutive failures and it opens, falling back to a deterministic stub planner that fills form fields in order. The user always has the final say."

**"Does this work on Firefox?"**
> "Yes. We have a Firefox manifest and a browser polyfill. The core detection and redaction is pure ES modules with no Chrome-specific APIs."

**"How accurate is the PII detection?"**
> "1.0000 F1 across 17 categories on 2000+ synthetic samples. We use deterministic detection first — DOM attributes, regex, Luhn checksum — which gives us perfect precision on structured PII. NER augmentation catches unstructured PII like names in prose."

**"What's the latency breakdown?"**
> "Capture: 40ms. Face detection: 130ms. PII detection: 6ms. Redaction: 27ms. The VLM call dominates at 8-9 seconds, which is why we compress the screenshot to JPEG 80% and downscale to 640px before sending — that cuts the VLM time by 30-50%."
