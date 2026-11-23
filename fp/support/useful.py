"""★ N2（2026-11-07）：判"这条腿抓回来的东西有没有用"——结构级判据。

## 为什么要有这个文件

主人对 N2 的原话是「你进去要有用，没用就别进」。泡泡第一版用的是
**长度 + 不含拦截词** 判据，被现网打穿过两次：

- 搜狗 `waf` / `tls` 腿抓到 **5,394 B**，判据认为"有用"。拆开看：
  `vr-title`（结果标题）= 0、`vrwrap`（结果容器）= 0、`result` = 0、
  外链 5 条全是搜狗自家（fankui / fuwu / corp / miibeian），
  CSS 引的是 `anti.min.css` + `verify.css` ⇒ 这是**换皮验证页**，零条搜索结果。
- 搜狗 mobile 腿抓到 **788 KB** 的「QQ浏览器搜索」同样结构计数全 0
  （spark-x2.6 独立复现）。

⇒ **页面再大、不含拦截词，只要结果容器计数为 0，就是验证页/换皮页。**
   长度和关键词都骗不过结构判据。

## 判据怎么定

按站点**结果容器的 DOM 特征**判，命中才算"有用"。qfmodel 现网抽验背书：
bing 桌面 `b_algo` 10/10、baidu 桌面 `c-result` 10/10、sogou 577B 拦壳 0 命中。

## ⚠️ 必须按壳形态分模板（qfmodel 补，勿硬套）

同一个站点的**桌面版和移动版结构不同**：

- 百度桌面 → `c-result` 块
- 百度移动 → **不是 `c-result`**，是 `parseBaiduMobile` 那套（`mu` 等结构）

拿桌面判据硬套移动壳 ⇒ 移动版会被判成"没结果"（假阴性）。
所以本模块的模板表是 `站点 → 多个模板`，任一模板命中即算有用。
"""
from __future__ import annotations

import re
from typing import List, Pattern, Tuple

# ---------------------------------------------------------------------------
# 模板：(名字, 正则, 说明)
#
# 正则一律直接匹配**原始 HTML**，不做 strip_tags —— 因为容器是标签属性
# （class/id），剥完标签就没了。这也是 G1 的教训：签名必须验原始 HTML。
# ---------------------------------------------------------------------------
_TPL: List[Tuple[str, str, Pattern[str], str]] = [
    # --- bing ---
    ("bing.desktop", "bing", re.compile(r'class="[^"]*\bb_algo\b', re.I),
     "bing 桌面结果块 b_algo"),
    ("bing.rss", "bing", re.compile(r"<item\s*>|<entry\s*>", re.I),
     "bing RSS/Atom 输出（parseBingRss）"),

    # --- baidu ---
    ("baidu.desktop", "baidu", re.compile(r'class="[^"]*\bc-result\b|class="result\b', re.I),
     "百度桌面结果块 c-result / result"),
    ("baidu.mobile", "baidu", re.compile(r'class="[^"]*\bmu\b[^"]*"|data-log="mu"', re.I),
     "百度移动结果块 mu（parseBaiduMobile 走的结构，**不能套桌面判据**）"),

    # --- sogou ---
    ("sogou.desktop", "sogou", re.compile(r'class="[^"]*\bvr-?wrap\b|class="[^"]*\bvr-?title\b', re.I),
     "搜狗桌面结果容器 vrwrap / vr-title"),
    ("sogou.mobile", "sogou", re.compile(r'class="[^"]*\bvrwrap\b|class="[^"]*\bresult\b', re.I),
     "搜狗移动结果容器"),

    # --- so360 ---
    ("so360.result", "so360", re.compile(r'class="[^"]*\bres-list\b|class="[^"]*\bresult\b', re.I),
     "360 结果列表 res-list / result"),

    # --- 通用 ---
    ("generic.api-json", "*", re.compile(r'^\s*[\{\[]', re.I),
     "JSON 接口（垂类 API 的常态，首字符是 { 或 [）"),
]

# 站点 → 模板名列表（None = 通用兜底）
#
# ★ 2026-11-07 修：`orchestrator.fetch()` 传进来的 `site` 是**完整 netloc**
#   （`cn.bing.com` / `www.sogou.com` / `export.arxiv.org`），不是 `bing`/`sogou`
#   这种短名。第一版直接拿 `_SITE_TPL.get(site)` 查 ⇒ **全部落到通用兜底**，
#   实测把 `cn.bing.com` 的真结果页（b_algo）判成了 "no result container"。
#   ⇒ 必须先做"域名 → 短名"归一。
_SITE_TPL = {
    "bing": ["bing.desktop", "bing.rss"],
    "baidu": ["baidu.desktop", "baidu.mobile"],
    "sogou": ["sogou.desktop", "sogou.mobile"],
    "so360": ["so360.result"],
}

# netloc 关键词 → 短名（顺序即优先级）
_SITE_ALIAS = [
    ("bing.", "bing"), ("bing.com", "bing"),
    ("baidu.", "baidu"), ("baidu.com", "baidu"),
    ("sogou.", "sogou"), ("sogou.com", "sogou"),
    ("so.com", "so360"), ("360.cn", "so360"), ("360.com", "so360"),
]


def site_key(site: str) -> str:
    """完整 netloc → 短名（`cn.bing.com` → `bing`）。认不出就原样返回。"""
    s = (site or "").strip().lower()
    s = re.sub(r"^https?://", "", s).split("/")[0].split(":")[0]
    for needle, key in _SITE_ALIAS:
        if needle in s or s.endswith(needle.rstrip(".")):
            return key
    return s

# 判"这是自家域名"用的后缀（外链判据要排除它们）
OWN_DOMAIN_SUFFIX = {
    "sogou": ("sogou.com",),
    "so360": ("so.com", "360.cn", "360.com", "qhimg.com", "qhimgs.com"),
    "baidu": ("baidu.com", "bdstatic.com", "bcebos.com"),
    "bing": ("bing.com", "microsoft.com", "msn.com", "live.com"),
}

_EXT_LINK = re.compile(r'href="(https?://[^"]+)"', re.I)

# JSON 接口判据（单独命名，别再从 _TPL 里按下标取 —— 下标取错过一次）
_JSON_RX = re.compile(r'^\s*[\{\[]')

# ★ 2026-11-08 逐条报批 #3（qfmodel 选 A + spark 同选 A）：验证词闸用词表。
#
# 为什么需要：`so360.result` 模板是 `class="[^"]*\bresult\b`，**太宽**。360 的验证壳
# 只要带 `class="result"` 就命中模板、直接判"有用" —— 实测：
#   _is_useless('www.so.com', '<div class="result">访问异常页面…</div>'*30) → (False, 'tpl:so360.result')
#   即漏判（False = 没被判无用）。
#
# 两条票给的词并集（都要求"用具体短语，不要单字'验证'"）：
#   qfmodel：访问异常 / 请输入验证码 / 安全验证
#   spark  ：访问异常页面 / 访问异常出错 / 请输入验证码 / 安全验证
# ⇒ 取并集，且「访问异常」已覆盖「访问异常页面/访问异常出错」两种形态。
_VERIFY_WORDS = (
    "访问异常页面",
    "访问异常出错",
    "访问异常",
    "请输入验证码",
    "安全验证",
)

# 只在这两家的模板组生效（qfmodel 明确：**不全局**）
_VERIFY_GATE_SITES = ("so360", "sogou")

# 扫描窗口：title + 正文前 2,000 字符（qfmodel 明确：**不做全文扫描**，
# 防真实结果页正文恰好引用"验证码/安全验证"话题被误杀）
_VERIFY_SCAN_CHARS = 2000


def _has_verify_words(body: str) -> str:
    """在 title + 前 2,000 字符里找验证词；命中返回那个词，否则返回 ''。"""
    window = (body or "")[:_VERIFY_SCAN_CHARS]
    for w in _VERIFY_WORDS:
        if w in window:
            return w
    return ""


def _own(host: str, site: str) -> bool:
    """host 是否属于该站自家域名。

    ★ 2026-11-08 逐条报批 #2（qfmodel 提、spark 同向）：

    **原实现的洞**：`OWN_DOMAIN_SUFFIX` 只列 4 家（sogou/so360/baidu/bing）。
    未知站拿到空元组 ⇒ `any(空)` 恒 False ⇒ **自己站内的链接全被判成外链**。
    实测：
        site_key('www.random.blog')               = 'www.random.blog'   （连 www. 都没剥）
        _own('www.random.blog','www.random.blog') = False              （自己都不认自己）
        useful(自家3条链接, 'www.random.blog')     = (True,'external links 1 >= 3')  ← 假阳性

    **修法（qfmodel 的原话要求，双条目）**：表命中就用表；表没命中，
    把 site 自身 netloc **原样 + 剥掉 www./m. 前缀后**两个都当自家域。
    理由（qfmodel）：`m.foo.bar` 剥成 `foo.bar`，正文外链若写 `foo.bar` 或 `m.foo.bar`，
    **两种都要算自家**，只留剥后版会丢原 netloc。
    """
    sk = site_key(site)
    if not sk:
        return False
    stripped = re.sub(r'^(?:www|m)\.', '', sk)
    suffixes = OWN_DOMAIN_SUFFIX.get(sk) or tuple(s for s in (sk, stripped) if s)
    h = (host or "").lower()
    return any(h == s or h.endswith("." + s) for s in suffixes)


def _hosts(html: str) -> List[str]:
    """抽出所有外链 host（粗提，不去重）。"""
    out: List[str] = []
    for m in _EXT_LINK.finditer(html or ""):
        url = m.group(1)
        try:
            host = re.sub(r"^https?://", "", url, flags=re.I).split("/")[0].split(":")[0]
        except Exception:
            continue
        if host:
            out.append(host)
    return out


def useful(html: str, site: str = "", *, min_external: int = 3,
           fp_store: str | None = None) -> Tuple[bool, str]:
    """判这条 html 有没有真结果。

    返回 `(是否可用, 依据)`。依据字符串可直接写进 verdict.diagnosis，便于事后复盘。

    判定顺序：
      ① JSON 接口 → 直接有用（垂类 API 不走 HTML 模板）
      ①b ★ ITERATION-002：指纹重定位优先——该站点有已存指纹且改版后模板失准时，
         用相似度找回结果容器（需传 fp_store；指纹层任何异常都不影响判据，
         直接落回模板路径）
      ② 该站点的任一模板命中 → 有用（**桌面/移动模板都得试**）
      ③ 兜底：外链 ≥ min_external 条且**非本站域名** → 有用
      ④ 都不中 → 没用（验证页/换皮页/空壳）
    """
    body = html or ""
    if not body.strip():
        return False, "empty body"

    # ① JSON
    if _JSON_RX.search(body[:2000]):
        return True, "json api"

    # ①b ★ ITERATION-002 指纹重定位优先（模板失准时的找回通道）
    #
    # 借鉴 Scrapling automatch 思路（只移植算法）：该站点有已存指纹时，对页内
    # 候选容器算加权相似度，超阈值即判"有用"。**验证词闸对指纹命中同样生效**
    # ——N2 打穿两次换来的教训（换皮验证页），不因通道不同而开后门。
    # fp_store 未传/指纹缺失/任何异常：静默落回模板路径，判据不受影响。
    if fp_store:
        try:
            from support.fingerprint import (DEFAULT_SIM_THRESHOLD, get_fp,
                                             relocate as fp_relocate)
            from parse.selectors import parse as _parse
            sk = site_key(site)
            fp = get_fp(site, fp_store)
            if fp:
                hit_el, score = fp_relocate(_parse(body), fp, DEFAULT_SIM_THRESHOLD)
                if hit_el is not None:
                    if sk in _VERIFY_GATE_SITES:
                        w = _has_verify_words(body)
                        if w:
                            return False, f"verify-word gate: '{w}' before fingerprint:{sk}"
                    return True, f"fingerprint:{sk} relocated (score={score})"
        except Exception:
            pass

    # ② 站点模板（一站点多模板，任一命中即可）
    #
    # ★ 2026-11-08 逐条报批 #3：命中模板 ≠ 直接放行。
    #   模板命中后、判"有用"之前，对 so360/sogou 两家过一道**验证词闸**：
    #   title + 前 2,000 字符里出现验证词 ⇒ 判无用（带原因返回）。
    #   理由（qfmodel）：360 验证壳带 class="result" 就会命中过宽的 so360.result 模板。
    names = _SITE_TPL.get(site_key(site))
    for name, tpl_site, rx, desc in _TPL:
        if names is not None and name not in names:
            continue
        if names is None and tpl_site != "*":
            continue
        if rx.search(body):
            # ★ 验证词闸：只 so360/sogou，只看 title+前 2,000 字符
            if tpl_site in _VERIFY_GATE_SITES:
                hit = _has_verify_words(body)
                if hit:
                    return False, f"verify-word gate: '{hit}' before tpl:{name}"
            # ★ ITERATION-002 保存阶段：模板命中即回填指纹库（保存阶段）。
            #   在页内找 class/id 片段满足模板正则的元素，抽指纹落盘；
            #   通用（'*'）模板与找不到对应元素时静默跳过，判据不受影响。
            if fp_store and tpl_site != "*":
                try:
                    from support.fingerprint import extract as fp_extract, save_fp
                    from parse.selectors import parse as _parse
                    for el in _parse(body).iter():
                        if not isinstance(el.tag, str):
                            continue
                        cls = el.get("class") or ""
                        eid = el.get("id") or ""
                        if (cls and rx.search(f'class="{cls}"')) or (
                                eid and rx.search(f'id="{eid}"')):
                            save_fp(site, fp_extract(el), fp_store)
                            break
                except Exception:
                    pass
            return True, f"tpl:{name} ({desc})"

    # ③ 外链兜底
    #
    # ★ 2026-11-08 逐条报批 #1：**判据与文案统一用去重后**。
    #   原实现判 `len(ext) >= min_external`（未去重），文案却报 `len(set(ext))`（去重后），
    #   导致能写出 "external links 1 >= 3" 这种自相矛盾的话，且 3 条同 host 也会误判有用。
    #   `min_external=3` 的语义是「3 个**不同域名**的外链」，不是"3 条链接"。
    hosts = _hosts(body)
    ext = [h for h in hosts if not _own(h, site)]
    uniq_ext = set(ext)
    if len(uniq_ext) >= min_external:
        return True, f"external links {len(uniq_ext)} >= {min_external}"

    return False, (
        f"no result container (site={site or '?'}, "
        f"templates={','.join(names) if names else 'generic'}, "
        f"external={len(uniq_ext)}, bytes={len(body)})"
    )
