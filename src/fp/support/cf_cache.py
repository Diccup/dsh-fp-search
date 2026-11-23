"""cf_clearance / cookies 会话缓存：过验成功后持久化，后续优先复用。"""
from __future__ import annotations
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

BASE = Path(__file__).resolve().parents[1]
CACHE_FILE = BASE / "out" / ".cf-cache.json"
TTL = 1800  # 30 min default


def _load() -> Dict[str, Any]:
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _atomic_write(data: Dict[str, Any]) -> None:
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_FILE.with_name(CACHE_FILE.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, CACHE_FILE)


def get(url: str, ua: str = "") -> Optional[Dict[str, Any]]:
    """返回未过期缓存 dict 或 None。"""
    data = _load()
    if not isinstance(data, dict):
        return None
    if data.get("url") and data.get("url") != url:
        return None
    if ua and data.get("ua") and data.get("ua") != ua:
        return None
    ts = float(data.get("ts") or 0)
    if time.time() - ts > float(data.get("ttl") or TTL):
        return None
    if not data.get("cookies"):
        return None
    return data


def save(url: str, cookies: Any, ua: str = "", ttl: float = TTL) -> None:
    _atomic_write({
        "url": url,
        "cookies": cookies,
        "ua": ua,
        "ts": time.time(),
        "ttl": ttl,
    })


def invalidate() -> None:
    try:
        CACHE_FILE.unlink(missing_ok=True)
    except Exception:
        pass