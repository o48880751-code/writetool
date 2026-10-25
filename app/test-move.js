const assertNode = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 拖拽落点（move）的测试。
 *
 * 这一层的每个用例都对着**不可逆的数据损失**：
 * 覆盖文件、目录成环、移到项目外。所以判据不是"功能能用"，
 * 而是"该拦的确实被拦住了，且拦得住的原因说得清"。
 */

const ROOT = path.resolve(__dirname, '..');
const { ProjectFs } = require(path.join(ROOT, 'app', 'electron', 'project-fs.js'));
const O = require(path.join(ROOT, 'app', 'electron', 'tree-order.js'));

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failures.push({ name, message: e.message });
    console.log('  ✗ ' + name);
    console.log('    ' + String(e.message).split('\n').join('\n    '));
  }
}
function section(t) { console.log('\n' + t); }

function assertThrows(fn, re, why) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assertNode.ok(threw, why || '本该抛错但没抛');
  if (re) {
    assertNode.ok(re.test(threw.message),
      `错误信息不含预期内容：实际「${threw.message}」`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-move-'));
const pfs = new ProjectFs(path.join(TMP, 'projects'));
const PID = 'mp';
pfs.ensureProject(PID);
const DIR = pfs.projectDir(PID);

process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

/** 每个用例用独立子项目，互不干扰 */
let n = 0;
function fresh() {
  const id = `mp${++n}`;
  pfs.ensureProject(id);
  return id;
}
function namesOf(pid, dir) {
  const t = pfs.tree(pid);
  const node = dir
    ? t.children.find((c) => c.path.replace(/\\/g, '/') === dir)
    : t;
  return (node?.children || []).map((c) => c.name);
}

/**
 * 只取匹配 re 的项名。
 *
 * ⚠ 为什么要过滤：项目建好时自带 4 个模板文件 + 3 个目录。
 *   直接比全量名字，断言就得把它们的位置也写死——而模板文件的位置
 *   与本次测的顺序行为无关。写死它会让"顺序错了一点"与
 *   "模板文件动了"混在一起，出错时分不清谁的问题。
 */
function onlyMatching(pid, dir, re) {
  return namesOf(pid, dir).filter((x) => re.test(x));
}

// ===========================================================
section('一、跨目录移动');
// ===========================================================

check('文件移到子目录，源目录不再有它', () => {
  const p = fresh();
  pfs.write(p, '甲.md', '内容甲');
  pfs.write(p, '乙.md', '内容乙');
  const r = pfs.move(p, '甲.md', '卷纲');
  assertNode.strictEqual(r.moved, true);
  assertNode.strictEqual(fs.existsSync(pfs.resolveIn(p, '甲.md')), false, '源还在');
  assertNode.ok(fs.existsSync(pfs.resolveIn(p, '卷纲/甲.md')), '目标不在');
  assertNode.strictEqual(
    fs.readFileSync(pfs.resolveIn(p, '卷纲/甲.md'), 'utf8'), '内容甲', '内容变了');
});

check('目录整个搬走（含子内容）', () => {
  const p = fresh();
  pfs.write(p, '设定/人物/甲.md', 'x');
  pfs.move(p, '设定', '卷纲');
  assertNode.strictEqual(fs.existsSync(pfs.resolveIn(p, '设定')), false);
  assertNode.ok(fs.existsSync(pfs.resolveIn(p, '卷纲/设定/人物/甲.md')));
});

check('移到项目根（目标目录为空串）', () => {
  const p = fresh();
  pfs.write(p, '章节/草稿.md', 'y');
  pfs.move(p, '章节/草稿.md', '');
  assertNode.ok(fs.existsSync(pfs.resolveIn(p, '草稿.md')));
  assertNode.strictEqual(fs.existsSync(pfs.resolveIn(p, '章节/草稿.md')), false);
});

// ===========================================================
section('二、必须拦住的三种情况');
// ===========================================================

check('★ 目录不能移进自己的子目录（成环）', () => {
  const p = fresh();
  pfs.write(p, '甲/乙/丙.md', 'z');
  assertThrows(() => pfs.move(p, '甲', '甲/乙'), /自己的子目录/,
    '把「甲」移进「甲/乙」被放行了——之后树会无限递归');
  // 现场没被动过
  assertNode.ok(fs.existsSync(pfs.resolveIn(p, '甲/乙/丙.md')));
});

check('★ 成环检查也覆盖多层后代', () => {
  const p = fresh();
  pfs.write(p, '甲/乙/丙/丁.md', 'z');
  assertThrows(() => pfs.move(p, '甲', '甲/乙/丙'), /自己的子目录/);
});

check('★ 目标已有同名时拒绝，不覆盖', () => {
  const p = fresh();
  pfs.write(p, '卷纲/甲.md', '旧内容');
  pfs.write(p, '章节/甲.md', '新内容');
  assertThrows(() => pfs.move(p, '章节/甲.md', '卷纲'), /同名/);
  assertNode.strictEqual(
    fs.readFileSync(pfs.resolveIn(p, '卷纲/甲.md'), 'utf8'), '旧内容',
    '★ 目标文件被覆盖了——这是不可逆的数据损失');
});

check('★ 目标路径越界被拦（沿用 resolveIn）', () => {
  const p = fresh();
  pfs.write(p, '甲.md', 'x');
  assertThrows(() => pfs.move(p, '甲.md', '../../../../Windows'), /越界|不允许/);
  assertThrows(() => pfs.move(p, '甲.md', 'C:/Windows'), /越界|不允许/);
  assertThrows(() => pfs.move(p, '../../../etc', '卷纲'), /越界/);
});

check('源不存在时报错', () => {
  const p = fresh();
  assertThrows(() => pfs.move(p, '没有这个.md', '卷纲'), /源不存在/);
});

check('目标目录不存在时报错（不自动建）', () => {
  const p = fresh();
  pfs.write(p, '甲.md', 'x');
  assertThrows(() => pfs.move(p, '甲.md', '不存在的目录'), /目标目录不存在/);
});

check('目标是文件不是目录时报错', () => {
  const p = fresh();
  pfs.write(p, '甲.md', 'x');
  // ⚠ 用例自己建一个当"目标"的文件，不要指望模板里有。
  //   原来写死 '世界观.md'，可模板改版后它已经挪到 设定/世界观.md，
  //   项目根下没有同名文件 → 先撞上「目标目录不存在」，
  //   根本走不到「不是文件夹」那一支，用例变成在测另一件事。
  pfs.write(p, '乙.md', 'y');
  assertThrows(() => pfs.move(p, '甲.md', '乙.md'), /不是文件夹/);
});

check('空源路径被拒', () => {
  const p = fresh();
  assertThrows(() => pfs.move(p, '', '卷纲'), /没有要移动/);
});

// ===========================================================
section('三、同目录重排');
// ===========================================================

check('同级重排只改顺序，不动磁盘', () => {
  const p = fresh();
  pfs.write(p, 'a.md', 'A');
  pfs.write(p, 'b.md', 'B');
  pfs.write(p, 'c.md', 'C');
  const r = pfs.move(p, 'c.md', '', { anchor: 'a.md', place: 'before' });
  assertNode.strictEqual(r.moved, false, '不该报告"已移动"');
  // 三个文件都还在
  for (const f of ['a.md', 'b.md', 'c.md']) {
    assertNode.ok(fs.existsSync(pfs.resolveIn(p, f)), `${f} 不见了`);
  }
  const files = onlyMatching(p, '', /^[abc]\.md$/);
  assertNode.deepStrictEqual(files, ['c.md', 'a.md', 'b.md'], `实际 ${files.join(',')}`);
});

check('重排后 refreshTree 的顺序与界面一致', () => {
  const p = fresh();
  pfs.write(p, '1.md', '1');
  pfs.write(p, '2.md', '2');
  pfs.move(p, '1.md', '', { anchor: '2.md', place: 'after' });
  const files = onlyMatching(p, '', /^[12]\.md$/);
  assertNode.deepStrictEqual(files, ['2.md', '1.md'], `实际 ${files.join(',')}`);
});

check('同级重排把自己当锚点是安全的', () => {
  const p = fresh();
  pfs.write(p, 'x.md', 'x');
  pfs.write(p, 'y.md', 'y');
  const r = pfs.move(p, 'x.md', '', { anchor: 'x.md', place: 'before' });
  assertNode.strictEqual(r.ok, true);
  const files = onlyMatching(p, '', /^[xy]\.md$/);
  assertNode.strictEqual(files.length, 2, `实际 ${files.join(',')}`);
});

check('★ 跨目录移动后，原目录的顺序表里不再有它', () => {
  const p = fresh();
  pfs.write(p, 'a.md', 'a');
  pfs.write(p, 'b.md', 'b');
  pfs.write(p, 'c.md', 'c');
  pfs.move(p, 'a.md', '', { anchor: 'c.md', place: 'before' });
  pfs.move(p, 'a.md', '卷纲');
  // 原目录顺序表里若还留着 a.md，下次新增文件会被排到它后面，
  // 而屏幕上根本没有这一项 —— 表现为"新文件插到了一个看不见的位置"
  const order = O.readOrder(pfs.projectDir(p));
  const rootOrder = order.dirs[''] || [];
  assertNode.ok(!rootOrder.includes('a.md'),
    `原目录顺序表仍含 a.md：${rootOrder.join(',')}`);
  // a.md 已进「卷纲」。拖动前根目录是 b,a,c；摘掉 a 之后就是 b,c。
  // 这条真正要验的是上面那句「顺序表里不再有 a.md」——
  // 若顺序表留着 a.md，下次新增文件会被排到它后面，
  // 而屏幕上根本没有这一项，用户看到的是"新文件插到了一个看不见的位置"。
  assertNode.deepStrictEqual(onlyMatching(p, '', /^[bc]\.md$/),
    ['b.md', 'c.md'], `实际 ${onlyMatching(p, '', /^[bc]\.md$/).join(',')}`);
});

check('跨目录移动时目标目录已有顺序表，新项插到指定位置', () => {
  const p = fresh();
  pfs.write(p, '卷纲/一.md', '1');
  pfs.write(p, '卷纲/二.md', '2');
  pfs.write(p, '零.md', '0');
  pfs.move(p, '零.md', '卷纲', { anchor: '二.md', place: 'before' });
  // 判据不是"绝对位置"，而是「零 落在 二 之前，且三者相对次序没乱」。
  //
  // ⚠ 为什么这样写：这一层的顺序表本来是空的（一.md/二.md 都没被用户摆过），
  //   所以它们按拼音序呈现：二,一。零 插到「二」之前 → 零,二,一。
  //   早先的断言写成 ['一','零','二']，那是我把"表内项在前"当成了规则，
  //   而实现是「表内项按表排 + 表外项按拼音接在后面」——
  //   第一版两者都不满足（一.md/二.md 压根不在表里）。
  const got = onlyMatching(p, '卷纲', /^[一二零]\.md$/);
  assertNode.ok(got.indexOf('零.md') < got.indexOf('二.md'),
    `零.md 没落到 二.md 之前：${got.join(',')}`);
  assertNode.ok(got.indexOf('二.md') < got.indexOf('一.md'),
    `二.md 与一.md 的相对次序变了：${got.join(',')}`);
});

check('没有 anchor 时移动到目标目录末尾', () => {
  const p = fresh();
  pfs.write(p, '卷纲/一.md', '1');
  pfs.write(p, '零.md', '0');
  pfs.move(p, '零.md', '卷纲');
  const got = onlyMatching(p, '卷纲', /^[一零]\.md$/);
  assertNode.strictEqual(got[got.length - 1], '零.md', `实际 ${got.join(',')}`);
});

check('★ 重命名不改变顺序（rename 与 move 语义分离）', () => {
  const p = fresh();
  pfs.write(p, 'a.md', 'a');
  pfs.write(p, 'b.md', 'b');
  pfs.move(p, 'a.md', '', { anchor: 'b.md', place: 'after' });
  pfs.rename(p, 'a.md', 'c.md');
  const files = onlyMatching(p, '', /^[bc]\.md$/);
  // 重命名后顺序表里还写着 a.md，于是 c.md 属于"表里没有的"，
  // 会接在末尾 —— 正好是用户预期的（它原来在最后）
  assertNode.deepStrictEqual(files, ['b.md', 'c.md'], `实际 ${files.join(',')}`);
});

// ===========================================================
section('四、与顺序表的协作');
// ===========================================================

check('顺序表损坏时 move 仍能工作（不依赖它）', () => {
  const p = fresh();
  pfs.write(p, '甲.md', 'x');
  fs.writeFileSync(path.join(pfs.projectDir(p), O.ORDER_FILE), '坏数据', 'utf8');
  const r = pfs.move(p, '甲.md', '卷纲');
  assertNode.strictEqual(r.moved, true);
  assertNode.ok(fs.existsSync(pfs.resolveIn(p, '卷纲/甲.md')));
});

check('move 之后顺序文件是合法 JSON', () => {
  const p = fresh();
  pfs.write(p, '甲.md', 'x');
  pfs.write(p, '乙.md', 'y');
  pfs.move(p, '甲.md', '', { anchor: '乙.md', place: 'before' });
  const raw = fs.readFileSync(path.join(pfs.projectDir(p), O.ORDER_FILE), 'utf8');
  const o = JSON.parse(raw);
  assertNode.strictEqual(o.v, O.ORDER_VERSION);
  assertNode.ok(Array.isArray(o.dirs['']), `根目录顺序不是数组：${JSON.stringify(o.dirs)}`);
});

check('顺序表不出现在文件树里（点开头被过滤）', () => {
  const p = fresh();
  pfs.write(p, '甲.md', 'x');
  pfs.move(p, '甲.md', '', { anchor: '世界观.md', place: 'before' });
  const all = namesOf(p);
  assertNode.ok(!all.includes(O.ORDER_FILE), `顺序文件出现在树里：${all.join(',')}`);
  assertNode.ok(!all.some((x) => x.includes('.tmp-')), '有临时文件残留');
});

check('回收站目录也不出现在树里', () => {
  const p = fresh();
  const { Trash } = require(path.join(ROOT, 'app', 'electron', 'trash.js'));
  const tr = new Trash(pfs);
  pfs.write(p, '误删.md', 'x');
  tr.add(p, '误删.md');
  const all = namesOf(p);
  assertNode.ok(!all.includes('.trash'), `.trash 出现在树里：${all.join(',')}`);
});

// ===========================================================
console.log('\n' + (failures.length ? '✗' : '✓') +
  ` ${passed} 通过${failures.length ? `，${failures.length} 失败` : ''}`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.message}`);
  process.exit(1);
}
process.exit(0);
