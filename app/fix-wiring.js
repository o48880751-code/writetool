/**
 * 把 test-tool-wiring.js 恢复成「只验加载期」的形态。
 *
 * 背景：我为了让 secret.init/bind 真执行，去放行 main.js 的 whenReady，
 * 结果初始化会走到 Menu —— 而那要求 Module._load 的 patch 一直生效，
 * 还原时机一变就 TypeError 把整个测试进程带崩。
 *
 * 代价太大，退回简单方案：
 *   - whenReady 永不 resolve（只验加载期）
 *   - 真落盘的验证交给两条自己 new Store 的判据，不依赖 main.js 生命周期
 */
const fs = require('node:fs');
const p = 'test-tool-wiring.js';
const raw = fs.readFileSync(p, 'utf8');
const NL = raw.includes('\r\n') ? '\r\n' : '\n';
let L = raw.split(NL);
let fixed = 0;

// ---- 1) appStub：whenReady 永不 resolve ----
const appAt = L.findIndex((l) => l.indexOf('const appStub = {') >= 0);
if (appAt < 0) { console.error('ABORT 找不到 appStub'); process.exit(2); }
let appEnd = appAt;
for (let i = appAt + 1; i < L.length; i++) { if (L[i] === '};') { appEnd = i; break; } }

const APP = [
  '/**',
  ' * app 桩。',
  ' *',
  ' * ⚠ whenReady 保持「永不 resolve」—— 只验加载期，不进初始化。',
  ' *',
  ' *   试过改成真跑（好让 secret.init/bind 真执行），代价太大：',
  ' *   初始化会走到 Menu.setApplicationMenu，而那要求 Module._load 的',
  ' *   patch 一直生效；还原时机没对好就是 TypeError，',
  ' *   **整个测试进程带崩**（不是一条判据红，是全部跑不完）。',
  ' *',
  ' *   真落盘的验证改由「三」里那两条自己 new Store 的判据负责。',
  ' */',
  'const appStub = {',
  '  isPackaged: false,',
  "  getVersion: () => '1.0.0',",
  "  getName: () => 'writetool',",
  '  getPath: () => TMP,',
  '  disableHardwareAcceleration: () => {},',
  '  commandLine: { appendSwitch: () => {} },',
  '  whenReady: () => new Promise(() => {}),',
  '  on: () => {},',
  '  quit: () => {},',
  '};',
];
L.splice(appAt, appEnd - appAt + 1, ...APP);
fixed++;

// ---- 2) loadMain：恢复 try/finally，不放行 ready ----
const lmAt = L.findIndex((l) => l.indexOf('const origLoad = Module._load;') >= 0);
if (lmAt < 0) { console.error('ABORT 找不到 loadMain 的 patch 段'); process.exit(2); }
let lmEnd = -1;
for (let i = lmAt; i < L.length; i++) {
  if (L[i].trim() === 'Module._load = origLoad;' && L[i + 1] === '}') { lmEnd = i + 1; break; }
}
if (lmEnd < 0) { console.error('ABORT 找不到 patch 还原处'); process.exit(2); }

const LM = [
  'const origLoad = Module._load;',
  '  Module._load = function patched(request, ...rest) {',
  "    if (request === 'electron') return electronStub;",
  '    return origLoad.call(this, request, ...rest);',
  '  };',
  '  try {',
  "    const entry = path.join(ROOT, 'app', 'electron', 'main.js');",
  '    delete require.cache[entry];',
  '    require(entry);',
  '  } finally {',
  '    Module._load = origLoad;',
  '  }',
  '}',
];
L.splice(lmAt, lmEnd - lmAt + 1, ...LM);
fixed++;

// ---- 3) 删掉 initDone 声明（已无用）----
const idAt = L.findIndex((l) => l.indexOf('let initDone') >= 0);
if (idAt >= 0) {
  L.splice(idAt, 2);   // 声明 + 紧跟的空行
  fixed++;
}

fs.writeFileSync(p, L.join(NL));
console.log('已修 ' + fixed + ' 处');