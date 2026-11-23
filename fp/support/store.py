"""持久化：画像/cookie/进度（原子写 + 版本化）。"""
from __future__ import annotations
import json
import os
from pathlib import Path


def ensure_dir(p) -> Path:
    p = Path(p)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _atomic_write(path: Path, data: dict, backup: bool = True) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if backup and path.exists():
        bak = path.with_suffix(path.suffix + ".bak")
        try:
            os.replace(path, bak)
        except OSError:
            pass
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def save_persona(path, persona) -> None:
    _atomic_write(Path(path), persona)


def load_persona(path) -> dict:
    path = Path(path)
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "persona_version" not in data:
        data["persona_version"] = 0
        data["_migrated"] = True
    return data


def save_state(path, state) -> None:
    _atomic_write(Path(path), state)


def load_state(path) -> dict:
    path = Path(path)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_persona_versioned(directory, persona) -> Path:
    directory = ensure_dir(directory)
    version = int((persona or {}).get("persona_version", 1))
    versioned = directory / f"persona.v{version}.json"
    _atomic_write(versioned, persona, backup=False)
    # pointer file
    _atomic_write(directory / "persona.json", persona, backup=False)
    return versioned
