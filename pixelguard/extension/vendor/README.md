# Vendor Setup — PixelGuard

## PART 1 (MUST): MediaPipe Face Detection

```bash
npm i @mediapipe/tasks-vision
# Copy the dist files to this directory:
cp node_modules/@mediapipe/tasks-vision/lib/vision_bundle.mjs vendor/tasks-vision/
cp -R node_modules/@mediapipe/tasks-vision/wasm vendor/tasks-vision/
# Download the face detection model:
curl -o models/blaze_face_short_range.tflite \
  https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite
```

If the vendor files are not present, `vision.js` gracefully falls back to
returning empty face detections (non-fatal). The pipeline still works —
just without face redaction.

## PART 2 (SHOULD, stretch): CLIP zero-shot classifier

```bash
npm i @xenova/transformers
cp node_modules/@xenova/transformers/dist/transformers.min.js vendor/transformers/
# Download CLIP model files:
# Place under models/clip/
```

Part 2 is time-boxed. If not vendored, `initVisionModel()` returns null
and `classifyCandidateType()` returns `{visualType: null, confidence: 0}`.
