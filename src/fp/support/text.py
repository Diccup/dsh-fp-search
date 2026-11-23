"""HTML → 文本（兼容层）。

兼容转发，真实现在 `parse.text`；这里保留 `to_text()` 老入口，避免历史调用点失效。
新代码请直接 `from parse.text import to_text, to_markdown`。
"""
from __future__ import annotations

from parse.text import normalize_ws, to_markdown, to_text  # noqa: F401  统一出口

__all__ = ["to_text", "to_markdown", "normalize_ws"]
