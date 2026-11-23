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
waf_fetch.py —— 带 WAF 挑战自动求解的抓取器（可复用工具）

能力：
1. 正常抓取
2. 若命中阿里云 WAF `acw_sc__v2` JS 挑战 → 调 node 求解 → 带 cookie 重试
3. 输出正文，检测限流话术（中文站常用 HTTP 200 + 提示语限流）

用法：
  python waf_fetch.py <URL> [-o FILE] [-r REFERER] [--raw] [--cookie "k=v"] [--show-status]
  python waf_fetch.py <URL> -o out.pdf --binary      # 下 PDF/图片必须加 --binary

【给调用方的重要提醒（血泪教训）】
  函数版下 PDF 一律用 `download(url, dst, expect=b"%PDF")` 或 `get_bytes(url)`，
  **绝不要用 `get()` 去下二进制**：`get()` 返回的是已按 UTF-8 解码的文本，
  二进制会被"ignore"策略静默丢字节，PDF 从 421,980 B 变成 226,433 B、
  且首流解压直接报 "incorrect header check"——文件看着像成功、实际全废。
  2026-10-18 实测踩过：24 个中文 PDF 全部因此损坏，已加 `download()` 修正。
"""
import sys, os, ssl, gzip, zlib, re, subprocess, tempfile, argparse
import urllib.request as U
import urllib.error as E

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
SOLVER = os.path.join(HERE, "acw_solver.js")


def _find_node():
    """找 node：优先环境变量，其次 DSH 打包 runtime，最后 PATH 里的 node.exe。
    ★ 发布版可移植化：原先写死 C:\\Users\\Diccup\\...，别人机器没这个路径。"""
    env = os.environ.get("DSH_NODE", "").strip()
    if env and os.path.isfile(env):
        return env
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "node", "bin", "node.exe"),
        os.path.join(home, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "node", "bin", "node"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    from shutil import which
    found = which("node") or which("node.exe")
    return found or "node"


NODE = _find_node()

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# ★ 黑框修复（2026-11-09）：DSH 是 GUI 子系统进程，随包 node.exe 是 Console 子系统。
#   GUI 进程 spawn 控制台程序 ⇒ Windows 必然给它分配新控制台 ⇒ 屏幕闪一个黑框。
#   这里用 STARTF_USESHOWWINDOW|SW_HIDE（Node 的 windowsHide 走的同一条路线）把它藏起来。
#   ★ 为什么不用 CREATE_NO_WINDOW(0x08000000)：宿主沙箱 README 明写——受限令牌下
#     CREATE_NO_WINDOW/CREATE_NEW_CONSOLE 的子进程会在 DLL 初始化阶段死于
#     STATUS_DLL_INIT_FAILED(0xC0000142)。SW_HIDE 不新建控制台，没有这个风险。
#   非 Windows 上 startupinfo 不适用，直接返回 None（走默认）。
def _hidden_startupinfo():
    if os.name != "nt":
        return None
    try:
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = subprocess.SW_HIDE
        return si
    except Exception:
        return None

# 中文站常见的"伪 200"限流话术
THROTTLE_WORDS = [
    "访问异常", "暂时受到限制", "访问过于频繁", "请求过于频繁",
    "请稍后再试", "操作太频繁", "人机验证", "安全验证",
    "您的访问受限", "已被限制", "系统监测",
]


def _decode(req):
    with U.urlopen(req, timeout=45, context=CTX) as r:
        raw = r.read()
        enc = (r.headers.get("Content-Encoding") or "").lower()
        try:
            if "gzip" in enc:
                raw = gzip.decompress(raw)
            elif "deflate" in enc:
                try:
                    raw = zlib.decompress(raw)
                except Exception:
                    raw = zlib.decompress(raw, -zlib.MAX_WBITS)
        except Exception:
            pass
        return r.status, raw, dict(r.headers)


def fetch(url, referer=None, cookie=None, timeout=45):
    req = U.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    req.add_header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
    req.add_header("Accept-Encoding", "gzip, deflate")
    if referer:
        req.add_header("Referer", referer)
    if cookie:
        req.add_header("Cookie", cookie)
    return _decode(req)


def is_acw(body, headers):
    """判定是否为阿里云 WAF acw_sc__v2 挑战页"""
    if not body:
        return False
    head = body[:4000]
    return (b"acw_sc__v2" in head or b"arg1=" in head or b"<html><script>" == head[:14]) \
        and b"a0j" in body[:20000]


def solve_acw(body):
    """用 node 跑求解器，返回 cookie 串"""
    with tempfile.NamedTemporaryFile("wb", suffix=".html", delete=False) as f:
        f.write(body)
        tmp = f.name
    try:
        r = subprocess.run([NODE, SOLVER, tmp], capture_output=True, timeout=60,
                           startupinfo=_hidden_startupinfo())
        out = r.stdout.decode("utf-8", "replace").strip()
        if r.returncode == 0 and out.startswith("acw_sc__v2="):
            return out
        sys.stderr.write("[solver] rc=%s err=%s\n" % (r.returncode,
                                                      r.stderr.decode("utf-8", "replace")[:200]))
        return None
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def check_throttle(text):
    for w in THROTTLE_WORDS:
        if w in text:
            return w
    return None


def get(url, referer=None, cookie=None, show_status=False):
    """返回 (status, text, note)"""
    note = []
    try:
        st, raw, h = fetch(url, referer, cookie)
    except E.HTTPError as e:
        return e.code, "", "HTTPError"
    except Exception as e:
        return None, "", str(e)[:120]
    if show_status:
        note.append("st=%s len=%s" % (st, len(raw)))

    # WAF 挑战 → 求解 → 重试
    if is_acw(raw, h):
        note.append("WAF挑战")
        ck = solve_acw(raw)
        if ck:
            note.append("已求解")
            full = (cookie + "; " if cookie else "") + ck
            try:
                st2, raw2, h2 = fetch(url, referer, full)
                note.append("重试 st=%s" % st2)
                if is_acw(raw2, h2):
                    note.append("仍被拦")
                else:
                    raw = raw2
                    st = st2
            except Exception as e:
                note.append("重试失败:%s" % str(e)[:60])
        else:
            note.append("求解失败")

    text = raw.decode("utf-8", "ignore") if raw else ""
    tw = check_throttle(text)
    if tw:
        note.append("⚠限流[%s]" % tw)
    return st, text, "; ".join(str(x) for x in note)


def post_bytes(url, data, referer=None, cookie=None, content_type=None):
    """POST 表单并返回 (status, raw_bytes, note)。二进制安全，同 get_bytes。

    data: 已 urlencode 的 str 或 bytes。自动带 X-Requested-With（多数 JSON 接口需要）。
    文本接口用 post()，下 PDF 仍走 download()。
    """
    note = []
    if isinstance(data, str):
        data = data.encode("utf-8")
    req = U.Request(url, data=data)
    req.add_header("User-Agent", UA)
    req.add_header("Content-Type", content_type
                   or "application/x-www-form-urlencoded; charset=UTF-8")
    req.add_header("Accept", "application/json, text/javascript, */*; q=0.01")
    req.add_header("Accept-Language", "zh-CN,zh;q=0.9")
    req.add_header("Accept-Encoding", "gzip, deflate")
    req.add_header("X-Requested-With", "XMLHttpRequest")
    if referer:
        req.add_header("Referer", referer)
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        st, raw, h = _decode(req)
    except E.HTTPError as e:
        return e.code, b"", "HTTPError"
    except Exception as e:
        return None, b"", str(e)[:120]
    if is_acw(raw, h):
        note.append("WAF挑战")
        ck = solve_acw(raw)
        if ck:
            note.append("已求解")
            full = (cookie + "; " if cookie else "") + ck
            req2 = U.Request(url, data=data)
            req2.add_header("User-Agent", UA)
            req2.add_header("Content-Type", content_type
                            or "application/x-www-form-urlencoded; charset=UTF-8")
            req2.add_header("Accept", "application/json, text/javascript, */*; q=0.01")
            req2.add_header("X-Requested-With", "XMLHttpRequest")
            req2.add_header("Cookie", full)
            if referer:
                req2.add_header("Referer", referer)
            try:
                st2, raw2, h2 = _decode(req2)
                note.append("重试 st=%s" % st2)
                if not is_acw(raw2, h2):
                    st, raw = st2, raw2
            except Exception as e:
                note.append("重试失败:%s" % str(e)[:60])
        else:
            note.append("求解失败")
    return st, raw or b"", "; ".join(str(x) for x in note)


def post(url, data, referer=None, cookie=None):
    """POST 表单并返回 (status, text, note)。仅用于文本接口，不要用来下 PDF。"""
    st, raw, note = post_bytes(url, data, referer, cookie)
    text = raw.decode("utf-8", "ignore") if raw else ""
    tw = check_throttle(text)
    if tw:
        note = (note + "; " if note else "") + "⚠限流[%s]" % tw
    return st, text, note


def get_bytes(url, referer=None, cookie=None):
    """返回 (status, raw_bytes, note)——二进制安全通道，下载 PDF/图片/压缩包必须用它。

    注意：get() 会把正文按 UTF-8 解码，二进制文件会被静默损坏（PDF 会被截断），
    所以下 PDF 一律用本函数，不要用 get()。
    """
    note = []
    try:
        st, raw, h = fetch(url, referer, cookie)
    except E.HTTPError as e:
        return e.code, b"", "HTTPError"
    except Exception as e:
        return None, b"", str(e)[:120]
    if is_acw(raw, h):
        note.append("WAF挑战")
        ck = solve_acw(raw)
        if ck:
            note.append("已求解")
            full = (cookie + "; " if cookie else "") + ck
            try:
                st2, raw2, h2 = fetch(url, referer, full)
                note.append("重试 st=%s" % st2)
                if not is_acw(raw2, h2):
                    raw, st = raw2, st2
            except Exception as e:
                note.append("重试失败:%s" % str(e)[:60])
        else:
            note.append("求解失败")
    return st, raw or b"", "; ".join(str(x) for x in note)


def download(url, dst, referer=None, cookie=None, min_size=1000, expect=None):
    """把 URL 下成文件（二进制安全）。返回 (ok:bool, size:int, note:str)。

    expect: 期望的文件头 bytes，如 b"%PDF"。给了就校验，不匹配判失败。
    """
    st, raw, note = get_bytes(url, referer, cookie)
    if st != 200 or not raw:
        return False, 0, "st=%s %s" % (st, note)
    if len(raw) < min_size:
        return False, len(raw), "仅 %d 字节(过小) %s" % (len(raw), note)
    if expect and not raw.startswith(expect):
        return False, len(raw), "文件头不符 %r %s" % (raw[:8], note)
    tmp = dst + ".part"
    with open(tmp, "wb") as f:
        f.write(raw)
    if os.path.exists(dst):
        os.remove(dst)
    os.rename(tmp, dst)
    return True, len(raw), note


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("-o", "--out")
    ap.add_argument("-r", "--referer")
    ap.add_argument("--cookie")
    ap.add_argument("--show-status", action="store_true")
    ap.add_argument("--binary", action="store_true",
                    help="按二进制下载（PDF/图片必须加；不加会按文本解码损坏文件）")
    a = ap.parse_args()

    if a.binary:
        st, raw, note = get_bytes(a.url, a.referer, a.cookie)
        print("[%s] %s  %d 字节  %s" % (st, a.url, len(raw), note))
        print("文件头: %r" % raw[:12])
        if a.out and raw:
            with open(a.out, "wb") as f:
                f.write(raw)
            print("已存:", a.out)
        return

    st, text, note = get(a.url, a.referer, a.cookie, a.show_status)
    print("[%s] %s  %s 字节  %s" % (st, a.url, len(text), note))
    if a.out and text:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
        print("已存:", a.out)
    elif text and not a.out:
        print(text[:3000])


if __name__ == "__main__":
    main()
