# -*- coding: utf-8 -*-
# ============================================================================
# 本文件由 AI 辅助生成（AI-generated / AI-assisted）。
#
# 免责声明：
#   本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
#   使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
#   请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。
#   完整声明见仓库根目录的 DISCLAIMER.md。
# ============================================================================
"""
web_get.py —— 统一网页抓取入口（自动选腿、自动降级）

干什么：
  使用者只想说「把某个网页抓下来」，不该关心它是 JS 渲染页还是 TLS 指纹被识别的页。
  本工具按顺序试三条腿，谁先成功用谁，并如实报告**走了哪条腿**：

    腿1 HTTP 普通      urllib + 拟真 Header      便宜、快，先试
    腿2 TLS 指纹伪装   curl_cffi impersonate     过 JA3/JA4/HTTP2 指纹识别（百度验证页已破）
    腿3 无头渲染      Edge headless --dump-dom   过 JS 注入内容（前端渲染的正文）

  三腿都拿不到时，按诊断给结论：
    - 命中人机验证/限流 → 明确告诉你「这站要真会话/验证码，工具到顶了」
    - 网络不可达       → 明确告诉你「本机出口不通，不是反爬」

用法：
  python web_get.py <URL> [-o FILE] [--max-chars N] [--force-leg http|tls|render]
                    [--probe] [--wait MS] [--impersonate chrome]
  python web_get.py <URL> --probe       # 只报走哪条腿成功/失败，不输出正文

⚠️ **默认不把正文打进 stdout**（省上下文）：
  这是本工具的第一原则。网页正文动辄几万字，直接打出来会污染上下文、拖慢每一轮。
  默认行为 = 正文**只落盘**，stdout 只回「走了哪条腿 + 文件路径 + 字节数 + 关键数字」。
  想看正文的三种正确姿势：
    ① `-o FILE` 后用 ctx_index 把 FILE 索引进知识库，再用 ctx_search 按需取片段（推荐）
    ② 用脚本按需取片段（例：python -c "print(open(r'FILE',encoding='utf-8').read()[:2000])"），
       大文件按切片取，不要整份读进对话
    ③ 确实需要全文入上下文时，显式加 `--print`（自己承担 token 代价）

退出码：0 成功 / 2 三腿都没拿到内容 / 3 命中人机验证或限流 / 4 环境缺失（无 curl_cffi/无浏览器）

⚠️ 与其它工具的关系：
  本工具是**编排层**，不重复实现能力；底层调用同目录的 waf_fetch.py / tls_fetch.py / page_render.py。
  三腿都失败时，可再用 waf_fetch.py 单独试阿里云 WAF 挑战。

⚠️ 合规边界：仅抓公开页面；不绕付费墙、不破验证码、不做高频轰炸。
"""
import sys, os, re, argparse, importlib.util, tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))

# 自动落盘的默认目录：系统临时目录下的 dsh-fp-download（不预设盘符，别人机器没 F 盘也能跑）
# 可用环境变量 FP_OUT_DIR 覆盖。
DEFAULT_DUMP_DIR = os.path.join(os.environ.get("TEMP") or os.environ.get("TMP") or tempfile.gettempdir(),
                                "dsh-fp-download")
try:
    os.makedirs(DEFAULT_DUMP_DIR, exist_ok=True)
except Exception:
    DEFAULT_DUMP_DIR = HERE


def load(name):
    """按文件路径加载同目录模块（不依赖 sys.path）。"""
    path = os.path.join(HERE, name + ".py")
    if not os.path.isfile(path):
        return None
    spec = importlib.util.spec_from_file_location("wgt_" + name, path)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:
        return None
    return mod


BLOCK_RE = re.compile(
    r"Just a moment|Checking your browser|Enable JavaScript and cookies|"
    r"安全验证|人机验证|拖动滑块|请完成.{0,10}验证|访问异常|访问过于频繁|"
    r"请求过于频繁|操作太频繁|访问受限|暂时受到限制|异常，暂时限制|验证码",
    re.I,
)

NET_RE = re.compile(
    r"ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_PROXY|"
    r"ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_SSL",
    re.I,
)

TAG_RE = re.compile(r"(?is)<(script|style|noscript|svg)\b.*?</\1>")
ANY_TAG_RE = re.compile(r"(?s)<[^>]+>")


def html_to_text(html_text):
    """HTML → 可检索纯文本。
    产出要能被 ctx_search 检索，所以默认剥标签；
    需要原始 HTML 就用 tls_fetch.py / waf_fetch.py 直接拿。"""
    body = TAG_RE.sub(" ", html_text)
    body = ANY_TAG_RE.sub(" ", body)
    body = (body.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
    body = re.sub(r"[ \t\u00a0]+", " ", body)
    return re.sub(r"\n{2,}", "\n", body).strip()


def leg_http(url, opts):
    mod = load("waf_fetch")
    if mod is None:
        return None, "waf_fetch.py 不可用"
    try:
        st, text, note = mod.get(url, show_status=True)
    except Exception as exc:
        return None, "异常 %s" % str(exc)[:80]
    if st == 200 and text and len(text) > 200 and not BLOCK_RE.search(text[:6000]):
        plain = html_to_text(text)
        return plain, "HTTP 普通腿成功（st=200, HTML %d 字 → 正文 %d 字）%s" % (len(text), len(plain), note)
    if st and text and BLOCK_RE.search(text[:6000]):
        return None, "命中验证页（st=%s）" % st
    return None, "HTTP 普通腿未拿到（st=%s, %d 字）%s" % (st, len(text or ""), note)


def leg_tls(url, opts):
    mod = load("tls_fetch")
    if mod is None:
        return None, "tls_fetch.py 不可用"
    # tls_fetch 把 curl_cffi 的 sys.path 注入写在自己的模块层，
    # 这里 import 的是它内部已加载好的模块对象，不重复走 sys.path。
    cr = getattr(mod, "_cr", None)
    if cr is None:
        cr = mod.load_curl_cffi()
        mod._cr = cr
    if cr is None:
        return None, "curl_cffi 未安装"
    headers = {}
    if opts.referer:
        headers["Referer"] = opts.referer
    if opts.cookie:
        headers["Cookie"] = opts.cookie
    try:
        resp = cr.get(url, impersonate=opts.impersonate, timeout=opts.timeout, headers=headers)
    except Exception as exc:
        return None, "网络失败 %s" % str(exc)[:90]
    raw = resp.content or b""
    text = raw.decode("utf-8", "ignore")
    if resp.status_code == 200 and raw and not BLOCK_RE.search(text[:6000]):
        plain = html_to_text(text)
        return plain, "TLS 指纹腿成功（st=200, HTML %d 字节 → 正文 %d 字, impersonate=%s）" % (len(raw), len(plain), opts.impersonate)
    if BLOCK_RE.search(text[:6000]):
        return None, "命中验证页（st=%s）" % resp.status_code
    return None, "TLS 腿未拿到（st=%s, %d 字节）" % (resp.status_code, len(raw))


def leg_render(url, opts):
    mod = load("page_render")
    if mod is None:
        return None, "page_render.py 不可用"
    dom, diag = mod.render(url, opts.wait, opts.timeout, None)
    if dom is None:
        return None, diag.get("msg", "渲染失败")
    stderr_tail = diag.get("stderr_tail", "")
    if diag.get("dom_bytes", 0) == 0 and NET_RE.search(stderr_tail + dom):
        return None, "网络不可达（%s）" % (NET_RE.search(stderr_tail + dom).group(0))
    text = mod.dom_to_text(dom)
    if text and not BLOCK_RE.search(text[:3000]):
        return text, "无头渲染腿成功（DOM %d 字节 → 正文 %d 字）" % (diag.get("dom_bytes", 0), len(text))
    if text:
        return None, "渲染到的是验证页（正文 %d 字）" % len(text)
    return None, "渲染无可读文本"


LEGS = [("http", leg_http), ("tls", leg_tls), ("render", leg_render)]


def main():
    ap = argparse.ArgumentParser(description="统一网页抓取（自动选腿）")
    ap.add_argument("url")
    ap.add_argument("-o", "--out")
    ap.add_argument("--max-chars", type=int, default=20000)
    ap.add_argument("--force-leg", choices=["http", "tls", "render"], help="只用这一条腿")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--wait", type=int, default=10000, help="渲染等待上限 ms")
    ap.add_argument("--timeout", type=int, default=90, help="渲染超时秒")
    ap.add_argument("--impersonate", default="chrome")
    ap.add_argument("-r", "--referer")
    ap.add_argument("--cookie")
    ap.add_argument("--print", dest="do_print", action="store_true",
                    help="把正文打进 stdout（默认只落盘，不进上下文）")
    a = ap.parse_args()

    url = a.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    order = [l for l in LEGS if l[0] == a.force_leg] if a.force_leg else LEGS
    tried, blocked = [], False
    for name, fn in order:
        try:
            text, note = fn(url, a)
        except Exception as exc:
            text, note = None, "异常 %s" % str(exc)[:90]
        tried.append("%s: %s" % (name, note))
        if text:
            clipped = text[:a.max_chars]
            suffix = "\n...[已截断，全文 %d 字]" % len(text) if len(text) > len(clipped) else ""
            payload = clipped + suffix
            print("[OK] %s" % url)
            for line in tried:
                print("  腿 %s" % line)
            if a.probe:
                print("  正文 %d 字" % len(text))
                return 0
            # 默认落盘、stdout 不吐正文（省上下文是第一原则）
            if not a.out:
                import tempfile
                fd, auto_path = tempfile.mkstemp(prefix="webget_", suffix=".txt",
                                               dir=DEFAULT_DUMP_DIR)
                os.close(fd)
                a.out = auto_path
            with open(a.out, "w", encoding="utf-8", errors="replace") as f:
                f.write(payload)
            print("  正文 %d 字 -> %s" % (len(text), a.out))
            print("  提示：用 ctx_index 索引该文件后 ctx_search 取片段；或 python 切片读；确需全文再加 --print")
            if a.do_print:
                print()
                print(payload)
            return 0
        if "验证" in note or "BLOCK" in note.upper():
            blocked = True

    print("[FAIL] %s" % url)
    for line in tried:
        print("  腿 %s" % line)
    if blocked:
        print("  → 结论：命中人机验证/限流。纯工具链已到顶，需要真实会话 cookie 或人工过验证。")
        return 3
    print("  → 结论：不是反爬问题（网络不可达或站点确实没内容）。")
    return 2


if __name__ == "__main__":
    sys.exit(main())
