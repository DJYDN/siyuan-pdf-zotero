#!/usr/bin/env python3
"""Convert the UniMERNet Lightning checkpoint into a plain transformers model directory.

The official model pack only ships a Lightning checkpoint (`unimernet_base.pth`)
whose `model.model.*` keys match `transformers.VisionEncoderDecoderModel`.
This script strips the wrapper prefixes and writes a standard HF directory
(config + safetensors + tokenizer) so the engine can run with transformers only
(no upstream `unimernet` package, no lightning/iopath/timm).

Output layout (used by release/OCR-UniMERNet-Portable):
    <out>/config.json
    <out>/model.safetensors
    <out>/tokenizer.json / tokenizer_config.json / special_tokens_map.json
    <out>/preprocessor_config.json
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"F:\study\VStudio\SiYuanArticleManger"
SRC_MODEL_DIR = os.path.join(ROOT, ".tmp", "release-src", "UniMERNet-Portable", "src", "UniMERNet-main", "models", "unimernet_base")
CKPT = os.path.join(SRC_MODEL_DIR, "unimernet_base.pth")
OUT_DIR = os.path.join(ROOT, "release", "OCR-UniMERNet-Portable", "models", "unimernet_base")

import torch  # noqa: E402
from transformers import PreTrainedTokenizerFast, VisionEncoderDecoderConfig, VisionEncoderDecoderModel  # noqa: E402


def main() -> int:
    started = time.time()
    print("loading checkpoint (mmap)...", flush=True)
    ckpt = torch.load(CKPT, map_location="cpu", mmap=True, weights_only=False)
    state = ckpt["model"]
    remapped = {}
    for key, value in state.items():
        if key.startswith("model.model."):
            remapped[key[len("model.model."):]] = value
        elif key.startswith("model."):
            remapped[key[len("model."):]] = value
        else:
            remapped[key] = value
    total_bytes = sum(value.numel() * value.element_size() for value in remapped.values())
    print(f"remapped {len(remapped)} tensors, {total_bytes/1e9:.2f} GB", flush=True)

    config = VisionEncoderDecoderConfig.from_pretrained(SRC_MODEL_DIR)
    model = VisionEncoderDecoderModel(config)
    missing, unexpected = model.load_state_dict(remapped, strict=False)
    print(f"missing={len(missing)} unexpected={len(unexpected)}")
    if missing:
        print("missing keys:", missing[:5])
        raise SystemExit("checkpoint does not cover the model")
    del remapped, state, ckpt

    os.makedirs(OUT_DIR, exist_ok=True)
    model.eval()
    model.save_pretrained(OUT_DIR, safe_serialization=True)
    tokenizer = PreTrainedTokenizerFast.from_pretrained(SRC_MODEL_DIR)
    tokenizer.save_pretrained(OUT_DIR)
    for name in ["preprocessor_config.json", "special_tokens_map.json"]:
        source = os.path.join(SRC_MODEL_DIR, name)
        if os.path.isfile(source):
            shutil.copy2(source, os.path.join(OUT_DIR, name))
    size = sum(os.path.getsize(os.path.join(current, name)) for current, _, files in os.walk(OUT_DIR) for name in files)
    print(f"wrote {OUT_DIR} ({size/1e6:.0f} MB) in {time.time()-started:.0f}s")
    print(json.dumps(sorted(os.listdir(OUT_DIR)), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
