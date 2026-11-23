"""兼容性检查器（强校验）。"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict

VALID_LEGS = {"http", "waf", "tls", "render", "cdp"}


@dataclass
class Report:
    ok: bool
    errors: list[str]
    warnings: list[str] = field(default_factory=list)


def _impersonate_major(imp: str) -> int | None:
    if not isinstance(imp, str):
        return None
    low = imp.lower()
    if low.startswith("safari"):
        return None
    digits = ""
    for ch in imp:
        if ch.isdigit():
            digits += ch
        elif digits:
            break
    try:
        return int(digits) if digits else None
    except ValueError:
        return None


def check_static(persona: Dict[str, Any]) -> Report:
    errors: list[str] = []
    warnings: list[str] = []
    browser = persona.get("browser") or {}
    tls = persona.get("tls") or {}
    headers = persona.get("headers") or {}
    screen = persona.get("screen") or {}
    http2 = persona.get("http2") or {}
    font = persona.get("font") or {}
    noise = persona.get("noise") or {}
    timing = persona.get("timing") or {}
    mouse = persona.get("mouse") or {}
    keyboard = persona.get("keyboard") or {}

    # 1 family
    family = browser.get("family")
    if family not in ("chrome", "edge"):
        errors.append(f"browser.family 期望 chrome/edge，实际 {family!r}")
    if family == "edge" and not tls.get("impersonate"):
        errors.append("browser.family=edge 但 tls.impersonate 缺失")

    major = browser.get("major")
    full_version = browser.get("full_version", "")
    impersonate = tls.get("impersonate", "")

    # 2 major consistency
    imp_major = _impersonate_major(impersonate)
    if isinstance(impersonate, str) and impersonate.lower().startswith("safari"):
        warnings.append(f"tls.impersonate={impersonate!r} 为 safari，跳过主版本一致性校验")
    else:
        if imp_major is not None and major is not None and imp_major != major:
            errors.append(f"tls.impersonate 版本 {imp_major} 与 browser.major {major} 不一致")
    # UA
    ua = headers.get("User-Agent", "")
    if major is not None and f"Chrome/{major}" not in ua and f"Chrome/{major}." not in ua:
        # allow full_version prefix
        if not (isinstance(full_version, str) and full_version.startswith(str(major)) and f"Chrome/{full_version}" in ua):
            errors.append(f"headers.User-Agent 应含 Chrome/{major}（或 {full_version}），实际 {ua!r}")
    # full_version prefix
    if isinstance(full_version, str) and major is not None:
        if not full_version.startswith(str(major) + "."):
            errors.append(f"browser.full_version {full_version!r} 前缀与 browser.major {major} 不一致")
    # sec-ch-ua
    sec_ua = headers.get("sec-ch-ua", "")
    if major is not None:
        token = f'v="{major}"'
        if token not in sec_ua:
            errors.append(f"headers.sec-ch-ua 应含 v=\"{major}\"，实际 {sec_ua!r}")
    # tls.impersonate version vs major
    if imp_major is not None and major is not None and imp_major != major:
        errors.append(f"tls.impersonate {impersonate!r} 版本 {imp_major} 与 browser.major {major} 不一致")

    # 3 platform
    ua_platform = browser.get("ua_platform", "")
    if ua_platform and ua_platform not in ua:
        errors.append(f"headers.User-Agent 应含 ua_platform {ua_platform!r}")
    sec_platform = headers.get("sec-ch-ua-platform", "")
    if "Windows" in str(ua_platform):
        expected_platform = '"Windows"'
    elif "Mac" in str(ua_platform):
        expected_platform = '"macOS"'
    else:
        expected_platform = None
    if expected_platform is not None and sec_platform != expected_platform:
        errors.append(f"headers.sec-ch-ua-platform 期望 {expected_platform}，实际 {sec_platform!r}")

    # 4 mobile
    mobile = browser.get("mobile", False)
    expected_mobile = "?1" if mobile else "?0"
    if headers.get("sec-ch-ua-mobile") != expected_mobile:
        errors.append(f"headers.sec-ch-ua-mobile 期望 {expected_mobile}，实际 {headers.get('sec-ch-ua-mobile')!r}")

    # 5 screen
    w = screen.get("width"); h = screen.get("height")
    ow = screen.get("outer_width"); oh = screen.get("outer_height")
    iw = screen.get("inner_width"); ih = screen.get("inner_height")
    aw = screen.get("avail_width"); ah = screen.get("avail_height")
    dpr = screen.get("dpr")
    if not (isinstance(iw, int) and isinstance(ow, int) and isinstance(w, int) and iw <= ow <= w):
        errors.append(f"screen.inner/outer/width 不等式失败: inner={iw} outer={ow} width={w}")
    if not (isinstance(ih, int) and isinstance(oh, int) and isinstance(h, int) and ih <= oh <= h):
        errors.append(f"screen.inner/outer/height 不等式失败: inner={ih} outer={oh} height={h}")
    if aw is not None and w is not None and not (aw <= w):
        errors.append(f"screen.avail_width {aw} > width {w}")
    if ah is not None and h is not None and not (ah <= h):
        errors.append(f"screen.avail_height {ah} > height {h}")
    if dpr is not None and not (0.5 <= float(dpr) <= 4):
        errors.append(f"screen.dpr {dpr} 不在 [0.5,4]")

    # 6 headers required
    for key in ("User-Agent", "sec-ch-ua", "Accept", "Accept-Language"):
        if not headers.get(key):
            errors.append(f"headers.{key} 缺失或为空")

    # 7 http2/tls alpn
    alpn = tls.get("alpn")
    if alpn is not None:
        if not (isinstance(alpn, list) and alpn and "h2" in alpn):
            errors.append(f"tls.alpn 应非空且含 h2，实际 {alpn!r}")
    settings = http2.get("settings", {})
    if isinstance(settings, dict) and settings:
        iws = settings.get("INITIAL_WINDOW_SIZE")
        mcs = settings.get("MAX_CONCURRENT_STREAMS")
        if not (isinstance(iws, int) and iws > 0):
            errors.append(f"http2.settings.INITIAL_WINDOW_SIZE 应为正整数，实际 {iws!r}")
        if not (isinstance(mcs, int) and mcs > 0):
            errors.append(f"http2.settings.MAX_CONCURRENT_STREAMS 应为正整数，实际 {mcs!r}")

    # 8 font
    fonts = font.get("fonts")
    if not (isinstance(fonts, list) and fonts and all(isinstance(x, str) and x for x in fonts)):
        errors.append(f"font.fonts 应为非空字符串列表，实际 {fonts!r}")

    # 9 noise
    for k in ("canvas", "audio", "webgl"):
        v = noise.get(k)
        if v is None:
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            errors.append(f"noise.{k} 非数字 {v!r}")
            continue
        if not (0 <= fv <= 0.05):
            errors.append(f"noise.{k} {fv} 不在 [0,0.05]")

    # 10 timing/mouse/keyboard
    rg = timing.get("request_gap_ms", {})
    if isinstance(rg, dict):
        mu = rg.get("mu"); sigma = rg.get("sigma")
        if mu is not None and not (isinstance(mu, (int, float)) and mu > 0):
            errors.append(f"timing.request_gap_ms.mu 应为正数，实际 {mu!r}")
        if sigma is not None and not (isinstance(sigma, (int, float)) and sigma > 0):
            errors.append(f"timing.request_gap_ms.sigma 应为正数，实际 {sigma!r}")
    movement = (mouse.get("movement") or {}) if isinstance(mouse, dict) else {}
    steps = movement.get("steps")
    if steps is not None and not (isinstance(steps, int) and steps > 0):
        errors.append(f"mouse.movement.steps 应为正整数，实际 {steps!r}")
    intra = keyboard.get("intra_word_ms") if isinstance(keyboard, dict) else None
    if isinstance(intra, (list, tuple)) and len(intra) >= 2:
        try:
            if not (intra[0] < intra[1]):
                errors.append(f"keyboard.intra_word_ms[0] 应 < [1]，实际 {intra!r}")
        except Exception:
            errors.append(f"keyboard.intra_word_ms 非法 {intra!r}")

    return Report(ok=not errors, errors=errors, warnings=warnings)


def check_dynamic(persona: Dict[str, Any], state: Dict[str, Any]) -> Report:
    errors: list[str] = []
    warnings: list[str] = []
    state = state or {}
    screen = (persona or {}).get("screen", {}) or {}
    pv_persona = (persona or {}).get("persona_version")
    pv_state = state.get("persona_version")
    if pv_state is None:
        warnings.append("state.persona_version 缺省")
    elif pv_persona is not None and pv_state != pv_persona:
        errors.append(f"state.persona_version {pv_state} 与 persona.persona_version {pv_persona} 不一致")

    mouse = state.get("mouse") or {}
    if isinstance(mouse, dict):
        x = mouse.get("x"); y = mouse.get("y")
        w = screen.get("width"); h = screen.get("height")
        if x is not None and w is not None and not (0 <= x <= w):
            errors.append(f"state.mouse.x {x} 超出 [0,{w}]")
        if y is not None and h is not None and not (0 <= y <= h):
            errors.append(f"state.mouse.y {y} 超出 [0,{h}]")

    visited = state.get("visited")
    if visited is not None:
        if not (isinstance(visited, list) and visited and all(isinstance(v, str) for v in visited)):
            errors.append(f"state.visited 应为非空 str 列表，实际 {visited!r}")

    legs = state.get("legs_tried")
    if legs is not None:
        if not (isinstance(legs, list) and all(isinstance(x, str) and x in VALID_LEGS for x in legs)):
            errors.append(f"state.legs_tried 元素必须 ⊆ {sorted(VALID_LEGS)}，实际 {legs!r}")

    cookies = state.get("cookies")
    if cookies is not None:
        if not isinstance(cookies, dict):
            errors.append(f"state.cookies 应为 dict，实际 {type(cookies).__name__}")
        else:
            for k, v in cookies.items():
                if not isinstance(k, str) or not isinstance(v, str):
                    errors.append(f"state.cookies 键值必须为 str：{k!r}:{v!r}")
                    break

    created_at = state.get("created_at")
    if created_at is not None:
        try:
            datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        except ValueError:
            errors.append(f"state.created_at 无法解析：{created_at!r}")

    return Report(ok=not errors, errors=errors, warnings=warnings)


def assert_ok(report: Report) -> None:
    if not report.ok:
        raise RuntimeError("; ".join(report.errors))
