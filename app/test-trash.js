/**
 * 回收站验收测试。
 *
 * 重点不是"能删能还原"，而是**不可逆操作的边界**：
 *   - 还原时原路径被占，绝不能静默覆盖
 *   - 回收站自己不能放进自己（递归套娃）
 *   - 索引坏了不能把用户锁在门外
 *   - 跨目录还原的 toPath 同样要过越界检查
 *
 * 这些错一旦发生就是丢稿，且**丢完不报错**。
 *
 * 运行：node app/test-trash.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectFs } = require('./electron/project-fs.js');
const { Trash, TRASH_DIR, ITEMS_DIR } = require('./electron/trash.js');

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
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }
function assertThrows(fn, mustMatch, msg) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error(msg || '应当抛异常，实际没抛');
  if (mustMatch && !threw.message.includes(mustMatch)) {
    throw new Error(`${msg || '异常信息不对'}：期望含「${mustMatch}」，实际「${threw.message}」`);
  }
  return threw;
}
function section(t) { console.log(`\n${t}`); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-trash-'));
const pfs = new ProjectFs(path.join(ROOT, 'projects'));
const PID = 'p1';
pfs.ensureProject(PID);
const trash = new Trash(pfs);

const P = (rel) => path.join(pfs.projectDir(PID), rel);

// ===========================================================
section('一、放入回收站');

check('删文件后文件树里没有了', () => {
  pfs.write(PID, '甲.md', '# 甲');
  trash.add(PID, '甲.md');
  assert(!fs.existsSync(P('甲.md')), '原文件还在');
  assert(trash.list(PID).length === 1, '回收站里应有 1 项');
});

check('内容进了 items/ 目录', () => {
  const items = P(path.join(TRASH_DIR, ITEMS_DIR));
  const dirs = fs.readdirSync(items);
  assertEq(dirs.length, 1, 'items 下应有 1 个条目');
  const f = path.join(items, dirs[0], '甲.md');
  assert(fs.existsSync(f), '文件本体不在');
  assertEq(fs.readFileSync(f, 'utf8'), '# 甲', '内容不一致');
});

check('索引记下了原路径与类型', () => {
  const [it] = trash.list(PID);
  assertEq(it.origPath, '甲.md', '原路径');
  assertEq(it.type, 'file');
  assertEq(it.name, '甲.md');
  assert(it.deletedAt, '缺删除时间');
});

check('删文件夹是整体搬走', () => {
  pfs.write(PID, '卷纲/第一卷.md', '一');
  pfs.write(PID, '卷纲/第二卷.md', '二');
  const e = trash.add(PID, '卷纲');
  assertEq(e.type, 'dir');
  assert(!fs.existsSync(P('卷纲')), '目录还在');
  assertEq(trash.list(PID).length, 2);
});

check('★ 同名文件在不同目录，删两条都进回收站（平铺会撞名）', () => {
  pfs.write(PID, 'a/设定.md', '甲目录的');
  pfs.write(PID, 'b/设定.md', '乙目录的');
  trash.add(PID, 'a/设定.md');
  trash.add(PID, 'b/设定.md');
  const list = trash.list(PID);
  const mine = list.filter((x) => x.name === '设定.md');
  assertEq(mine.length, 2, `回收站里应有 2 个「设定.md」，实际 ${mine.length}`);
  // 原路径必须各自记住
  const paths = mine.map((x) => x.origPath).sort();
  assertEq(JSON.stringify(paths), JSON.stringify(['a/设定.md', 'b/设定.md']));
  // 内容不能串
  const bodies = mine.map((x) => fs.readFileSync(P(path.join(TRASH_DIR, ITEMS_DIR, x.id, '设定.md')), 'utf8')).sort();
  assertEq(JSON.stringify(bodies), JSON.stringify(['乙目录的', '甲目录的']));
});

check('★ 回收站自己不能放进自己', () => {
  assertThrows(() => trash.add(PID, TRASH_DIR), '不能放进');
  assertThrows(() => trash.add(PID, `${TRASH_DIR}/index.json`), '不能放进');
});

check('删不存在的文件报错', () => {
  assertThrows(() => trash.add(PID, '从来没有.md'), '不存在');
});

// ===========================================================
section('二、还原');

check('还原回原路径', () => {
  const before = trash.list(PID).length;
  // 先删一个干净的
  pfs.write(PID, '要还原.md', '内容');
  const e = trash.add(PID, '要还原.md');
  const r = trash.restore(PID, e.id);
  assertEq(r.restoredTo, '要还原.md');
  assert(fs.existsSync(P('要还原.md')), '文件没回来');
  assertEq(fs.readFileSync(P('要还原.md'), 'utf8'), '内容');
  assertEq(trash.list(PID).length, before, '回收站条目数没减少');
});

check('还原文件夹会连同子内容一起回来', () => {
  pfs.write(PID, '章纲/甲.md', 'x');
  pfs.write(PID, '章纲/乙.md', 'y');
  const e = trash.add(PID, '章纲');
  trash.restore(PID, e.id);
  assert(fs.existsSync(P('章纲/甲.md')), '子文件没回来');
  assert(fs.existsSync(P('章纲/乙.md')), '子文件没回来');
});

check('★ 原路径被占时拒绝还原，且不覆盖', () => {
  pfs.write(PID, '占位.md', '原来的重要内容');
  pfs.write(PID, '临时.md', '新内容');
  const e = trash.add(PID, '临时.md');
  // 现在占位.md 和 临时.md 都在，制造"原路径被占"
  pfs.write(PID, '临时.md', '有人在原位置放了新东西');
  assertThrows(() => trash.restore(PID, e.id), '已有同名');
  assertEq(fs.readFileSync(P('临时.md'), 'utf8'), '有人在原位置放了新东西',
    '★ 原位置的文件被覆盖了');
  // 且条目还在回收站，可以换个地方还原
  assert(trash.list(PID).some((x) => x.id === e.id), '条目应仍留在回收站');
});

check('可以改路径还原', () => {
  const list = trash.list(PID);
  const e = list.find((x) => x.name === '临时.md');
  const r = trash.restore(PID, e.id, { toPath: '归档/临时.md' });
  assert(fs.existsSync(P('归档/临时.md')), '没还原到指定位置');
  assertEq(r.restoredTo, '归档/临时.md');
});

check('★ 跨目录还原的 toPath 也要过越界检查', () => {
  pfs.write(PID, '越界.md', 'x');
  const e = trash.add(PID, '越界.md');
  assertThrows(() => trash.restore(PID, e.id, { toPath: '../../evil.md' }), '路径越界');
  assertThrows(() => trash.restore(PID, e.id, { toPath: 'C:/Windows/x.md' }), '不允许绝对路径');
  // 条目必须还在
  assert(trash.list(PID).some((x) => x.id === e.id), '越界尝试不该丢掉条目');
});

check('还原不存在的 id 报错', () => {
  assertThrows(() => trash.restore(PID, '不存在的id'), '没有这一项');
});

check('★ 手工删掉 items/ 内容后再还原 → 明确报错而不是崩溃', () => {
  pfs.write(PID, '会消失.md', 'x');
  const e = trash.add(PID, '会消失.md');
  fs.rmSync(P(path.join(TRASH_DIR, ITEMS_DIR, e.id)), { recursive: true, force: true });
  assertThrows(() => trash.restore(PID, e.id), '内容已被删除');
});

// ===========================================================
section('三、粉碎与清空');

check('粉碎一个条目', () => {
  pfs.write(PID, '碎1.md', 'x');
  const e = trash.add(PID, '碎1.md');
  const r = trash.purge(PID, e.id);
  assertEq(r.purged, 1);
  assert(!trash.list(PID).some((x) => x.id === e.id), '条目还在');
  assert(!fs.existsSync(P(path.join(TRASH_DIR, ITEMS_DIR, e.id))), '本体还在');
});

check('粉碎文件夹连带子内容一起没了', () => {
  pfs.write(PID, '碎夹/a.md', 'x');
  pfs.write(PID, '碎夹/b/c.md', 'y');
  const e = trash.add(PID, '碎夹');
  trash.purge(PID, e.id);
  assert(!fs.existsSync(P(path.join(TRASH_DIR, ITEMS_DIR, e.id))), '本体还在');
});

check('粉碎不存在的 id 返回 0 而不是报错（幂等）', () => {
  const r = trash.purge(PID, '根本没有');
  assertEq(r.purged, 0);
});

check('清空回收站', () => {
  const before = trash.list(PID).length;
  assert(before > 0, '应有内容可清');
  const r = trash.empty(PID);
  assertEq(r.purged, before);
  assertEq(trash.list(PID).length, 0);
  assertEq(trash.stats(PID).count, 0);
});

check('清空后项目文件夹里没有残留', () => {
  const items = P(path.join(TRASH_DIR, ITEMS_DIR));
  assert(!fs.existsSync(items) || fs.readdirSync(items).length === 0,
    'items 目录没清干净');
});

// ===========================================================
section('四、健壮性');

check('索引 JSON 损坏时不把用户锁在门外', () => {
  pfs.write(PID, '待删.md', 'x');
  trash.add(PID, '待删.md');
  // 模拟索引被写坏
  fs.writeFileSync(P(path.join(TRASH_DIR, 'index.json')), '{ 这不是合法 JSON', 'utf8');
  const list = trash.list(PID);
  assert(Array.isArray(list), '应当返回数组而不是抛错');
  assertEq(list.length, 0, '损坏时当作空的');
  // 还能继续用
  pfs.write(PID, '坏后.md', 'y');
  trash.add(PID, '坏后.md');
  assertEq(trash.list(PID).length, 1, '损坏后应能继续投放');
});

check('索引是数组以外的类型时当作空', () => {
  fs.writeFileSync(P(path.join(TRASH_DIR, 'index.json')), '"我是字符串"', 'utf8');
  assertEq(trash.list(PID).length, 0);
});

check('★ items/ 被手工清空后，列表自动过滤（不留幽灵条目）', () => {
  pfs.write(PID, '幽灵.md', 'x');
  const e = trash.add(PID, '幽灵.md');
  // 直接在文件管理器里删了 items 下的内容
  fs.rmSync(P(path.join(TRASH_DIR, ITEMS_DIR, e.id)), { recursive: true, force: true });
  const list = trash.list(PID);
  assert(!list.some((x) => x.id === e.id), '幽灵条目应被过滤掉');
});

check('索引里的脏条目（缺字段）被过滤', () => {
  const idxPath = P(path.join(TRASH_DIR, 'index.json'));
  const itemsPath = P(path.join(TRASH_DIR, ITEMS_DIR));
  fs.mkdirSync(itemsPath, { recursive: true });
  fs.mkdirSync(path.join(itemsPath, 'fake-id'), { recursive: true });
  fs.writeFileSync(idxPath, JSON.stringify([
    { id: 'fake-id' },              // 缺 origPath
    { origPath: 'x.md' },          // 缺 id
    null,                          // 空项
    '字符串',
  ]), 'utf8');
  assertEq(trash.list(PID).length, 0, '脏条目应全被过滤');
});

check('没建过回收站时 list 返回空而不是建目录', () => {
  const fresh = new ProjectFs(path.join(ROOT, 'projects2'));
  fresh.ensureProject('fresh');
  const t2 = new Trash(fresh);
  assertEq(t2.list('fresh').length, 0);
  assert(!fs.existsSync(path.join(fresh.projectDir('fresh'), TRASH_DIR)),
    'list 不该有副作用地创建目录');
});

check('回收站不出现在文件树的普通条目里', () => {
  // project-fs 的 tree 会跳过 . 开头的文件/目录，
  // 而 .trash 以点开头 —— 这就是选这个名字的原因之一
  const tree = pfs.tree(PID);
  assert(!tree.children.some((c) => c.name === TRASH_DIR), '.trash 出现在文件树里了');
});

check('统计正确', () => {
  trash.empty(PID);
  pfs.write(PID, 'a.md', '12345');
  trash.add(PID, 'a.md');
  pfs.write(PID, 'b.md', '123');
  trash.add(PID, 'b.md');
  const s = trash.stats(PID);
  assertEq(s.count, 2);
  assertEq(s.bytes, 8, '字节数应为 5+3');
});

// ---------------------------------------------------------------
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${'-'.repeat(52)}`);
console.log(`回收站：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);