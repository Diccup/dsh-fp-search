"""元素定位与坐标（最小骨架）。"""
from __future__ import annotations
from typing import Dict, Any

def center_of(rect: Dict[str, Any]) -> tuple[int, int]:
    x = int(rect.get("x", 0) + rect.get("width", 0) / 2)
    y = int(rect.get("y", 0) + rect.get("height", 0) / 2)
    return x, y
