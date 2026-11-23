# -*- coding: utf-8 -*-
"""
cdp_client.py —— Edge CDP 客户端（纯 stdlib，零依赖）

本机 Edge 用 --remote-debugging-port 暴露 CDP 服务端；本工具用【纯 stdlib】手写 RFC6455 WebSocket 客户端 + JSON-RPC 与它对话。
不用 Playwright、不用 patchright、不用下载 Chromium。

提供四件事：
  1. Edge 能否用 --remote-debugging-port 起起来并暴露 /json/version
  2. 能否用【纯 stdlib】完成 WebSocket 握手（手写 RFC6455 client，不装 websocket-client）
  3. 能否通过 CDP 下发 Runtime.evaluate / Input.dispatchMouseEvent
  4. 端到端：打开一个页面 → 读 title → 模拟鼠标点击 → 读回结果

为什么重要：Scrapling 的 CF 求解器靠 Playwright 的 Page API（click/mouse），本机没 Playwright。
本工具让同等能力可用（Input.dispatchMouseEvent 派发真人式点击），从而省掉 200MB Chromium。

用法：
  python cdp_client.py <URL> [--port 9222] [--click X,Y] [--keep]

退出码：0 全部通过 / 1 部分步骤失败 / 2 浏览器起不来
"""
import sys, os, re, json, time, socket, base64, hashlib, struct, subprocess, tempfile, urllib.request, uuid

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
CREATE_NO_WINDOW = 0x08000000


def _mkworkdir(prefix: str = "cdpprobe_") -> str:
    """沙箱下 mkdtemp 建出的目录不可写，改用项目内 mkdir 继承正常 ACL。"""
    base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "out", ".tmp")
    try:
        os.makedirs(base, exist_ok=True)
        path = os.path.join(base, prefix + uuid.uuid4().hex[:8])
        os.makedirs(path, exist_ok=True)
        return path
    except Exception:
        return tempfile.mkdtemp(prefix=prefix)


# ---------- 1. 纯 stdlib WebSocket client（RFC6455） ----------

class WSClient:
    """最小可用 WebSocket 客户端：握手 + 文本帧收发。够 CDP 用。"""

    def __init__(self, url, timeout=30):
        m = re.match(r"ws://([^/:]+):(\d+)(/.*)", url)
        if not m:
            raise ValueError("bad ws url: %s" % url)
        host, port, path = m.group(1), int(m.group(2)), m.group(3)
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)
        )
        self.sock.sendall(req.encode())
        # 读握手响应
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("ws handshake closed")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise ConnectionError("ws handshake failed: %r" % head[:120])
        accept = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if accept.encode() not in head:
            raise ConnectionError("ws accept key mismatch")
        self._buf = rest

    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("ws closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def send(self, text):
        payload = text.encode()
        header = bytearray([0x81])  # FIN + text
        n = len(payload)
        mask_bit = 0x80
        if n < 126:
            header.append(mask_bit | n)
        elif n < (1 << 16):
            header.append(mask_bit | 126)
            header += struct.pack(">H", n)
        else:
            header.append(mask_bit | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv(self):
        """收一帧（文本），自动处理 ping/pong 与分片。"""
        while True:
            b0, b1 = self._recv_exact(2)
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else None
            data = self._recv_exact(length)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x9:      # ping -> pong
                self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
                continue
            if opcode == 0x8:
                raise ConnectionError("ws close frame")
            if opcode in (0x1, 0x2):
                return data.decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


class CDPSession:
    def __init__(self, ws_url):
        self.ws = WSClient(ws_url)
        self._id = 0

    def call(self, method, params=None, timeout=30):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (method, msg["error"]))
                return msg.get("result", {})
        raise TimeoutError(method)

    def evaluate(self, expr):
        r = self.call("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": True})
        res = r.get("result", {})
        if r.get("exceptionDetails"):
            return {"__error__": str(r["exceptionDetails"])[:200]}
        return res.get("value")

    def mouse_click(self, x, y, delay_ms=150):
        """按 Scrapling 的做法：mousePressed -> delay -> mouseReleased。"""
        common = {"x": int(x), "y": int(y), "button": "left", "clickCount": 1}
        self.call("Input.dispatchMouseEvent", dict(common, type="mouseMoved", buttons=0))
        self.call("Input.dispatchMouseEvent", dict(common, type="mousePressed", buttons=1))
        time.sleep(delay_ms / 1000.0)
        self.call("Input.dispatchMouseEvent", dict(common, type="mouseReleased", buttons=0))

    def close(self):
        self.ws.close()


# ---------- 2. 起 Edge 并等 CDP 就绪 ----------

def start_edge(port, timeout=40):
    tmp = _mkworkdir("cdpprobe_")
    args = [
        EDGE, "--headless=new", "--disable-gpu", "--no-first-run",
        "--disable-extensions", "--remote-debugging-port=%d" % port,
        "--remote-allow-origins=*", "--user-data-dir=%s" % tmp,
        "--disable-blink-features=AutomationControlled",
        "about:blank",
    ]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            stdin=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port, timeout=3) as r:
                return proc, json.loads(r.read().decode()), tmp
        except Exception:
            if proc.poll() is not None:
                break
            time.sleep(1)
    try:
        proc.kill()
    except Exception:
        pass
    return None, None, tmp


def new_tab(port, url, timeout=30):
    """开一个新标签页，返回该页的 webSocketDebuggerUrl。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:%d/json/new?%s" % (port, urllib.parse.quote(url, safe="")),
                method="PUT")
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read().decode())
        except Exception:
            time.sleep(1)
    return None


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"
    port = 9222
    click = None
    for i, a in enumerate(sys.argv):
        if a == "--port":
            port = int(sys.argv[i + 1])
        if a == "--click":
            click = tuple(int(x) for x in sys.argv[i + 1].split(","))
    import urllib.parse  # noqa

    print("[1] 起 Edge CDP ...")
    proc, ver, tmp = start_edge(port)
    if not ver:
        print("    FAIL: Edge 没起来 / CDP 端口没开")
        return 2
    print("    OK: %s" % ver.get("Browser"))
    print("    websocket: %s" % ver.get("webSocketDebuggerUrl"))

    print("[2] 开新标签页 %s ..." % url)
    tab = new_tab(port, url)
    if not tab:
        print("    FAIL: /json/new 失败")
        proc.kill()
        return 2
    print("    OK: tabId=%s" % tab.get("id"))

    print("[3] 纯 stdlib WebSocket 握手 + CDP 调用 ...")
    try:
        s = CDPSession(tab["webSocketDebuggerUrl"])
    except Exception as exc:
        print("    FAIL: %s: %s" % (type(exc).__name__, exc))
        proc.kill()
        return 1
    try:
        s.call("Page.enable")
        s.call("Runtime.enable")
        title = s.evaluate("document.title")
        ua = s.evaluate("navigator.userAgent")
        wd = s.evaluate("navigator.webdriver")
        print("    OK: title=%r" % title)
        print("    UA=%s" % ua)
        print("    navigator.webdriver=%r  (False=未被识别为自动化)" % wd)

        print("[4] 等页面加载后读正文长度 ...")
        for _ in range(12):
            time.sleep(1)
            st = s.evaluate("document.readyState")
            if st == "complete":
                break
        info = s.evaluate("JSON.stringify({len: document.body?document.body.innerText.length:0, "
                          "title: document.title, "
                          "cfiframe: !!document.querySelector(\"iframe[src*='challenges.cloudflare.com']\")})")
        print("    %s" % info)

        if click:
            print("[5] 模拟真人点击 (%d,%d) ..." % click)
            s.mouse_click(click[0], click[1], delay_ms=150)
            time.sleep(3)
            after = s.evaluate("JSON.stringify({title: document.title, "
                               "len: document.body?document.body.innerText.length:0})")
            print("    点击后: %s" % after)
    except Exception as exc:
        print("    FAIL: %s: %s" % (type(exc).__name__, exc))
        s.close()
        proc.kill()
        return 1
    finally:
        try:
            s.close()
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n结论：纯 stdlib 走通 CDP，本机 Edge 可被程序驱动（无需 Playwright/Chromium）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

