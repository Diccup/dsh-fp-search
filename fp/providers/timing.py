"""时序画像。"""
from __future__ import annotations
import random


def timing_profile(seed: int = 0) -> dict:
    rng = random.Random(seed)
    return {
        "request_gap_ms": {"dist": "lognormal", "mu": round(rng.uniform(5.5, 7.0), 2), "sigma": round(rng.uniform(0.4, 0.7), 2)},
        "think_ms": rng.randint(300, 1200),
        "page_dwell_ms": rng.randint(4000, 15000),
        "first_byte_ms": rng.randint(120, 600),
        "retry_backoff": {"base": 500, "cap": 8000, "jitter": 0.2},
    }
