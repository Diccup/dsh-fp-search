"""滑块求解（纯算法）。"""
from __future__ import annotations
import random
from typing import Any

try:
    from PIL import Image
    _PIL = True
except Exception:
    Image = None
    _PIL = False


def gap_x(bg_bytes, gap_bytes) -> int:
    if not _PIL:
        return -1
    try:
        from io import BytesIO
        bg = Image.open(BytesIO(bg_bytes)).convert("RGB")
        gap = Image.open(BytesIO(gap_bytes)).convert("RGB")
    except Exception:
        return -1
    # simple: find column with max pixel difference in a sliding window
    bw, bh = bg.size
    gw, gh = gap.size
    best_x = 0
    best_score = -1
    for x in range(0, max(1, bw - gw + 1)):
        score = 0
        for y in range(min(bh, gh)):
            for dx in range(gw):
                px = bg.getpixel((min(x + dx, bw - 1), y))
                # gap image usually has transparency; compare alpha? fallback brightness
                score += abs(px[0] - 128) + abs(px[1] - 128) + abs(px[2] - 128)
        if score > best_score:
            best_score = score
            best_x = x
    return best_x


def build_track(distance: int, rng=None) -> list:
    if rng is None:
        rng = random.Random()
    total_ms = rng.randint(800, 2500)
    steps = rng.randint(12, 30)
    track = []
    x = 0
    y = 0
    # phases
    t = 0
    # accelerate
    for i in range(steps // 3):
        step = rng.randint(5, 15)
        x = min(distance, x + step)
        t += rng.randint(20, 60)
        track.append((x, y + rng.randint(-2, 2), t))
    # uniform with jitter
    for i in range(steps // 3):
        step = rng.randint(3, 10)
        x = min(distance, x + step)
        t += rng.randint(30, 70)
        track.append((x, y + rng.randint(-3, 3), t))
    # decelerate + overshoot + back
    for i in range(steps // 3):
        step = rng.randint(1, 6)
        x = min(distance + rng.randint(2, 5), x + step)
        t += rng.randint(40, 90)
        track.append((x, y + rng.randint(-2, 2), t))
    # back to distance
    if track and track[-1][0] != distance:
        t += rng.randint(30, 80)
        track.append((distance, y, t))
    # ensure total duration
    if track:
        last_t = track[-1][2]
        if last_t < 800:
            # stretch last
            track[-1] = (track[-1][0], track[-1][1], rng.randint(800, 2500))
    # monotonic check: allow <=2 retreats
    # Already mostly monotonic; final exact.
    if not track or track[-1][0] != distance:
        track.append((distance, 0, max(track[-1][2] if track else 0, 800) + 10))
    return track


def simulate_events(track, start=(0, 0)) -> list:
    events = []
    x0, y0 = start
    for x, y, t in track:
        events.append({"type": "mouseMoved", "x": x0 + x, "y": y0 + y, "timestamp": t})
    return events


def solve(html_or_payload: Any) -> dict:
    # compatible: returns dict
    return {"gap": -1, "track": [], "ok": False}


def solve_slider(html: str) -> str:
    return html
