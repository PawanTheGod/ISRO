.PHONY: install dev lint clean

# ── Variables ─────────────────────────────────────────────────────────────────
PYTHON   ?= python
PIP      ?= pip
UVICORN  := uvicorn
HOST     ?= 0.0.0.0
PORT     ?= 8000

# ── Targets ───────────────────────────────────────────────────────────────────

## install: Install all pinned dependencies into the current Python environment
install:
	$(PIP) install -r requirements.txt

## dev: Start the development server with live reload (reads .env automatically)
dev: install
	$(UVICORN) main:app \
		--host $(HOST) \
		--port $(PORT) \
		--reload \
		--log-level info

## dev-stub: Start with the stub VLM provider (no API key needed, 0ms latency)
dev-stub:
	PG_PROVIDER=stub $(UVICORN) main:app \
		--host $(HOST) \
		--port $(PORT) \
		--reload \
		--log-level info

## health: Check server health endpoint
health:
	curl -s http://localhost:$(PORT)/health | python -m json.tool

## status: Check full server status (health + metrics)
status:
	curl -s http://localhost:$(PORT)/api/v1/status | python -m json.tool

## metrics: Check server metrics
metrics:
	curl -s http://localhost:$(PORT)/metrics | python -m json.tool

## warmup: Warm up the VLM model
warmup:
	curl -s -X POST http://localhost:$(PORT)/warmup | python -m json.tool

## lint: Run basic Python style checks
lint:
	$(PYTHON) -m py_compile main.py schema.py vlm_client.py && echo "✅ Syntax OK"

## clean: Remove Python bytecode caches
clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; echo "✅ Cleaned"

## help: Show this help message
help:
	@grep -E '^##' Makefile | sed 's/## /  /'
