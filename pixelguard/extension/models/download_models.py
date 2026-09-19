#!/usr/bin/env python3
"""download_models.py — Download on-device ML models for PixelGuard.
Downloads CLIP (visual candidate classification) and BERT-NER (entity recognition)
from HuggingFace into extension/models/.

Usage: python extension/models/download_models.py
"""
import json
import os
import sys
from pathlib import Path
from urllib.request import urlretrieve

MODELS_DIR = Path(__file__).parent

MODELS = {
    "clip": {
        "url_base": "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main",
        "files": ["config.json", "tokenizer.json", "preprocessor_config.json"],
        "onnx_files": [
            ("onnx/model_quantized.onnx", "model_quantized.onnx"),
        ],
        "dest": MODELS_DIR / "clip",
    },
    "ner": {
        "url_base": "https://huggingface.co/Xenova/bert-base-NER/resolve/main",
        "files": ["config.json", "tokenizer.json", "tokenizer_config.json"],
        "onnx_files": [
            ("onnx/model_quantized.onnx", "model_quantized.onnx"),
        ],
        "dest": MODELS_DIR / "ner",
    },
}

def download(url, dest, name):
    if dest.exists():
        print(f"  SKIP {name} (already exists: {dest.stat().st_size // 1024} KB)")
        return
    print(f"  Downloading {name}...")
    try:
        urlretrieve(url, str(dest))
        print(f"    OK: {dest.stat().st_size // 1024} KB")
    except Exception as e:
        print(f"    FAILED: {e}")

def main():
    for model_name, spec in MODELS.items():
        dest_dir = spec["dest"]
        dest_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n=== {model_name} ===")

        for f in spec["files"]:
            url = f"{spec['url_base']}/{f}"
            download(url, dest_dir / f, f)

        for remote_path, local_name in spec.get("onnx_files", []):
            url = f"{spec['url_base']}/{remote_path}"
            dest = dest_dir / local_name
            download(url, dest, local_name)

    print("\nDone. Models are in:", MODELS_DIR)
    print("\nIf downloads failed, you can manually download from:")
    for name, spec in MODELS.items():
        print(f"  {name}: {spec['url_base']}")

if __name__ == "__main__":
    main()
