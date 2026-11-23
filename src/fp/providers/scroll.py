"""滚动行为。"""
from __future__ import annotations
import random


def scroll_profile(seed: int = 0) -> dict:
    rng = random.Random(seed)
    return {
        "step_px": rng.randint(300, 900),
        "speed_px_per_s": rng.randint(600, 1800),
        "pause_ms": rng.randint(100, 600),
        "inertia": True,
        "overscroll_px": rng.randint(0, 30),
        "wheel_delta_modes": [0, 1, 2],
    }
