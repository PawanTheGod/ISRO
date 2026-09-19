from __future__ import annotations

import time
import threading
import logging
import json
import sys
from collections import defaultdict
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.middleware.base import BaseHTTPMiddleware

from schema import ActionResponse, SanitizedPayload, VALID_ACTIONS
from vlm_client import (
    VLMInvalidOutput,
    VLMUnavailable,
    VLMTimeout,
    check_ollama_reachable,
    get_circuit_breaker_state,
    plan,
    warmup,
    PG_PROVIDER,
    PG_MODEL,
    vlm_circuit_breaker,
)


# ═══════════════════════════════════════════════════════════════════════════════
# Structured JSON Logging
# ═══════════════════════════════════════════════════════════════════════════════

class StructuredFormatter(logging.Formatter):
    """JSON-formatted log lines for log aggregation systems."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if hasattr(record, "request_id"):
            log_entry["request_id"] = record.request_id
        if record.exc_info and record.exc_info[1]:
            log_entry["error"] = str(record.exc_info[1])
        return json.dumps(log_entry, ensure_ascii=False)


logging.basicConfig(
    level=logging.INFO,
    stream=sys.stdout,
    format="%(message)s",
)
for handler in logging.root.handlers:
    handler.setFormatter(StructuredFormatter())

logger = logging.getLogger("pixelguard.main")


# ═══════════════════════════════════════════════════════════════════════════════
# Metrics Collector
# ═══════════════════════════════════════════════════════════════════════════════

class Metrics:
    """Thread-safe metrics collector for observability."""

    def __init__(self):
        self._lock = threading.Lock()
        self.request_count = 0
        self.error_count = 0
        self.total_latency_ms = 0.0
        self.vlm_calls = 0
        self.vlm_failures = 0
        self.vlm_fallbacks = 0
        self.rate_limit_hits = 0
        self._latencies: list[float] = []

    def record_request(self, latency_ms: float, success: bool) -> None:
        with self._lock:
            self.request_count += 1
            self.total_latency_ms += latency_ms
            self._latencies.append(latency_ms)
            if len(self._latencies) > 100:
                self._latencies = self._latencies[-100:]
            if not success:
                self.error_count += 1

    def record_vlm_call(self, success: bool, fallback: bool = False) -> None:
        with self._lock:
            self.vlm_calls += 1
            if not success:
                self.vlm_failures += 1
            if fallback:
                self.vlm_fallbacks += 1

    def record_rate_limit(self) -> None:
        with self._lock:
            self.rate_limit_hits += 1

    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            lats = sorted(self._latencies) if self._latencies else [0]
            return {
                "request_count": self.request_count,
                "error_count": self.error_count,
                "error_rate": round(self.error_count / max(1, self.request_count), 4),
                "avg_latency_ms": round(self.total_latency_ms / max(1, self.request_count), 1),
                "p50_latency_ms": round(lats[len(lats) // 2], 1),
                "p95_latency_ms": round(lats[int(len(lats) * 0.95)], 1),
                "vlm_calls": self.vlm_calls,
                "vlm_failures": self.vlm_failures,
                "vlm_fallbacks": self.vlm_fallbacks,
                "rate_limit_hits": self.rate_limit_hits,
            }


metrics = Metrics()


# ═══════════════════════════════════════════════════════════════════════════════
# Rate Limiter (Token Bucket per client IP)
# ═══════════════════════════════════════════════════════════════════════════════

class TokenBucket:
    def __init__(self, rate: float = 10.0, capacity: int = 20):
        self.rate = rate
        self.capacity = capacity
        self._tokens = float(capacity)
        self._last_update = time.monotonic()
        self._lock = threading.Lock()

    def consume(self) -> bool:
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_update
            self._tokens = min(self.capacity, self._tokens + elapsed * self.rate)
            self._last_update = now
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False


class RateLimiter:
    """Per-IP rate limiter using token buckets."""

    def __init__(self, rate: float = 10.0, capacity: int = 20):
        self.rate = rate
        self.capacity = capacity
        self._buckets: dict[str, TokenBucket] = {}
        self._lock = threading.Lock()

    def check(self, client_id: str) -> bool:
        with self._lock:
            if client_id not in self._buckets:
                self._buckets[client_id] = TokenBucket(self.rate, self.capacity)
            return self._buckets[client_id].consume()


rate_limiter = RateLimiter(rate=10.0, capacity=20)


# ═══════════════════════════════════════════════════════════════════════════════
# Middleware: Request ID + Rate Limiting + Request Size
# ═══════════════════════════════════════════════════════════════════════════════

MAX_REQUEST_SIZE = 10 * 1024 * 1024  # 10 MB


class RequestMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("X-Request-ID", str(uuid4())[:12])

        # Rate limit only /select-action (not /health or /metrics)
        if request.url.path == "/select-action":
            client_id = request.client.host if request.client else "unknown"
            if not rate_limiter.check(client_id):
                metrics.record_rate_limit()
                logger.warning("Rate limit exceeded", extra={"request_id": request_id})
                return JSONResponse(
                    status_code=429,
                    content={"error": {"code": "RATE_LIMITED", "message": "Too many requests. Slow down.", "retry_attempted": False}},
                    headers={"X-Request-ID": request_id, "Retry-After": "2"},
                )

        # Request size limit
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_REQUEST_SIZE:
            logger.warning("Request too large: %s bytes", content_length, extra={"request_id": request_id})
            return JSONResponse(
                status_code=413,
                content={"error": {"code": "PAYLOAD_TOO_LARGE", "message": f"Request exceeds {MAX_REQUEST_SIZE // 1024 // 1024}MB limit", "retry_attempted": False}},
                headers={"X-Request-ID": request_id},
            )

        start = time.monotonic()
        response = await call_next(request)
        latency_ms = (time.monotonic() - start) * 1000

        response.headers["X-Request-ID"] = request_id
        response.headers["X-Response-Time-ms"] = f"{latency_ms:.1f}"

        metrics.record_request(latency_ms, response.status_code < 400)

        logger.info(
            "%s %s %d %.1fms",
            request.method,
            request.url.path,
            response.status_code,
            latency_ms,
            extra={"request_id": request_id},
        )

        return response


# ═══════════════════════════════════════════════════════════════════════════════
# FastAPI App
# ═══════════════════════════════════════════════════════════════════════════════

app = FastAPI(
    title="PixelGuard Server",
    version="2.0.0",
    description="Privacy-first visual perception for browser agents. VLM action selection by candidate ID — never coordinates.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID", "X-Response-Time-ms"],
)

app.add_middleware(RequestMiddleware)


# ═══════════════════════════════════════════════════════════════════════════════
# Endpoints
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    """Liveness + readiness check.
    
    Returns provider status, circuit breaker state, and Ollama reachability.
    A 200 means the server is alive; 'ollama_reachable' tells you if the VLM is ready.
    """
    reachable = check_ollama_reachable()
    cb = get_circuit_breaker_state()
    return {
        "status": "ok",
        "version": "2.0.0",
        "provider": PG_PROVIDER,
        "model": PG_MODEL,
        "ollama_reachable": reachable,
        "circuit_breaker": cb,
    }


@app.get("/metrics")
def get_metrics():
    """Prometheus-style metrics endpoint for observability."""
    return metrics.to_dict()


@app.post("/warmup")
def do_warmup():
    warmed, vlm_ms = warmup()
    return {"warmed": warmed, "vlm_ms": vlm_ms}


@app.post("/select-action")
def select_action(raw: dict):
    # Validate against schema
    try:
        payload_model = SanitizedPayload.model_validate(raw)
    except ValidationError as exc:
        logger.warning("SCHEMA_INVALID: %d validation errors", len(exc.errors()))
        raise HTTPException(
            status_code=422,
            detail={"error": {"code": "SCHEMA_INVALID", "message": str(exc), "retry_attempted": False}},
        )

    payload = payload_model.model_dump()
    candidate_ids = {c["id"] for c in payload["candidates"]}

    if not candidate_ids:
        raise HTTPException(
            status_code=422,
            detail={"error": {"code": "EMPTY_CANDIDATES", "message": "No candidates provided", "retry_attempted": False}},
        )

    t0 = time.monotonic()
    is_fallback = False
    try:
        result, vlm_ms, model_name, retried = plan(payload)
        if "fallback" in model_name:
            is_fallback = True
            metrics.record_vlm_call(success=False, fallback=True)
        else:
            metrics.record_vlm_call(success=True, fallback=False)
    except VLMInvalidOutput as exc:
        metrics.record_vlm_call(success=False)
        raise HTTPException(
            status_code=502,
            detail={"error": {"code": "VLM_INVALID_OUTPUT", "message": str(exc), "retry_attempted": True}},
        )
    except VLMUnavailable as exc:
        metrics.record_vlm_call(success=False)
        raise HTTPException(
            status_code=502,
            detail={"error": {"code": "VLM_UNAVAILABLE", "message": str(exc), "retry_attempted": True}},
        )
    except VLMTimeout as exc:
        metrics.record_vlm_call(success=False)
        raise HTTPException(
            status_code=504,
            detail={"error": {"code": "VLM_TIMEOUT", "message": str(exc), "retry_attempted": True}},
        )

    server_ms = int((time.monotonic() - t0) * 1000)

    # Post-validation: target_id must be in candidate list for click/type
    action = result.get("action", "done")
    target_id = result.get("target_id")
    if action in ("click", "type") and target_id not in candidate_ids:
        raise HTTPException(
            status_code=502,
            detail={"error": {"code": "INVALID_TARGET_ID", "message": f"target_id {target_id} not in candidate list", "retry_attempted": True}},
        )

    response = ActionResponse(
        action=action,
        target_id=target_id,
        value=result.get("value"),
        confidence=float(result.get("confidence", 0.5)),
        reasoning=result.get("reasoning", ""),
        server_meta={
            "vlm_ms": vlm_ms,
            "model": model_name,
            "retried": retried,
            "server_ms": server_ms,
            "circuit_breaker_state": vlm_circuit_breaker.state,
        },
    )

    logger.info(
        "select-action: action=%s target=%s conf=%.2f vlm_ms=%d server_ms=%d candidates=%d fallback=%s",
        action, target_id, response.confidence, vlm_ms, server_ms, len(candidate_ids), is_fallback,
    )
    return response.model_dump()


@app.on_event("startup")
async def startup():
    logger.info("PixelGuard server v2.0.0 starting — provider=%s model=%s", PG_PROVIDER, PG_MODEL)


@app.on_event("shutdown")
async def shutdown():
    logger.info("PixelGuard server shutting down — requests=%d errors=%d", metrics.request_count, metrics.error_count)
