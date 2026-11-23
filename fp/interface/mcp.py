"""MCP Server：JSON-RPC 2.0 over stdio，逐行读入、逐行输出（纯标准库）。"""
from __future__ import annotations
import json
import sys
from pathlib import Path
from typing import Any, Dict

BASE = Path(__file__).resolve().parents[1]
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "fpwebsearch", "version": "0.1.0"}

_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "url": {"type": "string", "description": "target URL"},
        "force_leg": {"type": "string", "enum": ["http", "waf", "tls", "render", "cdp"],
                      "description": "run only this leg (optional)"},
        "timeout": {"type": "integer", "description": "per-request timeout seconds (optional)"},
        "out_dir": {"type": "string", "description": "output directory (optional)"},
    },
    "required": ["url"],
}

TOOLS = [
    {
        "name": "fetch",
        "description": "fetch a URL through the five-leg pipeline (http->waf->tls->render->cdp), "
                       "save text/json under out_dir, return the unified JSON verdict",
        "inputSchema": _INPUT_SCHEMA,
    },
    {
        "name": "probe",
        "description": "probe a URL: status/title/chars only, no body file written",
        "inputSchema": _INPUT_SCHEMA,
    },
]


def tool_list() -> list[dict]:
    """工具清单（原样拷贝，避免调用方改坏内部结构）。"""
    return [dict(t) for t in TOOLS]


def _tool_def(name: str) -> Dict[str, Any]:
    for t in TOOLS:
        if t["name"] == name:
            return t
    raise ValueError(f"unknown tool: {name}")


def _call_tool(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """调 orchestrator.fetch，返回 tools/call 的 result。"""
    if name not in ("fetch", "probe"):
        return {"content": [{"type": "text", "text": json.dumps(
            {"error": f"unknown tool: {name}"}, ensure_ascii=False)}]}
    from support.orchestrator import fetch
    verdict = fetch(
        args.get("url", ""),
        probe=(name == "probe"),
        force_leg=args.get("force_leg"),
        timeout=args.get("timeout"),
        out_dir=args.get("out_dir"),
        emit=False,
    )
    return {"content": [{"type": "text", "text": json.dumps(verdict, ensure_ascii=False)}]}


def handle_request(msg: Dict[str, Any]) -> Dict[str, Any] | None:
    """处理一条请求，返回响应 dict；通知/空消息回 None。"""
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}
    if method is None:
        return None
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL_VERSION, "serverInfo": dict(SERVER_INFO),
                  "capabilities": {"tools": {}}}
    elif method == "tools/list":
        result = {"tools": tool_list()}
    elif method == "tools/call":
        result = _call_tool(params.get("name", ""), params.get("arguments") or {})
    elif method in ("notifications/initialized", "initialized"):
        return None
    else:
        if msg_id is None:
            return None
        return {"jsonrpc": "2.0", "id": msg_id,
                "error": {"code": -32601, "message": f"method not found: {method}"}}
    if msg_id is None:
        return None
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def serve() -> None:
    """主循环：stdin 逐行读请求，stdout 逐行写 JSON-RPC 响应。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            req_id = None
            try:  # 尽力从坏行里抠 id
                probe = json.loads(line)
                req_id = probe.get("id") if isinstance(probe, dict) else None
            except Exception:
                pass
            response = {"jsonrpc": "2.0", "id": req_id,
                        "error": {"code": -32700, "message": "parse error"}}
            print(json.dumps(response, ensure_ascii=False), flush=True)
            continue
        if not isinstance(msg, dict):
            response = {"jsonrpc": "2.0", "id": None,
                        "error": {"code": -32600, "message": "invalid request"}}
        else:
            response = handle_request(msg)
        if response is not None:
            print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    serve()
