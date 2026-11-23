"""★ ITERATION-002（2026-11-21）：元素指纹持久化 + 相似度重定位。

借鉴 Scrapling 的 automatch 思路（D4Vinci/Scrapling，BSD-3-Clause）：
**只移植算法思路，不搬源码**，无许可证义务。

两阶段（对应 automatch 的"保存 → 匹配"）：
  - 保存阶段：结果容器被成功判定/定位时，抽取元素指纹
    （tag / id / class / 文本样例 / 子元素标签直方图 / 链接数 / 深度），
    按站点（域名）隔离落盘；
  - 重定位阶段：页面结构改版导致模板失准时，对页内候选容器算加权相似度，
    取超过阈值的最高者找回容器——不再只靠人肉补硬模板。

落点纪律（建议书 + 包内成例）：
  - 纯标准库（re/json/difflib），零新依赖；
  - 原子写复用 `support.store._atomic_write`，文件名由调用方保证 `fp_` 前缀
    （落点卫生）；
  - **阈值参数名为本移植自定**：建议书引 Scrapling 的
    `threshold/parent_threshold/sibling_threshold`，该参数名在官方
    README/中文 README 均未实证（台账如实记录），本模块不宣称对齐其参数名，
    只保留"阈值可调"这一能力（见 `DEFAULT_SIM_THRESHOLD`）；
  - 本模块位于 support/，被 parse/adaptive.py **惰性**导入（避免 parse→support
    分层倒置），support/useful.py 同按包内惰性导入成例使用。
"""
from __future__ import annotations

import difflib
import json
import re
from pathlib import Path

FP_VERSION = 2

# 加权相似度阈值（可调，越高越严格）。
# 语义：结构特征（tag/子元素直方图/链接数）为主，class/id/文本为辅——
# 这样"站点改版只改 class 名"时，重定位仍能靠结构相似度找回容器。
DEFAULT_SIM_THRESHOLD = 0.55

# 权重（和为 1.0）
_W_TAG = 0.15
_W_ID = 0.10
_W_CLASS = 0.20
_W_TEXT = 0.10
_W_CHILDREN = 0.35
_W_LINKS = 0.10

_TEXT_SAMPLE = 120  # 指纹取文本样例的长度（容器文本随查询变化，只作辅助特征）


# netloc 关键词 → 短名。**镜像 support/useful.py 的 _SITE_ALIAS**：
# 指纹库键空间必须与模板判据的 site_key 严格一致（同一站点同一把键），
# useful 侧 alias 表变更时本表同步改——自检含漂移断言。
_SITE_ALIAS = [
    ("bing.", "bing"), ("bing.com", "bing"),
    ("baidu.", "baidu"), ("baidu.com", "baidu"),
    ("sogou.", "sogou"), ("sogou.com", "sogou"),
    ("so.com", "so360"), ("360.cn", "so360"), ("360.com", "so360"),
]


def fp_key(site: str) -> str:
    """netloc → 指纹库键（域名隔离，与 useful.site_key 同口径）。

    小写、剥 scheme/路径/端口；先按 alias 表归一为短名（cn.bing.com/www.bing.com
    → bing），认不出的再剥 www./m. 前缀原样返回。
    """
    s = (site or "").strip().lower()
    s = re.sub(r"^https?://", "", s).split("/")[0].split(":")[0]
    for needle, key in _SITE_ALIAS:
        if needle in s or s.endswith(needle.rstrip(".")):
            return key
    return re.sub(r"^(?:www|m)\.", "", s)


def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


def _element_text(el) -> str:
    """容器文本（与 parse/selectors.HTML._element_text 同口径的轻量版）。"""
    from parse.selectors import HTML
    return HTML._element_text(el)


def _child_hist(el) -> dict:
    """直接子元素标签直方图（前 8，按计数降序）。结构签名，抗文本扰动。"""
    cnt: dict[str, int] = {}
    for ch in el:
        t = (ch.tag or "").lower() if isinstance(ch.tag, str) else ""
        if t:
            cnt[t] = cnt.get(t, 0) + 1
    top = sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
    return dict(top)


def extract(el) -> dict:
    """抽取元素指纹（保存阶段）。"""
    txt = _norm_ws(_element_text(el))
    cls = el.get("class") or ""
    return {
        "version": FP_VERSION,
        "tag": (el.tag or "").lower(),
        "id": el.get("id") or "",
        "classes": sorted(t for t in cls.split() if t),
        "text_sample": txt[:_TEXT_SAMPLE],
        "text_len": len(txt),
        "child_tags": _child_hist(el),
        "links": len(el.xpath(".//a")),
        "depth": len(list(el.iterancestors())),
    }


def _links_sim(a: int, b: int) -> float:
    if a == 0 and b == 0:
        return 1.0
    if not a or not b:
        return 0.0
    return min(a, b) / max(a, b)


def similarity(fp: dict, el) -> float:
    """元素 el 对指纹 fp 的加权相似度，[0,1]。fp 为空返回 0。"""
    if not fp:
        return 0.0
    tag_ok = 1.0 if (fp.get("tag") or "").lower() == (el.tag or "").lower() else 0.0
    fp_id = fp.get("id") or ""
    id_ok = 1.0 if (fp_id and fp_id == (el.get("id") or "")) else 0.0
    cls_fp = set(fp.get("classes") or [])
    cls_el = set((el.get("class") or "").split())
    union = cls_fp | cls_el
    cls_ok = (len(cls_fp & cls_el) / len(union)) if union else 0.0
    txt_fp = _norm_ws(fp.get("text_sample") or "")
    txt_el = _norm_ws(_element_text(el))[:_TEXT_SAMPLE]
    txt_ok = difflib.SequenceMatcher(None, txt_fp, txt_el).ratio() if (txt_fp or txt_el) else 0.0
    ch_fp = fp.get("child_tags") or {}
    ch_el = _child_hist(el)
    keys = set(ch_fp) | set(ch_el)
    if keys:
        ch_ok = (sum(min(ch_fp.get(k, 0), ch_el.get(k, 0)) for k in keys)
                 / sum(max(ch_fp.get(k, 0), ch_el.get(k, 0)) for k in keys))
    else:
        ch_ok = 0.0
    links_ok = _links_sim(int(fp.get("links") or 0), len(el.xpath(".//a")))
    score = (_W_TAG * tag_ok + _W_ID * id_ok + _W_CLASS * cls_ok
             + _W_TEXT * txt_ok + _W_CHILDREN * ch_ok + _W_LINKS * links_ok)
    return max(0.0, min(1.0, score))


def load_all(path) -> dict:
    """读全量指纹库；缺失/损坏一律回 {}（指纹层不许抛到判据层）。"""
    p = Path(path)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def get_fp(site: str, path) -> dict | None:
    fp = load_all(path).get(fp_key(site))
    return fp if isinstance(fp, dict) and fp else None


def save_fp(site: str, fp: dict, path) -> None:
    """保存阶段：合并写回该站点指纹（原子写；调用方保证 fp_ 前缀落点）。"""
    from support.store import _atomic_write
    data = load_all(path)
    data[fp_key(site)] = fp
    _atomic_write(Path(path), data, backup=False)


# 候选容器标签（与 parse/adaptive.py 的 CONTAINER_TAGS 同集；
# adaptive 调用 relocate 时会传自己的标签集，此为默认值）
CANDIDATE_TAGS = ("article", "main", "div", "section", "li", "table")


def relocate(root, fp: dict, threshold: float = DEFAULT_SIM_THRESHOLD, tags=None):
    """重定位阶段：在候选容器里取相似度超阈值的最高者。

    返回 `(元素 | None, 得分)`。得分始终返回（便于诊断），是否达阈值由调用方判。
    """
    best_el, best_s = None, 0.0
    for t in (tags or CANDIDATE_TAGS):
        for el in root.xpath(f"//{t}"):
            s = similarity(fp, el)
            if s > best_s:
                best_el, best_s = el, s
    if best_el is not None and best_s >= threshold:
        return best_el, round(best_s, 3)
    return None, round(best_s, 3)
