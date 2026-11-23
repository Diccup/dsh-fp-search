"""阿里云 WAF 求解（封装 vendor/waf_fetch）。"""
from __future__ import annotations
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
VENDOR = BASE / "vendor"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))
import waf_fetch
from parse.text import title as parse_title


def fetch(url, timeout=20):
    st, text, note = waf_fetch.get(url)
    if st != 200 or not text:
        raise RuntimeError(f"拿页面失败: st={st} {note}")
    return parse_title(text), text


def solve_html(html):
    try:
        body = html.encode("utf-8") if isinstance(html, str) else (html or b"")
    except Exception:
        body = b""
    if not waf_fetch.is_acw(body, {}):
        return None
    return waf_fetch.solve_acw(body)


def fetch_with_retry(url, timeout=20, retries=2):
    last = None
    for i in range(retries + 1):
        try:
            return fetch(url, timeout=timeout)
        except Exception as e:
            last = e
    raise RuntimeError(f"带 cookie 重取失败: {last}")
