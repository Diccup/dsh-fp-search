# -*- coding: utf-8 -*-
"""
page_render.py —— 无头浏览器渲染取正文（JS 页面专用抓取层）

为什么需要：
  DSH 内置的 web page 工具只做「HTTP GET + 剥标签」，页面内容由 JS 注入时读不到正文。
  本工具调用本机 Edge/Chrome 的 headless --dump-dom 真渲染一遍再取文本，
  与 waf_fetch.py 组成两条互补的抓取腿：
    waf_fetch.py   → 纯 HTTP 层，解阿里云 WAF 的 acw_sc__v2 JS 挑战
    page_render.py → 浏览器层，JS 渲染完的 DOM 文本

用法：
  python page_render.py <URL> [-o FILE] [--wait MS] [--timeout SEC]
                        [--keep-html FILE] [--probe] [--max-chars N]
  python page_render.py <URL> --probe      # 只报可达性/渲染状态，不输出正文

退出码：
  0 成功（正文已输出/落盘）
  2 渲染失败（浏览器跑了但 DOM 为空或只有错误页）
  3 网络不可达（域名解析/连接失败，非反爬）
  4 找不到可用浏览器（Edge/Chrome 都没装）
  5 命中人机验证/限流（页面在，但内容是验证壳）——此时该走 waf_fetch 或带 cookie 会话

⚠️ 需要 DSH 文件沙箱【放行】（danger-full-access 授权）才能跑：
  Chromium 的多进程模型在默认沙箱内会被系统拦（crashpad / mojo platform_channel 报
  「拒绝访问 0x5」，--single-process 也不行）。
  ★ 不是"此腿不可用"——沙箱外/给授权后同一条命令正常（2026-11-21 实测：
    python.org/about 渲染成功、正文 43,265 字符）。
  ★ 怎么用：让本次工具调用带 sandbox_permissions=danger-full-access
    （宿主要求主人审批；插件子进程无法自我升权）。没授权时会失败并降级到 http/waf/tls。

坑：
  - stdout/stderr 必须直接重定向到【文件】，不能用 PIPE —— 沙箱内管道捕获是 EPERM 边界。
  - DOM 输出是 UTF-8 字节流，按字节读再 decode，不要让 PowerShell 二次转码。
  - --virtual-time-budget 是渲染等待上限，JS 多的页面给 8000~15000ms。
  - 只读公开页面，不绕验证码、不碰付费墙。
"""
import sys, os, re, html, subprocess, tempfile, argparse, shutil, socket, time, uuid


def _mkworkdir(prefix: str = "pagerender_") -> str:
    """工作目录用项目内 mkdir 建。

    沙箱下 tempfile.mkdtemp 建出的目录 mode 0o700，后续写 dom.html 会被拒
    （Permission denied / WinError 5），所以这里走 mkdir 继承正常 ACL。
    """
    base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "out", ".tmp")
    try:
        os.makedirs(base, exist_ok=True)
        path = os.path.join(base, prefix + uuid.uuid4().hex[:8])
        os.makedirs(path, exist_ok=True)
        return path
    except Exception:
        return tempfile.mkdtemp(prefix=prefix)

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]

# 中文站常见「伪 200」限流/人机验证话术
BLOCK_WORDS = [
    "安全验证", "人机验证", "拖动滑块", "滑动验证", "验证码", "访问异常",
    "暂时受到限制", "访问过于频繁", "请求过于频繁", "操作太频繁",
    "请完成下方验证", "网络不给力", "异常，暂时限制", "Access Denied",
    "Just a moment", "Checking your browser", "Enable JavaScript",
]

NET_ERR_MARKERS = [
    "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION", "ERR_INTERNET_DISCONNECTED",
    "ERR_PROXY", "ERR_TIMED_OUT", "ERR_ADDRESS_UNREACHABLE", "ERR_SSL",
]

# 🕷️ 反检测启动参数（移植自 Scrapling 的 scrapling/engines/constants.py，
#    BSD-3-Clause, 思路借鉴、参数逐条对照）。作用：抹掉 headless/自动化特征。
#    已知与本工具直接冲突的两条不放进来：
#      --disable-extensions  → 会拦掉我们不需要的扩展但也可能触发检测；保留 Scrapling 的 HARMFUL_ARGS 原样（它把它列为「有害」要忽略）
#      --enable-automation   → 明确暴露自动化，禁用
STEALTH_ARGS = [
    "--disable-blink-features=AutomationControlled",  # 去掉 navigator.webdriver 标记（最关键）
    "--test-type",                                     # 跳过首启检查，行为更像真实浏览器
    "--mute-audio",
    "--disable-sync",
    "--hide-scrollbars",
    "--disable-logging",
    "--disable-translate",
    "--disable-voice-input",
    "--no-pings",
    "--no-first-run",
    "--disable-infobars",
    "--disable-breakpad",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-search-engine-choice-screen",
    "--disable-features=Translate,OptimizationHints,MediaRouter,InterestFeedContentSuggestions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-client-side-phishing-detection",
    "--disable-sync-service",
    "--metrics-recording-only",
    "--disable-crash-reporter",
    "--disable-domain-reliability",
    "--disable-partial-raster",
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
    "--disable-ipc-flooding-protection",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-ipc-flooding-protection",
    "--enable-async-dns",
    "--use-mock-keychain",
    "--no-service-autorun",
    "--homepage=about:blank",
    "--password-store=basic",
    "--disable-hang-monitor",
    "--font-render-hinting=none",
    "--force-color-profile=srgb",
    "--aggressive-cache-discard",
    "--disable-cookie-encryption",
    "--disable-back-forward-cache",
    "--enable-surface-synchronization",
    "--disable-image-animation-resync",
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-position=0,0",
    "--disable-wake-on-wifi",
    "--ignore-gpu-blocklist",
    "--enable-tcp-fast-open",
    "--disable-print-preview",
    "--disable-dev-shm-usage",
    "--disable-prompt-on-repost",
    "--disable-offer-upload-credit-cards",
    "--disable-background-networking",
]

CREATE_NO_WINDOW = 0x08000000


def find_browser():
    for path in BROWSERS:
        if os.path.isfile(path):
            return path
    return None


def host_of(url):
    m = re.search(r"https?://([^/:\s]+)", url)
    return m.group(1) if m else url


def render(url, wait_ms, timeout, keep_html):
    """跑一遍 headless 渲染，返回 (dom_text, diag)。"""
    browser = find_browser()
    if browser is None:
        return None, {"code": 4, "msg": "未找到 Edge/Chrome（msedge.exe / chrome.exe）"}

    tmp = _mkworkdir("pagerender_")
    dom_path = os.path.join(tmp, "dom.html")
    err_path = os.path.join(tmp, "err.txt")
    prof = os.path.join(tmp, "prof")
    args = [
        browser, "--headless=new", "--disable-gpu", "--no-first-run",
        "--disable-extensions", "--disable-background-networking",
        "--dump-dom", f"--user-data-dir={prof}",
        f"--virtual-time-budget={wait_ms}", url,
    ]
    diag = {"browser": os.path.basename(browser), "tmp": tmp}
    try:
        with open(dom_path, "wb") as fout, open(err_path, "wb") as ferr:
            proc = subprocess.Popen(
                args, stdout=fout, stderr=ferr,
                stdin=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
            )
            try:
                proc.wait(timeout=timeout)
                diag["exit"] = proc.returncode
            except subprocess.TimeoutExpired:
                proc.kill()
                diag["exit"] = "timeout"
                diag["timeout"] = True

        raw = open(dom_path, "rb").read()
        diag["dom_bytes"] = len(raw)
        dom = raw.decode("utf-8", errors="replace")
        err = open(err_path, "rb").read().decode("utf-8", errors="replace")
        diag["stderr_tail"] = err[-1500:]
        if keep_html:
            with open(keep_html, "wb") as f:
                f.write(raw)
            diag["kept_html"] = keep_html
        return dom, diag
    except Exception as exc:  # noqa: BLE001
        return None, {"code": 2, "msg": f"渲染异常: {exc}"}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def dom_to_text(dom):
    body = re.sub(r"(?is)<(script|style|noscript|svg)\b.*?</\1>", " ", dom)
    body = re.sub(r"(?s)<!--.*?-->", " ", body)
    body = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|h[1-6])>", "\n", body)
    body = re.sub(r"(?s)<[^>]+>", " ", body)
    body = html.unescape(body)
    lines = [re.sub(r"[ \t\u00a0]+", " ", ln).strip() for ln in body.split("\n")]
    out, blank = [], 0
    for ln in lines:
        if not ln:
            blank += 1
            if blank > 1:
                continue
        else:
            blank = 0
        out.append(ln)
    return re.sub(r"\n{2,}", "\n", "\n".join(out)).strip()


def main():
    ap = argparse.ArgumentParser(description="headless 渲染取正文（JS 页面专用）")
    ap.add_argument("url")
    ap.add_argument("-o", "--out", help="正文落盘路径")
    ap.add_argument("--wait", type=int, default=10000, help="渲染等待上限 ms（默认 10000）")
    ap.add_argument("--timeout", type=int, default=90, help="浏览器进程超时秒（默认 90）")
    ap.add_argument("--keep-html", help="把渲染后的 HTML 另存一份")
    ap.add_argument("--max-chars", type=int, default=20000, help="正文最多输出多少字（默认 20000）")
    ap.add_argument("--probe", action="store_true", help="只报状态，不输出正文")
    ap.add_argument("--retry", type=int, default=1,
                    help="渲染出空 DOM 时重试几次（本机出口偶发抖动，默认重试 1 次）")
    args = ap.parse_args()

    url = args.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    dom, diag = None, {}
    attempts = max(0, args.retry) + 1
    for i in range(attempts):
        dom, diag = render(url, args.wait, args.timeout, args.keep_html)
        if dom is None:
            if i + 1 < attempts:
                time.sleep(2)
                continue
            print(f"[FAIL] {host_of(url)} {diag.get('msg', '渲染失败')}")
            return diag.get("code", 2)
        if diag.get("dom_bytes", 0) > 0:
            break
        if i + 1 < attempts:
            time.sleep(2)
    diag.setdefault("attempts", attempts if diag.get("dom_bytes", 0) == 0 else attempts)

    head = f"[{host_of(url)}] {diag.get('browser')} dom={diag.get('dom_bytes')}B exit={diag.get('exit')}"

    # 网络层不可达：DOM 空 + 浏览器报网络错误 → 退出码 3（区分于反爬）
    stderr_tail = diag.get("stderr_tail", "")
    net_hit = [m for m in NET_ERR_MARKERS if m in stderr_tail or m in dom]
    if diag.get("dom_bytes", 0) == 0 and net_hit:
        print(f"[UNREACHABLE] {head}\n  域名解析/连接失败: {', '.join(net_hit[:4])}\n  不是反爬问题——本机出口不通/抖动，该域名所有工具都读不了（可换线路或代理后重试）")
        return 3

    text = dom_to_text(dom)
    hit = [w for w in BLOCK_WORDS if w in dom or w in text]
    if hit and len(text) < 1500:
        print(f"[BLOCKED] {head}\n  命中人机验证/限流话术: {', '.join(sorted(set(hit))[:6])}")
        return 5

    if not text:
        tail = stderr_tail.strip().splitlines()[-3:] if stderr_tail.strip() else []
        print(f"[EMPTY] {head}\n  渲染完成但无可读文本" + ("\n  " + "\n  ".join(tail) if tail else ""))
        return 2

    if args.probe:
        print(f"[OK] {head}\n  可读文本 {len(text)} 字")
        return 0

    clipped = text[:args.max_chars]
    suffix = f"\n...[已截断，全文 {len(text)} 字]" if len(text) > len(clipped) else ""
    payload = clipped + suffix
    if args.out:
        with open(args.out, "w", encoding="utf-8", errors="replace") as f:
            f.write(payload)
        print(f"[OK] {head}\n  正文 {len(text)} 字 -> {args.out}")
    else:
        print(f"[OK] {head}\n")
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())

