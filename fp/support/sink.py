"""落盘与固定 JSON schema：原子写 + 结果文件命名。"""
from __future__ import annotations
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


def _atomic_write_text(path: Path, text: str) -> None:
    """tmp + os.replace 原子写，与 support/store.py 同风格。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_json(path, data: dict) -> None:
    """JSON 落盘（缩进 2，UTF-8，原子替换）。"""
    _atomic_write_text(Path(path), json.dumps(data, ensure_ascii=False, indent=2))


def write_text(path, text: str) -> None:
    """纯文本落盘（UTF-8，原子替换）。"""
    _atomic_write_text(Path(path), text)


def _safe_stem(site: str) -> str:
    """文件名安全化：非 [A-Za-z0-9._-] 一律替换 `_`，长度截断 120。"""
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", site or "site")
    return name[:120].strip("_") or "site"


def result_paths(site: str, out_dir) -> Tuple[Path, Path]:
    """站点名 → (txt_path, json_path)，文件名安全。"""
    out = Path(out_dir)
    stem = _safe_stem(site)
    return out / f"{stem}.txt", out / f"{stem}.json"


def save_result(verdict: Dict[str, Any], content: Optional[str], out_dir,
                save_text: bool = True, max_chars: int = 200000) -> Dict[str, Any]:
    """把 verdict 落盘：txt（content 非空且 save_text）+ json（schema/saved_at）。

    返回补齐 text_file/json_file/chars 后的新 dict（不改入参）。
    """
    result = dict(verdict)
    # 统一契约里的键必须始终存在（调用方可能直接取 text_file 判断是否落盘）
    result.setdefault("text_file", None)
    result.setdefault("json_file", None)
    result.setdefault("chars", 0)
    txt_path, json_path = result_paths(result.get("site") or "site", out_dir)
    chars = result.get("chars") or 0
    if content is not None and save_text:
        text = content[:max_chars]
        write_text(txt_path, text)
        result["text_file"] = str(txt_path)
        result["chars"] = result.get("chars") or len(content)
        chars = result["chars"]
    payload = dict(result)
    payload["schema"] = 1
    payload["saved_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    write_json(json_path, payload)
    result["json_file"] = str(json_path)
    if not result.get("chars"):
        result["chars"] = chars
    return result
