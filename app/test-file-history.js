/**
 * 文件历史版本（回退）的判据（2026-10-18）。
 *
 * ## 为什么要有这个功能
 *
 * 羽毛菌：「ai助手修改的文件不支持回退」。
 *
 * 备份其实一直在写（`write_note` / 自动落盘覆盖前都会留 `.bak-时间戳`），
 * 但**界面上没有任何入口能看见它们** —— 存了看不见等于没存。
 *
 * ## 这份判据盯的三件事
 *
 * 1. **备份真能救回原稿**（走真 fs，不看源码怎么写）
 * 2. 三端接线（main / preload / 界面）的名字对得上
 * 3. ⚠ 恢复**本身也要先备份** —— 否则"退回上一版"这个动作不可逆，
 *    用户点错一次就再也回不来
 *
 * 纯 node，不依赖 Electron。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let passed = 0;
const failures = [];
const pending = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (e) => { failures.push({ name, e }); console.log(`  ✗ ${name}\n    ${e.message}`); },
      ));
      return;
    }
    passed++; console.log(`  ✓ ${name}`);
  } catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
/** ⚠ 扫源码前必须剥注释：注释里到处是函数名，不剥的话删了实现也照样绿 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const mainSrc = stripComments(read('electron/main.js'));
const preloadSrc = stripComments(read('electron/preload.js'));
const docSrc = stripComments(read('src/components/DocPreview.jsx'));
const appSrc = stripComments(read('src/App.jsx'));

console.log('\n=== A. 走真 fs：备份真的能把原稿救回来 ===');

check('覆盖 → 备份 → 再覆盖 → 从备份恢复，内容回到第一版', () => {
  const toolMod = require('./electron/tools.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hist-'));
  try {
    const file = path.join(dir, '第一章.md');
    const v1 = '# 第一章\n\n这是用户亲手写的第一版。';
    const v2 = 'AI 重写后的第二版，把第一版盖掉了。';
    const v3 = '又一个版本。';

    fs.writeFileSync(file, v1, 'utf8');

    // AI 第一次覆盖：先备份
    const bak1 = toolMod.backupFile(file, () => file);
    assert.ok(bak1, '备份要返回文件名，否则界面不知道恢复了什么');
    fs.writeFileSync(file, v2, 'utf8');

    // AI 第二次覆盖：再备份
    const bak2 = toolMod.backupFile(file, () => file);
    assert.ok(bak2);
    fs.writeFileSync(file, v3, 'utf8');

    // 两次备份内容必须各自对应当时的版本
    assert.strictEqual(fs.readFileSync(path.join(dir, bak1), 'utf8'), v1, 'bak1 里必须是 v1');
    assert.strictEqual(fs.readFileSync(path.join(dir, bak2), 'utf8'), v2, 'bak2 里必须是 v2');

    // 恢复成 v1
    fs.writeFileSync(file, fs.readFileSync(path.join(dir, bak1), 'utf8'), 'utf8');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), v1, '恢复后必须回到第一版');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时目录 */ }
  }
});

check('⚠ 备份只保留最近 3 份（不能无限堆 .bak 把项目目录撑爆）', () => {
  const toolMod = require('./electron/tools.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hist2-'));
  try {
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, 'v0', 'utf8');
    // 手工造 6 份"更早"的备份（名字排序在当前时间之前 → 属于该被清掉的旧份）
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(dir, `a.md.bak-20200101-00000${i}`), `v${i}`, 'utf8');
    }
    const bak = toolMod.backupFile(file, () => file);
    assert.ok(bak, '前提：这次备份要成功');
    const baks = fs.readdirSync(dir).filter((n) => n.startsWith('a.md.bak-'));
    assert.ok(baks.length <= 3, `最多留 3 份，实际 ${baks.length} 份：${baks.join(', ')}`);
    assert.ok(baks.includes(bak), '刚生成的那份不能被自己清掉');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时目录 */ }
  }
});

console.log('\n=== B. 三端接线 ===');

check('main.js 注册了 fs:history 与 fs:restore', () => {
  assert.ok(/handle\('fs:history'/.test(mainSrc), '没注册 fs:history');
  assert.ok(/handle\('fs:restore'/.test(mainSrc), '没注册 fs:restore');
});
check('preload 暴露了 fs.history 与 fs.restore', () => {
  assert.ok(/history:\s*\(\{[^}]*\}\)\s*=>\s*call\('fs:history'/.test(preloadSrc),
    'preload 的 history 没接到 fs:history');
  assert.ok(/restore:\s*\(\{[^}]*\}\)\s*=>\s*call\('fs:restore'/.test(preloadSrc),
    'preload 的 restore 没接到 fs:restore');
});
check('⚠⚠ 界面真的调用了这两个方法（不是只有后端）', () => {
  assert.ok(/window\.api\.fs\.history\s*\(/.test(docSrc), 'DocPreview 没调 fs.history');
  assert.ok(/window\.api\.fs\.restore\s*\(/.test(docSrc), 'DocPreview 没调 fs.restore');
});
check('⚠ DocPreview 拿到了 projectId（没它调不通）', () => {
  assert.ok(/projectId,/.test(docSrc), '参数没解构出来');
  assert.ok(/projectId=\{projectId\}/.test(appSrc), 'App 没把 projectId 传下去');
});
check('⚠ 恢复后要重读文件（否则界面还显示旧内容）', () => {
  assert.ok(/onRestored/.test(docSrc) && /onRestored=\{openPreview\}/.test(appSrc),
    '恢复后没有重读，用户会以为没生效');
});

console.log('\n=== C. 安全与可逆性 ===');

check('⚠⚠ 恢复前会把当前内容也备份（撤销撤销也能撤销）', () => {
  // 找到 fs:restore 的实现段，确认里面调了 backupFile
  const i = mainSrc.indexOf("handle('fs:restore'");
  assert.ok(i > 0, '前提不成立：没找到 fs:restore');
  const seg = mainSrc.slice(i, i + 1400);
  assert.ok(/backupFile/.test(seg),
    '恢复前没有备份当前版本 —— 用户点错一次就再也回不到"恢复之前"了');
});
check('⚠ 备份文件名只认这个文件自己的（防越权读别的文件）', () => {
  const i = mainSrc.indexOf("handle('fs:restore'");
  const seg = mainSrc.slice(i, i + 1400);
  assert.ok(/startsWith\(`\$\{base\}\.bak-`\)/.test(seg) || /startsWith\(.*\.bak-/.test(seg),
    '没有校验备份名前缀，界面/模型传任意名字就能读项目里的任意文件');
  assert.ok(/includes\('\/'\)|includes\("\/"\)/.test(seg), '没有拦截路径分隔符');
});
check('历史列表按时间倒序（最新的那版排第一）', () => {
  const i = mainSrc.indexOf("handle('fs:history'");
  const seg = mainSrc.slice(i, i + 1200);
  assert.ok(/\.sort\(/.test(seg), '没有排序，用户得自己找哪份是刚才的');
  assert.ok(/stamp\s*<\s*b\.stamp\s*\?\s*1/.test(seg), '排序方向不对：应当是新的在前');
});

Promise.all(pending).then(() => {
  const total = passed + failures.length;
  console.log(`\n${'='.repeat(52)}`);
  if (failures.length) {
    console.log(`✗ ${failures.length}/${total} 条失败：`);
    for (const { name, e } of failures) console.log(`  · ${name}\n    ${e.message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部 ${total} 条通过`);
  }
});
