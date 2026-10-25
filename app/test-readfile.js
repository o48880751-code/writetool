/**
 * read_file / list_files 的判据（2026-10-18）。
 *
 * ## 为什么这两个工具必须有判据
 *
 * 在它们出现之前，这个产品**没有任何读文件的能力**。后果不是"少个功能"，
 * 而是模型完全失明：它想重写第一章，只能去调 terminal，而终端默认关着，
 * 三次调用三次报错，最后回一句「我这边读不到项目文件」（羽毛菌的截图）。
 *
 * ## 最要命的一条：不存在 ≠ 空
 *
 * `ctx.readFile` 读不到时返回空串。如果 read_file 不单独判存在，
 * 模型会看到一段空白，认定"这一章是空的"，于是从头写一份**覆盖掉**——
 * 而用户的原稿一直在磁盘上。误判的代价是丢稿子，所以这条用例给得最重。
 *
 * 纯 node，不依赖 Electron。
 */
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const T = require('./electron/tools.js');

let passed = 0;
const failures = [];

/**
 * ⚠ 必须支持 async：`execTool` 本身是 async 函数。
 *   同步版会把 `await T.execTool(...)` 漏掉，读到 undefined 当"通过"（假绿）。
 */
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

/** 用 flat 的 {路径: 内容} 造一个 ctx（含树） */
function ctxWith(files) {
  const paths = Object.keys(files);
  const tree = { name: 'proj', type: 'dir', path: '', children: [] };
  for (const p of paths) {
    const segs = p.split('/');
    let node = tree;
    for (let i = 0; i < segs.length; i++) {
      const isFile = i === segs.length - 1;
      const acc = segs.slice(0, i + 1).join('/');
      let next = (node.children || []).find((c) => c.name === segs[i]);
      if (!next) {
        next = isFile
          ? { name: segs[i], type: 'file', path: acc, size: String(files[p]).length }
          : { name: segs[i], type: 'dir', path: acc, children: [] };
        node.children.push(next);
      }
      node = next;
    }
  }
  return {
    fileExists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFile: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : ''),
    tree: () => tree,
  };
}

console.log('\n=== A. read_file：正常读 ===');

check('读一个存在的文件，内容原样返回', () => {
  const ctx = ctxWith({ '章节/第一章.md': '# 第一章\n\n夜枫抬头。' });
  const r = T.runReadFile({ path: '章节/第一章.md' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(r.output.includes('夜枫抬头'), '返回里必须有正文');
  assert.ok(r.output.includes('共 3 行'), `应当报总行数，实际：${r.output.slice(0, 80)}`);
});
check('反斜杠路径也能读（模型有时会写 Windows 分隔符）', () => {
  const ctx = ctxWith({ '章节/第一章.md': '正文' });
  const r = T.runReadFile({ path: '章节\\第一章.md' }, ctx);
  assert.strictEqual(r.ok, true);
});

console.log('\n=== B. read_file：⚠ 不存在 vs 空 ===');

check('★★ 文件不存在 → 明确报错，并指引去看目录', () => {
  const ctx = ctxWith({ '章节/第二章.md': '别的章' });
  const r = T.runReadFile({ path: '章节/第一章.md' }, ctx);
  assert.strictEqual(r.ok, false, '不存在时必须 ok:false —— 返回空内容会让模型以为文件是空的');
  assert.ok(/没有这个文件/.test(r.output), r.output);
  assert.ok(/list_files/.test(r.output), '要告诉模型下一步怎么做，否则它只会再试一次');
});
check('⚠⚠ 空文件就是空文件（这个不能被杀掉）', () => {
  const ctx = ctxWith({ '章节/第三章.md': '' });
  const r = T.runReadFile({ path: '章节/第三章.md' }, ctx);
  assert.strictEqual(r.ok, true, '空文件是合法状态，不该报"不存在"');
  assert.ok(/共 1 行/.test(r.output), r.output);
});

console.log('\n=== C. read_file：沙箱与边界 ===');

check('⚠ 绝对路径拒绝', () => {
  const ctx = ctxWith({ 'a.md': 'x' });
  assert.strictEqual(T.runReadFile({ path: '/etc/passwd' }, ctx).ok, false);
  assert.strictEqual(T.runReadFile({ path: 'C:/Windows/win.ini' }, ctx).ok, false);
});
check('⚠ 用 .. 越界拒绝', () => {
  const ctx = ctxWith({ 'a.md': 'x' });
  const r = T.runReadFile({ path: '../../secret.md' }, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/不合法/.test(r.output), r.output);
});
check('没有给路径 → 报错而不是崩', () => {
  assert.strictEqual(T.runReadFile({}, ctxWith({})).ok, false);
  assert.strictEqual(T.runReadFile({ path: '   ' }, ctxWith({})).ok, false);
});

console.log('\n=== D. read_file：分段读 ===');

check('from / lines 生效', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `第${i + 1}行`);
  const ctx = ctxWith({ 'a.md': lines.join('\n') });
  const r = T.runReadFile({ path: 'a.md', from: 11, lines: 5 }, ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(r.output.includes('第11行'), '起点必须对');
  assert.ok(r.output.includes('第15行'));
  assert.strictEqual(r.output.includes('第16行'), false, '不能多读一行');
});
check('⚠ 没读完要明确告诉模型"从第几行接着读"', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `L${i + 1}`);
  const ctx = ctxWith({ 'a.md': lines.join('\n') });
  const r = T.runReadFile({ path: 'a.md' }, ctx);   // 默认 400 行
  assert.strictEqual(r.ok, true);
  assert.ok(/还没读完/.test(r.output), '1000 行的文件只读 400 行，必须提示');
  assert.ok(/from=401/.test(r.output), `续读位置要算对，实际：${r.output.slice(-60)}`);
});
check('读完最后一段就不再提示续读', () => {
  const ctx = ctxWith({ 'a.md': 'a\nb\nc' });
  const r = T.runReadFile({ path: 'a.md' }, ctx);
  assert.strictEqual(r.output.includes('还没读完'), false);
});
check('⚠ 超大文件按字符截断（不能把整轮上下文吃掉）', () => {
  const huge = 'x'.repeat(60000);
  const ctx = ctxWith({ 'a.md': huge });
  const r = T.runReadFile({ path: 'a.md' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(r.output.length < T.READ_MAX_CHARS + 500,
    `返回必须被截断到 ${T.READ_MAX_CHARS} 上下，实际 ${r.output.length}`);
  assert.ok(/还没读完/.test(r.output), '截断了必须说');
});
check('lines 超过上限会被夹住（不让模型把 2000 行以上一次拉完）', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `L${i}`);
  const ctx = ctxWith({ 'a.md': lines.join('\n') });
  const r = T.runReadFile({ path: 'a.md', lines: 99999 }, ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(r.output.includes('共 3000 行'));
  assert.ok(/还没读完/.test(r.output), '只读了 2000 行，必须提示');
});

console.log('\n=== E. list_files ===');

check('列根目录：目录带 /，文件带大小', () => {
  const ctx = ctxWith({ '设定/世界观.md': 'x'.repeat(2048), '章节/第一章.md': 'y' });
  const r = T.runListFiles({}, ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(r.output.includes('设定/'), r.output);
  assert.ok(r.output.includes('章节/'), r.output);
});
check('列子目录', () => {
  const ctx = ctxWith({ '章节/第一章.md': 'y', '章节/第二章.md': 'z' });
  const r = T.runListFiles({ dir: '章节' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(r.output.includes('第一章.md'), r.output);
  assert.ok(r.output.includes('第二章.md'), r.output);
});
check('⚠ 目录不存在 → 报错（不能返回空，否则模型以为目录是空的）', () => {
  const ctx = ctxWith({ '章节/第一章.md': 'y' });
  const r = T.runListFiles({ dir: '不存在的目录' }, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/没有这个目录/.test(r.output), r.output);
});
check('⚠ dir 传 "." / "./" 应当当根目录（2026-10-19 现场：模型第一次就这么传）', () => {
  const ctx = ctxWith({ '设定/世界观.md': 'x', '章节/第一章.md': 'y' });
  for (const d of ['.', './', '.\\', './章节', '章节/', '章节']) {
    const r = T.runListFiles({ dir: d }, ctx);
    assert.strictEqual(r.ok, true,
      `dir=${JSON.stringify(d)} 被判失败：「${r.output}」—— 模型会据此以为项目是空的，白跑一轮`);
  }
});
check('dir 传 ".." 仍然拒绝', () => {
  const ctx = ctxWith({ 'a.md': 'x' });
  assert.strictEqual(T.runListFiles({ dir: '..' }, ctx).ok, false);
  assert.strictEqual(T.runListFiles({ dir: '../x' }, ctx).ok, false);
});
check('空目录说清楚是空的', () => {
  const ctx = { tree: () => ({ name: 'p', type: 'dir', path: '', children: [] }) };
  const r = T.runListFiles({}, ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(/空/.test(r.output), r.output);
});
check('depth 限制生效', () => {
  const ctx = ctxWith({ 'a/b/c/d.md': 'x' });
  const shallow = T.runListFiles({ depth: 1 }, ctx);
  assert.strictEqual(shallow.output.includes('d.md'), false, 'depth=1 不该看到第四层');
  const deep = T.runListFiles({ depth: 5 }, ctx);
  assert.strictEqual(deep.output.includes('d.md'), true, 'depth=5 应该能看到');
});
check('没有 tree 能力时明确报错，不崩', () => {
  const r = T.runListFiles({}, {});
  assert.strictEqual(r.ok, false);
});

console.log('\n=== F. execTool 路由 ===');

check('execTool 能路由到 read_file / list_files', async () => {
  const ctx = ctxWith({ 'a.md': '正文在这里' });
  const r1 = await T.execTool('read_file', { path: 'a.md' }, ctx);
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  const r2 = await T.execTool('list_files', {}, ctx);
  assert.strictEqual(r2.ok, true, JSON.stringify(r2));
});
check('不认识的工具名仍然拒绝（别把 default 分支弄坏）', async () => {
  const r = await T.execTool('rm_rf', {}, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/不认识的工具/.test(r.output), r.output);
});

console.log('\n=== G. 走真 ProjectFs（真目录）===');

check('真实项目：列目录 → 读模板文件 → 内容对得上', () => {
  const { ProjectFs } = require('./electron/project-fs.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-read-'));
  try {
    const pfs = new ProjectFs(root);
    const id = 'p1';
    pfs.ensureProject(id);
    const ctx = {
      fileExists: (rel) => {
        try { return fs.existsSync(pfs.resolveIn(id, rel)); } catch (_) { return false; }
      },
      readFile: (rel) => {
        try { return fs.readFileSync(pfs.resolveIn(id, rel), 'utf8'); } catch (_) { return ''; }
      },
      tree: () => pfs.tree(id, { maxDepth: 4 }),
    };

    // 列目录：模板里的三个文件都得出现
    const ls = T.runListFiles({}, ctx);
    assert.strictEqual(ls.ok, true, ls.output);
    for (const name of ['设定/', '卷纲/', '章节/']) {
      assert.ok(ls.output.includes(name), `目录里必须有 ${name}，实际：${ls.output}`);
    }

    // 读模板文件
    const rd = T.runReadFile({ path: '设定/世界观.md' }, ctx);
    assert.strictEqual(rd.ok, true, rd.output);
    assert.ok(rd.output.includes('# 世界观'), rd.output);

    // 写一章再读回来（读写闭环）
    pfs.write(id, '章节/第一章.md', '# 第一章\n\n夜枫站在崖边。');
    const rd2 = T.runReadFile({ path: '章节/第一章.md' }, ctx);
    assert.strictEqual(rd2.ok, true);
    assert.ok(rd2.output.includes('夜枫站在崖边'), '刚写的必须马上读得到');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* 临时目录 */ }
  }
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
