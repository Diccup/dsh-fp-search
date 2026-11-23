"""无头渲染通道（封装 vendor/page_render）。"""
from __future__ import annotations
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
VENDOR = BASE / "vendor"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))

import page_render

from drivers import stealth


def render(url: str, wait_ms: int = 10000, timeout: int = 90) -> str:
    dom, diag = page_render.render(url, wait_ms, timeout, None)
    if dom is None or diag.get("dom_bytes", 0) == 0:
        _raise_diag(diag)
    text = page_render.dom_to_text(dom)
    if not text:
        raise RuntimeError("render produced empty text")
    return text


def _raise_diag(diag: dict) -> None:
    """统一诊断抛错：exit/dom 字节/stderr 尾巴全带上，verdict 的 diagnosis 才有肉。"""
    tail = (diag.get("stderr_tail") or "").strip().splitlines()[-2:]
    detail = f"exit={diag.get('exit')} dom={diag.get('dom_bytes', 0)}B"
    if tail:
        detail += " | " + " | ".join(tail)
    raise RuntimeError(f"{diag.get('msg', 'render failed')}: {detail}"[:300])


def render_html(url: str, wait_ms: int = 10000, timeout: int = 90) -> str:
    dom, diag = page_render.render(url, wait_ms, timeout, None)
    if dom is None or diag.get("dom_bytes", 0) == 0:
        _raise_diag(diag)
    return dom


def render_with(persona, url: str, wait_ms: int = 10000, timeout: int = 90) -> dict:
    """使用 stealth 参数与 emulation（尽力而为，page_render 本身不支持注入，仅返回 dom/text）。"""
    dom, diag = page_render.render(url, wait_ms, timeout, None)
    return {"dom": dom, "text": page_render.dom_to_text(dom) if dom else "", "diag": diag, "persona": persona}
