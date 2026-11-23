"""统一契约：所有入口只返回这个结构。"""
from __future__ import annotations
import json
from typing import Any, Dict, Optional

def make_verdict(ok: bool, site: str, leg: str, title: str = "", text_file: Optional[str] = None,
                 json_file: Optional[str] = None, chars: int = 0, fields: Optional[Dict[str, Any]] = None,
                 diagnosis: Optional[str] = None) -> Dict[str, Any]:
    return {
        "ok": ok,
        "site": site,
        "leg": leg,
        "title": title,
        "text_file": text_file,
        "json_file": json_file,
        "chars": chars,
        "fields": fields or {},
        "diagnosis": diagnosis,
    }

def dumps(v: Dict[str, Any]) -> str:
    return json.dumps(v, ensure_ascii=False)
