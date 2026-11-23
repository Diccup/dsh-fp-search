"""会话画像。"""
from __future__ import annotations
import random


def session_profile(seed: int = 0) -> dict:
    rng = random.Random(seed)
    sid = f"s{rng.getrandbits(64):x}"
    return {
        "sid": sid,
        "cookies": {},
        "reuse": True,
        "cookie_jar_path": None,
        "header_case": "preserve",
        "h2_settings_ack": True,
    }
