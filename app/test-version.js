/**
 * 版本信息的测试。
 *
 * 这一版刻意**不做网络请求**——在线更新检查已经去掉了，
 * 所以这里只剩纯函数可测。
 *
 * 运行：node app/test-version.js
 */

const assertNode = require('node:assert');
const { versionInfo, validateDownloadUrl, LEVELS } = require('./electron/version-info.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function section(t) { console.log(`\n${t}`); }

// ===========================================================
section('一、版本解析');

check('标准三段版本', () => {
  const v = versionInfo({ version: '1.2.3' }, '0.0.0', {});
  assertNode.strictEqual(v.version, '1');
  assertNode.strictEqual(v.minor, '2');
  assertNode.strictEqual(v.patch, '3');
  assertNode.strictEqual(v.full, 'v1.2.3');
});

check('两段版本补 0', () => {
  const v = versionInfo({ version: '1.0' }, '0.0.0', {});
  assertNode.strictEqual(v.patch, '0');
  assertNode.strictEqual(v.full, 'v1.0.0');
});

check('单段版本也补齐', () => {
  const v = versionInfo({ version: '2' }, '0.0.0', {});
  assertNode.strictEqual(v.full, 'v2.0.0');
});

check('带 v 前缀', () => {
  const v = versionInfo({ version: 'v1.1.0' }, '0.0.0', {});
  assertNode.strictEqual(v.full, 'v1.1.0');
});

check('读不到 package.json 时用 app.getVersion()', () => {
  const v = versionInfo(null, '1.0.5', {});
  assertNode.strictEqual(v.full, 'v1.0.5');
});

check('两者都没有时兜底到 1.0.0（不返回 undefined）', () => {
  const v = versionInfo(null, '', {});
  assertNode.strictEqual(v.full, 'v1.0.0');
  assertNode.strictEqual(typeof v.version, 'string');
});

check('非数字段不崩', () => {
  const v = versionInfo({ version: 'abc.def' }, '', {});
  assertNode.strictEqual(typeof v.full, 'string');
});

check('三段语义说明齐全', () => {
  assertNode.ok(LEVELS.major && LEVELS.minor && LEVELS.patch,
    '大更新/小更新/修订三档说明都要有');
});

// ===========================================================
section('二、发布页地址校验');

check('空地址合法（用户还没填）', () => {
  const r = validateDownloadUrl('');
  assertNode.strictEqual(r.ok, true);
  assertNode.strictEqual(r.empty, true);
});

check('http / https 合法', () => {
  assertNode.strictEqual(validateDownloadUrl('http://example.com').ok, true);
  assertNode.strictEqual(validateDownloadUrl('https://example.com/download').ok, true);
});

check('★ javascript: 被拒（主进程会执行它）', () => {
  const r = validateDownloadUrl('javascript:alert(1)');
  assertNode.strictEqual(r.ok, false);
  assertNode.ok(r.error.includes('http'), `错误信息要说清只支持 http：${r.error}`);
});

check('★ file: 被拒（会打开本地可执行文件）', () => {
  assertNode.strictEqual(validateDownloadUrl('file:///C:/Windows/x.exe').ok, false);
});

check('data: 被拒', () => {
  assertNode.strictEqual(validateDownloadUrl('data:text/html,<h1>x').ok, false);
});

check('无协议的裸域名被拒', () => {
  assertNode.strictEqual(validateDownloadUrl('example.com').ok, false);
});

check('超长地址被拒', () => {
  assertNode.strictEqual(validateDownloadUrl('https://e.com/' + 'x'.repeat(600)).ok, false);
});

check('前后空格自动去掉', () => {
  const r = validateDownloadUrl('  https://example.com  ');
  assertNode.strictEqual(r.ok, true);
  assertNode.strictEqual(r.url, 'https://example.com');
});

check('null / undefined 不崩', () => {
  assertNode.strictEqual(validateDownloadUrl(null).ok, true);
  assertNode.strictEqual(validateDownloadUrl(undefined).ok, true);
});

check('从 config 读到的地址带过来', () => {
  const v = versionInfo({ version: '1.0.0' }, '', { downloadUrl: 'https://writetool.app/dl' });
  assertNode.strictEqual(v.downloadUrl, 'https://writetool.app/dl');
});

// ===========================================================
section('三、契约（防止后来又加回在线检查）');

check('不导出任何网络检查函数', () => {
  const mod = require('./electron/version-info.js');
  for (const bad of ['checkUpdate', 'fetchJson', 'newerVersion', 'sourceFromPackage']) {
    assertNode.strictEqual(mod[bad], undefined,
      `version-info.js 不该再导出 ${bad}——在线检查已按需求移除`);
  }
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`版本信息：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);