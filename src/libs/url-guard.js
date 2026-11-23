/**
 * libs/url-guard.js — 网页入口 URL 的安全闸（2.0 `b04-sandbox/fetch.ts` 的自有裁剪版）
 *
 * 干什么：op:index {url} / op:search {url} 把 URL 交给抓取实现**之前**过一遍闸：
 *        只放 http/https；字面内网地址、环回、链路本地（169.254 = 云 metadata）、
 *        保留主机名（localhost/*.internal 等）一律拒。
 * 为什么这样：2.0 完整版带逐跳 DNS 检查（SSRF per hop）。本包真实抓取链是
 *        ours/web-search（curl_cffi/浏览器指纹，fp 回退是主人要保的核心增强），
 *        引擎拿不到它每一跳的解析结果 —— 入口字面检查能拦掉最危险的直球
 *        （`http://169.254.169.254/`、`http://127.0.0.1:port`、`file://`），
 *        DNS 指向内网的域名跳不过，这是**已知边界**，注释在此不许假装全防。
 * 边界：纯同步函数，不解析 DNS、不发请求。
 */

import { err } from './err.js';

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 是否内网/环回/链路本地/未指定。 */
function isPrivateV4(a, b) {
    if (a === 127 || a === 10 || a === 0) return true;          // 环回 / 私网A / 未指定
    if (a === 169 && b === 254) return true;                    // 链路本地（云 metadata！）
    if (a === 172 && b >= 16 && b <= 31) return true;           // 私网B
    if (a === 192 && b === 168) return true;                    // 私网C
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT (RFC6598)
    if (a === 198 && (b === 18 || b === 19)) return true;       // benchmark
    return false;
}

/** IPv6 是否环回/未指定/链路本地/唯一本地（fc00::/7）或映射 v4 的内网。 */
function isPrivateV6(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80')) return true;                       // 链路本地
    if (h.startsWith('fc') || h.startsWith('fd')) return true;   // ULA fc00::/7
    const mapped = h.match(/:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (mapped && isPrivateV4(Number(mapped[1]), Number(mapped[2]))) return true;
    return false;
}

/* ------------------------------------------------------------------ *
 * ★ ITERATION-003（2026-11-21，补 L-008 洞）：IPv6 字节级判定
 *
 * 为什么必须字节级：`new URL()` 会把 `[::ffff:127.0.0.1]` **规范化成
 * `[::ffff:7f00:1]`**（点分映射形 → 十六进制形）。上面的 isPrivateV6 只用
 * 点分正则 `:(\d{1,3})\.…$`，看不见 hex 形 ⇒ 7 条映射地址全部放行。
 * 这正是 ssrf-gate S-6 长期报红、python 侧 07-P2 早已修好的那个洞
 * （`rawdl._is_private_v6_bytes` 注释原话：「旧写法 ffff 分支永不可达
 *  （死代码，与 JS 同款漏网）」）。此处按同一语义在 JS 侧重写。
 * ------------------------------------------------------------------ */

/**
 * IPv6 文本 → 16 字节数组。不可解析 ⇒ null。
 * 支持 `::` 压缩、尾部点分 v4（`::ffff:127.0.0.1`）、全展开形式。
 * @param {string} host
 * @returns {number[]|null}
 */
function ipv6ToBytes(host) {
    let h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    const zone = h.indexOf('%');          // 去 scope id（fe80::1%eth0）
    if (zone >= 0) h = h.slice(0, zone);
    if (!h.includes(':')) return null;

    // 尾部点分 v4（::ffff:127.0.0.1）先折算成两个 16 位组
    const v4Tail = h.match(/:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4Tail) {
        const q = [Number(v4Tail[1]), Number(v4Tail[2]), Number(v4Tail[3]), Number(v4Tail[4])];
        if (q.some((n) => n > 255)) return null;
        h = h.slice(0, v4Tail.index)
            + ':' + ((q[0] << 8) | q[1]).toString(16)
            + ':' + ((q[2] << 8) | q[3]).toString(16);
    }

    const dbl = h.split('::');
    if (dbl.length > 2) return null;
    const head = dbl[0] ? dbl[0].split(':') : [];
    const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
    if (dbl.length === 1 && head.length !== 8) return null;
    const fill = dbl.length === 2 ? 8 - head.length - tail.length : 0;
    if (fill < 0) return null;
    const groups = dbl.length === 2
        ? [...head, ...new Array(fill).fill('0'), ...tail]
        : head;
    if (groups.length !== 8) return null;

    const bytes = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        const v = parseInt(g, 16);
        bytes.push((v >> 8) & 0xff, v & 0xff);
    }
    return bytes;
}

/**
 * 16 字节 IPv6 是否危险（内网/环回/链路本地/ULA/映射内网 v4）。
 * 语义对齐 `fp/support/rawdl.py::_is_private_v6_bytes`，逐条同序。
 * @param {number[]} b
 * @returns {boolean}
 */
function isPrivateV6Bytes(b) {
    const zeros = (n) => b.slice(0, n).every((x) => x === 0);
    if (zeros(16)) return true;                                   // ::
    if (zeros(15) && b[15] === 1) return true;                    // ::1
    // v4 映射形（b[10..11]=ffff）与 v4 兼容形（=0000）都按尾部 v4 判。
    // ★ 注意：这里**不**先要求 b[10]===0 —— 那正是原死代码的病根。
    if (zeros(10) && ((b[10] === 0x00 && b[11] === 0x00) || (b[10] === 0xff && b[11] === 0xff))) {
        return isPrivateV4(b[12], b[13]);
    }
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;     // fe80::/10 链路本地
    if ((b[0] & 0xfe) === 0xfc) return true;                      // fc00::/7 ULA
    if (b[0] === 0xff) return true;                               // multicast（比 py 同严）
    return false;
}

const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.internal|.*\.local|metadata\.google.internal|wpad|.*\.home.arpa)$/i;

/**
 * 判一个 URL 能不能抓。安全 → 返回规范化的 URL 字符串；危险 → 抛 err('URL_BLOCKED')。
 * @param {string} raw
 * @returns {string} 规范化后的 URL
 */
export function assertSafeUrl(raw) {
    let u;
    try {
        u = new URL(String(raw));
    }
    catch {
        throw err('NO_INPUT', { reason: `url 无法解析：${String(raw).slice(0, 80)}` });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw err('URL_BLOCKED', { url: u.href, reason: `协议 ${u.protocol} 不许（只放 http/https）` });
    }
    const host = u.hostname.toLowerCase();
    const v4 = V4.exec(host);
    if (v4 && isPrivateV4(Number(v4[1]), Number(v4[2]))) {
        throw err('URL_BLOCKED', { url: u.href, reason: '内网/环回/链路本地地址（SSRF 闸）' });
    }
    if (host.includes(':') && isPrivateV6(host)) {
        throw err('URL_BLOCKED', { url: u.href, reason: '内网 IPv6 地址（SSRF 闸）' });
    }
    // ★ ITERATION-003：字节级 IPv6 判定（补 L-008 洞：new URL 会把
    //   [::ffff:127.0.0.1] 规范化成 [::ffff:7f00:1]，点分正则看不见）
    if (host.includes(':')) {
        const b = ipv6ToBytes(host);
        if (b === null) {
            throw err('URL_BLOCKED', { url: u.href, reason: '无效 IPv6 字面量（SSRF 闸）' });
        }
        if (isPrivateV6Bytes(b)) {
            throw err('URL_BLOCKED', { url: u.href, reason: '内网 IPv6 地址（SSRF 闸·字节级）' });
        }
    }
    if (BLOCKED_HOSTS.test(host)) {
        throw err('URL_BLOCKED', { url: u.href, reason: '保留主机名（localhost/.internal/.local/…）' });
    }
    if (u.username || u.password) {
        throw err('URL_BLOCKED', { url: u.href, reason: 'URL 里带凭据（ userinfo ）：不许' });
    }
    return u.href;
}
