# -*- coding: utf-8 -*-
"""
hans_cli.py —— 汉斯出版社（中文 OA 期刊）检索与全文下载工具

汉斯出版社 www.hanspub.org 是纯开放获取中文期刊群，PDF 明文直链：
    https://pdf.hanspub.org/<刊缩写>_<编号>.pdf
相关中文刊缩写：
    ap  = 心理学进展          acm = 临床医学进展      ns = 护理学
    ae  = 教育进展            ar  = 老龄化研究        se  = 社会科学前沿
    ass = 社会科学前沿(alt)   gser= 地球科学前沿      sea = 软件工程与应用

站点为 ASP.NET + 阿里云 WAF（acw_sc__v2 JS 挑战）。本工具自动求解挑战。

用法：
  python hans_cli.py search <关键词> [-n 页数] [-o out.json]
  python hans_cli.py get <paperid 或 pdf直链> [-o FILE]
  python hans_cli.py kw <关键词> [-d 下载目录] [-n 页数]    # 检索并下载全部 PDF
"""
import sys, os, re, json, time, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from waf_fetch import get as waf_get   # 复用带 WAF 求解的抓取器

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HAN_BASE = "https://www.hanspub.org"
JOURNALS = {
    "ap": "心理学进展", "acm": "临床医学进展", "ns": "护理学",
    "ae": "教育进展", "ar": "老龄化研究", "se": "社会科学前沿",
    "ass": "社会科学前沿", "gser": "地球科学前沿", "sea": "软件工程与应用",
    "hjce": "土木工程", "ecl": "生态学", "em": "教育进展",
}


def search(kw, pages=1, sleep=3.0):
    """检索，返回条目列表"""
    items = []
    for pg in range(1, pages + 1):
        from urllib.parse import quote
        url = ("%s/journal/articles?searchcode=%s&searchfield=all&page=%d"
               % (HAN_BASE, quote(kw), pg))
        st, html, note = waf_get(url, referer=HAN_BASE + "/")
        print("  [页%d] st=%s %s字节 %s" % (pg, st, len(html), note))
        if not html or len(html) < 5000:
            break
        found = _parse(html)
        if not found:
            break
        items.extend(found)
        if len(found) < 10:
            break
        time.sleep(sleep)
    # 去重
    seen, out = set(), []
    for it in items:
        k = it.get("paperid") or it.get("pdf") or it.get("title")
        if k and k not in seen:
            seen.add(k)
            out.append(it)
    return out


def _parse(html):
    """从检索结果页抽取条目"""
    items = []
    # 以 paperinformation 链接为锚切块
    anchors = list(re.finditer(
        r'href="[^"]*?/journal/paperinformation\?paperid=(\d+)"', html))
    for idx, m in enumerate(anchors):
        pid = m.group(1)
        end = anchors[idx + 1].start() if idx + 1 < len(anchors) else min(
            len(html), m.start() + 4000)
        seg = html[m.start():end]

        title = ""
        mt = re.search(r'paperinformation\?paperid=\d+"[^>]*>(.*?)</a>', seg, re.S)
        if mt:
            title = re.sub(r"<[^>]+>", "", mt.group(1))
            title = re.sub(r"\s+", " ", title).strip()
        if not title or len(title) < 5:
            for c in re.findall(r'<(?:h\d|p|span|a)[^>]*>([^<]{12,160})</', seg):
                c = re.sub(r"\s+", " ", c).strip()
                if len(c) > 10 and "Vol." not in c and "请输入" not in c:
                    title = c
                    break

        pdf = ""
        # 汉斯 PDF 直链有两种命名（都要认）：
        #   ns_2252088.pdf               新版：刊缩写_数字
        #   ae2024145_531166116.pdf      旧版：刊缩写+卷期+_长ID（多只在详情页出现）
        mp = re.search(r'(?:https?:)?//pdf\.hanspub\.org/([A-Za-z]{2,8}\d*_\d+)\.pdf', seg)
        if mp:
            pdf = "https://pdf.hanspub.org/%s.pdf" % mp.group(1)
        code = (re.match(r'[A-Za-z]{2,8}', mp.group(1)).group(0).lower()
                if mp else "")

        journal = ""
        mj = re.search(r'/journal/([A-Za-z]{2,8})\.html"[^>]*>\s*([^<]{2,40})', seg)
        if mj:
            journal = re.sub(r"\s+", "", mj.group(2)).strip() or JOURNALS.get(mj.group(1).lower(), "")
        elif code:
            journal = JOURNALS.get(code, code)

        vol = ""
        mv = re.search(r'Vol\.(\d+)\s*No\.(\d+)', seg)
        if mv:
            vol = "Vol.%s No.%s" % (mv.group(1), mv.group(2))

        date = ""
        md = re.search(r'((?:January|February|March|April|May|June|July|August|'
                       r'September|October|November|December)\s+\d{1,2}\s+\d{4})', seg)
        if md:
            date = md.group(1)

        doi = ""
        mdoi = re.search(r'(10\.12677/[a-z]+\.[\d\.]+)', seg)
        if mdoi:
            doi = mdoi.group(1)

        if title or pdf:
            items.append({
                "paperid": pid, "title": title, "journal": journal,
                "vol": vol, "date": date, "doi": doi, "pdf": pdf,
                "page": "%s/journal/paperinformation?paperid=%s" % (HAN_BASE, pid),
            })
    return items


def download(url_or_pid, out=None):
    """下载 PDF"""
    if url_or_pid.isdigit():
        st, html, note = waf_get("%s/journal/paperinformation?paperid=%s"
                                 % (HAN_BASE, url_or_pid), referer=HAN_BASE + "/")
        m = re.search(r'(?:https?:)?//pdf\.hanspub\.org/([A-Za-z]{2,8}\d*_\d+)\.pdf', html)
        if not m:
            print("  未在该详情页找到 PDF 直链 (%s)" % note)
            return None
        url = "https://pdf.hanspub.org/%s.pdf" % m.group(1)
    else:
        url = url_or_pid if url_or_pid.startswith("http") else "https://" + url_or_pid

    st, body, note = waf_get(url, referer=HAN_BASE + "/")
    raw = body.encode("utf-8", "replace") if isinstance(body, str) else body
    # waf_get 返回的是解码后的文本；PDF 需要原始字节 → 重新用 urllib 取
    import ssl, urllib.request as U
    ctx = ssl.create_default_context(); ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = U.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                 "AppleWebKit/537.36 (KHTML, like Gecko) "
                                 "Chrome/126.0.0.0 Safari/537.36")
    req.add_header("Referer", HAN_BASE + "/")
    try:
        with U.urlopen(req, timeout=120, context=ctx) as r:
            data = r.read()
    except Exception as e:
        print("  下载失败:", e)
        return None
    if data[:4] != b"%PDF":
        print("  非 PDF 响应:", data[:120])
        return None
    if not out:
        out = os.path.join(os.getcwd(), url.split("/")[-1])
    with open(out, "wb") as f:
        f.write(data)
    print("  ✓ %s  (%d 字节)" % (out, len(data)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["search", "get", "kw"])
    ap.add_argument("arg")
    ap.add_argument("-n", "--pages", type=int, default=1)
    ap.add_argument("-o", "--out")
    ap.add_argument("-d", "--dir")
    a = ap.parse_args()

    if a.mode == "search":
        items = search(a.arg, a.pages)
        print("\n共 %d 条" % len(items))
        for it in items:
            print("· %s" % it["title"][:90])
            print("   %s %s %s | %s" % (it["journal"], it["vol"], it["date"], it["doi"] or "-"))
            print("   %s" % (it["pdf"] or it["page"]))
        if a.out:
            json.dump(items, open(a.out, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=2)
            print("已存 JSON:", a.out)

    elif a.mode == "get":
        download(a.arg, a.out)

    elif a.mode == "kw":
        items = search(a.arg, a.pages)
        print("\n共 %d 条，开始下载有直链的" % len(items))
        d = a.dir or os.getcwd()
        os.makedirs(d, exist_ok=True)
        n = 0
        for it in items:
            if not it["pdf"]:
                continue
            fn = os.path.join(d, it["pdf"].split("/")[-1])
            if os.path.exists(fn):
                print("  已存在:", fn)
                continue
            download(it["pdf"], fn)
            n += 1
            time.sleep(2.0)
        print("下载 %d 个" % n)
        if a.out:
            json.dump(items, open(a.out, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
