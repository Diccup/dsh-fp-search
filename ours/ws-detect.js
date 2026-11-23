export const BLOCK_WORDS = [
  '安全验证', '人机验证', '拖动滑块', '滑动验证', '验证码', '访问异常',
  '暂时受到限制', '访问过于频繁', '请求过于频繁', '操作太频繁',
  '请完成下方验证', '异常，暂时限制',
  'Just a moment', 'Checking your browser', 'Enable JavaScript',
  'Attention Required', '正在进行安全验证', '确认您是真人',
  'Verify you are human', 'One more step', 'Ray ID',
  'acw_sc__v2', 'Request blocked',
  'Too Many Requests', 'rate limit',
];

const _PATTERNS = [
  { re: /<title>\s*访问异常页面\s*<\/title>/, kind: 'qihu_block', always: true }, // 360 反爬整页拦截(6.4KB 带样式,曾踩过长度豁免线漏网;签名=title 精确,特异无误伤,2026-11-01)
  { re: /just a moment/i, kind: 'cloudflare' },
  { re: /checking your browser/i, kind: 'cloudflare' },
  { re: /attention required/i, kind: 'cloudflare' },
  { re: /正在进行安全验证/, kind: 'cloudflare' },
  { re: /verify you are human|确认您是真人|one more step/i, kind: 'turnstile' },
  { re: /acw_sc__v2/, kind: 'alibaba_waf' },
  { re: /拖动滑块|滑动验证|slider captcha/i, kind: 'captcha' },
  { re: /too many requests|访问过于频繁|请求过于频繁|操作太频繁/i, kind: 'rate_limit' },
  { re: /request blocked|access denied|访问被拒绝/i, kind: 'waf' },
  { re: /antispider/i, kind: 'captcha' },
  { re: /环境异常|频繁访问|访问验证/, kind: 'rate_limit' },
  { re: /登录后(?:查看|继续|才能)|请先登录|扫码登录/, kind: 'login_wall' },
];

export const CHALLENGE_ONLY_TITLES = ['just a moment', '请稍候', 'attention required', '安全验证', '正在进行安全验证', 'verifying you are human'];

const R1_BAIDU = ['__PARIS_CHALLENGE_START__', '__CHALLENGE_CONFIG__', 'wappass.baidu.com', '百度安全验证'];

const HIGH = new Set(['cloudflare', 'turnstile', 'alibaba_waf', 'captcha', 'baidu_challenge']);
const LOW = new Set(['rate_limit', 'waf', 'generic', 'login_wall']);

export function isChallengeTitle(title = '') {
  const low = String(title ?? '').trim().toLowerCase();
  return CHALLENGE_ONLY_TITLES.some((t) => low.includes(String(t).toLowerCase()));
}

export function classifyBody(text, title = '') {
  const body = String(text ?? '');
  if (!body) return null;
  let kind = null;
  if (R1_BAIDU.some((f) => body.includes(f))) kind = 'baidu_challenge';
  if (!kind) {
    for (const p of _PATTERNS) {
      if (p.re.test(body)) {
        if (p.always) return p.kind; // 特异签名=整页拦截,不过长度豁免
        kind = p.kind;
        break;
      }
    }
  }
  if (!kind && BLOCK_WORDS.some((w) => body.includes(w))) kind = 'generic';
  if (!kind && isChallengeTitle(title) && body.length < 6000) kind = 'generic';

  if (!kind) return null;
  if (HIGH.has(kind) && body.length >= 6000) return null;
  if (LOW.has(kind) && body.length >= 2000) return null;
  return kind;
}

export function decodeHtml(bytes, contentTypeHeader = '') {
  const buf = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : (ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes || []));

  const header = String(contentTypeHeader || '');
  const encs = [];
  const hm = header.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i);
  if (hm) encs.push(hm[1]);
  const slice = buf.slice(0, 4096);
  let ascii = '';
  try { ascii = new TextDecoder('latin-1').decode(slice); } catch {}
  const mm = ascii.match(/<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i)
    || ascii.match(/<meta[^>]+content=["'][^"']*charset=([a-zA-Z0-9_-]+)/i);
  if (mm && !encs.includes(mm[1])) encs.push(mm[1]);
  for (const e of ['utf-8', 'gb18030', 'latin-1']) if (!encs.includes(e)) encs.push(e);

  for (const e of encs) {
    try {
      const td = new TextDecoder(e, { fatal: false });
      return { text: td.decode(buf), enc: e };
    } catch {}
  }
  return { text: new TextDecoder('latin-1').decode(buf), enc: 'latin-1' };
}
