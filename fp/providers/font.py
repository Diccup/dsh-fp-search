"""字体画像。"""
from __future__ import annotations

_WINDOWS_FONTS = [
    "Arial", "Calibri", "Cambria", "Consolas", "Courier New", "Georgia",
    "Microsoft YaHei", "Microsoft JhengHei", "Segoe UI", "SimSun", "Tahoma",
    "Times New Roman", "Trebuchet MS", "Verdana", "微软雅黑", "宋体", "黑体",
    "楷体", "仿宋", "Lucida Console", "Palatino Linotype", "Garamond",
]


def font_profile(platform: str = "Windows") -> dict:
    if platform == "macOS":
        fonts = ["Helvetica", "Helvetica Neue", "Arial", "Times New Roman", "Menlo", "Monaco"]
    else:
        fonts = list(_WINDOWS_FONTS)
    metrics = {
        "Arial": {"width_scale": 1.0},
        "Calibri": {"width_scale": 0.95},
        "Microsoft YaHei": {"width_scale": 1.05},
        "Consolas": {"width_scale": 0.9},
        "Times New Roman": {"width_scale": 1.02},
    }
    return {
        "fonts": fonts,
        "metrics": metrics,
        "fallback_order": ["Microsoft YaHei", "Segoe UI", "Arial", "sans-serif"],
    }
