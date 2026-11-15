#!/usr/bin/env python3
"""Local Pix2Text OCR service for siyuan-pdf-zotero.

Protocol:
  GET  /health
  POST /ocr   {"imageBase64": "...", "mode": "auto|formula|text", "languages": ["zh","en"]}

This service is intentionally dependency-light at the HTTP layer. Pix2Text is
initialised lazily so /health can report a useful model/import error instead of
preventing the process from starting.
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
PORTABLE_HOME = os.path.join(ROOT, "userprofile")
if os.path.isdir(PORTABLE_HOME):
    os.environ["USERPROFILE"] = PORTABLE_HOME
    os.environ["HOME"] = PORTABLE_HOME
    os.environ["APPDATA"] = os.path.join(PORTABLE_HOME, "AppData", "Roaming")
    os.environ["LOCALAPPDATA"] = os.path.join(PORTABLE_HOME, "AppData", "Local")
CONFIG_PATH = os.path.join(ROOT, "config.json")
MAX_BODY = 30 * 1024 * 1024

_p2t: Any = None
_init_error = ""
_engine_name = "pix2text"
_engine_key = ""


def load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


_unimernet: Any = None
_unimernet_key = ""


def init_unimernet(options: dict) -> Any:
    global _unimernet, _unimernet_key
    root = str(options.get("unimernetPath") or "").strip()
    if not root:
        raise RuntimeError("未配置 UniMERNet 目录，请在 OCR 设置中选择解压目录")
    if not os.path.isdir(root):
        raise RuntimeError(f"UniMERNet 目录不存在：{root}")
    config_path = str(options.get("unimernetConfigPath") or "").strip() or os.path.join(root, "configs", "demo.yaml")
    device_name = str(options.get("unimernetDevice") or "auto")
    key = json.dumps({"root": root, "config": config_path, "device": device_name}, ensure_ascii=False, sort_keys=True)
    if _unimernet is not None and key == _unimernet_key:
        return _unimernet
    try:
        import torch
        from types import SimpleNamespace
        sys.path.insert(0, root)
        from unimernet.common.config import Config
        from unimernet.tasks import setup_task
        from unimernet.processors import load_processor

        if device_name == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("UniMERNet 配置为 CUDA，但当前环境没有可用 CUDA")
        device = torch.device("cuda" if device_name in ("auto", "cuda") and torch.cuda.is_available() else "cpu")
        old_cwd = os.getcwd()
        os.chdir(root)
        try:
            cfg = Config(SimpleNamespace(cfg_path=config_path, options=None))
            task = setup_task(cfg)
            model = task.build_model(cfg).to(device)
            model.eval()
            processor = load_processor("formula_image_eval", cfg.config.datasets.formula_rec_eval.vis_processor.eval)
        finally:
            os.chdir(old_cwd)
        _unimernet = {"model": model, "processor": processor, "device": device, "torch": torch, "root": root}
        _unimernet_key = key
        return _unimernet
    except Exception:
        _unimernet = None
        _unimernet_key = ""
        raise


def recognize_unimernet(image: Any, options: dict) -> dict:
    started = time.time()
    engine = init_unimernet(options)
    processor = engine["processor"]
    model = engine["model"]
    device = engine["device"]
    with engine["torch"].no_grad():
        tensor = processor(image).unsqueeze(0).to(device)
        output = model.generate({"image": tensor})
    text = str(output.get("pred_str", [""])[0] or "").strip()
    if not text:
        raise RuntimeError("UniMERNet 没有返回公式")
    return {
        "ok": True,
        "kind": "formula",
        "markdown": f"${text}$",
        "items": [{"type": "formula", "latex": text, "text": text, "confidence": 1.0, "bbox": None}],
        "elapsedMs": int((time.time() - started) * 1000),
        "engine": "unimernet",
    }


def init_engine(options: dict | None = None) -> Any:
    global _p2t, _init_error, _engine_name, _engine_key
    options = options or {}
    config = load_config()
    device = str(options.get("device") or os.environ.get("PIX2TEXT_DEVICE") or config.get("device") or "cpu")
    if device == "auto":
        device = None
    enable_table = bool(options.get("enableTable", config.get("enableTable", False)))
    enable_spell = bool(options.get("enableSpellChecker", True))
    mfd_model = str(options.get("mfdModel") or "mfd-1.5")
    mfr_model = str(options.get("mfrModel") or "mfr-1.5")
    languages = options.get("languages") or config.get("languages") or ["zh", "en"]
    mapped_languages = []
    for language in languages:
        mapped_languages.append({"zh": "ch_sim", "ch": "ch_sim", "ch_sim": "ch_sim", "en": "en"}.get(str(language), str(language)))
    mfd_config = {"model_name": mfd_model, "model_backend": "onnx"}
    shape = str(options.get("mfdStaticShape") or "").strip()
    if shape:
        if "x" in shape.lower():
            first, second = shape.lower().split("x", 1)
            mfd_config["static_resized_shape"] = [int(first), int(second)]
        else:
            mfd_config["static_resized_shape"] = int(shape)
    formula_config = {"model_name": mfr_model, "model_backend": "onnx"}
    context = str(options.get("mfrContext") or "").strip()
    if context:
        formula_config["context"] = context
    total_configs = {
        "text_formula": {
            "languages": mapped_languages,
            "mfd": mfd_config,
            "formula": formula_config,
        }
    }
    key = json.dumps({"device": device, "enableTable": enable_table, "enableSpellChecker": enable_spell, "total_configs": total_configs}, ensure_ascii=False, sort_keys=True)
    if _p2t is not None and key == _engine_key:
        return _p2t
    try:
        from pix2text import Pix2Text

        _p2t = Pix2Text.from_config(
            total_configs=total_configs,
            enable_formula=True,
            enable_table=enable_table,
            enable_spell_checker=enable_spell,
            device=device,
        )
        _engine_name = "pix2text"
        _engine_key = key
        _init_error = ""
        return _p2t
    except Exception as exc:  # noqa: BLE001
        _p2t = None
        _engine_key = ""
        _init_error = f"{type(exc).__name__}: {exc}"
        raise

def bbox_of(position: Any) -> dict | None:
    try:
        xs = [float(point[0]) for point in position]
        ys = [float(point[1]) for point in position]
        if not xs or not ys:
            return None
        return {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}
    except Exception:
        return None


def item(type_name: str, text: str, score: float, position: Any = None) -> dict:
    is_formula = type_name in ("formula", "isolated", "embedding")
    return {
        "type": "text" if type_name == "text" else "formula",
        "latex": text if is_formula else "",
        "text": text,
        "confidence": float(score or 0),
        "bbox": bbox_of(position) if position is not None else None,
    }


def as_entries(raw: Any) -> list:
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, str):
        return [{"text": raw, "score": 1.0}]
    return []

def prepare_image(image: Any) -> Any:
    """Upscale small PDF crops so multi-line formulas keep enough detail."""
    try:
        width, height = image.size
        longest = max(width, height)
        if longest >= 1000 or longest <= 0:
            return image
        scale = min(2.0, 1000.0 / longest)
        if scale <= 1.15:
            return image
        return image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)
    except Exception:
        return image

def recognize(image: Any, mode: str, options: dict | None = None) -> dict:
    if str(options.get("engine") or "") == "unimernet":
        return recognize_unimernet(image, options)
    p2t = init_engine(options)
    image = prepare_image(image)
    started = time.time()
    mode = mode if mode in ("auto", "formula", "text") else "auto"
    items: list[dict] = []
    markdown_parts: list[str] = []
    if mode == "formula":
        raw = p2t.recognize_formula(image, return_text=False)
        for entry in as_entries(raw):
            text = str(entry.get("text", "")).strip()
            if not text:
                continue
            item_row = item("formula", text, entry.get("score", 0), entry.get("position"))
            items.append(item_row)
            markdown_parts.append(f"$${text}$$")
        kind = "formula"
    elif mode == "text":
        raw = p2t.recognize_text(image, return_text=False)
        for entry in as_entries(raw):
            text = str(entry.get("text", "")).strip()
            if not text:
                continue
            item_row = item("text", text, entry.get("score", 0), entry.get("position"))
            items.append(item_row)
            markdown_parts.append(text)
        kind = "text"
    else:
        raw = p2t.recognize_text_formula(image, return_text=False)
        has_text = False
        has_formula = False
        for entry in as_entries(raw):
            type_name = str(entry.get("type", "text"))
            text = str(entry.get("text", "")).strip()
            if not text:
                continue
            if type_name == "text":
                has_text = True
                markdown_parts.append(text)
            elif type_name == "isolated":
                has_formula = True
                markdown_parts.append(f"$${text}$$")
            else:
                has_formula = True
                markdown_parts.append(f"${text}$")
            items.append(item(type_name, text, entry.get("score", 0), entry.get("position")))
        kind = "mixed" if has_text and has_formula else ("formula" if has_formula else "text")
    return {
        "ok": True,
        "kind": kind,
        "markdown": "\n\n".join(markdown_parts).strip(),
        "items": items,
        "elapsedMs": int((time.time() - started) * 1000),
        "engine": _engine_name,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "SiYuanOCR/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[ocr] " + (fmt % args) + "\n")

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/health":
            config = load_config()
            error = ""
            ready = False
            try:
                if _p2t is None:
                    init_engine()
                ready = True
            except Exception as exc:  # noqa: BLE001
                error = str(exc)
            self.send_json(200, {
                "ok": ready,
                "version": "pix2text-ocr-0.2",
                "engine": "pz-shared",
                "engines": ["pix2text", "unimernet"],
                "capabilities": {"formula": True, "text": True, "mixed": True},
                "modelReady": ready,
                "models": config.get("modelDir", os.path.join(ROOT, "models")),
                "pid": os.getpid(),
                "error": error,
            })
            return
        self.send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/ocr":
            self.send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                raise ValueError("请求体为空或过大")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            image_base64 = str(payload.get("imageBase64", ""))
            if not image_base64:
                raise ValueError("缺少 imageBase64")
            from PIL import Image

            image = Image.open(io.BytesIO(base64.b64decode(image_base64))).convert("RGB")
            options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
            result = recognize(image, str(payload.get("mode", "auto")), options)
            self.send_json(200, result)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self.send_json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}", "detail": _init_error})


def main() -> None:
    config = load_config()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(config.get("port", 8891))
    host = str(config.get("host", "127.0.0.1"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"OCR server listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
