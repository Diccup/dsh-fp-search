"""验证页 / 限流页 / 挑战页识别。

`is_blocked(text)` 判"是否被拦"，`classify(text)` 进一步分类型，便于诊断与降级策略。
注意：长正文里偶尔出现"验证码""Just a moment"字样不算拦截，调用方应配合正文长度判断
（`support.orchestrator._is_blocked` 已内置 len < 5000 的约束）。
"""
from __future__ import annotations
import re
from typing import Optional

BLOCK_WORDS = [
    # 中文通用（只留强特征，避免"请稍候/请稍后重试"这类正常页面误判）
    "安全验证", "人机验证", "拖动滑块", "滑动验证", "验证码", "访问异常",
    "暂时受到限制", "访问过于频繁", "请求过于频繁", "操作太频繁",
    "请完成下方验证", "异常，暂时限制",
    # Cloudflare
    "Just a moment", "Checking your browser", "Enable JavaScript",
    "Attention Required", "正在进行安全验证", "确认您是真人",
    "Verify you are human", "One more step", "Ray ID",
    # 阿里云 WAF / 通用拦截
    "acw_sc__v2", "Request blocked",
    # 常见限流
    "Too Many Requests", "rate limit",
]

# 预编译：大小写不敏感匹配英文特征
_PATTERNS = [
    (re.compile(r"just a moment", re.I), "cloudflare"),
    (re.compile(r"checking your browser", re.I), "cloudflare"),
    (re.compile(r"attention required", re.I), "cloudflare"),
    (re.compile(r"正在进行安全验证"), "cloudflare"),
    (re.compile(r"verify you are human|确认您是真人|one more step", re.I), "turnstile"),
    (re.compile(r"acw_sc__v2"), "alibaba_waf"),
    (re.compile(r"拖动滑块|滑动验证|slider captcha", re.I), "captcha"),
    (re.compile(r"too many requests|访问过于频繁|请求过于频繁|操作太频繁", re.I), "rate_limit"),
    (re.compile(r"request blocked|access denied|访问被拒绝", re.I), "waf"),
]

CHALLENGE_ONLY_TITLES = ("just a moment", "请稍候", "attention required", "安全验证",
                         "正在进行安全验证", "verifying you are human")


def is_blocked(text: str) -> bool:
    """命中任一拦截特征即视为被拦。"""
    return classify(text) is not None


def classify(text: str) -> Optional[str]:
    """返回拦截类型：cloudflare / turnstile / alibaba_waf / captcha / rate_limit / waf / generic。"""
    body = text or ""
    if not body:
        return None
    for pattern, kind in _PATTERNS:
        if pattern.search(body):
            return kind
    if any(word in body for word in BLOCK_WORDS):
        return "generic"
    return None


def is_challenge_title(title: str) -> bool:
    """标题就是挑战页标题（CF/人机页常整页只有标题）。"""
    low = (title or "").strip().lower()
    return any(t.lower() in low for t in CHALLENGE_ONLY_TITLES)
