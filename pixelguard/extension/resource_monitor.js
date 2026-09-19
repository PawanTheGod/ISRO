// resource_monitor.js — PixelGuard Client Resource Utilization Monitor
// Tracks: JS heap usage, model load time/size, per-stage CPU time, backend selection.
// Criterion 4: "Client side resource utilization" — 20% of the rubric.
//
// Usage:
//   import { ResourceMonitor } from "./resource_monitor.js";
//   const monitor = ResourceMonitor.getInstance();
//   monitor.recordModelLoad("blaze_face", 224400, initMs);
//   monitor.recordStage("detect", detect_ms);
//   const report = monitor.getReport();

const MODEL_SIZES = {
  "blaze_face_short_range.tflite": 224400,
  "vision_bundle.mjs": 155000,
  "vision_wasm_internal.wasm": 11750000,
  "vision_wasm_nosimd_internal.wasm": 10950000,
};

class ResourceMonitor {
  constructor() {
    this._modelLoads = [];
    this._stageTimings = {};
    this._backend = "none";
    this._initHeap = null;
    this._peakHeap = 0;
    this._startMs = performance.now();
  }

  static _instance = null;

  static getInstance() {
    if (!ResourceMonitor._instance) {
      ResourceMonitor._instance = new ResourceMonitor();
    }
    return ResourceMonitor._instance;
  }

  // ── Heap memory tracking (Chrome only — performance.memory) ──────────────────

  getHeapSnapshot() {
    if (performance.memory) {
      const m = performance.memory;
      const snapshot = {
        usedJSHeapSize_MB: Math.round(m.usedJSHeapSize / 1024 / 1024 * 10) / 10,
        totalJSHeapSize_MB: Math.round(m.totalJSHeapSize / 1024 / 1024 * 10) / 10,
        jsHeapSizeLimit_MB: Math.round(m.jsHeapSizeLimit / 1024 / 1024 * 10) / 10,
      };
      if (snapshot.usedJSHeapSize_MB > this._peakHeap) {
        this._peakHeap = snapshot.usedJSHeapSize_MB;
      }
      if (this._initHeap === null) {
        this._initHeap = snapshot.usedJSHeapSize_MB;
      }
      return snapshot;
    }
    return { usedJSHeapSize_MB: null, totalJSHeapSize_MB: null, jsHeapSizeLimit_MB: null };
  }

  // ── Model load tracking ──────────────────────────────────────────────────────

  recordModelLoad(name, sizeBytes, loadMs) {
    this._modelLoads.push({
      name,
      size_KB: Math.round(sizeBytes / 1024 * 10) / 10,
      load_ms: Math.round(loadMs),
    });
  }

  // ── Stage timing ─────────────────────────────────────────────────────────────

  recordStage(stage, ms) {
    if (!this._stageTimings[stage]) {
      this._stageTimings[stage] = { count: 0, total_ms: 0, min_ms: Infinity, max_ms: 0, samples: [] };
    }
    const s = this._stageTimings[stage];
    s.count++;
    s.total_ms += ms;
    s.min_ms = Math.min(s.min_ms, ms);
    s.max_ms = Math.max(s.max_ms, ms);
    s.samples.push(ms);
    if (s.samples.length > 50) s.samples = s.samples.slice(-50);
  }

  // ── Backend selection ────────────────────────────────────────────────────────

  setBackend(backend) {
    this._backend = backend;
  }

  // ── Full report ──────────────────────────────────────────────────────────────

  getReport() {
    const heap = this.getHeapSnapshot();
    const uptime_s = Math.round((performance.now() - this._startMs) / 1000 * 10) / 10;

    const stages = {};
    for (const [name, s] of Object.entries(this._stageTimings)) {
      stages[name] = {
        count: s.count,
        avg_ms: Math.round(s.total_ms / s.count * 10) / 10,
        min_ms: s.min_ms,
        max_ms: s.max_ms,
        p50_ms: s.samples.length > 0 ? s.samples.sort((a, b) => a - b)[Math.floor(s.samples.length / 2)] : 0,
      };
    }

    const totalModelSize = this._modelLoads.reduce((sum, m) => sum + m.size_KB, 0);

    return {
      timestamp: new Date().toISOString(),
      uptime_s,
      backend: this._backend,
      memory: {
        ...heap,
        peak_heap_MB: this._peakHeap,
        init_heap_MB: this._initHeap,
        heap_growth_MB: this._initHeap !== null ? Math.round((this._peakHeap - this._initHeap) * 10) / 10 : null,
      },
      models: {
        loaded: this._modelLoads,
        total_size_KB: Math.round(totalModelSize * 10) / 10,
        total_size_MB: Math.round(totalModelSize / 1024 * 100) / 100,
      },
      stages,
      summary: {
        total_stages_measured: Object.keys(stages).length,
        total_model_loads: this._modelLoads.length,
        vision_backend: this._backend,
        heap_used_MB: heap.usedJSHeapSize_MB,
        model_footprint_MB: Math.round(totalModelSize / 1024 * 100) / 100,
      },
    };
  }

  // ── Formatted text report for display ────────────────────────────────────────

  getReportText() {
    const r = this.getReport();
    const lines = [];
    lines.push("═══ PixelGuard Resource Report ═══");
    lines.push(`Backend: ${r.backend}`);
    lines.push(`Uptime: ${r.uptime_s}s`);
    lines.push("");
    lines.push("── Memory (JS Heap) ──");
    lines.push(`  Used:   ${r.memory.usedJSHeapSize_MB} MB`);
    lines.push(`  Peak:   ${r.memory.peak_heap_MB} MB`);
    lines.push(`  Growth: ${r.memory.heap_growth_MB} MB`);
    lines.push(`  Limit:  ${r.memory.jsHeapSizeLimit_MB} MB`);
    lines.push("");
    lines.push("── Models ──");
    for (const m of r.models.loaded) {
      lines.push(`  ${m.name}: ${m.size_KB} KB (load: ${m.load_ms}ms)`);
    }
    lines.push(`  Total model size: ${r.models.total_size_MB} MB`);
    lines.push("");
    lines.push("── Stage Timings ──");
    for (const [name, s] of Object.entries(r.stages)) {
      lines.push(`  ${name}: avg=${s.avg_ms}ms p50=${s.p50_ms}ms (n=${s.count})`);
    }
    lines.push("");
    lines.push("── Summary ──");
    lines.push(`  Model footprint: ${r.summary.model_footprint_MB} MB`);
    lines.push(`  Heap used: ${r.summary.heap_used_MB} MB`);
    lines.push(`  Vision backend: ${r.summary.vision_backend}`);
    return lines.join("\n");
  }
}

export { ResourceMonitor, MODEL_SIZES };
