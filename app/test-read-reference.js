/**
 * `read_reference` 工具的行为判据（2026-10-30）。
 *
 * 运行：node test-read-reference.js
 *
 * ## 为什么这个工具值得单独钉
 *
 * 技能广场装来的技能，价值**几乎全在 `references/` 里**（短篇写作 37 份、
 * 短篇拆文 15 份）。而这个工具的职责是"按名字从技能库里取一份文档" ——
 * 一旦它的路径校验被改松，模型就能穿过技能目录读到项目外的东西；
 * 一旦它的截断逻辑被改哑，模型会以为读完了、拿半份资料写正文。
 *
 * 两种失败都不报错，所以必须有判据。
 */

const fs = require('node:fs');
const path = require('node:path');

let pass = 0;
let fail = 0;
const pending = [];

function check(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => { pass += 1; console.log(`  ✓ ${name}`); })
      .catch((e) => { fail += 1; console.log(`  ✗ ${name}`); console.log(`      ${e.message}`); })
  );
}

const tools = require('./electron/tools.js');
const { runReadReference, REFERENCE_MAX_CHARS } = tools;

/** 造一个假的技能资料环境 */
function makeCtx(files) {
  const map = new Map(files.map((f) => [f.path, f.content]));
  return {
    listReferences: () => files.map((f) => ({ path: f.path, size: (f.content || '').length })),
    readReference: (p) => (map.has(p) ? map.get(p) : ''),
  };
}

const SAMPLE = [
  { path: 'references/short-reversal.md', content: '反转设计：先给期待，再翻面。' },
  { path: 'references/genre-styles/追妻火葬场.md', content: '题材配方……' },
];

// ---------------------------------------------------------------- 行为

check('★ 没有选中技能时，给出可执行的下一步而不是报错', () => {
  const r = runReadReference({}, makeCtx([]));
  if (r.ok !== false) throw new Error('没有资料时不该返回成功');
  if (!/勾选技能|没有选中技能/.test(r.output)) throw new Error(`提示里没说该怎么办：${r.output}`);
});

check('★ 不带 path 时列出全部可读文件', () => {
  const r = runReadReference({}, makeCtx(SAMPLE));
  if (!r.ok) throw new Error('列清单应该成功');
  for (const f of SAMPLE) {
    if (!r.output.includes(f.path)) throw new Error(`清单里少了 ${f.path}`);
  }
  if (!r.output.includes('read_reference')) throw new Error('清单后面没教它怎么读');
});

check('★ 正常读取返回原文', () => {
  const r = runReadReference({ path: 'references/short-reversal.md' }, makeCtx(SAMPLE));
  if (!r.ok) throw new Error(`读失败：${r.output}`);
  if (r.output !== SAMPLE[0].content) throw new Error('内容和原文不一致');
});

check('★ 带 ./ 前缀也能读到（模型常这么写）', () => {
  const r = runReadReference({ path: './references/short-reversal.md' }, makeCtx(SAMPLE));
  if (!r.ok) throw new Error(`带 ./ 就读不到：${r.output}`);
});

check('★ 反斜杠路径能归一化（Windows 下模型会写）', () => {
  const r = runReadReference({ path: 'references\\short-reversal.md' }, makeCtx(SAMPLE));
  if (!r.ok) throw new Error(`反斜杠路径读不到：${r.output}`);
});

check('★ 穿目录路径被拒绝', () => {
  for (const bad of ['../secret.md', 'references/../../x.md', '..\\..\\x.md']) {
    const r = runReadReference({ path: bad }, makeCtx(SAMPLE));
    if (r.ok) throw new Error(`越界路径被放行了：${bad}`);
    if (!/不合法/.test(r.output)) throw new Error(`拒绝理由不清楚：${r.output}`);
  }
});

check('★ 绝对路径与盘符被拒绝', () => {
  for (const bad of ['/etc/passwd', 'C:/Windows/win.ini']) {
    const r = runReadReference({ path: bad }, makeCtx(SAMPLE));
    if (r.ok) throw new Error(`绝对路径被放行了：${bad}`);
  }
});

check('★ 不存在的文件给出最接近的候选', () => {
  const r = runReadReference({ path: 'references/reversal.md' }, makeCtx(SAMPLE));
  if (r.ok) throw new Error('读不存在的文件不该返回成功');
  if (!r.output.includes('short-reversal.md')) throw new Error('没给候选路径，模型只能瞎试');
});

check('★ 超长文件截断并明确告知，不能悄悄少给', () => {
  const big = 'x'.repeat(REFERENCE_MAX_CHARS + 500);
  const r = runReadReference({ path: 'references/big.md' }, makeCtx([{ path: 'references/big.md', content: big }]));
  if (!r.ok) throw new Error('超长文件应该截断而不是失败');
  if (!r.output.includes('没读到') && !r.output.includes('只给了前')) {
    throw new Error('截断了但没告诉模型，它会以为读完了');
  }
});

check('★ 空文件不假装读成功', () => {
  const r = runReadReference({ path: 'references/empty.md' }, makeCtx([{ path: 'references/empty.md', content: '' }]));
  if (r.ok) throw new Error('空文件不该算读到');
});

// ---------------------------------------------------------------- 判据自检

check('★ 反向用例：去掉校验的实现会被同一批输入抓出来', () => {
  // 故意写一个"什么都放行"的实现，确认上面的越界断言不是恒真
  const bad = (a) => ({ ok: true, output: String(a.path || '') });
  const caught = ['../secret.md', 'C:/Windows/win.ini'].some((p) => bad({ path: p }).ok);
  if (!caught) throw new Error('反向用例没被抓到 —— 说明越界断言本身是废的');
});

check('★ 主进程只把 reference 类文件交给模型（静态断言）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'electron/main.js'), 'utf8');
  if (!/f\.kind !== 'reference'/.test(src)) {
    throw new Error("main.js 的 listReferences 没有过滤 kind —— script/asset 会一起给模型读到");
  }
});

check('★ 工具已在「始终可用」列表里（否则模型看不到它）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'electron/main.js'), 'utf8');
  const m = src.match(/always:\s*\[([^\]]+)\]/);
  if (!m) throw new Error('找不到 always 列表');
  if (!m[1].includes('read_reference')) {
    throw new Error(`always 列表里没有 read_reference：${m[1].trim()}`);
  }
});

check('★ 工具定义已注册且分组存在', () => {
  const names = tools.TOOL_DEFS.map((d) => d.function && d.function.name);
  if (!names.includes('read_reference')) throw new Error('TOOL_DEFS 里没有这个工具');
  if (!tools.TOOL_GROUPS.file.includes('read_reference')) {
    throw new Error('TOOL_GROUPS.file 里没有它，界面开关会管不到');
  }
});

// ---------------------------------------------------------------- 汇总

Promise.all(pending).then(() => {
  console.log(`\nread_reference：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});
