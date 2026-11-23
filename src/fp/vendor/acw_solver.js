// 阿里云 WAF acw_sc__v2 挑战求解器
// 输入：挑战页 HTML 文件路径
// 输出：stdout 打印 acw_sc__v2 的 cookie 值
const fs = require('fs');
const vm = require('vm');

const file = process.argv[2];
if (!file) { console.error('USAGE: node acw_solver.js <challenge.html>'); process.exit(1); }

const html = fs.readFileSync(file, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('NO_SCRIPT'); process.exit(2); }
const code = m[1];

const captured = { cookie: '' };

const locationStub = {
  reload() {}, assign() {}, replace() {},
  href: '', toString() { return ''; }
};

const documentStub = new Proxy({}, {
  get(t, p) {
    if (p === 'cookie') return captured.cookie;
    if (p === 'location') return locationStub;
    if (p in t) return t[p];
    return function () {};
  },
  set(t, p, v) {
    if (p === 'cookie') {
      captured.cookie = String(v);
      t[p] = v;
      return true;
    }
    t[p] = v;
    return true;
  }
});

const sandbox = {
  document: documentStub,
  window: {},
  navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
  console: { log() {}, error() {}, warn() {}, info() {} },
  setTimeout, clearTimeout, setInterval, clearInterval
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);

try {
  vm.runInContext(code, ctx, { timeout: 15000 });
} catch (e) {
  console.error('EVAL_ERROR: ' + e.message);
  process.exit(3);
}

if (!captured.cookie) {
  console.error('NO_COOKIE');
  process.exit(4);
}

// 从 "acw_sc__v2=XXX; expires=..." 抽出值
const val = captured.cookie.split(';')[0].trim();
process.stdout.write(val);
