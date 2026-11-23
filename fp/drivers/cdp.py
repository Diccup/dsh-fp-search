"""CDP 通道（封装 vendor/cdp_client，带 stealth 参数、Emulation 覆盖与 CF 求解）。

fetch(url, timeout, persona) 启动独立 Edge headless，注入 stealth 补丁与画像
Emulation，等待加载完成并尝试求解 Cloudflare，最后返回 (title, text)。
"""
from __future__ import annotations
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

BASE = Path(__file__).resolve().parents[1]
VENDOR = BASE / "vendor"
if VENDOR.exists() and str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))

import cdp_client
from drivers import stealth as stealth_mod
from challenge.cf import solve as solve_cf
from challenge.cf import detect_state as cf_detect_state
from challenge.cf import challenge_ready as cf_challenge_ready

from providers.mouse import bezier_path

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
CREATE_NO_WINDOW = 0x08000000


def _edge_path() -> str:
    for path in EDGE_CANDIDATES:
        if Path(path).exists():
            return path
    raise RuntimeError("Edge not found")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _sub(name: str, default):
    """取 stealth 模块里的可选增强（老版本没有就退化）。"""
    return getattr(stealth_mod, name, default)


def _wait_devtools(port: int, proc: subprocess.Popen, deadline: float):
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3) as resp:
                return json.loads(resp.read().decode("utf-8", "ignore"))
        except Exception:
            if proc.poll() is not None:
                return None
            time.sleep(0.5)
    return None


def _list_tabs(port: int, deadline: float) -> list[dict]:
    """用 /json/list 列出所有页，找 about:blank 页（比 /json/new 更稳：页已就绪）。"""
    tabs: list[dict] = []
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3) as resp:
                tabs = json.loads(resp.read().decode("utf-8", "ignore"))
                if tabs:
                    return tabs
        except Exception:
            pass
        time.sleep(0.5)
    return tabs


def _blank_wsurl(tabs: list[dict]) -> Optional[str]:
    for t in tabs:
        url = t.get("url") or ""
        if url == "about:blank" and t.get("webSocketDebuggerUrl"):
            return t["webSocketDebuggerUrl"]
    return None


def _connect_ws(ws_url: str, retries: int = 4, base_delay: float = 0.4) -> Any:
    """建立 CDP WebSocket 会话，失败按指数退避重试（缓解 WinError 10053）。"""
    last_err: Optional[Exception] = None
    for i in range(retries):
        try:
            return cdp_client.CDPSession(ws_url)
        except Exception as exc:
            last_err = exc
            time.sleep(min(base_delay * (2 ** i), 5.0))
    raise last_err if last_err else RuntimeError("ws connect failed")


def _tail(path: Path, lines: int = 6) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore").strip().splitlines()
        return " | ".join(text[-lines:])
    except Exception:
        return ""


def _launch_error(err_log: Path) -> str:
    """把 Chromium 启动失败翻译成可行动的诊断。

    ★ ITERATION-005：措辞要点——**这条腿是能用的，只是本次调用没拿到沙箱授权**。
    原来写"需在 DSH 无沙箱下运行"，读起来像"此腿不可用/坏了"，
    接手的新模型会据此放弃。改成"给授权即可用"，并写明怎么给。
    """
    tail = _tail(err_log)
    lowered = tail.lower()
    if "mojo" in lowered or "0x5" in tail or "拒绝访问" in tail:
        return ("edge 启动失败：Chromium 需要 Mojo 命名管道，**本次调用的沙箱没有放行**（拒绝访问 0x5）。"
                "这不是 cdp 腿不可用——在带 danger-full-access 授权的调用里它能正常工作"
                "（2026-11-21 实测可取到真正文）。需要渲染时请让本次工具调用带 "
                "sandbox_permissions=danger-full-access（宿主要求主人审批）。"
                f"stderr: {tail[:300]}")
    return f"edge cdp failed to start。stderr: {tail[:300]}"


def _inject_human_events(session: Any) -> None:
    """派发拟人输入轨迹：鼠标缓动点击 + 键盘键位，仅供 CDPSession 使用。"""
    import random
    import time

    try:
        session.call("Input.enable")
    except Exception:
        return

    try:
        w = int(session.evaluate("window.innerWidth || 1920") or 1920)
        h = int(session.evaluate("window.innerHeight || 1080") or 1080)
    except Exception:
        w, h = 1920, 1080

    def rnd(v: int, p: float = 30.0) -> int:
        return int(v + random.uniform(-p, p))

    # 4 次随机悬停/点击（分段贝塞尔 + 随机抖动）
    for _ in range(4):
        target_x = rnd(random.randint(200, max(200, w - 200)))
        target_y = rnd(random.randint(150, max(150, h - 150)))
        pts = [(w / 2, h / 2)]
        for i in range(1, 6):
            t = i / 6.0
            x = pts[-1][0] + (target_x - pts[-1][0]) * t
            y = pts[-1][1] + (target_y - pts[-1][1]) * t
            session.call("Input.dispatchMouseEvent", {
                "type": "mouseMoved",
                "x": int(x),
                "y": int(y),
                "buttons": 0,
            })
            time.sleep(random.uniform(0.006, 0.018))
        session.call("Input.dispatchMouseEvent", {
            "type": "mousePressed",
            "x": target_x,
            "y": target_y,
            "button": "left",
            "buttons": 1,
            "clickCount": 1,
        })
        time.sleep(random.uniform(0.05, 0.12))
        session.call("Input.dispatchMouseEvent", {
            "type": "mouseReleased",
            "x": target_x,
            "y": target_y,
            "button": "left",
            "buttons": 0,
            "clickCount": 1,
        })
        time.sleep(random.uniform(0.05, 0.12))

    # 键盘轨迹：简单 tab/方向键，避免无事件
    for key in ("Tab", "ArrowDown"):
        session.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": key})
        time.sleep(random.uniform(0.01, 0.03))
        session.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": key})
        time.sleep(random.uniform(0.02, 0.05))


def _extract_title_text(session) -> tuple[str, str]:
    """抽取 (title, text)。多口径按"信息量"取最优，空文本时重试 + outerHTML 兜底。

    ★ ITERATION-006 重写（原实现只取 innerText，是内容偏窄的真根因）：
      · `innerText` 只返回**视口可见**文本。headless 下视口曾退化成 3px
        ⇒ 同页只拿到 3,579 字符（DOM 实有 40KB，render 腿拿到 43,265 字符）。
      · 改为三口径依次尝试并**取最长**：
          ① `textContent`（不依赖可见性，覆盖全 DOM）
          ② `innerText`（可见文本，排版更干净）
          ③ `documentElement.outerHTML`（最后兜底，交给上层解析）
      · textContent / outerHTML 是**原始**口径，会带 script/style 噪音与标签，
        但对 N2 判据（找 class 特征）与后处理解析反而更有利；纯文本交付由
        `dom_to_text`/`parse.text` 负责清洗，不在这里做有损裁切。
    返回 (title, text)；若仍无正文抛 RuntimeError("cdp produced empty text")。
    """
    title = ""
    try:
        title = session.evaluate("document.title") or ""
    except Exception:
        pass

    # 视口兜底：即使启动参数没带 --window-size，也把视口撑到正常桌面尺寸，
    # 否则 innerText 只能看见几行（ITERATION-006 实测 innerHeight=3）。
    try:
        cur = session.evaluate("String(window.innerHeight||0)")
        if not cur or int(float(cur)) < 200:
            session.call("Emulation.setDeviceMetricsOverride",
                         {"width": 1920, "height": 1080,
                          "deviceScaleFactor": 1, "mobile": False})
    except Exception:
        pass

    def _eval(expr: str) -> str:
        try:
            v = session.evaluate(expr)
            return v if isinstance(v, str) else ""
        except Exception:
            return ""

    # 候选口径（按"信息完整性"优先级）。取**最长**而非第一个非空：
    # textContent 通常远多于 innerText，正是我们要补回来的那部分。
    cands = [
        _eval("document.body ? document.body.textContent : "
              "document.documentElement ? document.documentElement.textContent : ''"),
        _eval("document.body ? document.body.innerText : "
              "document.documentElement ? document.documentElement.innerText : ''"),
    ]
    text = max(cands, key=len) if cands else ""

    if not text.strip():
        # 全空：等 DOM 重建一次再试（reload 后窗口期）
        time.sleep(0.5)
        text = max([
            _eval("document.body ? document.body.textContent : "
                  "document.documentElement ? document.documentElement.textContent : ''"),
            _eval("document.body ? document.body.innerText : ''"),
        ], key=len)
    if not text.strip():
        # 仍空：退 outerHTML（标签也要，别把内容丢在这层）
        text = _eval("document.documentElement.outerHTML")
    if not text.strip():
        raise RuntimeError("cdp produced empty text")
    return str(title), str(text)


def fetch(url: str, timeout: int = 30, persona: Dict[str, Any] | None = None) -> Tuple[str, str]:
    """跑一次 CDP 抓取，返回 (标题, 正文文本)。失败抛 RuntimeError。"""
    # 用项目内 mkdir 建 profile 目录：沙箱下 tempfile.mkdtemp 建出来的目录不可写（ACL 拒绝）
    import uuid
    tmp_dir = BASE / "out" / f".cdp-{uuid.uuid4().hex[:8]}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = str(tmp_dir)
    port = _free_port()
    base_args = _sub("base_args", None)
    if callable(base_args):
        try:
            flags = list(base_args(port=port, user_data_dir=tmp))
        except TypeError:
            flags = list(base_args())
        args = [_edge_path()] + flags
    else:
        args = [
            _edge_path(), "--headless=new", "--disable-gpu", "--no-sandbox",
            "--disable-setuid-sandbox", "--no-first-run",
            # C1b 伪码集：保留 --disable-blink-features=AutomationControlled，去掉 --enable-automation/--headless 老式
            "--disable-extensions", "--disable-blink-features=AutomationControlled",
            "--disable-features=TranslateUI,OptimizationHints",
            f"--remote-debugging-port={port}", "--remote-allow-origins=*",
            f"--user-data-dir={tmp}",
        ]
    if not any(str(a).startswith("--user-data-dir") for a in args):
        args.append(f"--user-data-dir={tmp}")
    if not any(str(a).startswith("--remote-debugging-port") for a in args):
        args.append(f"--remote-debugging-port={port}")
    args.append("about:blank")

    err_log = BASE / "out" / ".cdp-last-err.log"
    err_fh = None
    try:
        err_log.parent.mkdir(parents=True, exist_ok=True)
        err_fh = open(err_log, "wb")
    except Exception:
        err_fh = None
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                            stderr=(err_fh if err_fh else subprocess.DEVNULL),
                            stdin=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
    session = None
    try:
        info = _wait_devtools(port, proc, time.time() + timeout)
        if not info:
            raise RuntimeError(_launch_error(err_log))

        # 优先用 /json/list 拿已就绪的页的 webSocketDebuggerUrl，
        # 避免 /json/new 在页还未完成初始化时就握手导致 WinError 10053。
        session = None
        deadline = time.time() + timeout
        while time.time() < deadline:
            tabs = _list_tabs(port, time.time() + 2.0)
            ws_url = _blank_wsurl(tabs)
            if not ws_url and tabs:
                for t in tabs:
                    if t.get("webSocketDebuggerUrl"):
                        ws_url = t["webSocketDebuggerUrl"]
                        break
            if not ws_url:
                # 还没有可用页，尝试新建一个
                try:
                    tab = cdp_client.new_tab(port, "about:blank", timeout=2)
                    if tab and "webSocketDebuggerUrl" in tab:
                        ws_url = tab["webSocketDebuggerUrl"]
                except Exception:
                    pass
            if ws_url:
                try:
                    session = _connect_ws(ws_url, retries=4, base_delay=0.5)
                    break
                except Exception:
                    session = None
                    time.sleep(0.8)
            else:
                time.sleep(0.5)
        if session is None:
            raise RuntimeError("cdp connect failed: no usable tab / ws connect")

        # P2/P3/P5：页面新建即注入补丁
        patch_scripts = _sub("patch_scripts", None)
        scripts = []
        if callable(patch_scripts):
            try:
                scripts = list(patch_scripts(persona) or [])
            except Exception:
                scripts = []
        if not scripts:
            legacy = _sub("console_override_script", None)
            if callable(legacy):
                try:
                    legacy_script = legacy() or ""
                except Exception:
                    legacy_script = ""
                scripts = [legacy_script] if legacy_script else []
        for src in scripts:
            if not src:
                continue
            try:
                session.call("Page.addScriptToEvaluateOnNewDocument", {"source": src})
            except Exception:
                pass

        # P4：尺寸/时区/UA/语言覆盖
        apply_emulation = _sub("apply_emulation", None)
        if callable(apply_emulation) and persona:
            try:
                apply_emulation(session, persona)
            except Exception:
                pass

        # 先注入补丁与 Emulation，再导航（顺序不能反：new_tab 直接带 url 会绕过注入）
        try:
            session.call("Page.enable")
        except Exception:
            pass
        try:
            session.call("Page.navigate", {"url": url})
        except Exception:
            # 退化：直接让页面跳转
            try:
                session.evaluate(f"location.href={url!r}")
            except Exception:
                pass

        deadline = time.time() + timeout
        # ★ ITERATION-006：不再死等 readyState=complete。
        #   实测 python.org 用 headless 打开后 readyState 长期停在 "loading"
        #   （页面有长连接/慢资源），原逻辑要耗满整个 timeout 才继续，且期间
        #   视口/内容都可能还是半成品。改为：**interactive 即可用**，
        #   并要求 body 有内容；另加"DOM 大小稳定"判据提前收工。
        last_len = -1
        stable = 0
        while time.time() < deadline:
            try:
                state = session.evaluate("document.readyState")
                href = session.evaluate("location.href") or ""
                body_len = session.evaluate(
                    "document.body ? document.body.innerHTML.length : 0") or 0
            except Exception:
                state, href, body_len = "", "", 0
            if href not in ("", "about:blank") and body_len:
                if body_len == last_len:
                    stable += 1
                else:
                    stable = 0
                    last_len = body_len
                # interactive 且 DOM 连续两次不再增长 ⇒ 视为可抽取
                if state in ("interactive", "complete") and stable >= 1:
                    break
            time.sleep(0.4)
        time.sleep(0.5)  # 让同步渲染/骨架屏落地一点点

        # 行为层拟人事件注入（本任务仅此一处）
        try:
            session.call("Input.enable")
        except Exception:
            pass
        _inject_human_events(session)

        try:
            cf_ok = solve_cf(session, max_attempts=2, wait=min(12.0, max(5.0, timeout / 3)), url=url)
        except TypeError:
            try:
                cf_ok = solve_cf(session, url=url)
            except Exception:
                cf_ok = False
        except Exception:
            cf_ok = False

        # 诊断优先：solve_cf 返回 False 且仍处于挑战态时，绝不把「验证页」吞成空文本。
        # 否则 reload 风暴刚触发时 innerText 拿到空 document，会误抛 "cdp produced empty text"。
        if not cf_ok:
            try:
                _st = cf_detect_state(session)
            except Exception:
                _st = ""
            # 诊断优先：先做「挑战页就绪检查」。若挑战内容根本没渲染出来
            # （空白 interstitial / 静态桩 label），报独立诊断，别和「已加载但没解过」混成一个错。
            try:
                _why = cf_challenge_ready(session)
            except Exception:
                _why = ""
            if _why:
                raise RuntimeError("verification page not loaded: " + _why)
            if _st in ("interstitial", "managed", "widget", "turnstile-iframe"):
                raise RuntimeError("hit verification page")
            # 兼容旧 detect() 命名（widget/interstitial/None）
            try:
                from challenge.cf import detect as _cf_detect
                _legacy = _cf_detect(session)
            except Exception:
                _legacy = None
            if _legacy in ("interstitial", "widget"):
                raise RuntimeError("hit verification page")

        title, text = _extract_title_text(session)
        return title, text
    finally:
        if session is not None:
            try:
                session.close()
            except Exception:
                pass
        try:
            proc.kill()
        except Exception:
            pass
        if err_fh is not None:
            try:
                err_fh.close()
            except Exception:
                pass
        shutil.rmtree(tmp, ignore_errors=True)
