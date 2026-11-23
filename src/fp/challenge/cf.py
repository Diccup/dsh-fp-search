"""Cloudflare / Turnstile 求解（CDP 版，五态诊断状态机）。

五态：interstitial / managed / turnstile-iframe / passed / blocked
按 title、cf-wrapper、challenge-running、cf-turnstile 等 DOM 特征判定，
每态进入时间与截图/停留文本落盘到项目内 diag/ 目录；
blocked 与超时才走 reload 重试（保留 cookie，user-data-dir 不清）。
"""
from __future__ import annotations
import base64
import random
import time
from pathlib import Path
from typing import Any, Optional

from providers.mouse import bezier_path

try:  # 缓存复用（t4）：模块缺席时优雅降级
    from support.cf_cache import get as _cache_get, save as _cache_save
except Exception:  # pragma: no cover
    _cache_get = None
    _cache_save = None


def _inject_cached_cookies(session, cookie_str: str, url: str) -> None:
    """把缓存里的 cf_clearance 等 cookie 真种进浏览器（no-Cookie 复用的关键）。

    之前缓存命中只 return True，cookie 根本没进浏览器（每次都是新 user-data-dir）
    → 复用一直无效，请求仍撞 CF。这里按 document.cookie 的 "a=1; b=2" 格式解析，
    用 Network.setCookie 以页面 origin 落，回退到 document.cookie 赋值。
    """
    if not cookie_str:
        return
    origin = url.split("?")[0]
    for pair in str(cookie_str).split(";"):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        name, _, value = pair.partition("=")
        name, value = name.strip(), value.strip()
        if not name:
            continue
        try:
            session.call("Network.setCookie", {
                "name": name, "value": value, "url": origin, "path": "/",
            })
        except Exception:
            try:
                session.evaluate(f"document.cookie={name!r}+'='+{value!r}+'; path=/'")
            except Exception:
                pass

BASE = Path(__file__).resolve().parents[1]
DIAG_DIR = BASE / "diag"

# 挑战页标题/正文特征（含中文 CF 页面）
BLOCK_TITLES = (
    "just a moment", "请稍候", "checking your browser", "attention required",
    "one more step", "安全验证", "正在进行安全验证", "verify you are human",
    "确认您是真人", "enable javascript", "ddos-guard",
)
INTERSTITIAL_MARKERS = (
    "cf-wrapper", "cf-browser-verification", "cf_chl_opt", "cf-please-wait", "challenge-form",
)
MANAGED_MARKERS = (
    "challenge-running", "cf-chl-platform", "cf-chl-waiting", "cf-challenge",
)
TOKEN_SELECTORS = (
    'input[name="cf-turnstile-response"]',
    'input[name="cf_captcha_kind"]',
    'textarea[name="cf-turnstile-response"]',
)
MAX_WAIT = 30.0
BACKOFF_BASE = 0.25
BACKOFF_CAP = 8.0
MANAGED_BACKOFF_BASE = 0.2
MANAGED_BACKOFF_CAP = 6.0

# 五态
INTERSTITIAL = "interstitial"
MANAGED = "managed"
TURNSTILE_IFRAME = "turnstile-iframe"
PASSED = "passed"
BLOCKED = "blocked"

# 状态进入时间戳（状态 -> 首次进入时刻），用于算停留时长
_state_entered: dict[str, float] = {}
_last_state: Optional[str] = None


# ------------------------------------------------------------------ 页面读取

def _evaluate(session, expr: str, default: Any = "") -> Any:
    try:
        value = session.evaluate(expr)
        return default if value is None else value
    except Exception:
        return default


def _page_html(session) -> str:
    return str(_evaluate(session, "document.documentElement.outerHTML", "") or "")


def title(session) -> str:
    return str(_evaluate(session, "document.title", "") or "")


def body_len(session) -> int:
    return int(_evaluate(session, "document.body ? document.body.innerText.length : 0", 0) or 0)


def token(session) -> str:
    for sel in TOKEN_SELECTORS:
        value = _evaluate(
            session,
            f'(document.querySelector({sel!r}) || {{}}).value || ""',
            "",
        )
        if value:
            return str(value)
    return ""


def _has_turnstile_iframe(html: str) -> bool:
    """旧 detect() 兼容：iframe 存在即认定为 turnstile-iframe（最先判定）。
    避免“人机验证”标题/CF 级别把 widget 误判成 interstitial。
    """
    low = html.lower()
    return "cf-turnstile" in low or "challenges.cloudflare.com" in low

# ------------------------------------------------------------------ 五态判定

def detect_state(session) -> str:
    """返回五态之一：interstitial / managed / turnstile-iframe / passed / blocked。"""
    if token(session):
        return PASSED
    html = _page_html(session).lower()
    # 兼容旧 detect(): iframe 存在即 turnstile-iframe，必须先于标题/级别判定
    if _has_turnstile_iframe(html):
        return TURNSTILE_IFRAME
    t = title(session).lower()
    if any(b in t for b in BLOCK_TITLES) or "cf-wrapper" in html or "just a moment" in html:
        return INTERSTITIAL
    if any(m in html for m in MANAGED_MARKERS):
        return MANAGED
    if "cf-turnstile" in html or "challenges.cloudflare.com" in html or "turnstile" in html:
        return TURNSTILE_IFRAME
    if body_len(session) > 200:
        return PASSED
    return BLOCKED


def challenge_ready(session) -> str:
    """挑战页就绪检查：验证页是否真的把挑战内容渲染出来了。

    返回 "" 表示挑战已就绪、可以继续解；
    否则返回一条简短诊断（说明卡在哪一步），让调用方能区分
    「挑战页根本没加载（空白/静态桩）」与「挑战已加载但没解过」——
    否则两种失败都报成笼统错，根本分不出是哪一步错。
    """
    st = detect_state(session)
    if st == PASSED:
        return ""
    html = _page_html(session)
    low = html.lower()
    bl = body_len(session)
    if st == TURNSTILE_IFRAME:
        # 真 Turnstile 挑战必须有 widget iframe（challenges.cloudflare.com 或 cf-turnstile）。
        # 页面只有 "Cloudflare Turnstile" 文字/label 而无 iframe = 静态桩（如 nopecha demo）。
        if "challenges.cloudflare.com" in low or "cf-turnstile" in low:
            return ""
        return "challenge not loaded: turnstile widget iframe absent (static label only)"
    if st in (INTERSTITIAL, MANAGED):
        # interstitial/managed 必须真渲染出 CF 挑战内容（正文有字，或带 CF 挑战渲染标记）。
        # 注意：标题 "just a moment" 只代表页面在挑战页，不代表挑战内容渲染出来了——
        # 空白 interstitial（正文空、无 CF 标记）就是挑战没加载，要报出来。
        if bl > 40:
            return ""
        if any(m in low for m in INTERSTITIAL_MARKERS):
            return ""
        if any(m in low for m in MANAGED_MARKERS):
            return ""
        return f"challenge not loaded: blank interstitial (no CF markers, body={bl})"
    if st == "blocked":
        return f"challenge not loaded: blocked (blank page, body={bl})"
    return f"challenge not loaded: unknown state {st!r}"


def detect(session) -> Optional[str]:
    """兼容旧入口：返回 "widget"/"interstitial"/None。"""
    st = detect_state(session)
    if st == PASSED:
        return None
    if st == TURNSTILE_IFRAME:
        return "widget"
    if st == INTERSTITIAL:
        return "interstitial"
    return None


# ------------------------------------------------------------------ 诊断落盘

def record_state(session, state: str, text: str = "") -> None:
    """把状态进入时间、停留文本与截图落盘到 diag/；截图失败不抛。"""
    now = time.time()
    if state not in _state_entered:
        _state_entered[state] = now
    entered = _state_entered[state]
    dwell = now - entered
    try:
        DIAG_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        return
    ts = time.strftime("%Y%m%d_%H%M%S", time.localtime(now))
    stem = f"cf_{state}_{ts}"
    info = (
        f"state={state}\n"
        f"entered={entered:.3f} now={now:.3f} dwell={dwell:.3f}\n"
        f"title={title(session)}\n"
        f"body_len={body_len(session)}\n"
        f"token={bool(token(session))}\n"
        f"{text}\n"
    )
    try:
        (DIAG_DIR / f"{stem}.txt").write_text(info, encoding="utf-8")
    except Exception:
        pass
    try:
        data = session.call("Page.captureScreenshot", {"format": "png"})
        if isinstance(data, str) and data:
            (DIAG_DIR / f"{stem}.png").write_bytes(base64.b64decode(data))
    except Exception:
        pass


# ------------------------------------------------------------------ 元素定位

def _iframe_rect(session) -> Optional[dict]:
    """找 Turnstile iframe 的可视矩形，穿透 shadow DOM 与 turnstile 容器。"""
    js = """(() => {
        const walk = (root, out) => {
            const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const el of nodes) {
                if (el.tagName === 'IFRAME' && (el.src || '').includes('challenges.cloudflare.com')) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                        out.push({x: r.x, y: r.y, width: r.width, height: r.height});
                    }
                }
                if (el.shadowRoot) walk(el.shadowRoot, out);
            }
        };
        const out = [];
        walk(document, out);
        return out.length ? out[0] : null;
    })()"""
    return _evaluate(session, js, None)


def _move_mouse(session, start, end, steps: int = 24) -> None:
    """真人速度的贝塞尔滑入：≈2s 內緩慢滑動到目標附近 (step 時間放大) — 避過
    過快滑動觸發 CF 的非人類軌跡檢測。"""
    for x, y in bezier_path(start, end, steps=steps):
        try:
            session.call("Input.dispatchMouseEvent",
                         {"type": "mouseMoved", "x": int(x), "y": int(y), "buttons": 0})
        except Exception:
            return
        time.sleep(random.uniform(0.06, 0.12))


def _click(session, x: int, y: int) -> None:
    for kind in ("mousePressed", "mouseReleased"):
        try:
            session.call("Input.dispatchMouseEvent", {
                "type": kind, "x": int(x), "y": int(y),
                "button": "left", "buttons": 1 if kind == "mousePressed" else 0,
                "clickCount": 1,
            })
        except Exception:
            pass
    time.sleep(random.uniform(0.05, 0.12))


def click_widget(session) -> bool:
    """点击 Turnstile 复选框（坐标相对 iframe 左上角约 30,32）。"""
    rect = _iframe_rect(session)
    if not rect:
        return False
    x = int(rect["x"] + 30 + random.uniform(-2, 2))
    y = int(rect["y"] + 32 + random.uniform(-2, 2))
    _move_mouse(session, (int(rect["x"] + random.uniform(0, 10)),
                          int(rect["y"] + random.uniform(0, 10))), (x, y))
    _click(session, x, y)
    return True


# ------------------------------------------------------------------ 等待

def _poll_token(session, deadline: float) -> bool:
    """轮询 cf-turnstile-response token，出现即返回 True。"""
    while time.time() < deadline:
        if token(session):
            return True
        time.sleep(0.25)
    return bool(token(session))


def wait_clear(session, timeout: float = MAX_WAIT) -> bool:
    """状态机轮询直到 passed；blocked/超时返回 False，由 solve 决定是否 reload。

    每态首次进入会落盘诊断（进入时间 + 停留文本 + 截图）。
    """
    global _last_state
    start = time.time()
    deadline = start + timeout
    _last_state = None
    while time.time() < deadline:
        st = detect_state(session)
        if st == PASSED:
            _last_state = None
            return True
        if st != _last_state:
            record_state(session, st)
            _last_state = st
        if st == BLOCKED:
            break
        time.sleep(0.25)
    return False


# ------------------------------------------------------------------ 入口

def solve(session, max_attempts: int = 3, wait: float = MAX_WAIT,
         url: str = "", ua: str = "") -> bool:
    """尽力求解 CF 挑战；返回是否已通过。

    先查缓存：命中未过期直接 True（跳过挑战）。
    passed 直接返回；turnstile-iframe 走等待->点击->等待；
    interstitial/managed 走 wait_clear；blocked 与超时 reload 一次重试
    （cookie 由 user-data-dir 持久化，不丢失）。
    """
    # 缓存命中：未过期直接跳过
    try:
        if _cache_get is not None and url:
            cached = _cache_get(url, ua)
            if cached:
                # no-Cookie 复用关键：必须把缓存 cookie 真种进浏览器，否则命中也没用
                _inject_cached_cookies(session, cached.get("cookies", ""), url)
                return True
    except Exception:
        pass
    for attempt in range(max_attempts):
        st = detect_state(session)
        if st == PASSED:
            # 过验成功：持久化 cookie/UA/时间戳
            try:
                if _cache_save is not None and url:
                    cookies = _evaluate(session, "document.cookie", "")
                    _cache_save(url, cookies, ua)
            except Exception:
                pass
            return True
        if st == TURNSTILE_IFRAME:
            if click_widget(session) and wait_clear(session, min(wait, 15.0)):
                return True
            continue
        if wait_clear(session, wait):
            return True
        # blocked 或超时：reload 一次，cookie 保留
        if attempt < max_attempts - 1:
            try:
                session.evaluate("location.reload()")
            except Exception:
                pass
            time.sleep(min(2.0 + attempt * 0.5, 5.0))
            time.sleep(0.5)
    return detect_state(session) == PASSED
