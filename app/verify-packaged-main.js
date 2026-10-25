/**
 * 验证打包产物里的 main.js 能加载（而不只是"源码里能加载"）。
 *
 * 做法：把 app.asar 整个解出来 → 用假 electron 加载其中的 electron/main.js，
 * 并把 process.resourcesPath 指向产物的 resources（那里有真的 db/memory 模块）。
 *
 * 这样验的是**用户装到机器上的那一份代码 + 那一份模块**能不能跑起来，
 * 而不是我源码目录里的版本。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const APP = 'D:/Documents/qwen-agent/vbVMzLbqoE/default/ollama-toolcall-验证/app';
const PRODUCT = path.join(APP, 'release-fix', 'win-unpacked');
const ASAR = path.join(PRODUCT, 'resources', 'app.asar');
const OUT = path.join(os.tmpdir(), 'wt-asar-check');

fs.rmSync(OUT, { recursive: true, force: true });
require(path.join(APP, 'node_modules', '@electron', 'asar')).extractAll(ASAR, OUT);
console.log('已解出 asar →', OUT);

const MAIN = path.join(OUT, 'electron', 'main.js');
console.log('main.js 大小', fs.statSync(MAIN).size, '字节');

// 打包态布局
process.resourcesPath = path.join(PRODUCT, 'resources');

const registered = [];
const appStub = {
  isPackaged: true,                       // ⚠ 关键：走打包态路径分支
  getVersion: () => '1.0.0',
  getName: () => 'writetool',
  getPath: () => os.tmpdir(),
  disableHardwareAcceleration: () => {},
  commandLine: { appendSwitch: () => {} },
  whenReady: () => new Promise(() => {}),  // 只验加载期
  on: () => {},
  quit: () => {},
};
const ipcMainStub = { handle: (ch) => { registered.push(ch); }, on: () => {} };
class BW { constructor() { this.webContents = { on: () => {} }; } }
const swallow = () => new Proxy({}, { get: () => () => undefined });

const stub = new Proxy({}, {
  get(_, p) {
    if (p === 'app') return appStub;
    if (p === 'ipcMain') return ipcMainStub;
    if (p === 'BrowserWindow') return BW;
    if (p === 'safeStorage') return { isEncryptionAvailable: () => false };
    if (p === 'then') return undefined;
    return swallow();
  },
});

const orig = Module._load;
// eslint-disable-next-line no-underscore-dangle
Module._load = function (req, ...rest) {
  if (req === 'electron') return stub;
  return orig.call(this, req, ...rest);
};

let err = null;
try {
  require(MAIN);
} catch (e) {
  err = e;
} finally {
  // eslint-disable-next-line no-underscore-dangle
  Module._load = orig;
}

if (err) {
  console.log('\n✗ 产物里的 main.js 加载失败：');
  console.log('  ' + err.name + ': ' + err.message);
  console.log('  ' + String(err.stack || '').split('\n')[1]);
  process.exit(1);
}
console.log('\n✓ 产物里的 main.js 加载成功，注册了', registered.length, '个 IPC 通道');
console.log('  ROOT 用的是', path.join(PRODUCT, 'resources', 'modules'));
