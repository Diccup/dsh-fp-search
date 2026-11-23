"""键盘动作。"""
from __future__ import annotations
import random


def keyboard_profile(seed: int = 0) -> dict:
    rng = random.Random(seed)
    intra_lo = rng.randint(50, 90)
    intra_hi = intra_lo + rng.randint(40, 80)
    inter_lo = rng.randint(150, 260)
    inter_hi = inter_lo + rng.randint(180, 320)
    return {
        "intra_word_ms": [intra_lo, intra_hi],
        "inter_word_ms": [inter_lo, inter_hi],
        "typo_rate": round(rng.uniform(0.008, 0.02), 4),
        "backspace_delay_ms": [rng.randint(40, 90), rng.randint(90, 180)],
        "modifier_delay_ms": [rng.randint(20, 60), rng.randint(60, 120)],
        "paste_rate": round(rng.uniform(0.0, 0.05), 4),
    }


def typing_track(text: str, profile: dict | None = None) -> list:
    profile = profile or {}
    intra = profile.get("intra_word_ms", [60, 120])
    inter = profile.get("inter_word_ms", [200, 400])
    out = []
    for i, ch in enumerate(text):
        if ch == " ":
            out.append({"char": ch, "delay_ms": random.choice(inter)})
        else:
            out.append({"char": ch, "delay_ms": random.choice(intra)})
    return out
