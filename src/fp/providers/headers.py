"""请求头（有序）。"""
from __future__ import annotations
import random


def _ua(browser: dict) -> str:
    full = browser.get("full_version", "136.0.7103.114")
    platform = browser.get("platform", "Windows")
    if platform == "macOS":
        os_part = "Macintosh; Intel Mac OS X 10_15_7"
    else:
        os_part = "Windows NT 10.0; Win64; x64"
    return f"Mozilla/5.0 ({os_part}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{full} Safari/537.36"


def _stable_seed(browser: dict) -> int:
    full = browser.get("full_version", "136.0.7103.114")
    return sum((i + 1) * ord(c) for i, c in enumerate(full))


def headers(profile: dict | None = None) -> dict:
    profile = profile or {}
    browser = profile.get("browser", {})
    major = browser.get("major", 136)
    mobile = browser.get("mobile", False)
    platform = browser.get("platform", "Windows")
    platform_value = "macOS" if platform == "macOS" else "Windows"
    rng = random.Random(_stable_seed(browser))
    brands = [
        f'"Chromium";v="{major}"',
        f'"Google Chrome";v="{major}"',
        '"Not-A.Brand";v="99"',
    ]
    rng.shuffle(brands)
    sec_ch_ua = ", ".join(brands)
    d = {}
    d["User-Agent"] = _ua(browser)
    d["sec-ch-ua"] = sec_ch_ua
    d["sec-ch-ua-mobile"] = "?1" if mobile else "?0"
    d["sec-ch-ua-platform"] = f'"{platform_value}"'
    d["Upgrade-Insecure-Requests"] = "1"
    d["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    d["Sec-Fetch-Site"] = "none"
    d["Sec-Fetch-Mode"] = "navigate"
    d["Sec-Fetch-User"] = "?1"
    d["Sec-Fetch-Dest"] = "document"
    d["Accept-Encoding"] = "gzip, deflate, br, zstd"
    langs = browser.get("languages", ["zh-CN", "zh", "en"])
    d["Accept-Language"] = ",".join(f"{l};q={round(1 - i*0.1,1)}" for i, l in enumerate(langs))
    d["priority"] = "u=0, i"
    return d


def headers_ordered(profile: dict | None = None) -> list:
    return list(headers(profile).items())
