"""隐身补丁通道（P1-P5）。"""
from __future__ import annotations

STEALTH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-logging",
    "--disable-translate",
    "--no-default-browser-check",
    "--disable-infobars",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=Translate,OptimizationHints,MediaRouter,InterestFeedContentSuggestions",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-dev-shm-usage",
]


def apply_to_args(args: list[str]) -> list[str]:
    out = list(args)
    for a in STEALTH_ARGS:
        if a not in out:
            out.append(a)
    return out


def base_args(port: int | None = None, user_data_dir: str | None = None,
              headless: bool | None = None) -> list[str]:
    """启动参数。headless 默认由环境变量 FPWEB_HEADLESS 控制（"0" 走有头模式）。

    CF 托管挑战在无头模式下经常过不去，需要时可 FPWEB_HEADLESS=0 用真实窗口跑。
    """
    import os
    if headless is None:
        headless = os.environ.get("FPWEB_HEADLESS", "1") not in ("0", "false", "False", "no")
    args = ["--headless=new", "--disable-gpu"] if headless else ["--disable-gpu"]
    # ★ ITERATION-006：headless 也必须给窗口尺寸。
    #   原来只有非 headless 才加 --window-size，headless 下视口退化成
    #   innerHeight=3px ⇒ `innerText` 只回可见的那 3px 文本（实测 cdp 腿
    #   在 python.org/about 只取到 3,579 字符，而 DOM 实际 40KB，render 腿
    #   同页取到 43,265 字符）。这是 cdp 内容"偏窄"的真根因，不是抽取逻辑问题。
    args += ["--window-size=1920,1080"]
    if not headless:
        args += ["--start-maximized"]
    if port is not None:
        args.append(f"--remote-debugging-port={port}")
    args.append("--remote-allow-origins=*")
    if user_data_dir:
        args.append(f"--user-data-dir={user_data_dir}")
    args.append("--no-first-run")
    return apply_to_args(args)


def _persona(persona):
    return persona or {}


def patch_scripts(persona: dict | None = None) -> list[str]:
    p = _persona(persona)
    browser = p.get("browser", {}) if isinstance(p, dict) else {}
    languages = browser.get("languages", ["zh-CN", "zh", "en"])
    hw = browser.get("hardware_concurrency", 8)
    dm = browser.get("device_memory", 8)
    webgl_vendor = browser.get("webgl_vendor", "Google Inc. (Intel)")
    webgl_renderer = browser.get("webgl_renderer", "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)")

    scripts = []

    # 1 webdriver
    scripts.append("""try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}""")

    # 2 languages
    langs_js = repr(list(languages))
    scripts.append(f"""try {{ Object.defineProperty(navigator, 'languages', {{ get: () => {langs_js} }}); Object.defineProperty(navigator, 'language', {{ get: () => {langs_js}[0] }}); }} catch (e) {{}}""")

    # 3 plugins/mimeTypes
    scripts.append("""try {
  const makePlugin = (name) => ({ name, description: name, filename: name + '.dll', length: 1 });
  Object.defineProperty(navigator, 'plugins', { get: () => [makePlugin('Chrome PDF Plugin'), makePlugin('Chrome PDF Viewer'), makePlugin('Native Client')] } });
  Object.defineProperty(navigator, 'mimeTypes', { get: () => ({ length: 3 }) });
} catch (e) {}""")

    # 4 hardwareConcurrency/deviceMemory
    scripts.append(f"""try {{ Object.defineProperty(navigator, 'hardwareConcurrency', {{ get: () => {int(hw)} }}); Object.defineProperty(navigator, 'deviceMemory', {{ get: () => {int(dm)} }}); }} catch (e) {{}}""")

    # 5 window.chrome
    scripts.append("""try { if (!window.chrome) window.chrome = {}; if (!window.chrome.runtime) window.chrome.runtime = {}; } catch (e) {}""")

    # 6 WebGL getParameter
    scripts.append(f"""try {{
  const vendor = {webgl_vendor!r};
  const renderer = {webgl_renderer!r};
  const patch = (proto) => {{
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (pname) {{
      if (pname === 37445) return vendor;
      if (pname === 37446) return renderer;
      return orig.call(this, pname);
    }};
  }};
  patch(WebGLRenderingContext && WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
}} catch (e) {{}}""")

    # 7 focus/visibility
    scripts.append("""try {
  Object.defineProperty(document, 'hasFocus', { value: () => true });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
  Object.defineProperty(document, 'hidden', { get: () => false });
} catch (e) {}""")

    # 8 permissions query
    scripts.append("""try {
  if (navigator.permissions && navigator.permissions.query) {
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: 'denied', onchange: null });
      }
      return orig(params);
    };
  }
} catch (e) {}""")

    # 9 Error.prepareStackTrace
    scripts.append("""try {
  if (Error.prepareStackTrace) {
    const orig = Error.prepareStackTrace;
    Error.prepareStackTrace = (e, frames) => String(orig(e, frames)).replace(/puppeteer|playwright/gi, 'chrome');
  }
} catch (e) {}""")

    # 10 UA-CH / userAgentData 一致性
    full = str(browser.get("full_version", "136.0.7103.114"))
    major = str(browser.get("major") or full.split(".")[0])
    platform = browser.get("platform", "Windows")
    mobile = bool(browser.get("mobile", False))
    scripts.append("""

try {{
  const plat = """ + repr(platform) + """;
  const ua = """ + repr(p.get('headers', {}).get('User-Agent') or '') + """;
  if (!ua) {{
    const osPart = plat === 'macOS' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64';
    ua = `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
  }}
  Object.defineProperty(navigator, 'userAgentData', {{ get: () => ({
    brands: [
      {{ brand: 'Chromium', version: '"""+ major +"""' }},
      {{ brand: 'Not-A.Brand', version: '99' }},
      {{ brand: 'Google Chrome', version: '"""+ major +"""' }}
    ],
    fullVersionList: [
      {{ brand: 'Chromium', version: '"""+ full +"""' }},
      {{ brand: 'Not-A.Brand', version: '99.0.0.0' }},
      {{ brand: 'Google Chrome', version: '"""+ full +"""' }}
    ],
    fullVersion: '"""+ full +"""',
    platform: plat === 'macOS' ? 'macOS' : 'Windows',
    mobile: """ + str(mobile).lower() + """,
    architecture: 'x86',
    model: '',
    bitness: '64',
    wow64: false
  }}), enumerable: false, configurable: true });
}} catch (e) {{}}""")

    # 11 cdc_ 变量清理
    scripts.append("""
try {
  const isCdc = (k) => /^cdc_/.test(k);
  const clean = () => {
    try {
      for (const key of Object.keys(window)) { if (isCdc(key)) try { delete window[key]; } catch (e) {} }
      const syms = Object.getOwnPropertySymbols(window);
      for (const sym of syms) { if (isCdc(String(sym))) try { delete window[sym]; } catch (e) {} }
    } catch (e) {}
  };
  if (document.readyState === 'complete') { clean(); }
  else {
    const mo = new MutationObserver(() => { if (document.readyState === 'complete') { clean(); mo.disconnect(); } });
    mo.observe(document, { childList: true, subtree: true });
  }
} catch (e) {}
""")

    return scripts


def emulation_params(persona: dict | None = None) -> list:
    p = _persona(persona)
    browser = p.get("browser", {}) if isinstance(p, dict) else {}
    screen = p.get("screen", {}) if isinstance(p, dict) else {}
    w = int(screen.get("width", 1920))
    h = int(screen.get("height", 1080))
    dpr = float(screen.get("deviceScaleFactor", screen.get("dpr", 1.0)))
    mobile = bool(browser.get("mobile", False))
    ua = None
    # build UA if headers present
    headers = p.get("headers", {}) if isinstance(p, dict) else {}
    ua = headers.get("User-Agent")
    if not ua:
        full = browser.get("full_version", "136.0.7103.114")
        platform = browser.get("platform", "Windows")
        os_part = "Windows NT 10.0; Win64; x64" if platform != "macOS" else "Macintosh; Intel Mac OS X 10_15_7"
        ua = f"Mozilla/5.0 ({os_part}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{full} Safari/537.36"
    langs = browser.get("languages", ["zh-CN", "zh", "en"])
    accept_language = ",".join(langs)
    platform_str = browser.get("ua_platform", "Windows NT 10.0; Win64; x64")
    # CDP platform expects navigator.platform-ish; use ua_platform? Use "Win32"/"MacIntel"
    if "Windows" in str(platform_str):
        cdp_platform = "Win32"
    elif "Mac" in str(platform_str):
        cdp_platform = "MacIntel"
    else:
        cdp_platform = "Linux x86_64"
    tz = browser.get("timezone", "Asia/Shanghai")
    full_version = str(browser.get("full_version") or "136.0.7103.114")
    major = str(browser.get("major") or full_version.split(".")[0])
    if "Mac" in str(platform_str):
        meta_platform, meta_platform_version = "macOS", "15.3.0"
    else:
        meta_platform, meta_platform_version = "Windows", "10.0.0"
    brand_version = f"{major}.0.0.0"
    ua_metadata = {
        "brands": [
            {"brand": "Chromium", "version": major},
            {"brand": "Not-A.Brand", "version": "99"},
            {"brand": "Google Chrome", "version": major},
        ],
        "fullVersionList": [
            {"brand": "Chromium", "version": full_version},
            {"brand": "Not-A.Brand", "version": "99.0.0.0"},
            {"brand": "Google Chrome", "version": full_version},
        ],
        "fullVersion": full_version,
        "platform": meta_platform,
        "platformVersion": meta_platform_version,
        "architecture": "x86",
        "model": "",
        "mobile": mobile,
        "bitness": "64",
        "wow64": False,
    }
    return [
        ("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": dpr, "mobile": mobile}),
        ("Emulation.setTimezoneOverride", {"timezoneId": tz}),
        ("Emulation.setUserAgentOverride", {"userAgent": ua, "acceptLanguage": accept_language,
                                            "platform": cdp_platform,
                                            "userAgentMetadata": ua_metadata}),
        ("Emulation.setLocaleOverride", {"locale": str(langs[0]) if langs else "zh-CN"}),
        ("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": "."}),
    ]


def apply_emulation(session, persona) -> list:
    failures = []
    for method, params in emulation_params(persona):
        try:
            session.call(method, params)
        except Exception as e:
            failures.append(f"{method}: {e}")
    return failures


def console_override_script() -> str:
    return ""
