"""自适应定位：在 HTML 里找主内容容器或表单字段。"""
from __future__ import annotations

from typing import Any

from parse.selectors import BLOCK_TAGS, HTML, css, parse, xpath

CONTAINER_TAGS = ("article", "main", "div", "section", "li", "table")
NAV_KEYS = ("nav", "footer", "header", "aside", "menu", "sidebar", "breadcrumb", "copyright")


def _text(el) -> str:
    return HTML._element_text(el)


def _score(el) -> tuple[float, dict[str, Any]]:
    txt = _text(el)
    link_txt = sum(len(_text(a)) for a in el.xpath(".//a"))
    cls = ((el.get("class") or "") + " " + (el.get("id") or "")).lower()
    nav_pen = 40 if any(k in cls for k in NAV_KEYS) else 0
    density = len(txt) / max(1, len(list(el.iter())))
    link_pen = (link_txt / max(1, len(txt))) * 40 if txt else 40
    depth_pen = len(list(el.iterancestors())) * 2
    score = len(txt) * 0.4 + density * 5 - nav_pen - link_pen - depth_pen
    return score, {
        "len": len(txt),
        "density": density,
        "link_ratio": (link_txt / max(1, len(txt))) if txt else 1.0,
        "nav_pen": nav_pen,
    }


def locate(html: str, fingerprint: dict | None = None, *,
           site: str | None = None, fp_store: str | None = None) -> dict[str, Any]:
    root = parse(html)
    fp = fingerprint or {}
    tag = (fp.get("tag") or "div").lower()
    keywords = [str(k).lower() for k in fp.get("keywords", [])]
    field_names = [str(f).lower() for f in fp.get("field_names", [])]
    min_chars = int(fp.get("min_chars") or 0)

    candidates = []
    for t in CONTAINER_TAGS:
        candidates.extend(root.xpath(f"//{t}"))
    # 去重（同一节点多个 tag 可能重复）
    seen = set()
    uniq = []
    for c in candidates:
        nid = id(c)
        if nid in seen:
            continue
        seen.add(nid)
        uniq.append(c)

    scored = []
    for el in uniq:
        txt = _text(el)
        if min_chars and len(txt) < min_chars:
            continue
        score, detail = _score(el)
        kw_hit = sum(1 for k in keywords if k in txt.lower() or k in (el.get("class") or "").lower() or k in (el.get("id") or "").lower())
        field_hit = sum(1 for f in field_names if f in (el.get("name") or "").lower() or f in (el.get("id") or "").lower())
        if keywords:
            score += kw_hit * 30
        if field_names:
            score += field_hit * 30
        scored.append((score, el, detail))

    # ★ ITERATION-002（借鉴 Scrapling automatch）：未给显式指纹但该站点有已存
    #   指纹时，给候选加相似度加成（重定位驱动定位）。惰性导入、异常静默跳过，
    #   不改变原打分路径的既有行为。
    if not fingerprint and site and fp_store:
        try:
            from support.fingerprint import get_fp, similarity as fp_similarity
            saved = get_fp(site, fp_store)
            if saved:
                scored = [(s + fp_similarity(saved, el) * 30, el, d)
                          for s, el, d in scored]
        except Exception:
            pass

    def pick(pred):
        best = None
        best_s = -1e18
        for s, el, d in scored:
            if pred(el, d) and s > best_s:
                best = el
                best_s = s
        return best

    if keywords or field_names or min_chars:
        chosen = pick(lambda el, d: True)
    else:
        chosen = pick(lambda el, d: d["nav_pen"] == 0 and d["len"] > 0)

    result = {"found": False, "selector": None, "confidence": 0.0, "samples": [], "reason": ""}
    if chosen is None:
        result["reason"] = "no candidate"
        return result

    txt = _text(chosen)
    sel = _make_selector(chosen)
    conf = min(1.0, max(0.0, len(txt) / 2000.0)) if not (keywords or field_names) else min(0.95, 0.5 + len(txt) / 4000.0)
    if not (keywords or field_names):
        conf = min(conf, 0.5)
    # 自验证：用生成的 selector 回查，命中同一元素才接受
    if sel:
        try:
            hits = css(html, sel)
            if hits and hits[0] is not chosen:
                # lxml xpath 复用同一节点对象，is 判断可行
                chosen2 = hits[0]
                if chosen2 is not chosen:
                    # 退回：以文本内容兜底匹配
                    hits2 = [h for h in hits if _text(h) == txt]
                    if hits2:
                        chosen = hits2[0]
                        sel = _make_selector(chosen)
                    else:
                        sel = None
        except Exception:
            sel = None

    if sel:
        result["found"] = True
        result["selector"] = sel
        result["confidence"] = round(conf, 3)
        result["samples"] = [txt[:120]]
        result["reason"] = "scored match"
        # ★ ITERATION-002 保存阶段：定位成功即把容器指纹落盘（供跨版本重定位）
        if site and fp_store:
            try:
                from support.fingerprint import extract as fp_extract, save_fp
                save_fp(site, fp_extract(chosen), fp_store)
            except Exception:
                pass
    else:
        result["reason"] = "selector self-verify failed"
    return result


def _make_selector(el) -> str | None:
    eid = el.get("id")
    if eid:
        return f"#{eid}"
    cls = el.get("class")
    if cls:
        first = cls.split()[0]
        tag = (el.tag or "div").lower()
        return f"{tag}.{first}"
    return _nth_of_type_path(el)


def _nth_of_type_index(el) -> int | None:
    """同标签兄弟中的 1 基位次；找不到返回 None。"""
    parent = el.getparent()
    if parent is None:
        return 1
    tag = (el.tag or "").lower()
    idx = 0
    for sib in parent:
        if (sib.tag or "").lower() == tag:
            idx += 1
            if sib is el:
                return idx
    return None


def _nth_of_type_path(el, max_depth: int = 6) -> str | None:
    """无 id/class 时生成祖先路径选择器 `tag:nth-of-type(k)`（后代组合器连接）。

    ★ ITERATION-002（借鉴 Scrapling get_selector 思路，只移植算法）：
    自根向下逐层取 `tag:nth-of-type(k)`，任一层有 id/class 即锚定为稳定选择器
    并截断；走到 max_depth 仍未锚定则返回 None，交由 locate 的自验证回路裁决
    （验得过才用，不放宽任何既有判据）。
    """
    parts = []
    node = el
    for _ in range(max_depth):
        tag = (node.tag or "div").lower()
        nid = node.get("id")
        if nid:
            parts.append(f"#{nid}")
            break
        cls = node.get("class")
        if cls:
            parts.append(f"{tag}.{cls.split()[0]}")
            break
        if node.getparent() is None:
            parts.append(tag)          # 根元素：无兄弟语义，裸标签即可
            break
        k = _nth_of_type_index(node)
        if k is None:
            return None
        parts.append(f"{tag}:nth-of-type({k})")
        node = node.getparent()
    else:
        return None
    return " ".join(reversed(parts))


def locate_fields(html: str, names: list[str]) -> dict[str, str]:
    """按 label/placeholder/name/id 邻近取值（表单场景）。"""
    root = parse(html)
    out: dict[str, str] = {}
    for name in names:
        val = None
        # id 匹配
        for expr in (f"//*[@id={_q(name)}]", f"//*[@name={_q(name)}]"):
            els = root.xpath(expr)
            if els:
                val = HTML._element_text(els[0]) or els[0].get("value") or ""
                break
        # placeholder
        if not val:
            els = root.xpath(f"//*[contains(@placeholder,{_q(name)})]")
            if els:
                val = HTML._element_text(els[0]) or els[0].get("value") or ""
        # label 邻近
        if not val:
            els = root.xpath(f"//label[contains(normalize-space(string(.)),{_q(name)})]")
            for lab in els:
                for inp in lab.xpath(".//input|.//textarea|.//select"):
                    v = inp.get("value") or HTML._element_text(inp)
                    if v:
                        val = v
                        break
                if val:
                    break
        out[name] = val or ""
    return out


def _q(s: str) -> str:
    if '"' not in s:
        return f"'{s}'"
    return f"'{s.replace(chr(39), chr(39))}'"
