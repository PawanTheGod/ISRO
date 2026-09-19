# PixelGuard — Known Failure Cases (For Honest Demo)

> The expert reviewer asked: "Show me a redaction failure. If you can't produce one, I will assume your test set isn't hard enough."

We agree. Here are the cases we know we miss, stated before the judges find them.

## Failure 1: PII split across DOM nodes

**Input**: `<p>Contact <span>rohan</span>.<span>sharma</span>@<span>example</span>.<span>com</span></p>`

**What happens**: `getDirectText()` concatenates the text nodes into "rohan.sharma@example.com" — so detection actually catches this. But if the email is split across separate `<p>` tags, each with its own text node, the detection misses it because `detectInText` runs per-candidate, not across candidates.

**Why**: Each candidate is a separate DOM element. Cross-element PII detection would require concatenating text from parent containers, which we don't do.

**Impact**: Low — most real forms use single elements for PII values.

## Failure 2: Name without any label or context

**Input**: `"The meeting was attended by Vikram Rathore and Priya Nair from the Bangalore office."`

**What happens**: The name regex requires a label prefix ("Name:", "Applicant:", "my name is", "contact person:"). Without any of those, the names "Vikram Rathore" and "Priya Nair" are NOT detected.

**Why**: Detecting every capitalized bigram in prose would produce massive false positives ("Bangalore Office", "Monday Morning", etc.). The heuristic trades recall for precision.

**Mitigation**: NER (bert-base-NER) catches PER entities without labels. If NER is enabled, this is caught. If NER is disabled (default), it's missed.

**Impact**: Medium — names in prose without labels are missed by default.

## Failure 3: DOB in fully natural language without any numeric date format

**Input**: `"She was born on the fourteenth of July, nineteen ninety-two."`

**What happens**: The DOB regex expects at least some digits. Fully spelled-out dates with no digits are NOT detected.

**Why**: Regex can't parse every natural language date format. NER's DATE entity catches some, but not fully spelled dates.

**Impact**: Low — most forms use numeric date pickers.

## Failure 4: PII in CSS pseudo-elements

**Input**: `<div class="user-email" data-email="rohan@example.com">Contact</div>` where the email is displayed via `content: attr(data-email)` in CSS.

**What happens**: The email is in a `data-` attribute, not in a text node or input value. We don't read `data-*` attributes. The email is NOT detected.

**Why**: Reading all `data-*` attributes would be a privacy risk itself (we'd be reading values we're supposed to protect). We only read text content and input values.

**Impact**: Very low — this is an unusual pattern.

## Failure 5: SVG text elements

**Input**: `<svg><text x="10" y="20">rohan@example.com</text></svg>`

**What happens**: SVG `<text>` elements are not in our `TEXT_BLOCK_TAGS` set. The email inside SVG is NOT detected.

**Why**: SVG text is rare in forms. Adding it would be trivial but we haven't.

**Impact**: Very low.

## Failure 6: Low-confidence action correctly triggering ask_user

**This is a feature, not a bug — but we should demo it.**

**Scenario**: The VLM returns `{action: "click", target_id: "n3", confidence: 0.4}` for a candidate it's unsure about.

**What happens**: If confidence < 0.6 and auto-run is on, the console shows a confirm dialog: "Low confidence (0.40): [reasoning]. Execute anyway?" The user decides.

**Why**: We gate auto-execute at 0.6 confidence. This is the human-in-the-loop safety mechanism.

**How to demo**: Point the console at a page with ambiguous elements. The VLM will return low confidence, and the console will ask the user instead of blindly executing.
