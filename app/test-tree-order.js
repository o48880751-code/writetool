const assertNode = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 拖拽排序的底层测试。
 *
 * 这一层最容易出的错是**静默的**：顺序错了界面只是"不好看"，
 * 而覆盖文件、目录成环是**不可逆的数据损失**。
 * 所以两类都要钉死，且要验证它真的能失败。
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

function section(t) {
  console.log('\n' + t);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-order-'));
const pfs = new ProjectFs(path.join(TMP, 'projects'));
const PID = 'p1';
pfs.ensureProject(PID);
const DIR = pfs.projectDir(PID);

process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ===========================================================
section('一、顺序文件读写');
// ===========================================================

check('项目刚建好时没有顺序文件（走默认排序）', () => {
  assertNode.strictEqual(fs.existsSync(path.join(DIR, O.ORDER_FILE)), false);
  assertNode.deepStrictEqual(O.readOrder(DIR).dirs, {});
});

check('写入后能读回', () => {
  const r = O.writeOrder(DIR, { dirs: { '': ['b.md', 'a.md'], '卷纲': ['x.md'] } });
  assertNode.strictEqual(r.ok, true, r.error);
  const back = O.readOrder(DIR);
  assertNode.deepStrictEqual(back.dirs[''], ['b.md', 'a.md']);
  assertNode.deepStrictEqual(back.dirs['卷纲'], ['x.md']);
});

check('★ 顺序文件损坏时退回空表，且不留异常', () => {
  const f = path.join(DIR, O.ORDER_FILE);
  fs.writeFileSync(f, '{ 这不是 JSON', 'utf8');
  const back = O.readOrder(DIR);
  assertNode.deepStrictEqual(back.dirs, {}, `实际 ${JSON.stringify(back.dirs)}`);
  // 现场被备份了，用户能看出是自己改坏的
  const bak = fs.readdirSync(DIR).filter((n) => n.startsWith('.order.json.bad-'));
  assertNode.ok(bak.length > 0, '损坏的顺序文件没有被备份');
  O.writeOrder(DIR, { dirs: {} });
});

check('顺序文件是合法 JSON 数组的字段被拒（不崩）', () => {
  const f = path.join(DIR, O.ORDER_FILE);
  fs.writeFileSync(f, JSON.stringify({ v: 1, dirs: { '': '这不是数组' } }), 'utf8');
  const back = O.readOrder(DIR);
  assertNode.strictEqual(back.dirs[''], undefined, '非数组的值不该被接受');
  O.writeOrder(DIR, { dirs: {} });
});

check('超大顺序文件直接忽略（不解析）', () => {
  const f = path.join(DIR, O.ORDER_FILE);
  fs.writeFileSync(f, JSON.stringify({ v: 1, dirs: { '': ['x'.repeat(700 * 1024)] } }), 'utf8');
  const back = O.readOrder(DIR);
  assertNode.deepStrictEqual(back.dirs, {}, '超大的文件应被当空的');
  O.writeOrder(DIR, { dirs: {} });
});

check('写顺序表是原子的（不留 .tmp 残留）', () => {
  O.writeOrder(DIR, { dirs: { '': ['a.md'] } });
  const leftovers = fs.readdirSync(DIR).filter((n) => n.includes('.tmp-'));
  assertNode.strictEqual(leftovers.length, 0, `残留：${leftovers.join(',')}`);
});

// ===========================================================
section('二、套用顺序');
// ===========================================================

check('按顺序表排列这一层', () => {
  const nodes = [{ name: 'a.md' }, { name: 'b.md' }, { name: 'c.md' }];
  const out = O.applyOrder(nodes, ['c.md', 'a.md', 'b.md']);
  assertNode.deepStrictEqual(out.map((n) => n.name), ['c.md', 'a.md', 'b.md']);
});

check('★ 表里没有的项接在后面，且保持原有相对次序', () => {
  const nodes = [{ name: '新1.md' }, { name: 'a.md' }, { name: '新2.md' }];
  const out = O.applyOrder(nodes, ['a.md']);
  assertNode.deepStrictEqual(out.map((n) => n.name), ['a.md', '新1.md', '新2.md'],
    `实际 ${out.map((n) => n.name).join(',')}`);
});

check('★ 顺序表让文件排在目录前面（拖拽的前提）', () => {
  // 旧版 tree() 强制「目录永远在前」，那与拖拽排序直接冲突——
  // 用户把文件拖到目录上面，刷新后又被弹回去。
  const nodes = [{ name: '卷纲', type: 'dir' }, { name: '灵感.md', type: 'file' }];
  const out = O.applyOrder(nodes, ['灵感.md', '卷纲']);
  assertNode.deepStrictEqual(out.map((n) => n.name), ['灵感.md', '卷纲']);
});

check('表里已删除的项被忽略（不产生空位）', () => {
  const nodes = [{ name: 'a.md' }, { name: 'b.md' }];
  const out = O.applyOrder(nodes, ['已删.md', 'b.md', 'a.md']);
  assertNode.deepStrictEqual(out.map((n) => n.name), ['b.md', 'a.md']);
});

check('顺序表为空时原样返回', () => {
  const nodes = [{ name: 'a.md' }, { name: 'b.md' }];
  assertNode.deepStrictEqual(O.applyOrder(nodes, []), nodes);
  assertNode.deepStrictEqual(O.applyOrder(nodes, null), nodes);
});

check('applyOrder 不改原数组（纯函数）', () => {
  const nodes = [{ name: 'a.md' }, { name: 'b.md' }];
  O.applyOrder(nodes, ['b.md', 'a.md']);
  assertNode.deepStrictEqual(nodes.map((n) => n.name), ['a.md', 'b.md']);
});

// ===========================================================
section('三、拖拽位置计算（纯函数）');
// ===========================================================

check('插到锚点之前', () => {
  assertNode.deepStrictEqual(
    O.reorderNames(['a', 'b', 'c'], 'c', 'a', 'before'), ['c', 'a', 'b']);
});

check('插到锚点之后', () => {
  assertNode.deepStrictEqual(
    O.reorderNames(['a', 'b', 'c'], 'a', 'c', 'after'), ['b', 'c', 'a']);
});

check('★ 移给自己当锚点是安全的（不重复、不丢项）', () => {
  // 拖拽时锚点可能就是自己——计算要能扛住，不能产出 [a,a,b]
  for (const where of ['before', 'after']) {
    const out = O.reorderNames(['a', 'b', 'c'], 'b', 'b', where);
    assertNode.strictEqual(new Set(out).size, 3, `出现重复：${out.join(',')}`);
    assertNode.deepStrictEqual([...out].sort(), ['a', 'b', 'c'], `丢项：${out.join(',')}`);
  }
});

check('锚点不存在时移到末尾', () => {
  assertNode.deepStrictEqual(
    O.reorderNames(['a', 'b'], 'a', '不存在的', 'before'), ['b', 'a']);
});

check('锚点为 null 表示移到最末', () => {
  assertNode.deepStrictEqual(O.reorderNames(['a', 'b'], 'a', null, 'before'), ['b', 'a']);
});

check('原数组里有重复名时只移走一个', () => {
  const out = O.reorderNames(['a', 'b', 'a'], 'a', 'b', 'after');
  assertNode.strictEqual(out.filter((x) => x === 'a').length, 1, `实际 ${out.join(',')}`);
});

// ===========================================================
section('四、成环判断');
// ===========================================================

check('目录是子目录的祖先 → 判定为环', () => {
  assertNode.strictEqual(O.isAncestorPath('卷纲', '卷纲/子集'), true);
  assertNode.strictEqual(O.isAncestorPath('卷纲', '卷纲'), true);
});

check('同层与旁支不算环', () => {
  assertNode.strictEqual(O.isAncestorPath('卷纲', '章节'), false);
  assertNode.strictEqual(O.isAncestorPath('卷纲', '卷纲2/内'), false,
    '「卷纲2」不是「卷纲」的子目录（前缀相同但不是路径包含）');
});

check('根不是有效目标', () => {
  assertNode.strictEqual(O.isAncestorPath('', '任意'), false);
});

// ===========================================================
section('五、树读取套用顺序（端到端）');
// ===========================================================

/**
 * 只取指定前缀的文件名。
 *
 * ⚠ 为什么要过滤：项目建好时自带 4 个模板文件。
 *   表外项（新文件、模板）按拼音序接在表内项之后，
 *   所以"全量文件顺序"里必然混着它们。断言要比的是
 *   「用户摆过的那几个文件的相对次序」，其余的与本用例无关。
 */
function mine(t, re) {
  return t.children.filter((c) => c.type === 'file' && re.test(c.name)).map((c) => c.name);
}

check('tree() 按顺序表返回，而不是按名字', () => {
  pfs.write(PID, '甲.md', 'a');
  pfs.write(PID, '乙.md', 'b');
  pfs.write(PID, '丙.md', 'c');
  O.recordLayer(DIR, '', ['丙.md', '甲.md', '乙.md']);
  const t = pfs.tree(PID);
  const names = mine(t, /^[甲乙丙]\.md$/);
  assertNode.deepStrictEqual(names, ['丙.md', '甲.md', '乙.md'], `实际 ${names.join(',')}`);
});

check('★ 表外项按拼音序接在表内项之后（不是保持磁盘序）', () => {
  // 这是第一版真实踩过的坑：表外项若保持 readdir 的原始次序，
  // 「拖一个文件」就会把其余文件的相对位置也一起改掉，
  // 用户看到的是"一堆文件都在跳"。这里把判据钉死。
  //
  // ⚠⚠ 2026-10-16 修：原来这里拿**模板文件**（章节摘要.md 等）当"表外项"，
  //   而模板文件现在都待在自己的文件夹里、根目录下一个散文件都没有
  //   → `tpl` 成了空数组 → `firstTpl = -1` → 判据红得毫无意义
  //   （报"表外项没接在表内项之后"，其实根本没有表外项）。
  //   ⚠ 判据的夹具**别依赖模板长什么样**：自己造两个表外项最稳。
  pfs.write(PID, '丁.md', 'd');
  pfs.write(PID, '戊.md', 'e');
  const t = pfs.tree(PID);
  const all = t.children.filter((c) => c.type === 'file').map((c) => c.name);
  const inTable = mine(t, /^[甲乙丙]\.md$/);
  const outTable = mine(t, /^[丁戊]\.md$/);
  const lastInTable = all.map((n) => inTable.includes(n)).lastIndexOf(true);
  const firstOut = all.indexOf(outTable[0]);
  assertNode.ok(lastInTable >= 0, `表内项一个都没有：${all.join(',')}`);
  assertNode.ok(outTable.length === 2, `表外项没进树：${all.join(',')}`);
  assertNode.ok(firstOut > lastInTable,
    `表外项没接在表内项之后：\n    ${all.join(',')}`);
  assertNode.deepStrictEqual(outTable, ['丁.md', '戊.md'],
    `表外项之间没按拼音序：${outTable.join(',')}`);
});

check('★ 目录段不受文件排序影响（分段处理）', () => {
  // 拖文件不该动目录的相对位置。第一版把目录与文件混在一起排，
  // 拖一个文件就把「卷纲,设定,章节」变成了「卷纲,章节,设定」。
  const dirsOf = (t) => t.children.filter((c) => c.type === 'dir').map((c) => c.name);
  const before = dirsOf(pfs.tree(PID));
  pfs.move(PID, '甲.md', '', { anchor: '丙.md', place: 'before' });
  const after = dirsOf(pfs.tree(PID));
  assertNode.deepStrictEqual(after, before,
    `目录顺序被改动了：\n    ${before.join(',')}\n    ${after.join(',')}`);
});

check('顺序表不影响子目录各自的内容', () => {
  const t = pfs.tree(PID);
  // ⚠ 卷纲在 2026-10-13 改成了真空目录（不再放"说明.md"占位），
  //   所以这里改验「设定」——它有 世界观.md 与 人物库.md。
  //   验"空目录的 children 是空数组"由 test-project-fs.js 负责。
  const st = t.children.find((c) => c.name === '设定');
  assertNode.ok(st, '设定目录不见了');
  assertNode.strictEqual(st.children.length, 2,
    `设定下应有两个文件，实际 ${st.children.length}：${st.children.map((c) => c.name).join('、')}`);
});

check('清掉顺序表后回到默认排序（目录在前 + 拼音）', () => {
  fs.rmSync(path.join(DIR, O.ORDER_FILE));
  const t = pfs.tree(PID);
  const kinds = t.children.map((c) => c.type);
  const lastDir = kinds.lastIndexOf('dir');
  const firstFile = kinds.indexOf('file');
  assertNode.ok(firstFile < 0 || lastDir < firstFile,
    `无顺序表时目录必须在文件前面：${kinds.join(',')}`);
  const names = mine(t, /^[甲乙丙]\.md$/);
  assertNode.deepStrictEqual(names, ['丙.md', '甲.md', '乙.md'],
    `默认按名字排应是丙/甲/乙（拼音序），实际 ${names.join(',')}`);
});

check('顺序表在新建文件后仍生效（新文件接在末尾）', () => {
  O.recordLayer(DIR, '', ['乙.md', '甲.md']);
  pfs.write(PID, '丁.md', 'd');
  const t = pfs.tree(PID);
  const names = mine(t, /^[甲乙丙丁]\.md$/);
  assertNode.deepStrictEqual(names, ['乙.md', '甲.md', '丙.md', '丁.md'],
    `实际 ${names.join(',')}`);
  fs.rmSync(path.join(DIR, O.ORDER_FILE));
});

// ===========================================================
section('六、recordLayer 只写一层');
// ===========================================================

check('其他目录的顺序不受影响', () => {
  O.recordLayer(DIR, '卷纲', ['说明.md']);
  O.recordLayer(DIR, '', ['甲.md']);
  const order = O.readOrder(DIR);
  assertNode.deepStrictEqual(order.dirs['卷纲'], ['说明.md'], '卷纲的顺序被覆盖了');
  assertNode.deepStrictEqual(order.dirs[''], ['甲.md']);
  fs.rmSync(path.join(DIR, O.ORDER_FILE));
});

check('路径分隔符统一（反斜杠归一）', () => {
  assertNode.strictEqual(O.normDir('卷纲\\子集'), '卷纲/子集');
  assertNode.strictEqual(O.normDir('/卷纲/'), '卷纲');
  assertNode.strictEqual(O.normDir(''), '');
});

// ===========================================================
console.log('\n' + (failures.length ? '✗' : '✓') +
  ` ${passed} 通过${failures.length ? `，${failures.length} 失败` : ''}`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.message}`);
  process.exit(1);
}
process.exit(0);
