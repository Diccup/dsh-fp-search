"""HTML -> 纯文本 / Markdown。"""
from __future__ import annotations

import re
from html import unescape
from lxml import html as _lhtml

from parse.selectors import BLOCK_TAGS, HTML, normalize_ws, parse

SKIP = {"script", "style", "noscript", "svg"}

# ★ ITERATION-004（建议书 P1-11）：Markdown 输出前的"sanitized"降噪。
#   只认**明确的导航/广告/横幅结构特征**，不按文本猜，避免误删正文：
#   标签层面（nav/aside/footer/header）与 class/id 命名层面（nav|menu|sidebar|
#   breadcrumb|footer|ad|ads|advert|banner|cookie|consent|promo|sponsor|share）。
#   `article`/`main` 子树一律不动（正文保护区）。
_AD_TAGS = ("nav", "aside", "footer", "header")
_AD_KEYS = ("nav", "menu", "sidebar", "side-bar", "breadcrumb", "footer",
            "advert", "adsense", "ad-banner", "advertisement", "banner",
            "cookie", "consent", "gdpr", "promo", "sponsor", "share",
            "social", "subscribe", "newsletter", "popup", "modal")


def _looks_boilerplate(el) -> bool:
    """结构级判据：标签或 class/id 命名像导航/广告/横幅。"""
    tag = (el.tag or "").lower() if isinstance(el.tag, str) else ""
    if tag in _AD_TAGS:
        return True
    keys = ((el.get("class") or "") + " " + (el.get("id") or "")).lower()
    if not keys.strip():
        return False
    return any(k in keys for k in _AD_KEYS)


def strip_boilerplate(html: str) -> str:
    """去掉导航/广告/横幅/浮层的外层结构，返回净化后的 HTML 串。

    ★ ITERATION-004：对标 Scrapling 的 `page.markdown()`"sanitized"思路。
    **保守**：`article`/`main` 子树整体跳过（那是正文保护区）；只删结构明确
    的容器，不按文本内容猜，宁少删不错删。
    """
    root = parse(html)
    for el in root.xpath("//script|//style|//noscript|//svg|//iframe"):
        el.drop_tree()
    # 正文保护区：article/main 内部不动。
    # ★ 不能用 id(el) 建集合：lxml 的 element 代理对象会被回收复用，
    #   id() 会撞（ITERATION-004 实测：nav 被误判为 article 内部而幸免）。
    #   改用 XPath 祖先判定，语义直白且不受代理对象生命周期影响。
    def in_protected(el) -> bool:
        try:
            return bool(el.xpath("ancestor-or-self::article|ancestor-or-self::main"))
        except Exception:
            return False

    # 自底向上删：先删深层，父节点被删时子节点已处理完。
    nodes = [el for el in root.iter() if isinstance(el.tag, str)]
    for el in reversed(nodes):
        if el.getparent() is None:          # 根元素不删
            continue
        try:
            if not el.xpath("ancestor::*"):  # 已被祖先连带删除的游离节点
                continue
        except Exception:
            continue
        if in_protected(el):
            continue
        if _looks_boilerplate(el):
            try:
                el.drop_tree()
            except Exception:
                pass
    return _lhtml.tostring(root, encoding="unicode") if root is not None else html


def title(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    return unescape(m.group(1)).strip() if m else ""


def to_text(html: str) -> str:
    """去 script/style/noscript/svg，块级换行，压缩空白，保留段落。"""
    root = parse(html)
    for el in root.xpath("//script|//style|//noscript|//svg"):
        el.drop_tree()
    parts = []

    def visit(node):
        if node.text:
            parts.append(node.text)
        for child in node:
            tag = (child.tag or "").lower() if isinstance(child.tag, str) else ""
            if tag == "br":
                parts.append("\n")
            elif tag in BLOCK_TAGS:
                parts.append("\n")
            visit(child)
            if tag in BLOCK_TAGS:
                parts.append("\n")
            if child.tail:
                parts.append(child.tail)

    visit(root)
    s = "".join(parts).replace("\xa0", " ")
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def _inline_text(el) -> str:
    parts = []

    def visit(node):
        if node.text:
            parts.append(node.text)
        for child in node:
            tag = (child.tag or "").lower() if isinstance(child.tag, str) else ""
            if tag in SKIP:
                continue
            visit(child)
            if child.tail:
                parts.append(child.tail)

    visit(el)
    return "".join(parts)


def _md(el, out) -> None:
    tag = (el.tag or "").lower() if isinstance(el.tag, str) else ""
    if tag in SKIP:
        return
    if el.text:
        out.append(el.text)
    for child in el:
        _md_one(child, out)
        if child.tail:
            out.append(child.tail)


def _md_one(el, out) -> None:
    tag = (el.tag or "").lower() if isinstance(el.tag, str) else ""
    if tag == "br":
        out.append("\n")
        return
    if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
        out.append(f"\n{'#' * int(tag[1])} {_inline_text(el).strip()}\n")
        return
    if tag == "p":
        out.append("\n")
        _md(el, out)
        out.append("\n")
        return
    if tag == "li":
        out.append("\n- ")
        _md(el, out)
        out.append("\n")
        return
    if tag == "blockquote":
        out.append("\n> ")
        _md(el, out)
        out.append("\n")
        return
    if tag == "pre":
        out.append("\n```\n" + _inline_text(el) + "\n```\n")
        return
    if tag == "code":
        out.append("`" + _inline_text(el) + "`")
        return
    if tag == "a":
        out.append("[" + _inline_text(el) + "](" + (el.get("href") or "") + ")")
        return
    if tag == "img":
        out.append("![ " + (el.get("alt") or "") + "](" + (el.get("src") or "") + ")")
        return
    if tag == "hr":
        out.append("\n---\n")
        return
    if tag == "table":
        out.append("\n" + _table(el) + "\n")
        return
    if tag in ("ul", "ol", "div", "section", "article", "main", "body"):
        _md(el, out)
        return
    _md(el, out)


def _table(el) -> str:
    rows = []
    for tr in el.xpath("./tr"):
        cells = [_inline_text(c).strip() for c in tr.xpath("./th|./td")]
        rows.append("| " + " | ".join(cells) + " |")
    if not rows:
        return ""
    first = el.xpath("./tr[1]")
    n = len(first[0].xpath("./th|./td")) if first else 0
    sep = "| " + " | ".join(["---"] * n) + " |"
    return "\n".join([rows[0], sep] + rows[1:])


def to_markdown(html: str) -> str:
    root = parse(html)
    out = []
    _md(root, out)
    s = "".join(out)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def to_markdown_clean(html: str) -> str:
    """★ ITERATION-004：先去导航/广告/横幅再转 Markdown（LLM-ready 干净稿）。

    对标 Scrapling `page.markdown()` 的 sanitized 语义。降噪是**结构级**的
    （见 `strip_boilerplate`），不按文本猜，正文不被误删。
    """
    return to_markdown(strip_boilerplate(html))


NAV_KEYS = ("nav", "footer", "header", "aside", "menu", "sidebar", "breadcrumb", "copyright")


def main_content(html: str) -> str:
    """启发式去导航/页脚/侧栏，返回主内容 Markdown。"""
    root = parse(html)
    candidates = root.xpath("//article|//main|//div|//section|//li|//table")
    best = None
    best_score = -1e9
    for el in candidates:
        score = _content_score(el)
        if score > best_score:
            best = el
            best_score = score
    if best is None:
        return ""
    return to_markdown(_lhtml.tostring(best, encoding="unicode"))


def _content_score(el) -> float:
    txt = HTML._element_text(el)
    score = len(txt) * 0.5
    cls = ((el.get("class") or "") + " " + (el.get("id") or "")).lower()
    for k in NAV_KEYS:
        if k in cls:
            score -= 100
    links = el.xpath(".//a")
    link_txt = sum(len(HTML._element_text(a)) for a in links)
    if txt:
        score -= (link_txt / len(txt)) * 40
    score -= len(list(el.iterancestors())) * 2
    return score
