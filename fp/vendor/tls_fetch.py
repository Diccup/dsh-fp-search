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
tls_fetch.py —— 带浏览器 TLS/HTTP2 指纹伪装的抓取器（curl_cffi 后端）

干什么：
  urllib / requests 的 TLS 握手指纹（JA3/JA4、cipher 顺序、扩展顺序、HTTP2 SETTINGS）
  一眼就被 Cloudflare / 站点风控认出来，返回 403「Just a moment...」或空壳挑战页。
  curl_cffi 内嵌 curl-impersonate，能把指纹拟真成真实浏览器（chrome/safari/edge/firefox…），
  本机实测装上即跑通（2026-10-26：impersonate=chrome 抓 api.github.com → HTTP 200）。

与已有工具的分工（三条腿）：
  waf_fetch.py   → 纯 HTTP + 自动解阿里云 WAF 的 acw_sc__v2 JS 挑战
  tls_fetch.py   → 纯 HTTP + TLS/HTTP2 指纹伪装（本工具）
  page_render.py → 无头 Edge 真渲染（JS 注入的内容）

用法：
  python tls_fetch.py <URL> [-o FILE] [--impersonate chrome] [--referer R] [--cookie C]
                     [--timeout 45] [--binary] [--show-status] [--post-data D]
  python tls_fetch.py <URL> --probe        # 只报状态与是否命中验证页

⚠️ **默认不把正文打进 stdout**（省上下文）：
  默认正文**只落盘**（不给 -o 就自动落临时文件），stdout 只回状态行 + 文件路径 + 字节数。
  要看正文：用 ctx_index 索引该文件再 ctx_search 取片段，或 python 切片读；
  确需全文入上下文时显式加 `--print`（自担 token 代价）。

退出码：0 成功 / 2 无内容 / 3 命中人机验证或限流 / 4 curl_cffi 不可用 / 5 网络失败

⚠️ 依赖：curl_cffi（本机已装到工作区隔离目录，不污染 DSH 自带 Python）
   **⚠️ 必须在 DSH 文件沙箱【外】装**（实测 2026-10-26）：
     · 沙箱内 pip install 必失败——pip 用 tempfile.mkdtemp 建 mode 0o700 临时目录，
       DSH 沙箱对该模式目录拒绝写入，报
        `OSError: [Errno 13] Permission denied: '<TMP>/pip-unpack-XXXX/xxx.whl.metadata'`；
       把 TMP/TEMP 指到工作区也不行（Python 自建 0o700 目录仍被拦）。
     · 沙箱外（danger-full-access）同一条命令成功。
   装法（DSH 打包 Python）：
     python.exe -m pip install --target <工作区>/pylibs curl_cffi
   默认从这些位置找（按序）：
     1) 环境变量 DSH_TLS_LIBS
     2) 与本脚本同级的 ../pylibs
     3) 插件包内的 deps/pylibs
   也可以直接 pip install curl_cffi 进 DSH 打包 Python（更省事，但会污染运行时）。

⚠️ 合规边界：仅用于正常访问公开页面；不绕付费墙、不破验证码、只做公开数据抓取。
"""
import sys, os, re, argparse, tempfile

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
LIB_CANDIDATES = [
    os.environ.get("DSH_TLS_LIBS", ""),
    os.path.join(os.path.dirname(HERE), "pylibs"),
    os.path.join(HERE, "pylibs"),
    os.path.join(os.path.dirname(os.path.dirname(HERE)), "deps", "pylibs"),
]

# 中文站/国际站常见的「伪 200」限流与人机验证话术
BLOCK_PATTERNS = [
    (r"Just a moment", "Cloudflare 5秒盾"),
    (r"Checking your browser", "Cloudflare 人机校验"),
    (r"Enable JavaScript and cookies to continue", "Cloudflare 挑战页"),
    (r"安全验证", "人机验证"),
    (r"人机验证", "人机验证"),
    (r"拖动滑块", "滑块验证"),
    (r"请完成.{0,10}验证", "人机验证"),
    (r"访问异常", "限流"),
    (r"访问过于频繁|请求过于频繁|操作太频繁", "限流"),
    (r"你的访问受限|暂时受到限制", "限流"),
    (r"异常，暂时限制", "风控拦截"),
    (r"验证码", "验证码拦截"),
]


def load_curl_cffi():
    """导入 curl_cffi 并把模块对象挂在 _cr 上（供 web_get.py 编排层复用）。"""
    for path in LIB_CANDIDATES:
        if path and os.path.isdir(path) and path not in sys.path:
            sys.path.insert(0, path)
    try:
        from curl_cffi import requests as cr
        global _cr
        _cr = cr
        return cr
    except Exception as exc:
        sys.stderr.write(
            "[tls_fetch] curl_cffi 不可用: %s\n"
            "  装法: python.exe -m pip install --target %s curl_cffi\n"
            % (str(exc)[:200], LIB_CANDIDATES[1])
        )
        return None


_cr = None


def detect_block(text):
    for pat, label in BLOCK_PATTERNS:
        if re.search(pat, text, re.I):
            return label
    return None


def main():
    ap = argparse.ArgumentParser(description="TLS 指纹伪装抓取")
    ap.add_argument("url")
    ap.add_argument("-o", "--out")
    ap.add_argument("--impersonate", default="chrome",
                    help="浏览器指纹预设（chrome/chrome124/chrome131/safari/edge/firefox…），默认 chrome")
    ap.add_argument("-r", "--referer")
    ap.add_argument("--cookie")
    ap.add_argument("--timeout", type=int, default=45)
    ap.add_argument("--binary", action="store_true", help="按二进制下载（PDF/图片必须加）")
    ap.add_argument("--post-data", help="POST 的表单数据（urlencoded 串）")
    ap.add_argument("--show-status", action="store_true")
    ap.add_argument("--probe", action="store_true", help="只报状态，不输出正文")
    ap.add_argument("--print", dest="do_print", action="store_true",
                    help="把正文打进 stdout（默认只落盘，不进上下文）")
    a = ap.parse_args()

    url = a.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    cr = load_curl_cffi()
    if cr is None:
        return 4

    headers = {}
    if a.referer:
        headers["Referer"] = a.referer
    if a.cookie:
        headers["Cookie"] = a.cookie

    try:
        kw = dict(impersonate=a.impersonate, timeout=a.timeout, headers=headers)
        if a.post_data:
            resp = cr.post(url, data=a.post_data, **kw)
        else:
            resp = cr.get(url, **kw)
    except Exception as exc:
        print("[FAIL] %s 网络失败: %s" % (url, str(exc)[:150]))
        return 5

    raw = resp.content or b""
    status = resp.status_code
    note = ["impersonate=%s" % a.impersonate]
    if a.show_status:
        note.append("len=%d" % len(raw))

    # 命中验证/限流页 —— 报出来，别把验证壳当正文
    text_head = raw[:6000].decode("utf-8", "ignore")
    block = detect_block(text_head)
    if block:
        print("[BLOCKED] %s  HTTP %s  %d 字节  %s" % (url, status, len(raw), "; ".join(note)))
        print("  命中: %s" % block)
        print("  → 换 impersonate 预设、加 Referer/Cookie，或改走 page_render.py / 真实会话")
        return 3

    if not raw:
        print("[EMPTY] %s  HTTP %s" % (url, status))
        return 2

    if a.probe:
        print("[OK] %s  HTTP %s  %d 字节  %s" % (url, status, len(raw), "; ".join(note)))
        return 0

    if a.binary:
        print("[%s] %s  %d 字节  %s" % (status, url, len(raw), "; ".join(note)))
        if not a.out:
            import tempfile
            fd, a.out = tempfile.mkstemp(prefix="tlsfetch_", suffix=".bin",
                                         dir=DEFAULT_DUMP_DIR)
            os.close(fd)
        with open(a.out, "wb") as f:
            f.write(raw)
        print("已存:", a.out)
        return 0

    text = raw.decode("utf-8", "ignore")
    print("[%s] %s  %d 字节  %s" % (status, url, len(raw), "; ".join(note)))
    # 默认落盘、stdout 不吐正文（省上下文是第一原则）
    if not a.out:
        import tempfile
        fd, a.out = tempfile.mkstemp(prefix="tlsfetch_", suffix=".txt",
                                     dir=DEFAULT_DUMP_DIR)
        os.close(fd)
    with open(a.out, "w", encoding="utf-8", errors="replace") as f:
        f.write(text)
    print("已存:", a.out)
    if a.do_print:
        print()
        print(text[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
