"""装配器：13 槽位画像装配。"""
from __future__ import annotations
import zlib
from datetime import datetime, timezone
from typing import Any, Dict

from providers.browser import browser_profile
from providers.screen import screen_profile
from providers.mouse import mouse_profile
from providers.keyboard import keyboard_profile
from providers.scroll import scroll_profile
from providers.timing import timing_profile
from providers.network import network_profile
from providers.tls import tls_profile
from providers.http2 import http2_profile
from providers.headers import headers
from providers.session import session_profile
from providers.noise import noise_profile
from providers.font import font_profile
from support.coherence import check_static, Report
from support.rng import make_rng
from support.store import save_persona, save_state


def _tls(browser: dict) -> dict:
    try:
        return tls_profile(browser)
    except TypeError:
        return tls_profile()


def plan(url: str, policy: dict | None = None) -> dict:
    policy = policy or {}
    if "seed" in policy and policy.get("seed") is not None:
        seed = int(policy["seed"])
    else:
        seed = zlib.crc32(url.encode("utf-8")) & 0xFFFFFFFF
    legs = policy.get("legs", [])
    timeout = policy.get("timeout", 30)
    return {"url": url, "policy": policy, "seed": seed, "legs": legs, "timeout": timeout}


def assemble(spec: dict) -> dict:
    spec = spec or {}
    seed = spec.get("seed", 0)
    url = spec.get("url", "")
    rng = make_rng(seed)
    browser = browser_profile(seed)
    screen = screen_profile(seed)
    mouse = mouse_profile(seed)
    keyboard = keyboard_profile(seed)
    scroll = scroll_profile(seed)
    timing = timing_profile(seed)
    network = network_profile(seed)
    tls = _tls(browser)
    http2 = http2_profile()
    hdrs = headers({"browser": browser})
    session = session_profile(seed)
    noise = noise_profile(seed)
    font = font_profile(browser.get("platform", "Windows"))
    persona = {
        "browser": browser,
        "screen": screen,
        "mouse": mouse,
        "keyboard": keyboard,
        "scroll": scroll,
        "timing": timing,
        "network": network,
        "tls": tls,
        "http2": http2,
        "headers": hdrs,
        "session": session,
        "noise": noise,
        "font": font,
        "persona_version": 1,
        "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "seed": seed,
        "url": url,
    }
    warnings: list[str] = []
    return {"spec": spec, "persona": persona, "rng": rng, "warnings": warnings}


def check(persona: dict) -> Report:
    return check_static(persona)


def save_session_head(url: str, policy: dict | None, base_dir) -> dict:
    from pathlib import Path
    base_dir = Path(base_dir)
    spec = plan(url, policy)
    assembled = assemble(spec)
    report = check(assembled["persona"])
    if not report.ok:
        raise RuntimeError("coherence failed: " + "; ".join(report.errors))
    save_persona(base_dir / "persona.json", assembled["persona"])
    state = {
        "persona_version": 1,
        "created_at": assembled["persona"].get("created_at"),
        "mouse": {"x": 0, "y": 0},
        "visited": [url],
        "legs_tried": [],
        "cookies": {},
    }
    save_state(base_dir / "persona.state.json", state)
    return state


def evolve(persona: dict, action: dict) -> dict:
    import copy
    p = copy.deepcopy(persona or {})
    screen = p.get("screen", {}) or {}
    w = screen.get("width", 1920)
    h = screen.get("height", 1080)
    action = action or {}
    if "hover" in action:
        x, y = action["hover"]
        x = max(0, min(int(x), w))
        y = max(0, min(int(y), h))
        p.setdefault("mouse", {}).setdefault("movement", {})["last_hover"] = (x, y)
    if "scroll" in action:
        px = int(action["scroll"])
        scroll = p.setdefault("scroll", {})
        cur = scroll.get("step_px", 0)
        new = max(0, min(cur + px, h))
        scroll["step_px"] = new if new > 0 else scroll.get("step_px", 300)
    if "click" in action:
        x, y = action["click"]
        x = max(0, min(int(x), w))
        y = max(0, min(int(y), h))
        p.setdefault("mouse", {}).setdefault("click", {})["last_click"] = (x, y)
    return p
