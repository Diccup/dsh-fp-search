"""CSS -> XPath 解析层（不依赖 cssselect）。

提供：
- parse(html)           -> lxml 元素（容错；空串返回空元素）
- css(html, selector)   -> list[lxml 元素]
- xpath(html, expr)     -> list
- text/texts/attr/html_of 便捷函数
- css_to_xpath(selector) -> str  纯 Python 转换器
- HTML._element_text(el)   供 parse/text.py 复用
"""
from __future__ import annotations

import re
from typing import Any
from lxml import html as _lhtml

_LOWER = "abcdefghijklmnopqrstuvwxyz"
_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_TRANS = f"translate(name(),'{_UPPER}','{_LOWER}')"

BLOCK_TAGS = {
    "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt",
    "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
    "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "noscript", "ol",
    "p", "pre", "section", "table", "td", "th", "tr", "ul",
}

_TAG = re.compile(r"[a-zA-Z_][\w-]*")
_ATTR_NAME = re.compile(r"[A-Za-z_][\w-]*")
_COMB = {">": "/", "+": "/following-sibling::", " ": "//"}


def normalize_ws(s: str) -> str:
    """压缩所有空白为单空格并两端修剪。"""
    return re.sub(r"\s+", " ", s or "").strip()


class HTML:
    @staticmethod
    def _element_text(el) -> str:
        """元素 innerText：块级/br 换行，&nbsp; 转空白，整体归一化。"""
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

        visit(el)
        s = "".join(parts).replace("\xa0", " ")
        return normalize_ws(s)


def parse(html: str) -> _lhtml.HtmlElement:
    """容错解析；空串返回空文档（保证 css/xpath 不误命中），非法 HTML 兜底。"""
    if not html or not html.strip():
        return _lhtml.fromstring("<html><body></body></html>")
    try:
        return _lhtml.fromstring(html)
    except Exception:
        return _lhtml.fromstring("<html><body></body></html>")


def xpath(html: str, expr: str) -> list:
    return parse(html).xpath(expr)


# ------------------------- CSS -> XPath -------------------------

def _split_top(s: str, sep: str) -> list[str]:
    """按分隔符分割，但不切开 [...] / (...) 内部。"""
    parts, depth, cur = [], 0, []
    for ch in s:
        if ch in "[(":
            depth += 1
        elif ch in "])":
            depth = max(0, depth - 1)
        elif ch == sep and depth == 0:
            parts.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    parts.append("".join(cur))
    return parts


def _parse_compound(s: str, i: int):
    """解析一个复合选择器（不含组合器），返回 (compound, next_i)。"""
    n = len(s)
    tag = None
    universal = False
    ids: list[str] = []
    classes: list[str] = []
    attrs: list[tuple[str, str, str]] = []
    pseudos: list[tuple[str, str | None]] = []
    elements: list[tuple[str, str | None]] = []   # ★ ITERATION-004：伪元素
    while i < n:
        c = s[i]
        if c.isspace() or c in ",>+":
            break
        if c == "*":
            universal = True
            i += 1
            continue
        if c == "#":
            j = i + 1
            m = _TAG.match(s, j)
            j = m.end() if m else j
            ids.append(s[i + 1:j])
            i = j
            continue
        if c == ".":
            j = i + 1
            m = _TAG.match(s, j)
            j = m.end() if m else j
            classes.append(s[i + 1:j])
            i = j
            continue
        if c == "[":
            j = s.index("]", i)
            inner = s[i + 1:j]
            m = re.match(r"^\s*([A-Za-z_][\w-]*)\s*(\^=|\$=|\*=|~=|=)?\s*(.*?)\s*$", inner, re.S)
            aname = m.group(1)
            op = m.group(2) or "exists"
            raw = m.group(3).strip()
            if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
                raw = raw[1:-1]
            attrs.append((aname, op, raw))
            i = j + 1
            continue
        if c == ":":
            # ★ ITERATION-004：伪元素（`::text` / `::attr(name)`）与伪类分开记。
            #   Scrapy/parsel 风格的选择器在 agent 场景高频出现，模型写惯了
            #   `.quote .text::text`，不支持就整个选择器静默失败。
            if i + 1 < n and s[i + 1] == ":":
                j = i + 2
                m = _TAG.match(s, j)
                ename = m.group(0) if m else ""
                j += len(ename)
                earg = None
                if j < n and s[j] == "(":
                    depth = 1
                    k = j + 1
                    while k < n and depth:
                        if s[k] == "(":
                            depth += 1
                        elif s[k] == ")":
                            depth -= 1
                        k += 1
                    earg = s[j + 1:k - 1].strip()
                    j = k
                if ename:
                    elements.append((ename.lower(), earg))
                    i = j
                    continue
                i = j
                continue
            j = i + 1
            m = _TAG.match(s, j)
            name = m.group(0) if m else ""
            j += len(name)
            arg = None
            if j < n and s[j] == "(":
                depth = 1
                k = j + 1
                while k < n and depth:
                    if s[k] == "(":
                        depth += 1
                    elif s[k] == ")":
                        depth -= 1
                    k += 1
                arg = s[j + 1:k - 1]
                j = k
            pseudos.append((name, arg))
            i = j
            continue
        m = _TAG.match(s, i)
        if m:
            tag = m.group(0)
            i += len(tag)
            continue
        # 无法识别的字符：跳过，避免原地循环
        i += 1
        continue
    return (tag, universal, ids, classes, attrs, pseudos, elements), i


def _parse_complex(s: str) -> list[tuple[str, tuple]]:
    """解析一个逗号分组（由组合器串联的复合选择器序列）。"""
    items = []
    comb = " "
    i, n = 0, len(s)
    while i < n:
        while i < n and s[i].isspace():
            i += 1
        if i >= n:
            break
        if s[i] in ">+":
            comb = s[i]
            i += 1
            continue
        compound, i = _parse_compound(s, i)
        items.append((comb, compound))
        comb = " "
    return items


def _xstr(v: str) -> str:
    """XPath 字符串字面量（自处理单引号）。"""
    if "\x27" not in v:
        return "\x27" + v + "\x27"
    if '"' not in v:
        return '"' + v + '"'
    parts = v.split("\x27")
    toks = []
    for i, p in enumerate(parts):
        toks.append("\x27" + p + "\x27")
        if i < len(parts) - 1:
            toks.append("\x27")
    return "concat(" + ", ".join(toks) + ")"


def _attr_pred(aname: str, op: str, val: str) -> str:
    if op == "exists":
        return f"@{aname}"
    if op == "=":
        return f"@{aname}={_xstr(val)}"
    if op == "^=":
        return f"starts-with(@{aname},{_xstr(val)})"
    if op == "$=":
        return f"substring(@{aname}, string-length(@{aname}) - string-length({_xstr(val)}) + 1)={_xstr(val)}"
    if op == "*=":
        return f"contains(@{aname},{_xstr(val)})"
    # op == "~="
    return f"contains(concat(' ',@{aname},' '),' {val} ')"


def _nth_pred(arg: str | None) -> str:
    a = (arg or "").strip().lower()
    if a == "odd":
        return "position() mod 2 = 1"
    if a == "even":
        return "position() mod 2 = 0"
    m = re.match(r"^(\d*)n\s*(?:([+-])\s*(\d+))?$", a)
    if m:
        a_coef = int(m.group(1)) if m.group(1) else 1
        bval = int(m.group(3)) if m.group(3) else 0
        if m.group(2) == "-":
            bval = -bval
        if a_coef == 1 and bval == 0:
            return "position()>=0"  # :nth-child(n) 匹配全部
        return f"(position()-{bval}) mod {a_coef} = 0 and position()>={bval}"
    m = re.match(r"^(\d+)$", a)
    if m:
        return f"position()={m.group(1)}"
    return "position()>=0"


def _nth_of_type_pred(tag: str | None, arg: str | None) -> str:
    """`:nth-of-type(n)` 谓词：数同标签的前序兄弟。

    ★ ITERATION-002（借鉴 Scrapling get_selector 思路）：CSS 有 nth-of-type、
    XPath 1.0 没有，翻译成 count 表达式（与本文件 first-of-type/last-of-type
    的既有实现风格一致）。语义：position = 同型前序兄弟数 + 1，CSS 的
    (position - b) mod a = 0 且 position >= b ⇒ (ce - (b-1)) mod a = 0。
    """
    ce = (f"count(preceding-sibling::*[{_TRANS}='{tag}'])" if tag
          else "count(preceding-sibling::*)")
    a = (arg or "").strip().lower()
    if a == "odd":
        return f"({ce} mod 2 = 0)"
    if a == "even":
        return f"({ce} mod 2 = 1)"
    m = re.match(r"^(\d*)n\s*(?:([+-])\s*(\d+))?$", a)
    if m:
        coef = int(m.group(1)) if m.group(1) else 1
        b = int(m.group(3)) if m.group(3) else 0
        if m.group(2) == "-":
            b = -b
        if coef == 1 and b == 0:
            return "true()"
        off = b - 1
        return f"({ce}-{off}) mod {coef} = 0 and {ce}>={off}"
    m = re.match(r"^(\d+)$", a)
    if m:
        return f"{ce}={int(m.group(1)) - 1}"
    return "true()"


def _of_type_pred(tag: str | None, direction: str) -> str:
    axis = "preceding-sibling" if direction == "preceding" else "following-sibling"
    test = f"*[{_TRANS}='{tag}']" if tag else "*"
    return f"count({axis}::{test})=0"


def _not_pred(arg: str | None) -> str:
    comp, _ = _parse_compound(arg or "", 0)
    tag, universal, ids, classes, attrs, _pseudos, _elements = comp
    parts = []
    if tag and not universal:
        parts.append(f"{_TRANS}='{tag}'")
    for aid in ids:
        parts.append(f"@id={_xstr(aid)}")
    for cls in classes:
        parts.append(f"contains(concat(' ',normalize-space(@class),' '),' {cls} ')")
    for aname, op, val in attrs:
        parts.append(_attr_pred(aname, op, val))
    inner = " and ".join(parts) if parts else "true()"
    return f"not({inner})"


def _compound_xpath(comp: tuple, adjacent: bool = False) -> str:
    tag, universal, ids, classes, attrs, pseudos, _elements = comp
    if adjacent:
        test = "*"
    elif universal:
        test = "*"
    elif tag:
        test = f"*[{_TRANS}='{tag}']"
    else:
        test = "*"
    preds = []
    for aid in ids:
        preds.append(f"@id={_xstr(aid)}")
    for cls in classes:
        preds.append(f"contains(concat(' ',normalize-space(@class),' '),' {cls} ')")
    for aname, op, val in attrs:
        preds.append(_attr_pred(aname, op, val))
    pos_preds: list[str] = []
    not_preds: list[str] = []
    for name, arg in pseudos:
        if name == "first-child":
            pos_preds.append("position()=1")
        elif name == "last-child":
            pos_preds.append("position()=last()")
        elif name == "nth-child":
            pos_preds.append(_nth_pred(arg))
        elif name == "nth-of-type":
            # ★ ITERATION-002：自动选择器生成的路径回退需要它
            pos_preds.append(_nth_of_type_pred(tag if not adjacent else None, arg))
        elif name == "first-of-type":
            pos_preds.append(_of_type_pred(tag if not adjacent else None, "preceding"))
        elif name == "last-of-type":
            pos_preds.append(_of_type_pred(tag if not adjacent else None, "following"))
        elif name == "not":
            not_preds.append(_not_pred(arg))
    if adjacent:
        pos_preds = ["position()=1"] + pos_preds
    out = test
    for p in preds:
        out += f"[{p}]"
    if pos_preds or not_preds:
        out += "[" + " and ".join(pos_preds + not_preds) + "]"
    return out


def _complex_to_xpath(items: list[tuple[str, tuple]]) -> str:
    parts: list[str] = []
    for comb, comp in items:
        step = _compound_xpath(comp, adjacent=(comb == "+"))
        if parts:
            parts.append(_COMB[comb])
        parts.append(step)
    return "//" + "".join(parts) if parts else "*"


def css_to_xpath(selector: str) -> str:
    """纯 Python CSS 子集 -> XPath 1.0。"""
    groups = [g for g in _split_top(selector, ",") if g.strip()]
    if not groups:
        return "*"
    return " | ".join(_complex_to_xpath(_parse_complex(g)) for g in groups)


_PSEUDO_ELEM = re.compile(r"::([A-Za-z-]+)(?:\s*\(\s*([^)]*?)\s*\))?")


def split_pseudo_element(selector: str) -> tuple[str, str | None, str | None]:
    """剥离并返回选择器末尾的伪元素：`(基础选择器, 名, 参数)`。

    ★ ITERATION-004：支持 `::text`（取文本）与 `::attr(name)`（取属性）。
    只认**最后一个**伪元素；无伪元素返回 `(selector, None, None)`。
    """
    last = None
    for m in _PSEUDO_ELEM.finditer(selector):
        last = m
    if last is None:
        return selector, None, None
    name = last.group(1).lower()
    if name not in ("text", "attr"):
        return selector, None, None
    base = (selector[:last.start()] + selector[last.end():]).strip()
    return (base or "*"), name, (last.group(2) or "").strip()


def select(html: str, selector: str) -> list:
    """统一取数：有伪元素时返回**文本/属性字符串列表**，否则返回**元素列表**。

    `.quote .text::text` → 文本列表；`a::attr(href)` → href 列表。
    """
    base, name, arg = split_pseudo_element(selector)
    els = css(html, base)
    if name is None:
        return els
    if name == "text":
        return [HTML._element_text(e) for e in els]
    return [e.get(arg) for e in els if e.get(arg) is not None]


def css(html: str, selector: str) -> list:
    """CSS 选择器匹配，返回 lxml 元素列表。以 '/' 或 '(' 开头可直接当原始 XPath。

    带 `::text` / `::attr(name)` 伪元素时**先剥掉**再匹配元素
    （★ ITERATION-004：不剥会让伪元素被当空名伪类吞掉，选择器静默失败）；
    要取文本/属性值请用 `select()` 或 `text()/texts()/attr()`。
    """
    root = parse(html)
    s = split_pseudo_element(selector)[0].strip()
    if s.startswith(("/", "(")):
        return root.xpath(s)
    try:
        hits = root.xpath(css_to_xpath(s))
    except Exception:
        hits = []
    if hits:
        return hits
    # HTML 属性名不区分大小写：属性名小写后重试一次
    sel2 = re.sub(r"\[([A-Za-z_][\w-]*)", lambda m: "[" + m.group(1).lower(), s)
    if sel2 != s:
        try:
            return root.xpath(css_to_xpath(sel2))
        except Exception:
            return []
    return []


def text(html: str, selector: str) -> str:
    """首个匹配的 innerText，归一化。"""
    els = css(html, selector)
    return HTML._element_text(els[0]) if els else ""


def texts(html: str, selector: str) -> list[str]:
    return [HTML._element_text(e) for e in css(html, selector)]


def attr(html: str, selector: str, name: str) -> str | None:
    els = css(html, selector)
    if not els:
        return None
    return els[0].get(name)


def html_of(html: str, selector: str) -> str:
    els = css(html, selector)
    if not els:
        return ""
    return _lhtml.tostring(els[0], encoding="unicode")


# ---------------------------------------------------------------- 按文本找元素
# ★ ITERATION-004（借鉴 Scrapling `find_by_text`）：agent 场景里"找写着『价格』
#   的那行"比构造 CSS 自然得多。纯函数、零依赖、不动 op 契约（是否进工具面另议）。

_SCAN_TAGS = ("a", "button", "label", "span", "p", "li", "td", "th", "h1", "h2",
              "h3", "h4", "h5", "h6", "div", "option", "strong", "em", "dt", "dd")


def find_by_text(html: str, needle: str, *, exact: bool = False,
                 first_match: bool = True, tag: str | None = None) -> list:
    """找 innerText 含 `needle` 的元素（`exact=True` 为全等）。

    返回元素列表（`first_match=True` 时只留**最内层**第一个匹配）。
    "最内层"指没有同为匹配的后代——避免返回整个 body/容器。
    """
    if not needle:
        return []
    root = parse(html)
    tags = [tag] if tag else list(_SCAN_TAGS)
    want = needle.strip()
    hits = []
    for t in tags:
        for el in root.iter(t):
            txt = HTML._element_text(el)
            ok = (txt == want) if exact else (want in txt)
            if ok:
                hits.append(el)
    if not hits:
        return []
    # 只留最内层：丢弃那些"后代里已有命中"的容器
    hitset = set(id(e) for e in hits)
    inner = [e for e in hits
             if not any(id(d) in hitset for d in e.iterdescendants())]
    out = inner or hits
    return out[:1] if first_match else out


def find_by_regex(html: str, pattern: str, *, flags: int = 0,
                  first_match: bool = True, tag: str | None = None) -> list:
    """按正则找元素 innerText（`pattern` 为标准库 re 语法）。语义同 `find_by_text`。"""
    if not pattern:
        return []
    try:
        rx = re.compile(pattern, flags)
    except re.error:
        return []
    root = parse(html)
    tags = [tag] if tag else list(_SCAN_TAGS)
    hits = []
    for t in tags:
        for el in root.iter(t):
            if rx.search(HTML._element_text(el)):
                hits.append(el)
    if not hits:
        return []
    hitset = set(id(e) for e in hits)
    inner = [e for e in hits
             if not any(id(d) in hitset for d in e.iterdescendants())]
    out = inner or hits
    return out[:1] if first_match else out


def text_of(html: str, needle: str, *, exact: bool = False) -> str:
    """`find_by_text` 的便捷版：直接回首个匹配元素的归一化文本。"""
    els = find_by_text(html, needle, exact=exact)
    return HTML._element_text(els[0]) if els else ""
