"""鼠标动作。"""
from __future__ import annotations
import random
import math
from typing import List, Tuple


def mouse_profile(seed: int = 0) -> dict:
    rng = random.Random(seed)
    return {
        "movement": {
            "speed_px_per_s": rng.randint(350, 900),
            "jitter_px": rng.randint(1, 4),
            "steps": rng.randint(12, 28),
            "overshoot_px": rng.randint(0, 6),
        },
        "click": {
            "delay_ms": [rng.randint(70, 150), rng.randint(150, 320)],
            "double_click_gap_ms": rng.randint(35, 90),
            "jitter_px": rng.randint(1, 3),
        },
        "wheel": {"notch_px": 120, "inertia": True},
    }


def _stable_seed(start, end):
    return (start[0] * 73856093 ^ start[1] * 19349663 ^ end[0] * 83492791 ^ end[1] * 2654435761) & 0xFFFFFFFF


def bezier_path(start: Tuple[int, int], end: Tuple[int, int], steps: int = 20) -> List[Tuple[int, int]]:
    rng = random.Random(_stable_seed(start, end) + steps)
    c1 = (start[0] + rng.randint(-30, 30), start[1] + rng.randint(-30, 30))
    c2 = (end[0] + rng.randint(-30, 30), end[1] + rng.randint(-30, 30))
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1-t)**3*start[0] + 3*(1-t)**2*t*c1[0] + 3*(1-t)*t**2*c2[0] + t**3*end[0]
        y = (1-t)**3*start[1] + 3*(1-t)**2*t*c1[1] + 3*(1-t)*t**2*c2[1] + t**3*end[1]
        pts.append((int(x), int(y)))
    return pts


def click_points(center: Tuple[int, int], jitter: int = 3) -> Tuple[int, int]:
    rng = random.Random(center[0] * 31 + center[1] * 37 + jitter)
    return center[0] + rng.randint(-jitter, jitter), center[1] + rng.randint(-jitter, jitter)
