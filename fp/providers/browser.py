"""浏览器画像。"""
from __future__ import annotations
import random
from typing import Dict, Any

_PROFILES = [
    {"family": "chrome", "major": 136, "full_version": "136.0.7103.114", "platform": "Windows",
     "ua_platform": "Windows NT 10.0; Win64; x64", "impersonate": "chrome136",
     "webgl_vendor": "Google Inc. (Intel)", "webgl_renderer": "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)",
     "hardware_concurrency": 8, "device_memory": 8, "languages": ["zh-CN", "zh", "en"],
     "timezone": "Asia/Shanghai", "mobile": False},
    {"family": "chrome", "major": 131, "full_version": "131.0.6778.205", "platform": "Windows",
     "ua_platform": "Windows NT 10.0; Win64; x64", "impersonate": "chrome131",
     "webgl_vendor": "Google Inc. (Intel)", "webgl_renderer": "ANGLE (Intel, Intel(R) Iris Xe Graphics Direct3D11 vs_5_0 ps_5_0)",
     "hardware_concurrency": 12, "device_memory": 16, "languages": ["zh-CN", "zh", "en"],
     "timezone": "Asia/Shanghai", "mobile": False},
    {"family": "chrome", "major": 124, "full_version": "124.0.6367.208", "platform": "Windows",
     "ua_platform": "Windows NT 10.0; Win64; x64", "impersonate": "chrome124",
     "webgl_vendor": "Google Inc. (Intel)", "webgl_renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)",
     "hardware_concurrency": 16, "device_memory": 16, "languages": ["zh-CN", "zh", "en"],
     "timezone": "Asia/Shanghai", "mobile": False},
    {"family": "chrome", "major": 136, "full_version": "136.0.7103.114", "platform": "macOS",
     "ua_platform": "Macintosh; Intel Mac OS X 10_15_7", "impersonate": "chrome136",
     "webgl_vendor": "Google Inc. (Apple)", "webgl_renderer": "ANGLE (Apple, Apple M2, OpenGL 4.1)",
     "hardware_concurrency": 8, "device_memory": 8, "languages": ["zh-CN", "zh", "en"],
     "timezone": "Asia/Shanghai", "mobile": False},
]


def browser_profile(seed: int = 0) -> dict:
    rng = random.Random(seed)
    return dict(rng.choice(_PROFILES))
