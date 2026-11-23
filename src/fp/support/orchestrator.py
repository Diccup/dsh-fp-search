"""编排：统一入口内部调用；HTTP → WAF → TLS → render → CDP 五段。

对外只有一个函数 fetch()，五条腿顺序尝试，任一腿拿到"非验证页"内容即返回统一契约。
- force_leg：只跑指定一条腿（CLI --force-leg）
- probe：只回状态/标题/字符数，不落正文文件（CLI --probe）
- emit：是否把契约打印成一行 JSON（CLI 自己打印时传 False）
"""
from __future__ import annotations
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parents[1]
for _sub in ("pylibs", "vendor"):
    _p = BASE / _sub
    if _p.exists() and str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from support.verdict import make_verdict
from parse.text import title as parse_title

LEGS: Tuple[str, ...] = ("http", "waf", "tls", "render", "cdp")
OUT_DIR = BASE / "out"
MAX_DIAG = 600


# ---------------------------------------------------------------- 配置与工具

def _cfg() -> Dict[str, Any]:
    try:
        from support.config import load_config
        cfg = load_config()
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def _decode_bytes(data: bytes, headers=None) -> str:
    charset = None
    if headers is not None:
        try:
            charset = headers.get_content_charset()
        except Exception:
            charset = None
    if not charset:
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


def _is_blocked(title: str, content: str) -> bool:
    """验证页/限流页判定：强挑战特征 + 正文短；长页面里出现"验证码"字样不算拦截。"""
    try:
        from support.detect import classify, is_challenge_title
    except Exception:
        return False
    body = content or ""
    kind = classify((title or "") + "\n" + body[:4000])
    if kind in ("cloudflare", "turnstile", "alibaba_waf", "captcha"):
        return len(body) < 6000
    if kind in ("rate_limit", "waf", "generic"):
        return len(body) < 2000
    if is_challenge_title(title or "") and len(body) < 6000:
        return True
    return False


def _is_useless(site: str, content: str, fp_store: Any = None) -> tuple[bool, str]:
    """★ N2（2026-11-07）：判"抓回来的东西有没有用"（主人：「进去要有用，没用就别进」）。

    为什么不能只看长度/拦截词：泡泡第一版就是这么判的，被现网打穿两次——
    搜狗 waf/tls 腿 5,394 B、mobile 腿 788 KB，都"不含拦截词且够长"，
    但 `vr-title`/`vrwrap`/`result` 计数全 0、外链全是自家域名 ⇒ 换皮验证页。

    判据见 `support/useful.py`（按站点结果容器分模板，桌面/移动不混用）。
    边界：
      - 只对 **HTML** 生效；JSON 接口直接放行（`useful()` 内部已判）。
      - 判不出站点（未知域名）时走"外链 ≥3 且非本站"的兜底。
      - **判定"没用"只让这条腿失败并继续下一腿，不抛到调用方**，与 `_is_blocked` 同一处理路径。

    ★ ITERATION-002：`fp_store` 传指纹库路径（out_dir 内 `fp_fingerprints.json`），
      指纹重定位通道生效；不传时行为与改前完全一致（模板判据原样）。
    """
    try:
        from support.useful import useful
    except Exception:
        return False, ""            # 模块缺失时不拦（宁可放过，不可误杀）
    ok, why = useful(content or "", site or "", fp_store=fp_store)
    return (not ok), why



def _ua_headers(persona: Dict[str, Any] | None) -> Dict[str, str]:
    """优先用画像请求头，退化到最小 UA。"""
    if persona:
        hdrs = persona.get("headers") or {}
        keep = {k: v for k, v in hdrs.items() if isinstance(v, str)}
        if keep.get("User-Agent"):
            return keep
    return {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"}


def _safe_name(site: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", site or "site")
    return name[:120].strip("_") or "site"


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def zlib_crc(text: str) -> int:
    import zlib
    return zlib.crc32(text.encode("utf-8"))


def _load_json(path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ---------------------------------------------------------------- 五条腿

def _ssl_context():
    """优先用项目内 pylibs/certifi 的 CA 包（系统 python 常缺根证书）。"""
    try:
        import ssl
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return None


def _decompress(data: bytes, encoding: str | None) -> bytes:
    """urllib 不做内容解码，这里手动处理 gzip/deflate（br/zstd 不支持，见 _http_headers）。"""
    enc = (encoding or "").lower().strip()
    if not data or not enc or enc == "identity":
        return data
    try:
        if "gzip" in enc:
            import gzip
            return gzip.decompress(data)
        if "deflate" in enc:
            import zlib
            try:
                return zlib.decompress(data)
            except zlib.error:
                return zlib.decompress(data, -zlib.MAX_WBITS)
    except Exception:
        return data
    return data


def _http_headers(persona: Dict[str, Any] | None) -> Dict[str, str]:
    """urllib 腿专用请求头：裁掉 br/zstd，避免拿到无法解码的压缩字节。"""
    hdrs = dict(_ua_headers(persona))
    hdrs["Accept-Encoding"] = "gzip, deflate"
    return hdrs


def _encode_url(url: str) -> str:
    """非 ASCII 字符（中文路径/query）percent-encode——http.client 请求行按 ascii 编码，
    含中文 URL（如 ?query=秋刀鱼）会 UnicodeEncodeError（2026-10-31 战场摸底发现）。"""
    from urllib.parse import urlsplit, urlunsplit, quote
    try:
        parts = urlsplit(url)
        path = quote(parts.path, safe="/%:@!$&'()*+,;=~")
        query = quote(parts.query, safe="=&%/:@!$&'()*+,;?~[]")
        return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))
    except Exception:
        return url


def _http_fetch(url: str, ctx: Dict[str, Any]) -> Tuple[str, str]:
    import ssl
    req = urllib.request.Request(_encode_url(url), headers=_http_headers(ctx.get("persona")))
    kwargs: Dict[str, Any] = {"timeout": ctx["timeout"]}
    ctx_ssl = _ssl_context()
    if ctx_ssl is not None:
        kwargs["context"] = ctx_ssl

    def _read(resp) -> str:
        data = _decompress(resp.read(), resp.headers.get("Content-Encoding"))
        return _decode_bytes(data, resp.headers)

    try:
        with urllib.request.urlopen(req, **kwargs) as resp:
            html = _read(resp)
    except urllib.error.URLError as exc:
        # 证书链在本机不可验证时降级（仅 http 腿；tls 腿由 curl_cffi 自行校验）
        if "CERTIFICATE_VERIFY_FAILED" not in str(exc):
            raise
        kwargs["context"] = ssl._create_unverified_context()
        with urllib.request.urlopen(req, **kwargs) as resp:
            html = _read(resp)
    return parse_title(html), html


def _waf_fetch(url: str, ctx: Dict[str, Any]) -> Tuple[str, str]:
    from challenge.waf import fetch as waf_fetch
    try:
        return waf_fetch(url, ctx["timeout"])
    except TypeError:
        return waf_fetch(url)


def _tls_fetch(url: str, ctx: Dict[str, Any]) -> Tuple[str, str]:
    from drivers.tls import get as tls_get
    persona = ctx.get("persona") or {}
    tls = persona.get("tls") or {}
    impersonate = tls.get("impersonate") or "chrome136"
    html = tls_get(url, timeout=ctx["timeout"], impersonate=impersonate,
                   headers=_ua_headers(persona))
    return parse_title(html), html


def _render_fetch(url: str, ctx: Dict[str, Any]) -> Tuple[str, str]:
    from drivers import render as render_mod
    # render 腿加余量：Edge 启动 3~5s + virtual-time 10s ≈ 踩线标准 timeout，
    # 20s 腿预算实测必炸（2026-10-31：CLI 90s 成功 / fp 20s 失败的根因）
    budget = ctx["timeout"] + 15
    html_fn = getattr(render_mod, "render_html", None)
    if callable(html_fn):
        try:
            html = html_fn(url, 10000, budget)
        except TypeError:
            html = html_fn(url)
        if html:
            return parse_title(html), html
    text = render_mod.render(url, 10000, budget)
    if not text:
        raise RuntimeError("render produced empty text")
    return "", text


def _cdp_fetch(url: str, ctx: Dict[str, Any]) -> Tuple[str, str]:
    from drivers.cdp import fetch as cdp_fetch
    persona = ctx.get("persona") or {}
    try:
        return cdp_fetch(url, ctx["timeout"], persona)
    except TypeError:
        return cdp_fetch(url, ctx["timeout"])


FETCHERS: Dict[str, Callable[[str, Dict[str, Any]], Tuple[str, str]]] = {
    "http": _http_fetch,
    "waf": _waf_fetch,
    "tls": _tls_fetch,
    "render": _render_fetch,
    "cdp": _cdp_fetch,
}


# ---------------------------------------------------------------- 会话头

def _session_head(url: str, cfg: Dict[str, Any], out_dir: Path) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """装配画像 + 落会话头；任何异常都不阻断抓取，只记 warning。"""
    seed = int(cfg.get("seed") or 0) or (zlib_crc(url) & 0xFFFFFFFF)
    policy = {"seed": seed}
    try:
        from support.assembler import save_session_head
        state = save_session_head(url, policy, out_dir)
        persona = _load_json(out_dir / "persona.json")
        return persona, state if isinstance(state, dict) else {}
    except Exception as exc:
        return {}, {"_warning": f"session head failed: {exc}"}


def _touch_state(out_dir: Path, url: str, leg: str, ok: bool) -> None:
    path = out_dir / "persona.state.json"
    state = _load_json(path)
    if not state:
        return
    tried = state.get("legs_tried")
    if not isinstance(tried, list):
        tried = []
    if leg not in tried:
        tried.append(leg)
    state["legs_tried"] = tried
    state["last_leg"] = leg
    state["last_ok"] = ok
    state["last_url"] = url
    try:
        _write_atomic(path, json.dumps(state, ensure_ascii=False, indent=2))
    except Exception:
        pass


# ---------------------------------------------------------------- 主流程

def fetch(url: str, probe: bool = False, force_leg: str | None = None,
          timeout: int | None = None, out_dir: Any = None,
          emit: bool = True) -> Dict[str, Any]:
    """五段编排主入口，返回统一契约 dict。"""
    started = time.time()
    cfg = _cfg()
    site = urlparse(url).netloc or url
    out = Path(out_dir or cfg.get("out_dir") or OUT_DIR)
    to = int(timeout or cfg.get("timeout") or 20)
    max_chars = int(cfg.get("max_chars") or 200000)
    save_text = bool(cfg.get("save_text", True))

    if force_leg and force_leg not in LEGS:
        raise ValueError(f"unknown leg: {force_leg}")

    out.mkdir(parents=True, exist_ok=True)
    persona, state = _session_head(url, cfg, out)
    ctx: Dict[str, Any] = {"timeout": to, "persona": persona, "cfg": cfg}

    legs: List[str] = [force_leg] if force_leg else list(LEGS)
    errors: List[str] = []
    warnings: List[str] = []
    if state.get("_warning"):
        warnings.append(state["_warning"])

    for leg in legs:
        fetcher = FETCHERS[leg]
        try:
            title, content = fetcher(url, ctx)
            if content is None:
                raise RuntimeError("empty body")
            if _is_blocked(title or "", content):
                raise RuntimeError("hit verification page")
            # ★ N2：结构级"有用性"判据（长度/关键词骗不过它）
            # ★ ITERATION-002：指纹库与 persona.json 同落 out_dir（fp_ 前缀，落点卫生）
            useless, why_useless = _is_useless(
                site, content, fp_store=str(out / "fp_fingerprints.json"))
            if useless:
                raise RuntimeError(f"useless page: {why_useless}")
            text_file = json_file = None
            if save_text and not probe:
                stem = _safe_name(site)
                text_path = out / f"{stem}.txt"
                json_path = out / f"{stem}.json"
                _write_atomic(text_path, content[:max_chars])
                text_file, json_file = str(text_path), str(json_path)
            verdict = make_verdict(
                True, site, leg, title=(title or ""), text_file=text_file,
                json_file=json_file, chars=len(content),
                fields={
                    "title": title or "",
                    "probe": probe,
                    "legs_tried": [leg],
                    "elapsed_ms": int((time.time() - started) * 1000),
                    "warnings": warnings,
                },
            )
            if json_file:
                _write_atomic(Path(json_file), json.dumps(verdict, ensure_ascii=False, indent=2))
            _touch_state(out, url, leg, True)
            if emit and not cfg.get("quiet"):
                print(json.dumps(verdict, ensure_ascii=False), flush=True)
            return verdict
        except Exception as exc:  # 单腿失败不致命，继续下一腿
            errors.append(f"{leg}: {type(exc).__name__}: {exc}")
            _touch_state(out, url, leg, False)

    verdict = make_verdict(
        False, site, legs[-1] if legs else "http",
        diagnosis="; ".join(errors)[:MAX_DIAG],
        fields={"probe": probe, "legs_tried": legs,
                "elapsed_ms": int((time.time() - started) * 1000),
                "warnings": warnings},
    )
    if emit and not cfg.get("quiet"):
        print(json.dumps(verdict, ensure_ascii=False), flush=True)
    return verdict
