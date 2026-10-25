/**
 * 库结构版本与升级的判据（2026-10-20）。
 *
 * ## 为什么必须单独测这个
 *
 * 这个软件的升级方式是"下载安装包覆盖安装"，用户的库**原地不动**。
 * 而 1.0 → 1.2.2 之间表结构改过（加过列、加过表），
 * 之前从没有一条判据验证过"老库升上来还能不能用"。
 *
 * 更糟的是：原来**没有版本号**。所以出问题时连"这个库是第几版"都不知道，
 * 只能靠"试着补列"反推。
 *
 * ## 这份判据要证明的四件事
 *
 * 1. 全新库建完之后，版本号写进去了
 * 2. **老库（缺列 + 有数据 + 版本号 0）升级后：列回来了、数据没丢**
 * 3. 重复打开是幂等的（不会反复迁移、不会重复加列）
 * 4. **库比代码新时明确拒绝**，而不是静默写入
 *
 * ⚠ 必须用真文件：`:memory:` 测不出"文件已存在但结构是旧的"这个前提。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// ⚠ store.js 依赖 skill-format.js，先把它交给 store（否则会抛"找不到解析器"）
const storeMod = require('./../db/store.js');
storeMod.setSkillFormat(require('./electron/skill-format.js'));
const { Store, SCHEMA_VERSION } = storeMod;

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mig-'));
let seq = 0;
const newPath = () => path.join(tmpRoot, `db${++seq}.sqlite`);

/** 读出库文件头里的版本号（不经 Store，避免"用被测代码验证被测代码"） */
function readVersion(file) {
  const db = new DatabaseSync(file);
  try {
    const r = db.prepare('PRAGMA user_version').get();
    return Number(r.user_version ?? r['user_version']) || 0;
  } finally { db.close(); }
}

function cols(file, table) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  } finally { db.close(); }
}

console.log('\n=== A. 全新库 ===');

check('新库建完，版本号 = SCHEMA_VERSION', () => {
  const f = newPath();
  const s = new Store(f);
  try {
    assert.strictEqual(readVersion(f), SCHEMA_VERSION,
      `新库的 user_version 应当是 ${SCHEMA_VERSION}`);
  } finally { s.db.close(); }
});

check('新库该有的表都在（14 张）', () => {
  const f = newPath();
  const s = new Store(f);
  try {
    const db = new DatabaseSync(f);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map((r) => r.name);
    db.close();
    for (const t of ['projects', 'chapters', 'conversations', 'messages', 'connections', 'skills', 'skill_files']) {
      assert.ok(names.includes(t), `缺表 ${t}，实际：${names.join(',')}`);
    }
  } finally { s.db.close(); }
});

console.log('\n=== B. ⚠⚠ 老库升级（这是这次改动的全部意义）===');

/**
 * 造一个"1.0 形态"的库：
 *   ① 用当前 schema 建出完整结构
 *   ② 把后来才加的 think_level 列**删掉**（模拟那时候还没有这一列）
 *   ③ 写入一条真实数据
 *   ④ 版本号置 0（模拟老库：它压根没有版本概念）
 */
function makeLegacyDb() {
  const f = newPath();
  // 先用正式 Store 建出完整结构
  const seed = new Store(f);
  seed.db.close();

  const db = new DatabaseSync(f);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('ALTER TABLE conversations DROP COLUMN think_level;');
  db.prepare(
    'INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)'
  ).run('conv-legacy', 'proj-legacy', '升级前就存在的对话', 1700000000000, 1700000001000);
  db.exec('PRAGMA user_version = 0;');
  db.close();
  return f;
}

check('★★ 老库缺列时能补回来，且版本号被写进去', () => {
  const f = makeLegacyDb();
  // 前提自证：造出来的确实是"缺列 + 版本 0"的老库
  assert.ok(!cols(f, 'conversations').includes('think_level'), '前提失败：老库不该有 think_level');
  assert.strictEqual(readVersion(f), 0, '前提失败：老库版本号应当是 0');

  const s = new Store(f);
  try {
    assert.ok(cols(f, 'conversations').includes('think_level'), '升级后 think_level 没补上');
    assert.strictEqual(readVersion(f), SCHEMA_VERSION, '升级后版本号没更新');
  } finally { s.db.close(); }
});

check('★★ 升级不丢数据（老对话还在，内容对得上）', () => {
  const f = makeLegacyDb();
  const s = new Store(f);
  try {
    const rows = s.db.prepare('SELECT id, title FROM conversations').all();
    assert.strictEqual(rows.length, 1, `应当只有 1 条老对话，实际 ${rows.length} 条`);
    assert.strictEqual(rows[0].id, 'conv-legacy');
    assert.strictEqual(rows[0].title, '升级前就存在的对话');
  } finally { s.db.close(); }
});

check('★ 补上的列有默认值（不是 null，否则查询会炸）', () => {
  const f = makeLegacyDb();
  const s = new Store(f);
  try {
    const row = s.db.prepare("SELECT think_level FROM conversations WHERE id='conv-legacy'").get();
    assert.strictEqual(row.think_level, '',
      `新列应当取 DEFAULT ''，实际：${JSON.stringify(row.think_level)}`);
  } finally { s.db.close(); }
});

check('★ 升级后能正常按新列查询（真正可用，不是"列在了但一查就崩"）', () => {
  const f = makeLegacyDb();
  const s = new Store(f);
  try {
    const n = s.db.prepare("SELECT COUNT(*) AS c FROM conversations WHERE think_level = ''").get();
    assert.strictEqual(n.c, 1, '按新列过滤查不到老数据 —— 说明默认值不对');
  } finally { s.db.close(); }
});

console.log('\n=== C. 幂等 ===');

check('★ 连开三次不会重复迁移、不会报错', () => {
  const f = makeLegacyDb();
  for (let i = 0; i < 3; i++) {
    const s = new Store(f);
    try {
      assert.strictEqual(readVersion(f), SCHEMA_VERSION, `第 ${i + 1} 次打开后版本号不对`);
    } finally { s.db.close(); }
  }
  const s = new Store(f);
  try {
    const rows = s.db.prepare('SELECT COUNT(*) AS c FROM conversations').get();
    assert.strictEqual(rows.c, 1, '重复打开把数据弄多了或弄少了');
  } finally { s.db.close(); }
});

console.log('\n=== D. ⚠ 库比代码新时拒绝 ===');

check('★★ 库版本高于程序支持时抛错（不是静默写入）', () => {
  const f = newPath();
  const seed = new Store(f);
  seed.db.close();

  const db = new DatabaseSync(f);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5};`);
  db.close();

  assert.throws(() => {
    const s = new Store(f);
    s.db.close();
  }, /更新的版本|装回新版/, '没有给出可行动的提示');
});

check('★ 拒绝时不动数据（版本号也没被改回去）', () => {
  const f = newPath();
  const seed = new Store(f);
  seed.db.close();
  const db = new DatabaseSync(f);
  // ⚠ 这条测试只关心"拒绝时库有没有被动过"，不关心外键完整性，
  //   所以关掉外键再插（conversations.project_id 外键指向 projects）。
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5};`);
  db.prepare('INSERT INTO conversations (id, project_id, title) VALUES (?,?,?)')
    .run('c1', 'p1', '别动我');
  db.close();

  try { const s = new Store(f); s.db.close(); } catch (_) { /* 预期抛错 */ }

  assert.strictEqual(readVersion(f), SCHEMA_VERSION + 5, '拒绝时不该改写版本号');
  const check2 = new DatabaseSync(f);
  const n = check2.prepare('SELECT COUNT(*) AS c FROM conversations').get();
  check2.close();
  assert.strictEqual(n.c, 1, '拒绝时不该动数据');
});

console.log('\n=== E. 版本常量本身 ===');

/**
 * 造一个 "1.2.4 形态" 的库（user_version = 1，messages 还没有 reasoning_content）。
 *
 * ⚠ 这一列是 2026-10-21 为修 DeepSeek 的 400 加的：
 *   "The reasoning_content in the thinking mode must be passed back to the API."
 *   老库的表是 CREATE TABLE IF NOT EXISTS 建出来的 → 新列不会自动出现，
 *   必须靠迁移补。不补的话，用户升上来第一次生成就撞 no such column。
 */
function makeV1Db() {
  const f = newPath();
  const seed = new Store(f);
  seed.db.close();

  const db = new DatabaseSync(f);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('ALTER TABLE messages DROP COLUMN reasoning_content;');
  db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?,?,?,?)')
    .run('msg-old', 'conv-x', 'assistant', '升级前就有的回答');
  db.exec('PRAGMA user_version = 1;');
  db.close();
  return f;
}

check('★★ v1 老库升级后 messages 有 reasoning_content 列', () => {
  const f = makeV1Db();
  assert.ok(!cols(f, 'messages').includes('reasoning_content'),
    '前提失败：造出来的 v1 库不该有这一列');

  const s = new Store(f);
  try {
    assert.ok(cols(f, 'messages').includes('reasoning_content'),
      '升级后没补上 reasoning_content —— 用户下一轮对话会 400');
    assert.strictEqual(readVersion(f), SCHEMA_VERSION, '版本号没更新到 2');
  } finally { s.db.close(); }
});

check('★ 升级不丢旧消息', () => {
  const f = makeV1Db();
  const s = new Store(f);
  try {
    const rows = s.listMessages('conv-x');
    assert.strictEqual(rows.length, 1, `应当只有 1 条旧消息，实际 ${rows.length}`);
    assert.strictEqual(rows[0].content, '升级前就有的回答');
    assert.strictEqual(rows[0].reasoning_content, null, '旧消息的思考列应当是 NULL');
  } finally { s.db.close(); }
});

check('★★ 能存能取 reasoning_content（400 修复的核心）', () => {
  const f = makeV1Db();
  const s = new Store(f);
  try {
    /**
     * ⚠ 关掉外键：这条判据只关心 reasoning_content 的存取，
     *   不想为了满足 messages → conversations 的外键去建一整套项目/对话。
     */
    s.db.exec('PRAGMA foreign_keys = OFF;');
    s.addMessage({
      conversationId: 'conv-x', role: 'assistant', content: '正文（带思考）',
      reasoningContent: '用户想让我写第一章，先看看设定库里有什么。',
    });
    const rows = s.listMessages('conv-x');
    const hit = rows.find((m) => m.content === '正文（带思考）');
    assert.ok(hit, '写进去的消息读不出来');
    assert.strictEqual(hit.reasoning_content, '用户想让我写第一章，先看看设定库里有什么。',
      'listMessages 没返回 reasoning_content —— 历史构造时就拿不到，400 依然存在');
  } finally { s.db.close(); }
});


check('SCHEMA_VERSION 是正整数且已导出', () => {
  assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1,
    `SCHEMA_VERSION 应当是正整数，实际 ${SCHEMA_VERSION}`);
});

check('⚠⚠ main.js 里 new Store 包在 try 里（否则抛错就是白屏）', () => {
  /**
   * 版本守卫会抛错 —— 而抛错的那一行原来在 `whenReady().then()` 里裸着。
   * 没人接的后果不是"报个错"，是**窗口永远不创建、用户什么都看不到**，
   * 而且每次重启都会再抛一次。
   */
  const src = fs.readFileSync(path.join(__dirname, 'electron/main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const i = src.indexOf('new Store(');
  assert.ok(i > 0, '前提不成立：main.js 里找不到 new Store(');
  const before = src.slice(Math.max(0, i - 400), i);
  assert.ok(/try\s*\{[^}]*$/.test(before),
    'new Store() 不在 try 块里 —— 数据库打不开时窗口不会创建，用户看到的是"软件没反应"');
});

// 清理
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* 临时目录 */ }

const total = passed + failures.length;
console.log(`\n${'='.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length}/${total} 条失败：`);
  for (const { name, e } of failures) console.log(`  · ${name}\n    ${e.message}`);
  process.exitCode = 1;
} else {
  console.log(`✓ 全部 ${total} 条通过`);
}
process.exit(failures.length ? 1 : 0);
