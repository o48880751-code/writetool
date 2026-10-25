'use strict';
/**
 * 字体预置表校验（不依赖 Electron，纯 node 跑）。
 *
 * 1. 4 个开源字体都在、字段齐全（id/label/family/file/url/sizeMB/desc）
 * 2. 每个 url 真实可达（HEAD 200）—— 抓「手滑写错版本号 / 路径」这种低级但致命的错
 * 3. family 含空格的都带了引号（否则 @font-face 会解析失败）
 * 4. @font-face 注入串拼装正确（与渲染层 injectFontFaces 同构）
 */
const assert = require('assert');
const https = require('https');
const { FONTS, fontById } = require('./electron/font-presets.js');

let pass = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); process.exitCode = 1; }
};
const head = (url) => new Promise((resolve) => {
  const req = https.request(new URL(url), { method: 'HEAD', timeout: 12000 }, (res) => {
    res.resume(); resolve(res.statusCode);
  });
  req.on('error', () => resolve(0));
  req.setTimeout(12000, () => { req.destroy(); resolve(0); });
  req.end();
});

console.log('字体预置校验');
check('恰好 4 个开源字体', () => assert.strictEqual(FONTS.length, 4));
check('字段齐全', () => {
  for (const f of FONTS) {
    for (const k of ['id', 'label', 'family', 'file', 'url', 'sizeMB', 'desc']) {
      assert.ok(f[k] != null, `${f.id} 缺 ${k}`);
    }
  }
});
check('id 唯一', () => {
  const ids = new Set(FONTS.map((f) => f.id));
  assert.strictEqual(ids.size, FONTS.length);
});
check('含空格的 family 带了引号', () => {
  for (const f of FONTS) {
    if (/\s/.test(f.family.replace(/['"]/g, ''))) {
      assert.ok(/^['"]/.test(f.family), `${f.id} 的 family ${f.family} 含空格却没引号`);
    }
  }
});
check('url 带版本锁（不是 @latest）', () => {
  for (const f of FONTS) assert.ok(!/@latest/.test(f.url), `${f.id} 用了 @latest`);
});
check('fontById 能查到', () => {
  assert.ok(fontById('lgwk'));
  assert.strictEqual(fontById('nope'), null);
});

(async () => {
  console.log('真实可达性（jsDelivr HEAD）');
  for (const f of FONTS) {
    const code = await head(f.url);
    check(`${f.id} ${f.label} → HTTP ${code}`, () => assert.strictEqual(code, 200));
  }

  // @font-face 拼装（与 src/lib/fonts.js injectFontFaces 同构）
  const css = FONTS.filter((f) => f.id === 'lgwk')
    .map((p) => `@font-face{font-family:${p.family};src:url('appfont://${p.file}');font-display:swap;}`)
    .join('\n');
  check('@font-face 拼装正确', () => {
    assert.ok(css.includes("@font-face{font-family:'LXGW WenKai'"));
    assert.ok(css.includes("url('appfont://LXGW-WenKai.ttf')"));
  });

  console.log(`\n通过 ${pass} 项${process.exitCode ? '（有失败）' : '，全部 PASS'}`);
})();
