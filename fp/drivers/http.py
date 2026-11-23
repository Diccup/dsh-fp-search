"""HTTP 通道（最小骨架）。"""
from __future__ import annotations
import urllib.request
from urllib.parse import urlsplit, urlunsplit, quote


def _encode_url(url: str) -> str:
    """非 ASCII 字符（中文路径/query）percent-encode——http.client 请求行按 ascii 编码，
    含中文的 URL（如 ?query=秋刀鱼）会 UnicodeEncodeError（2026-10-31 战场摸底发现）。"""
    try:
        parts = urlsplit(url)
        path = quote(parts.path, safe="/%:@!$&'()*+,;=~")
        query = quote(parts.query, safe="=&%/:@!$&'()*+,;?~[]")
        return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))
    except Exception:
        return url


def get(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(_encode_url(url), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")
