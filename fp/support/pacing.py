"""退避/降速/限速：指数退避、Retry-After 解析、请求间隔、令牌桶。"""
from __future__ import annotations
import email.utils
import random
import threading
import time
from contextlib import contextmanager
from typing import Optional


def backoff(attempt: int, base: float = 0.5, cap: float = 8.0, jitter: float = 0.3) -> float:
    """指数退避 + 抖动，返回实际应 sleep 的秒数（不执行 sleep）。结果封顶在 cap。"""
    raw = min((base or 0.5) * (2 ** max(0, int(attempt))), cap)
    spread = raw * (jitter or 0.0)
    return max(0.0, min(cap, raw + random.uniform(-spread, spread)))


def parse_retry_after(value: Optional[str]) -> Optional[float]:
    """解析 Retry-After：秒数或 HTTP 日期，返回秒；非法/过期回 None。"""
    if not value:
        return None
    text = value.strip()
    if text.isdigit():
        return float(text)
    try:
        target = email.utils.parsedate_to_datetime(text)
        delta = target.timestamp() - time.time()
        return delta if delta > 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def sleep_gap(rng: random.Random, profile: Optional[dict] = None) -> float:
    """按 providers.timing 的 request_gap_ms 画像抽样睡眠，返回秒数。

    profile 为空时自动生成一个（seed=0）；解析失败退化为固定 0.3s。
    """
    if profile is None:
        try:
            from providers.timing import timing_profile
            profile = timing_profile(0)
        except Exception:
            return 0.3
    gap = profile.get("request_gap_ms") if isinstance(profile, dict) else None
    seconds = 0.3
    if isinstance(gap, dict):
        try:
            mu = float(gap.get("mu", 6.2))
            sigma = float(gap.get("sigma", 0.55))
            seconds = rng.lognormvariate(mu, sigma) / 1000.0
        except (ValueError, TypeError, AttributeError):
            seconds = 0.3
    elif isinstance(gap, (int, float)):
        seconds = float(gap) / 1000.0
    seconds = max(0.0, min(seconds, 30.0))
    if seconds > 0:
        time.sleep(seconds)
    return seconds


class rate_limiter:
    """简单令牌桶限速：per_second 每秒补充令牌，acquire() 无令牌时阻塞等待。

    用法一（类）：rl = rate_limiter(2)；rl.acquire()
    用法二（上下文管理器）：with rate_limiter(2): ...
    """

    def __init__(self, per_second: float = 1.0, capacity: Optional[int] = None):
        rate = max(1e-6, float(per_second))
        self._rate = rate
        self._capacity = float(capacity if capacity is not None else max(1.0, rate))
        self._tokens = self._capacity
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    def _refill(self) -> None:
        now = time.monotonic()
        self._tokens = min(self._capacity, self._tokens + (now - self._updated) * self._rate)
        self._updated = now

    def acquire(self, timeout: Optional[float] = None) -> bool:
        """取一个令牌；timeout 秒内拿不到回 False（None 表示无限等）。"""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            with self._lock:
                self._refill()
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return True
                wait = (1.0 - self._tokens) / self._rate
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                wait = min(wait, remaining)
            # ponytail: 固定 50ms 轮询醒来重试；高 QPS 场景换 Condition 精确唤醒
            time.sleep(min(0.05, wait) if wait > 0 else 0.001)

    def __enter__(self) -> "rate_limiter":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        return None
