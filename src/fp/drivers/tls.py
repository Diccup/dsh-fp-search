"""TLS 通道（curl_cffi 指纹伪装，封装 TLS 腿）。"""
from __future__ import annotations
import sys
from pathlib import Path
from typing import Optional

BASE = Path(__file__).resolve().parents[1]
PYLIBS = BASE / "pylibs"
if not PYLIBS.exists():
    # 回退链：工作区形态（fp\ 与 deps\pylibs 平级）→ 发布形态（包根\重建搜索项目\deps\pylibs）
    for _alt in (BASE.parent / "deps" / "pylibs",
                 BASE.parent / "重建搜索项目" / "deps" / "pylibs"):
        if (_alt / "curl_cffi").exists():
            PYLIBS = _alt
            break
if PYLIBS.exists():
    sys.path.insert(0, str(PYLIBS))

from curl_cffi import requests as curl_requests


def _decode_bytes(data: bytes, headers=None) -> str:
    charset = None
    if headers is not None:
        try:
            charset = headers.get_content_charset() if hasattr(headers, "get_content_charset") else None
        except Exception:
            charset = None
    if not charset:
        import re
        m = re.search(rb"charset=['\"]?([\w-]+)", data[:4096], re.I)
        if m:
            charset = m.group(1).decode("ascii", "ignore")
    for enc in (charset, "utf-8", "gb18030", "latin-1"):
        if not enc:
            continue
        try:
            return data.decode(enc)
        except Exception:
            continue
    return data.decode("utf-8", "ignore")


def get(url: str, timeout: int = 20, impersonate: str = "chrome", headers: Optional[dict] = None) -> str:
    """返回解码后的 HTML 文本；失败抛异常。"""
    r = curl_requests.get(url, impersonate=impersonate, timeout=timeout, headers=headers or {})
    r.raise_for_status()
    return _decode_bytes(r.content, r.headers)
