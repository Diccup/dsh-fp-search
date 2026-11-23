"""TLS 指纹。"""
from __future__ import annotations

def tls_profile(browser: dict | None = None) -> dict:
    browser = browser or {}
    impersonate = browser.get("impersonate", "chrome136")
    return {
        "impersonate": impersonate,
        "tls_version": "1.3",
        "alpn": ["h2", "http/1.1"],
        "http3": False,
        "ja3_note": "chrome-like tls 1.3",
    }
