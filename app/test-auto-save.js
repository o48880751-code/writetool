/**
 * 自动落盘的判据。
 *
 * ⚠⚠ 这份用例的**主角不是"能写进去"，是"不该写的时候一个字都不许动"**。
 *   写文件是破坏性的：误判一次就把用户的章节盖掉（.bak 能救，但那一刻
 *   足以让人不敢再用这个软件）。所以每个正向用例都配了反例。
 *
 * ⚠ 跨模块判据（最后一组）必须走**真的 fs**：只断言 resolve 返回了
 *   一个 path，等于只测了一半 —— 用户看到的是"文件里有没有内容"。
 *
 * 纯 node，不依赖 Electron。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./electron/auto-save.js');

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

/** 够长的一段"正文"，用来过 MIN_CHARS */
const LONG = '夜枫站在崖边，风从谷底卷上来。\n\n' + '他没有回头。'.repeat(90);

/** 造一棵典型的项目树 */
function treeWith(files) {
  return {
    name: 'proj', type: 'dir', path: '', children: [
      { name: '设定', type: 'dir', path: '设定', children: [
        { name: '世界观.md', type: 'file', path: '设定/世界观.md', ext: '.md' },
        { name: '人物库.md', type: 'file', path: '设定/人物库.md', ext: '.md' },
      ] },
      { name: '卷纲', type: 'dir', path: '卷纲', children: [] },
      { name: '章节', type: 'dir', path: '章节', children: files },
    ],
  };
}
const f = (name) => ({ name, type: 'file', path: `章节/${name}`, ext: '.md' });

console.log('\n=== A. 中文数字 ===');

check('cnToInt 一位与十位', () => {
  assert.strictEqual(A.cnToInt('一'), 1);
  assert.strictEqual(A.cnToInt('九'), 9);
  assert.strictEqual(A.cnToInt('十'), 10);
  assert.strictEqual(A.cnToInt('十一'), 11, '「十一」必须算 11 不是 1');
  assert.strictEqual(A.cnToInt('二十'), 20);
  assert.strictEqual(A.cnToInt('二十一'), 21);
});
check('cnToInt 百千与零', () => {
  assert.strictEqual(A.cnToInt('一百'), 100);
  assert.strictEqual(A.cnToInt('一百零三'), 103, '「零」不能吃掉后面的数字');
  assert.strictEqual(A.cnToInt('三百二十一'), 321);
  assert.strictEqual(A.cnToInt('两千'), 2000);
});
check('cnToInt 非数字返回 null（不猜）', () => {
  assert.strictEqual(A.cnToInt('abc'), null);
  assert.strictEqual(A.cnToInt(''), null);
  assert.strictEqual(A.cnToInt('第一章'), null, '带"第/章"应当解析不出来，由调用方先剥');
});
check('intToCn 各档位', () => {
  assert.strictEqual(A.intToCn(1), '一');
  assert.strictEqual(A.intToCn(10), '十');
  assert.strictEqual(A.intToCn(11), '十一');
  assert.strictEqual(A.intToCn(20), '二十');
  assert.strictEqual(A.intToCn(21), '二十一');
  assert.strictEqual(A.intToCn(100), '一百');
  assert.strictEqual(A.intToCn(103), '一百零三');
  assert.strictEqual(A.intToCn(1000), '一千');
});
check('1~300 往返一致（换算不能有洞）', () => {
  for (let i = 1; i <= 300; i++) {
    const cn = A.intToCn(i);
    assert.strictEqual(A.cnToInt(cn), i, `${i} → ${cn} → ${A.cnToInt(cn)}`);
  }
});

console.log('\n=== B. 章节号提取 ===');

check('「第一章」「第1章」都抽得出，且归一成 1', () => {
  assert.deepStrictEqual(A.extractChapterNumbers('重写第一章'), [1]);
  assert.deepStrictEqual(A.extractChapterNumbers('重写第1章'), [1]);
  assert.deepStrictEqual(A.extractChapterNumbers('重写第12章'), [12]);
});
check('空格与中文数字都能扛', () => {
  assert.deepStrictEqual(A.extractChapterNumbers('重写 第 3 章'), [3]);
  assert.deepStrictEqual(A.extractChapterNumbers('重写第二十一章'), [21]);
});
check('提到多章要去重保序', () => {
  assert.deepStrictEqual(A.extractChapterNumbers('第一章和第二章对比一下'), [1, 2]);
  assert.deepStrictEqual(A.extractChapterNumbers('第一章第一章'), [1]);
});
check('没有章节号就是空数组（不能瞎猜成第一章）', () => {
  assert.deepStrictEqual(A.extractChapterNumbers('重写一下这一章'), []);
  assert.deepStrictEqual(A.extractChapterNumbers('帮我润色'), []);
});

console.log('\n=== C. 文件名匹配 ===');

check('「第1章」能命中文件「第一章.md」（跨写法）', () => {
  assert.strictEqual(A.nameMatchesChapter('第一章.md', 1), true);
  assert.strictEqual(A.nameMatchesChapter('第1章.md', 1), true);
});
check('⚠ 第 1 章绝不能命中第 11 章', () => {
  assert.strictEqual(A.nameMatchesChapter('第十一章.md', 1), false);
  assert.strictEqual(A.nameMatchesChapter('第11章.md', 1), false);
  assert.strictEqual(A.nameMatchesChapter('第二十一章.md', 1), false);
});
check('带标题的文件名也算（第一章 剑来.md）', () => {
  assert.strictEqual(A.nameMatchesChapter('第一章 剑来.md', 1), true);
  assert.strictEqual(A.nameMatchesChapter('第一章_剑来.md', 1), true);
});
check('⚠ 细纲/摘要/大纲不是正文', () => {
  assert.strictEqual(A.nameMatchesChapter('第一章细纲.md', 1), false);
  assert.strictEqual(A.nameMatchesChapter('章节摘要.md', 1), false);
  assert.strictEqual(A.nameMatchesChapter('第三章大纲.md', 3), false);
});

console.log('\n=== D. 意图判定 ===');

check('明确写作动词 → write', () => {
  assert.strictEqual(A.detectIntent('重写第一章').write, true);
  assert.strictEqual(A.detectIntent('续写第3章').write, true);
  assert.strictEqual(A.detectIntent('帮我润色第一章').write, true);
});
check('⚠ 只问意见 → 不写', () => {
  assert.strictEqual(A.detectIntent('分析一下第一章').write, false);
  assert.strictEqual(A.detectIntent('第一章写得怎么样').write, false, '裸「写」不算写作意图');
  assert.strictEqual(A.detectIntent('看看第一章有没有问题').write, false);
});
check('⚠ 又要写又要点评 → 同时命中，交给上层拒写', () => {
  const r = A.detectIntent('重写第一章，说说哪里不好');
  assert.strictEqual(r.write, true);
  assert.strictEqual(r.advice, true, 'advice 必须为真，否则会把评价写进正文');
});
check('显式拒绝 → deny', () => {
  assert.strictEqual(A.detectIntent('不要写进文件').deny, true);
  assert.strictEqual(A.detectIntent('先别写').deny, true);
  assert.strictEqual(A.detectIntent('只给我看就行').deny, true);
});
check('「先写第一章」不能被 deny 误伤', () => {
  assert.strictEqual(A.detectIntent('先写第一章').deny, false);
});
check('⚠ 「写第五章」「帮我写第一章」也算写作意图（裸「写」不认，但「写+第N章」认）', () => {
  assert.strictEqual(A.detectIntent('写第五章').write, true, '这是用户最自然的说法，漏了就等于功能没做');
  assert.strictEqual(A.detectIntent('帮我写第一章').write, true);
  assert.strictEqual(A.detectIntent('写一下第三章').write, true);
});
check('⚠ 「第一章写得怎么样」仍然不算（结构不同，不能误伤）', () => {
  assert.strictEqual(A.detectIntent('第一章写得怎么样').write, false);
  assert.strictEqual(A.detectIntent('第五章写完了吗').write, false);
});

console.log('\n=== E. 正文清洗 ===');

check('剥掉「好的，以下是重写后的第一章：」', () => {
  const r = A.stripPreamble('好的，以下是重写后的第一章：\n\n夜枫抬头。');
  assert.strictEqual(r.stripped.length > 0, true);
  assert.strictEqual(r.text.trim(), '夜枫抬头。');
});
check('⚠ 正文首句不许动', () => {
  const r = A.stripPreamble('夜枫抬头。\n\n他看见雪。');
  assert.strictEqual(r.stripped, '');
  assert.strictEqual(r.text, '夜枫抬头。\n\n他看见雪。');
});
check('⚠ 首行很长时不剥（那多半是正文）', () => {
  const long = '这一天的风很大，夜枫站在崖边看着远处的云海翻涌，心里想的却是另外一件事：那柄刀到底还在不在。';
  const r = A.stripPreamble(`${long}\n\n第二段。`);
  assert.strictEqual(r.stripped, '');
});
check('只有一行时不剥（没有正文可留）', () => {
  const r = A.stripPreamble('好的，以下是正文：');
  assert.strictEqual(r.stripped, '');
});

console.log('\n=== F. resolve：该写的要写 ===');

check('目录里有第一章 → 覆盖它', () => {
  const plan = A.resolve({
    userText: '重写第一章', tree: treeWith([f('第一章.md'), f('第二章.md')]), content: LONG,
  });
  assert.ok(plan, '必须给出写入计划');
  assert.strictEqual(plan.path, '章节/第一章.md');
  assert.strictEqual(plan.mode, 'replace');
});
check('⚠ 目录里没有第一章 → 新建，而不是什么都不做', () => {
  const plan = A.resolve({ userText: '重写第一章', tree: treeWith([f('第二章.md')]), content: LONG });
  assert.ok(plan, '没有文件时应当新建（用户明确要求过）');
  assert.strictEqual(plan.path, '章节/第一章.md');
  assert.strictEqual(plan.mode, 'create');
});
check('用户说「第3章」，文件叫「第三章.md」→ 命中', () => {
  const plan = A.resolve({ userText: '重写第3章', tree: treeWith([f('第三章.md')]), content: LONG });
  assert.ok(plan);
  assert.strictEqual(plan.path, '章节/第三章.md');
});
check('没点名章节，但界面正打开着第一章 → 写它', () => {
  const plan = A.resolve({
    userText: '重写一下这一章', activePath: '章节/第一章.md',
    tree: treeWith([f('第一章.md')]), content: LONG,
  });
  assert.ok(plan, '打开着某一章时说"重写一下"应当写到那一章');
  assert.strictEqual(plan.path, '章节/第一章.md');
});

console.log('\n=== G. resolve：不该写的一个字都不许动 ===');

check('⚠ 内容太短 → 不写', () => {
  assert.strictEqual(A.resolve({ userText: '重写第一章', tree: treeWith([f('第一章.md')]), content: '好的，我明白了。' }), null);
});
check('⚠ 用户按了停止 → 不写（半截稿子不能覆盖）', () => {
  assert.strictEqual(A.resolve({
    userText: '重写第一章', tree: treeWith([f('第一章.md')]), content: LONG, stopped: true,
  }), null);
});
check('⚠ 模型自己已经 write_note 过 → 不重复写', () => {
  assert.strictEqual(A.resolve({
    userText: '重写第一章', tree: treeWith([f('第一章.md')]), content: LONG, wroteByTool: true,
  }), null);
});
check('⚠ 同时提到两章 → 不猜', () => {
  assert.strictEqual(A.resolve({
    userText: '第一章和第二章都重写', tree: treeWith([f('第一章.md'), f('第二章.md')]), content: LONG,
  }), null);
});
check('⚠ 纯咨询 → 不写', () => {
  assert.strictEqual(A.resolve({
    userText: '分析一下第一章', tree: treeWith([f('第一章.md')]), content: LONG,
  }), null);
});
check('⚠ 要写 + 要点评 → 不写', () => {
  assert.strictEqual(A.resolve({
    userText: '重写第一章，说说哪里不好', tree: treeWith([f('第一章.md')]), content: LONG,
  }), null);
});
check('⚠ 用户说不要写 → 不写', () => {
  assert.strictEqual(A.resolve({
    userText: '不要写进文件，只给我看第一章的改写', tree: treeWith([f('第一章.md')]), content: LONG,
  }), null);
});
check('⚠ 当前打开的是设定文档 → 不写', () => {
  assert.strictEqual(A.resolve({
    userText: '重写一下', activePath: '设定/世界观.md',
    tree: treeWith([f('第一章.md')]), content: LONG,
  }), null);
});
check('⚠ 当前打开的是章节摘要 → 不写', () => {
  assert.strictEqual(A.resolve({
    userText: '重写一下', activePath: '章节/章节摘要.md',
    tree: treeWith([f('章节摘要.md')]), content: LONG,
  }), null);
});
check('⚠ 当前打开的那一章在磁盘上已经没了 → 不写', () => {
  assert.strictEqual(A.resolve({
    userText: '重写一下', activePath: '章节/第九章.md',
    tree: treeWith([f('第一章.md')]), content: LONG,
  }), null);
});
check('⚠ 什么都没提、也没打开文件 → 不写', () => {
  assert.strictEqual(A.resolve({
    userText: '重写一下', tree: treeWith([f('第一章.md')]), content: LONG,
  }), null);
});
check('⚠ 同名文件散落在两个目录 → 只认 章节/ 下的；仍多义则不写', () => {
  const tree = {
    name: 'p', type: 'dir', path: '', children: [
      { name: '章节', type: 'dir', path: '章节', children: [f('第一章.md')] },
      { name: '卷纲', type: 'dir', path: '卷纲', children: [f('第一章.md').type === 'file' ? { name: '第一章.md', type: 'file', path: '卷纲/第一章.md' } : null] },
    ],
  };
  const plan = A.resolve({ userText: '重写第一章', tree, content: LONG });
  assert.ok(plan, '应当收敛到 章节/ 下那一个');
  assert.strictEqual(plan.path, '章节/第一章.md');
});

console.log('\n=== H. 跨模块：真的写进磁盘 ===');

check('走真 fs：有文件→覆盖、没文件→新建', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-autosave-'));
  try {
    // 场景一：文件已存在，内容是旧稿
    const p1 = path.join(dir, '第一章.md');
    fs.writeFileSync(p1, '# 第一章\n\n这是旧稿，会被覆盖。', 'utf8');
    const tree1 = treeWith([f('第一章.md')]);

    const plan1 = A.resolve({ userText: '重写第一章', tree: tree1, content: LONG });
    assert.ok(plan1, '前提：应当给出计划');
    assert.strictEqual(plan1.mode, 'replace', '前提：文件存在时必须是覆盖');
    fs.writeFileSync(path.join(dir, plan1.path.replace(/^章节\//, '')), plan1.content, 'utf8');
    const after1 = fs.readFileSync(p1, 'utf8');
    assert.strictEqual(after1, plan1.content, '文件内容必须等于生成的正文');
    assert.strictEqual(after1.includes('旧稿'), false, '旧内容必须被覆盖掉');

    // 场景二：文件不存在，要新建
    const plan2 = A.resolve({ userText: '写第五章', tree: treeWith([]), content: LONG });
    assert.ok(plan2, '前提：新章节应当给出计划');
    assert.strictEqual(plan2.mode, 'create', '前提：目录里没有时必须是新建');
    const p2 = path.join(dir, plan2.path.replace(/^章节\//, ''));
    fs.mkdirSync(path.dirname(p2), { recursive: true });
    fs.writeFileSync(p2, plan2.content, 'utf8');
    assert.strictEqual(fs.readFileSync(p2, 'utf8'), plan2.content, '新建的文件必须真的在磁盘上');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时目录清不掉不影响判据 */ }
  }
});

console.log('\n=== I. 走产品自己的 ProjectFs（真目录 + 真文件树）===');

/** 造一个真实项目：用产品自己的 ProjectFs 建模板 */
function withProject(fn) {
  const { ProjectFs } = require('./electron/project-fs.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pfs-'));
  const pfs = new ProjectFs(root);
  const id = 'p1';
  pfs.ensureProject(id);
  return Promise.resolve(fn(pfs, id)).finally(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* 临时目录 */ }
  });
}

check('新建一章：写完之后**文件树里真的出现**这一章', () => withProject((pfs, id) => {
  const tree0 = pfs.tree(id);
  const before = A.collectFiles(tree0);
  // ⚠ 先断言前提：模板里只有 章节/章节摘要.md，没有正文
  assert.strictEqual(before.some((f) => /第.+章/.test(f.name)), false,
    '前提不成立：模板里已经有章节正文了，这条判据就失去意义');

  const plan = A.resolve({ userText: '写第一章', tree: tree0, content: LONG });
  assert.ok(plan, '前提：应当给出新建计划');
  assert.strictEqual(plan.mode, 'create', '前提：此时必须是新建');

  A.applyPlan(plan, {
    exists: (rel) => fs.existsSync(pfs.resolveIn(id, rel)),
    backup: () => null,
    write: (rel, c) => pfs.write(id, rel, c),
  });

  const after = A.collectFiles(pfs.tree(id));
  const hit = after.find((f) => f.path === '章节/第一章.md');
  assert.ok(hit, `写完之后文件树里必须出现 章节/第一章.md，实际有：${after.map((f) => f.path).join(', ')}`);
  assert.strictEqual(pfs.read(id, '章节/第一章.md').content, plan.content, '读回来的内容必须等于生成的正文');
}));

check('⚠ 覆盖已有的一章：内容变了，且 .bak 真的落在磁盘上', () => withProject((pfs, id) => {
  const old = '# 第一章\n\n这是用户手写的旧稿，绝对不能被无声吞掉。';
  pfs.write(id, '章节/第一章.md', old);
  const tree0 = pfs.tree(id);

  const plan = A.resolve({ userText: '重写第一章', tree: tree0, content: LONG });
  assert.ok(plan, '前提：应当给出覆盖计划');
  assert.strictEqual(plan.path, '章节/第一章.md');
  assert.strictEqual(plan.mode, 'replace');

  const toolMod = require('./electron/tools.js');
  const info = A.applyPlan(plan, {
    exists: (rel) => fs.existsSync(pfs.resolveIn(id, rel)),
    backup: (rel) => {
      const abs = pfs.resolveIn(id, rel);
      return toolMod.backupFile(abs, () => abs);
    },
    write: (rel, c) => pfs.write(id, rel, c),
  });

  assert.strictEqual(pfs.read(id, '章节/第一章.md').content, plan.content, '文件必须被新正文覆盖');
  assert.ok(info.backup, '覆盖必须留下备份名');
  const absDir = pfs.resolveIn(id, '章节');
  const baks = fs.readdirSync(absDir).filter((n) => n.includes('.bak-'));
  assert.strictEqual(baks.length >= 1, true, `磁盘上必须真的有备份文件，实际：${fs.readdirSync(absDir).join(', ')}`);
  const saved = fs.readFileSync(path.join(absDir, baks[0]), 'utf8');
  assert.strictEqual(saved, old, '备份里必须是**旧稿原文**，不是新内容');
}));

console.log('\n=== J. applyPlan：备份与通知 ===');

check('覆盖时会备份，通知里带上备份名', () => {
  const calls = [];
  const info = A.applyPlan(
    { path: '章节/第一章.md', mode: 'replace', content: '新正文', why: 'test' },
    {
      exists: () => true,
      backup: () => '第一章.md.bak-20261018-120000',
      write: (p, c) => calls.push(['write', p, c]),
      notify: (i) => calls.push(['notify', i]),
    },
  );
  assert.strictEqual(info.backup, '第一章.md.bak-20261018-120000');
  assert.deepStrictEqual(calls[0], ['write', '章节/第一章.md', '新正文'], '必须先写文件');
  assert.strictEqual(calls[1][0], 'notify', '写完之后才通知');
  assert.strictEqual(calls[1][1].chars, 3);
});
check('新建时不备份（没有东西被覆盖）', () => {
  let backupCalled = false;
  const info = A.applyPlan(
    { path: '章节/第五章.md', mode: 'create', content: 'x', why: 't' },
    {
      exists: () => false,
      backup: () => { backupCalled = true; return 'b'; },
      write: () => {},
    },
  );
  assert.strictEqual(backupCalled, false, '文件不存在时不该产生 .bak');
  assert.strictEqual(info.backup, null);
});
check('⚠ 备份失败不拦写入（保险坏了也要先把稿子存进去）', () => {
  let wrote = false;
  const info = A.applyPlan(
    { path: '章节/第一章.md', mode: 'replace', content: 'y', why: 't' },
    {
      exists: () => true,
      backup: () => { throw new Error('磁盘满'); },
      write: () => { wrote = true; },
    },
  );
  assert.strictEqual(wrote, true, '备份抛异常后写入仍然必须发生');
  assert.strictEqual(info.backup, null, '备份失败要如实报 null，不能假装有备份');
});
check('⚠ 通知失败不影响已写好的文件', () => {
  let wrote = false;
  const info = A.applyPlan(
    { path: '章节/第一章.md', mode: 'replace', content: 'z', why: 't' },
    {
      exists: () => false,
      write: () => { wrote = true; },
      notify: () => { throw new Error('窗口已销毁'); },
    },
  );
  assert.strictEqual(wrote, true);
  assert.strictEqual(info.path, '章节/第一章.md');
});
check('applyPlan 收到 null 计划 → 什么都不做', () => {
  let touched = false;
  const r = A.applyPlan(null, { exists: () => { touched = true; return true; }, write: () => { touched = true; } });
  assert.strictEqual(r, null);
  assert.strictEqual(touched, false);
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
