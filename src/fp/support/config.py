"""配置加载：DEFAULT_CONFIG ← config.json ← FPWEB_* 环境变量。"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

BASE = Path(__file__).resolve().parents[1]

DEFAULT_CONFIG: Dict[str, Any] = {
    "timeout": 20,
    "out_dir": str(BASE / "out"),
    "legs": ["http", "waf", "tls", "render", "cdp"],
    "user_agent_override": None,
    "proxy": None,
    "retries": 2,
    "seed": 0,
    "verbose": False,
    "save_text": True,
    "max_chars": 200000,
}

# 环境变量名 → (键, 解析函数)；FPWEB_TIMEOUT=20 → cfg["timeout"]=20
_ENV_KEYS = {
    "FPWEB_TIMEOUT": ("timeout", int),
    "FPWEB_OUT_DIR": ("out_dir", str),
    "FPWEB_USER_AGENT_OVERRIDE": ("user_agent_override", str),
    "FPWEB_PROXY": ("proxy", str),
    "FPWEB_RETRIES": ("retries", int),
    "FPWEB_SEED": ("seed", int),
    "FPWEB_MAX_CHARS": ("max_chars", int),
    "FPWEB_SAVE_TEXT": ("save_text", lambda v: v.lower() in ("1", "true", "yes")),
    "FPWEB_VERBOSE": ("verbose", lambda v: v.lower() in ("1", "true", "yes")),
}


def legs_order() -> list[str]:
    """五条腿固定顺序。"""
    return ["http", "waf", "tls", "render", "cdp"]


def _load_json_file(path: Path) -> Dict[str, Any]:
    """读 JSON 配置文件；坏 JSON 不崩，警告到 stderr 后忽略。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
        print(f"[config] {path.name} 顶层不是对象，忽略", file=sys.stderr)
        return {}
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[config] 读取 {path} 失败（{exc}），忽略", file=sys.stderr)
        return {}


def load_config(path: Optional[Path] = None) -> Dict[str, Any]:
    """合并默认值、项目根 config.json 与 FPWEB_* 环境变量，返回新 dict。"""
    cfg = dict(DEFAULT_CONFIG)
    file_path = Path(path) if path else BASE / "config.json"
    for k, v in _load_json_file(file_path).items():
        cfg[k] = v
    for env_name, (key, cast) in _ENV_KEYS.items():
        raw = os.environ.get(env_name)
        if raw is None or raw == "":
            continue
        try:
            cfg[key] = cast(raw)
        except (ValueError, TypeError):
            print(f"[config] 环境变量 {env_name}={raw!r} 解析失败，忽略", file=sys.stderr)
    if not isinstance(cfg.get("legs"), list) or not cfg["legs"]:
        cfg["legs"] = legs_order()
    return cfg


def save_config(cfg: Dict[str, Any], path: Optional[Path] = None) -> Path:
    """可选：把配置写回 JSON 文件（原子写）。"""
    file_path = Path(path) if path else BASE / "config.json"
    tmp = file_path.with_name(file_path.name + ".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, file_path)
    return file_path
