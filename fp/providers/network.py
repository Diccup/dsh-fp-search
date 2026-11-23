"""网络画像。"""
from __future__ import annotations
import random

def network_profile(seed: int = 0) -> dict:
    rng = random.Random(seed)
    return {
        "rtt_ms": {"dist": "lognormal", "mu": round(rng.uniform(4.0, 4.8), 2), "sigma": 0.4},
        "doh": None,
        "proxy": None,
        "connection_reuse": True,
        "doh_candidates": ["https://dns.google/dns-query", "https://cloudflare-dns.com/dns-query"],
        "proxy_pool": None,
    }
