"""屏幕与窗口。"""
from __future__ import annotations
import random

_COMBOS = [
    (1920, 1080, 1040),
    (1536, 864, 824),
    (2560, 1440, 1400),
    (1366, 768, 728),
]


def screen_profile(seed: int = 0) -> dict:
    rng = random.Random(seed)
    w, h, avail_h = rng.choice(_COMBOS)
    dpr = rng.choice([1.0, 1.25, 1.5, 2.0])
    outer_w = w
    outer_h = h
    inner_w = outer_w - rng.randint(0, 16)
    inner_h = outer_h - rng.randint(80, 140)
    if inner_w > outer_w:
        inner_w = outer_w
    if inner_h > outer_h:
        inner_h = outer_h
    return {
        "width": w,
        "height": h,
        "avail_width": w,
        "avail_height": avail_h,
        "outer_width": outer_w,
        "outer_height": outer_h,
        "inner_width": inner_w,
        "inner_height": inner_h,
        "dpr": dpr,
        "color_depth": 24,
        "pixel_depth": 24,
        "zoom": 1.0,
    }
