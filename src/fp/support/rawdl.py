r"""rawdl · 04 片新增：原始字节下载器（反扒文件专用，与文本五段腿并行）。

为什么单独一个模块，不借 `support.orchestrator` 的道：
  编排器每一腿都在驱动边界把 bytes decode 成 str（`drivers/tls.py:38`、
  `orchestrator._decode_bytes`、cdp 回 `str(text)`），搬二进制必坏——这正是
  03 项目实测到的乱码根因。所以这里另开一条**只做字节**的旁路：
  http → waf → tls 三腿，流式写盘，绝不 decode。

  ★ render / cdp 两腿**不接**：浏览器腿产出 DOM 文本，对文件无字节语义（04 立项书 §二）。

SSRF 口径（关联表 #1/#30 + Readme §六-9，不许新增绕过）：
  · 本模块不 import url-guard.js（那是 JS 件），但**镜像同一条款**（下方纯字符串判据），
    且判据在**每一跳前**都算一次；`final_url` 与 `content_type` 一律回传，由 JS 侧再复一次闸。
  · 已知边界与 url-guard.js 头注一致：纯词法，不解析 DNS。JS 侧 `assertSafeUrl` 是最终裁判。

降级判据（与文本路同口径，泡泡 2026-11-19 定）：
  · 非 2xx / 网络错 / 被拦（小体积正文命中 detect 特征）⇒ 记死因、换下一腿；
  · 大体积正文不做拦截猜测（防"大文件字节采样误判"，见 04 开发日志 L-006 设计账）；
  · 重定向：手动跟、每跳过闸、上限 5 跳，与 JS fetch 路同额度。

用法（桥模式，通信全走文件；stdout 空、stdio 'ignore'）：
  python rawdl.py <url> --dest <path> [--pylibs <dir>] [--timeout 8] [--max-bytes N]
                    [--legs http,waf,tls] [--quiet]
退出码：0 成功 / 1 全腿失败 / 2 URL 被 SSRF 闸拒
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

VERSION = "04-rawdl-1.0.0"
MAX_REDIRECTS = 5
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
LEG_ORDER = ("http", "waf", "tls")
CHALLENGE_SNIFF_BYTES = 65536   # 只对 ≤64KB 的 text/html 正文做拦截特征嗅探

_V4 = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")
_SHORT_V4_RE = re.compile(r"^(?:\d+\.){0,3}\d+$")


def _normalize_v4(host: str) -> Optional[Tuple[str, str, str, str]]:
    """把 1.2.3.4 / 1.2.3（=1.2.0.3）/ 1（=0.0.0.1）这类 WHATWG 短写展开成四段。
    八位组 >255 ⇒ None（两边同向拒）。与 JS 侧 new URL 的展开规则对齐（04 L-006 对账账）。"""
    parts = host.split(".")
    if len(parts) > 4 or not parts:
        return None
    try:
        nums = [int(x) for x in parts]
    except ValueError:
        return None
    if any(n > 0xFFFFFFFF for n in nums):
        return None
    if len(nums) == 4:
        a, b, c, d = nums
    elif len(nums) == 3:
        a, b, cd = nums
        if cd > 0xFFFF:
            return None
        b2, d = divmod(cd, 256)
        if b2 > 255:
            return None
        return None if b > 255 else (str(a), str(b), str(b2), str(d))
    elif len(nums) == 2:
        a, bc = nums
        if bc > 0xFFFFFF:
            return None
        b, cd = divmod(bc, 65536)
        c, d = divmod(cd, 256)
        return None if (a > 255 or b > 255 or c > 255) else (str(a), str(b), str(c), str(d))
    else:  # 1 段
        a = nums[0]
        if a > 0xFFFFFFFF:
            return None
        b, c, d = 0, 0, 0
        rest = a
        c = rest % 256; rest //= 256
        b = rest % 256; rest //= 256
        a2 = rest % 256; rest //= 256
        return None if rest > 255 else (str(rest), str(a2), str(b), str(c))
    if max(a, b, c, d) > 255:
        return None
    return (str(a), str(b), str(c), str(d))
_BLOCKED_HOSTS = re.compile(
    r"^(localhost|.*\.localhost|.*\.internal|.*\.local|metadata\.google\.internal|wpad|.*\.home\.arpa)$",
    re.I,
)


# ------------------------------------------------------------------ SSRF 判据
# ★ 与 ours/libs/url-guard.js 逐条镜像（对账账见 04 开发日志 L-006 / L-007）。改一边必须改另一边。
#   口径：python 侧允许「更严」，绝不允许「更松」——对账门只卡 py 更松的方向。

_V4_RE = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")
_BLOCKED_HOSTS = re.compile(
    r"^(localhost|.*\.localhost|.*\.internal|.*\.local|metadata\.google\.internal|wpad|.*\.home\.arpa)$",
    re.I,
)


class UrlBlocked(Exception):
    def __init__(self, href: str, reason: str):
        super().__init__(reason)
        self.href = href
        self.reason = reason


def _is_private_v4(a: int, b: int) -> bool:
    """前两段判内网（与 url-guard.js isPrivateV4 同源）。"""
    if a == 127 or a == 10 or a == 0:
        return True
    if a == 169 and b == 254:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    if a == 100 and 64 <= b <= 127:
        return True
    if a == 198 and b in (18, 19):
        return True
    return False


def _whatwg_label_num(label: str) -> Optional[int]:
    """单段数值，照 WHATWG「IPv4 number」：0x 前缀=16 进制；前导 0=8 进制
    （去零后仍含 8/9 ⇒ 退回 10 进制）；其余 10 进制。非数值段 ⇒ None。"""
    s = label
    if not s or len(s) > 16:
        return None
    if s[:2].lower() == "0x":
        body = s[2:].lower()
        if not body or any(c not in "0123456789abcdef" for c in body):
            return None
        return int(body, 16)
    if not re.fullmatch(r"[0-9]+", s):
        return None
    if len(s) > 1 and s[0] == "0":
        stripped = s.lstrip("0") or "0"
        if any(c in "89" for c in stripped):
            return int(stripped, 10)
        return int(stripped, 8)
    return int(s, 10)


def _v4_candidate(host: str) -> Optional[List[int]]:
    """host 是否为「IPv4 字面量（含短写/16/8 进制形）」；是 ⇒ 段数值列表，否 ⇒ None。"""
    parts = host.split(".")
    if not 1 <= len(parts) <= 4:
        return None
    nums: List[int] = []
    for part in parts:
        n = _whatwg_label_num(part)
        if n is None:
            return None
        nums.append(n)
    return nums


def _expand_v4(nums: List[int]) -> Optional[Tuple[int, int, int, int]]:
    """短写展开（127.1 → 127.0.0.1）；越界 ⇒ None = 无效 IPv4（JS new URL 同样拒）。"""
    if len(nums) == 4:
        a, b, c, d = nums
    elif len(nums) == 3:
        a, b, last = nums
        if last > 0xFFFF:
            return None
        c, d = divmod(last, 256)
    elif len(nums) == 2:
        a, last = nums
        if last > 0xFFFFFF:
            return None
        b, rest = divmod(last, 65536)
        c, d = divmod(rest, 256)
    else:
        last = nums[0]
        if last > 0xFFFFFFFF:
            return None
        a, rest = divmod(last, 16777216)
        b, rest = divmod(rest, 65536)
        c, d = divmod(rest, 256)
    if max(a, b, c, d) > 255:
        return None
    return (a, b, c, d)


def _v6_packed(host: str) -> Optional[bytes]:
    """IPv6（含或不含方括号）→ 16 字节；不可解析 ⇒ None。"""
    h = host.lower().strip("[]")
    try:
        import ipaddress  # noqa: PLC0415
        ip = ipaddress.ip_address(h)
    except Exception:
        return None
    return ip.packed if ip.version == 6 else None


def _is_private_v6_bytes(b: bytes) -> bool:
    if b == b"\x00" * 16 or b == b"\x00" * 15 + b"\x01":
        return True                                     # :: 与 ::1
    if b[:10] == b"\x00" * 10:
        # v4 映射形（b[10:12]=ffff）与 v4 兼容形（=0000）都按尾部 v4 判。
        # ★ 07-P2：旧写法 `and b[10] == 0` 打头 ⇒ ffff 分支永不可达（死代码，与 JS 同款漏网）。
        if b[10:12] in (b"\x00\x00", b"\xff\xff"):
            return _is_private_v4(b[12], b[13])
    if b[0] == 0xFE and (b[1] & 0xC0) == 0x80:
        return True                                     # fe80::/10 链路本地
    if (b[0] & 0xFE) == 0xFC:
        return True                                     # fc00::/7 ULA
    if b[0] == 0xFF:
        return True                                     # multicast：比 JS 严，一律拒
    return False


def assert_safe_url(raw: str) -> str:
    """危险 ⇒ 抛 UrlBlocked；安全 ⇒ 返回规范化 href。判据顺序照 JS：
    协议 → IPv4 → IPv6 → 保留主机名 → userinfo。"""
    try:
        u = urllib.parse.urlsplit(str(raw))
    except Exception:
        raise UrlBlocked(str(raw)[:80], "url 无法解析")
    scheme = (u.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise UrlBlocked(raw, f"协议 {u.scheme or '(无)'} 不许（只放 http/https）")
    host = (u.hostname or "").lower()
    if not host:
        raise UrlBlocked(raw, "URL 无主机名（py 更严：JS 侧 hostname 为空串放行，见对账白名单）")
    cand = _v4_candidate(host)
    if cand is not None:
        quad = _expand_v4(cand)
        if quad is None:
            raise UrlBlocked(raw, "无效 IPv4 字面量（SSRF 闸）")
        if _is_private_v4(quad[0], quad[1]):
            raise UrlBlocked(raw, "内网/环回/链路本地地址（SSRF 闸）")
    elif ":" in host:
        packed = _v6_packed(host)
        if packed is None:
            raise UrlBlocked(raw, "无效 IPv6 字面量（SSRF 闸）")
        if _is_private_v6_bytes(packed):
            raise UrlBlocked(raw, "内网 IPv6 地址（SSRF 闸）")
    if _BLOCKED_HOSTS.match(host):
        raise UrlBlocked(raw, "保留主机名（localhost/.internal/.local/…）")
    if u.username or u.password:
        raise UrlBlocked(raw, "URL 里带凭据（userinfo）：不许")
    return normalize_url(raw)


def normalize_url(raw: str) -> str:
    """小写协议/主机、去默认端口、IPv6 加回方括号。
    ★ 不做 .. 折叠与 IPv6 文本规范化（JS 侧 new URL 会做）：SSRF 判定只看主机与端口，
      这两项不影响闸的结论；差异账见 04 开发日志 L-007。"""
    u = urllib.parse.urlsplit(str(raw))
    scheme = (u.scheme or "").lower()
    port = u.port
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None
    host = (u.hostname or "").lower()
    netloc = "[" + host + "]" if ":" in host else host
    if u.username:
        info = urllib.parse.quote(u.username, safe="")
        netloc = f"{info}:{urllib.parse.quote(u.password or '', safe='')}@{netloc}"
    if port:
        netloc = f"{netloc}:{port}"
    return urllib.parse.urlunsplit((scheme, netloc, u.path or "/", u.query, u.fragment))


# ------------------------------------------------------------------ 流式读

def _read_capped(resp: Any, limit: int, on_bytes: Any = None) -> bytes:
    """流式读，最多吃 limit+1 字节（多读 1 字节只为判断"是否超限"）；超限部分丢弃不落盘。
    ★ 06-P1：on_bytes(cum_done) 每 chunk 回调一次（进度上报；回调异常绝不影响下载）。"""
    cap = limit + 1
    buf = bytearray()
    read = getattr(resp, "read", None)
    if read is None:
        return b""
    while len(buf) < cap:
        n = read(min(262144, cap - len(buf)))
        if not n:
            break
        buf += n
        if on_bytes is not None:
            try:
                on_bytes(len(buf))
            except Exception:
                pass   # 进度是附加面，坏在它身上也不能咬下载本体
    return bytes(buf[:cap])


def _sniff_challenge(head: bytes) -> Optional[str]:
    """小体积正文的拦截特征嗅探：命中 detect 的词法特征 ⇒ 返回类型；否则 None。
    只在 ≤CHALLENGE_SNIFF_BYTES 且 content-type 是 text/html 时调用（大文件不嗅，防误判）。
    """
    try:
        from support.detect import classify, is_challenge_title  # noqa: PLC0415
    except Exception:
        return None
    text = head.decode("utf-8", "ignore")
    k = classify(text)
    return k


# ------------------------------------------------------------------ 三条腿

def _http_headers() -> Dict[str, str]:
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        # 不带 Accept-Encoding: br/zstd —— urllib 侧解不了（同 orchestrator._http_headers 的账）
    }


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁自动跳转：30x 直接交回调用方，由我们自己跟、每跳重过闸（关联表 #30）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def _ssl_context() -> Optional[ssl.SSLContext]:
    try:
        import certifi  # noqa: PLC0415
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return None


class _Progress:
    """★ 06-P1：下载进度小文件（宿主无工具进度通道，S1 探测定案 ⇒ 文件面外显）。

    - 路径 = `<dest>.fpdl.json`（继承 dest 的 `fp_` 前缀 ⇒ 清扫家族自动覆盖，关联表 #76）。
    - 覆写式原子替换（写 tmp 再 rename），观察者永远读到完整 JSON。
    - 节流 ≥0.4s 一跳；总时长/均速/腿名/已收字节/Content-Length 全带上。
    - 结束时置终态快照后**删除**（文件消失 = 完成信号；JS 侧不需要读它，死因仍走 verdict 契约）。
    - 任何异常一律吞：进度是附加面，绝不咬下载本体。
    """

    def __init__(self, dest: Path, url: str, leg: str, limit: int):
        self.path = Path(str(dest) + ".fpdl.json")
        self.started = time.monotonic()
        self.url = url
        self.leg = leg
        self.limit = limit
        self.total = None          # Content-Length（可得时）
        self.last_emit = 0.0
        self.max_seen = 0
        self.alive = True

    def set_leg(self, leg: str, restarted: bool = False):
        self.leg = leg
        if restarted:
            self.max_seen = 0
            self.started = time.monotonic()
        self._emit(force=True)

    def set_total(self, total):
        try:
            t = int(total)
            if t > 0:
                self.total = t
        except Exception:
            pass

    def tick(self, done: int):
        if done > self.max_seen:
            self.max_seen = done
        now = time.monotonic()
        if now - self.last_emit >= 0.4:
            self._emit()

    def _emit(self, force: bool = False, final: str = ""):
        if not self.alive and not final:
            return
        now = time.monotonic()
        if not force and not final and now - self.last_emit < 0.4:
            return
        self.last_emit = now
        el = max(now - self.started, 1e-6)
        body = {
            "status": final or "downloading",
            "leg": self.leg, "url": self.url,
            "bytes_done": self.max_seen, "bytes_total": self.total,
            "limit": self.limit, "elapsed_s": round(el, 2),
            "avg_Bps": int(self.max_seen / el), "updated": round(now, 3),
        }
        try:
            tmp = Path(str(self.path) + ".tmp")
            tmp.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.path)
        except Exception:
            pass

    def finish(self, final: str):
        """终态：写最后一跳后删除小文件（消失 = 结束，见外部观察者无需轮询两遍）。"""
        self._emit(force=True, final=final)
        self.alive = False
        try:
            self.path.unlink()
        except Exception:
            pass


def _leg_http(url: str, dest: Path, timeout: int, limit: int,
              hops_log: List[str], prog: Any = None) -> Tuple[Optional[str], Optional[str], Optional[int], Optional[str], Optional[int]]:
    """返回 (final_url, content_type, size, diag)；diag 非空 = 本腿失败。"""
    current = url
    ctx_ssl = _ssl_context()
    handlers: List[Any] = [_NoRedirect(), urllib.request.ProxyHandler()]
    if ctx_ssl is not None:
        handlers.append(urllib.request.HTTPSHandler(context=ctx_ssl))
    opener = urllib.request.build_opener(*handlers)
    for _ in range(MAX_REDIRECTS + 1):
        assert_safe_url(current)          # ★ 每跳前重过闸
        hops_log.append(current)
        req = urllib.request.Request(current, headers=_http_headers())
        try:
            resp = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as exc:
            code = exc.code
            loc = exc.headers.get("Location") if exc.headers else None
            if 300 <= code < 400 and loc:
                current = urllib.parse.urljoin(current, loc)
                continue
            return None, None, None, f"http {code}", code
        except Exception as exc:
            return None, None, None, f"{type(exc).__name__}: {exc}"[:200], None
        try:
            status = getattr(resp, "status", None) or resp.getcode()
            headers = {str(k).lower(): str(v) for k, v in (resp.headers.items() if resp.headers else [])}
            if 300 <= int(status) < 400 and headers.get("location"):
                current = urllib.parse.urljoin(current, headers["location"])
                continue
            # ★ 与 Node 路同口径：非 2xx 一律判本腿失败（3xx 无 Location 也不落错误页），
            #   交给下一腿；waf/tls 腿同款检查在下面。
            if not (200 <= int(status) < 300):
                return None, None, None, f"http {status}", int(status)
            if prog is not None:
                prog.set_total(headers.get("content-length"))
            raw = _read_capped(resp, limit, on_bytes=(prog.tick if prog is not None else None))
        finally:
            try:
                resp.close()
            except Exception:
                pass
        return _finish_leg(raw, headers, normalize_url(current), limit, dest, int(status))
    return None, None, None, f"重定向超过 {MAX_REDIRECTS} 跳", None


def _curl_cffi():
    r"""惰性拿 curl_cffi.requests。★ 复用 drivers.tls 自带的 pylibs 发现链（发布形态
    `fp\pylibs` / 包根 `deps\pylibs` 两级回退），不自己造第二份找路逻辑；
    import 挪到调用时——`support.*` 导入面坏也不能炸整个模块（门要能单独测判据）。"""
    try:
        from drivers.tls import curl_requests  # noqa: PLC0415
        return curl_requests
    except Exception:
        pass
    try:
        from curl_cffi import requests as curl_requests  # noqa: PLC0415  （--pylibs 已入 sys.path 时）
        return curl_requests
    except Exception:
        return None


def _leg_curl(impersonate: str, url: str, dest: Path, timeout: int, limit: int,
              hops_log: List[str], prog: Any = None) -> Tuple[Optional[str], Optional[str], Optional[int], Optional[str], Optional[int]]:
    curl = _curl_cffi()
    if curl is None:
        return None, None, None, "curl_cffi 不可导入（waf/tls 腿不可用）", None
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        assert_safe_url(current)          # ★ 每跳前重过闸
        hops_log.append(current)
        try:
            r = curl.get(current, impersonate=impersonate, timeout=timeout,
                         allow_redirects=False, headers={"Accept": "*/*"})
        except Exception as exc:
            return None, None, None, f"{type(exc).__name__}: {exc}"[:200], None
        status = getattr(r, "status_code", 0) or 0
        headers = {}
        try:
            headers = {str(k).lower(): str(v) for k, v in dict(r.headers).items()}
        except Exception:
            pass
        if 300 <= int(status) < 400 and headers.get("location"):
            current = urllib.parse.urljoin(current, headers["location"])
            continue
        try:
            raw = r.content or b""
        except Exception as exc:
            return None, None, None, f"content: {type(exc).__name__}: {exc}"[:160], None
        if int(status) not in range(200, 300):
            return None, None, None, f"http {status}", int(status)
        # r.content 是全量入内存的第三方行为，本层拦不住；超限只影响"是否截断落盘"
        truncated = len(raw) > limit
        raw = raw[:limit]
        return _finish_leg(raw, headers, normalize_url(str(getattr(r, "url", "") or current)), limit, dest,
                           int(status), truncated)
    return None, None, None, f"重定向超过 {MAX_REDIRECTS} 跳", None


def _finish_leg(raw: bytes, headers: Dict[str, str], final_url: str, limit: int, dest: Path,
                status: int, extra_truncated: bool = False):
    if not raw:
        return None, None, None, "empty body", None
    ct = (headers.get("content-type") or "").strip()
    head_bytes = raw if len(raw) <= CHALLENGE_SNIFF_BYTES else b""
    low_ct = ct.lower()
    if head_bytes and ("text/html" in low_ct or "text/plain" in low_ct or not low_ct):
        kind = _sniff_challenge(head_bytes)
        if kind:
            return None, None, None, f"hit verification page ({kind})", None
    truncated = extra_truncated or len(raw) > limit
    try:
        dest.write_bytes(raw[:limit])
    except Exception as exc:
        return None, None, None, f"落盘失败 {type(exc).__name__}: {exc}"[:160], None
    return final_url, ct, min(len(raw), limit), ("truncated" if truncated else None), status


LEG_FUNCS = {
    "http": lambda url, dest, to, lim, hops, prog=None: _leg_http(url, dest, to, lim, hops, prog),
    "waf": lambda url, dest, to, lim, hops, prog=None: _leg_curl("chrome", url, dest, to, lim, hops, prog),
    "tls": lambda url, dest, to, lim, hops, prog=None: _leg_curl("chrome136", url, dest, to, lim, hops, prog),
}


# ------------------------------------------------------------------ 主入口

def safe_download(url: str, dest: Path, *, timeout: int = 8, max_bytes: int = DEFAULT_MAX_BYTES,
                  legs: Optional[List[str]] = None, progress: bool = False) -> Dict[str, Any]:
    """三腿递减取原始字节。永不抛（除入口 SSRF 拒）。返回 verdict dict。
    ★ 06-P1：progress=True ⇒ 下载期间在 `<dest>.fpdl.json` 写进度小文件（外部可观察）。
      http 腿逐 chunk 真进度；waf/tls 腿只有相位（curl 全量入内存，第三方行为拦不住，不吹）。"""
    prog = _Progress(dest, url, "init", max_bytes) if progress else None
    t0 = time.monotonic()
    try:
        href = assert_safe_url(url)
    except UrlBlocked as exc:
        if prog:
            prog.finish("blocked")
        return {"ok": False, "blocked": True, "url": exc.href, "reason": exc.reason,
                "leg_used": None, "bytes_file": None, "final_url": None,
                "content_type": None, "size": 0, "hops": [], "errors": [],
                "truncated": False, "ver": VERSION}
    order = [l for l in (legs or list(LEG_ORDER)) if l in LEG_FUNCS]
    if not order:
        order = list(LEG_ORDER)
    errors: List[str] = []
    for leg in order:
        hops: List[str] = []
        if prog:
            prog.set_leg(leg, restarted=(prog.max_seen > 0))   # 换腿重开计时（除非首腿）
        try:
            final_url, ct, size, diag, status = LEG_FUNCS[leg](href, dest, timeout, max_bytes, hops, prog)
        except UrlBlocked as exc:
            errors.append(f"{leg}: URL_BLOCKED: {exc.reason}")
            if prog:
                prog.finish("blocked")
            return {"ok": False, "blocked": True, "url": exc.href, "reason": exc.reason,
                    "leg_used": leg, "bytes_file": None, "final_url": None,
                    "content_type": None, "size": 0, "hops": hops, "errors": errors,
                    "truncated": False, "ver": VERSION}
        except Exception as exc:
            errors.append(f"{leg}: {type(exc).__name__}: {exc}"[:200])
            continue
        if diag == "truncated":
            if prog:
                prog.finish("done-truncated")
            return {"ok": True, "blocked": False, "url": href, "reason": None, "leg_used": leg,
                    "bytes_file": str(dest), "final_url": final_url, "content_type": ct or None,
                    "size": size, "status": status, "hops": hops, "errors": errors,
                    "truncated": True, "elapsed_s": round(time.monotonic() - t0, 2), "ver": VERSION}
        if diag:
            errors.append(f"{leg}: {diag}")
            continue
        if prog:
            prog.finish("done")
        return {"ok": True, "blocked": False, "url": href, "reason": None, "leg_used": leg,
                "bytes_file": str(dest), "final_url": final_url, "content_type": ct or None,
                "size": size, "status": status, "hops": hops, "errors": errors,
                "truncated": False, "elapsed_s": round(time.monotonic() - t0, 2), "ver": VERSION}
    if prog:
        prog.finish("failed")
    return {"ok": False, "blocked": False, "url": href, "reason": None, "leg_used": None,
            "bytes_file": None, "final_url": None, "content_type": None, "size": 0,
            "hops": [], "errors": errors, "truncated": False, "ver": VERSION}


def main(argv: Optional[List[str]] = None) -> None:
    ap = argparse.ArgumentParser(description="原始字节下载器（反扒文件腿）")
    ap.add_argument("url")
    ap.add_argument("--dest", required=True, help="落盘目标（绝对路径，由调用方命名与消毒）")
    ap.add_argument("--pylibs", default=None, help="deps/pylibs 目录（curl_cffi 所在）")
    ap.add_argument("--timeout", type=int, default=8)
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ap.add_argument("--legs", default=None, help="逗号分隔子集，如 waf,tls")
    ap.add_argument("--progress", action="store_true",
                    help="下载期间写 <dest>.fpdl.json 进度小文件（06-P1）")
    ap.add_argument("--quiet", action="store_true", help="不往 stdout 打（结果看 --dest 与退出码）")
    ap.add_argument("--version", action="version", version=VERSION)
    args = ap.parse_args(argv)

    if args.pylibs:
        p = str(Path(args.pylibs).resolve())
        if p not in sys.path:
            sys.path.insert(0, p)
    here = str(Path(__file__).resolve().parents[1])   # fp/ 根，让 support.detect 可导入
    if here not in sys.path:
        sys.path.insert(0, here)

    legs = [s.strip() for s in args.legs.split(",") if s.strip()] if args.legs else None
    v = safe_download(args.url, Path(args.dest), timeout=args.timeout,
                      max_bytes=args.max_bytes, legs=legs,
                      progress=bool(getattr(args, "progress", False)))
    if not args.quiet:
        print(json.dumps(v, ensure_ascii=False))
    if v.get("blocked"):
        sys.exit(2)
    sys.exit(0 if v.get("ok") else 1)


if __name__ == "__main__":
    main()
