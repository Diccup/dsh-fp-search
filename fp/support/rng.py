"""可复现随机源（最小可用）。"""
from __future__ import annotations
import random
import math

def make_rng(seed: int) -> random.Random:
    return random.Random(seed)

def lognormal(rng: random.Random, mu: float, sigma: float) -> float:
    return rng.lognormvariate(mu, sigma)

def uniform(rng: random.Random, a: float, b: float) -> float:
    return rng.uniform(a, b)
