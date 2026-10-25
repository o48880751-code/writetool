/**
 * 数据层：SQLite 封装。
 *
 * 职责边界（刻意收窄）：
 *   - 只管 schema 建表、设定库读写、伏笔读写、章节读写、状态表读写；
 *   - **不做检索排序**——排序与 top_k 截断的语义由 run-verify.js 的 scoreEntry 定义，
 *     本模块只负责把「某项目的全部 active 设定 + 别名」取出来交给它，保证单一真相源。
 *   - 不做 Agent 编排、不调模型。
 *
 * 依赖：Node 22.22 内置 node:sqlite（实验特性，无第三方包）
 * 运行：node db/test-db.js
 */

const fs = require('fs');
const path = require('path');

let DatabaseSync = null;
let sqliteReady = false;
try {
  ({ DatabaseSync } = require('node:sqlite'));
  sqliteReady = true;
} catch (e) {
  sqliteReady = false;
  const hint =
    '未找到 node:sqlite。本模块需要 Node >= 22.5（内置 SQLite）。\n' +
    '当前版本：' + process.version + '\n' +
    '解决：升级 Node，或改用 better-sqlite3（需 npm install，本项目坚持零依赖）。';
  throw new Error(hint + '\n原始错误：' + e.message);
}

/**
 * SKILL.md 的 frontmatter 解析。
 *
 * ⚠ 路径不能写死。打包后布局变了：
 *     开发态  db/store.js  →  ../app/electron/skill-format.js   ✓
 *     打包态  resources/modules/db/store.js
 *             → ../app/electron/...  那是 resources/modules/app/  ✗ 不存在
 *   实际位置是 app.asar/electron/skill-format.js，
 *   相对于 db 要跨 app.asar 整个包，没有一个相对路径能同时对上。
 *
 * 所以**不要在这里 require**。用 skillFmt() 延迟取，
 * 由 main.js 在启动时把已经加载好的模块传进来（setSkillFormat）。
 *
 * 找不到时的行为是抛错而不是静默返回 null ——
 * 静默的话 seed 会跳过所有目录式技能，
 * 用户看到的只是「技能不见了」，猜不到是打包漏了文件。
 */
let skillFormat = null;
function setSkillFormat(mod) {
  if (mod && typeof mod.parse === 'function') skillFormat = mod;
}
/** 取 skill-format。没注入就现场按两种布局找一次。 */
function skillFmt() {
  if (skillFormat) return skillFormat;
  const cands = [
    path.join(__dirname, '..', 'app', 'electron', 'skill-format.js'),
    path.join(__dirname, '..', 'app.asar', 'electron', 'skill-format.js'),
    path.join(__dirname, 'skill-format.js'),
  ];
  for (const c of cands) {
    try {
      const m = require(c);
      if (m && typeof m.parse === 'function') { skillFormat = m; return m; }
    } catch (_) { /* 试下一个 */ }
  }
  throw new Error(
    '找不到 skill-format.js（SKILL.md 解析器）。'
    + '尝试过：' + cands.join(' | ')
    + '。通常是打包时漏了文件。'
  );
}

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * 当前库结构版本（2026-10-20 加）。
 *
 * ⚠⚠ 在这之前**根本没有版本号**：`schema.sql` 全是 `CREATE TABLE IF NOT EXISTS`，
 * 老库升级靠 `_addMissingColumns` 一列一列地补。那套能 work，但答不了三个问题：
 *
 *   ① 这个库是第几版？—— 不知道，只能靠"试着补列"反推
 *   ② 改列类型 / 删列 / 搬迁数据 —— 补列机制根本做不到
 *   ③ 用户拿**旧版**打开**新版**的库会怎样？—— 静默写入，丢掉新字段
 *
 * 现在用 SQLite 自带的 `PRAGMA user_version` 记版本：它存在库文件头里，
 * 不占表、不需要额外的迁移记录表，读一个整数就知道该不该升。
 *
 * ⚠⚠ 规则：**改表结构就 +1，并在 `migrate()` 里加一步**。
 *   只改 schema.sql 是不够的 —— `IF NOT EXISTS` 会把整条建表语句跳过，
 *   老用户拿到的还是旧结构（这正是 `_addMissingColumns` 当初存在的理由）。
 */
const SCHEMA_VERSION = 2;

/**
 * Skill 配套文件的路径校验与归一化。
 *
 * ## 为什么这是硬约束
 *
 * path 来自**外部文件**（导入的 Skill）且参与后续的磁盘写入与读取，
 * 所以它必须被当成不可信输入：
 *   `../../evil.txt`  → 能写到技能目录外面
 *   `C:/Windows/x`    → 绝对路径，Windows 上直接生效
 *   `/etc/passwd`     → POSIX 绝对路径
 *   `a\..\..\b`       → 反斜杠版本的穿越
 *
 * 任何一种都能让「导入一个 Skill」变成任意文件读写。
 * 所以规则收紧到：**必须是相对路径、不许 ..、不许盘符、不许空**。
 *
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
function normalizeSkillPath(p) {
  const raw = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  if (!raw) return { ok: false, error: '配套文件路径不能为空' };
  if (raw.startsWith('/')) return { ok: false, error: '配套文件路径必须相对于技能目录' };
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, error: '配套文件路径不能是绝对路径' };
  // 逐段检查，穿越在任何一段都算数
  const segs = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) {
    return { ok: false, error: '配套文件路径不能包含 ..（那会写到技能目录外面）' };
  }
  if (!segs.length) return { ok: false, error: '配套文件路径不能为空' };
  const value = segs.join('/');
  // 只允许 SKILL.md 与 scripts/ references/ assets/ 三类目录
  if (value.toLowerCase() !== 'skill.md') {
    if (!/^(scripts?|references?|assets?)\//.test(value)) {
      return {
        ok: false,
        error: `配套文件要放在 scripts/、references/ 或 assets/ 下（现在放的是 ${value}）`,
      };
    }
  }
  return { ok: true, value };
}

/** 归一化：与 run-verify.js 的 norm 完全一致，两侧必须同规则 */
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s　。，、；：？！“”‘’（）()《》〈〉\-_·.]/g, '');
}

class Store {
  /**
   * @param {string} dbPath 数据库文件路径；':memory:' 用于测试
   */
  constructor(dbPath) {
    this.path = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    // WAL + 外键 + 锁等待。busy_timeout 是必须的：
    // 生成正文时主进程仍在读设定库，写入（状态回写）并发时若不设等待会直接抛 SQLITE_BUSY。
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this._stmts = {};
  }

  /**
   * 升级库结构到当前版本。
   *
   * ## 为什么先读版本再决定做什么
   *
   * 原来的实现是"无条件 exec schema.sql + 无条件补列"——每次启动都跑一遍。
   * 那在功能上没错（都是幂等的），但**没有任何地方能回答"这个库是哪一版"**。
   * 一旦将来要改列类型或搬数据，就完全无从下手：你不知道该从哪一步开始。
   *
   * ## 全新库与老库走同一条路
   *
   * `cur = 0` 时：`_upgradeTo1()` 对全新库是"建表"，对老库是"补列"——
   * 因为建表是 `IF NOT EXISTS`、补列先查 `pragma table_info`，两步都幂等。
   * **不区分"是不是新库"是刻意的**：分出两条路径就多一处出错的地方。
   */
  migrate() {
    const cur = this._userVersion();

    /**
     * ⚠⚠ 库比代码新：用户先装了新版、又装回旧版。
     *
     * 直接放行是最坏的选择——旧代码不认识新列，它会在**不知道的情况下**
     * 写进一批缺字段的行，等用户再升回新版时，数据已经是残缺的了，
     * 而且没有任何日志能证明是哪一版写坏的。
     *
     * 明确拒绝，让用户去升级，比"看起来能用"好得多。
     */
    if (cur > SCHEMA_VERSION) {
      throw new Error(
        `数据库来自更新的版本（库 v${cur}，本程序支持到 v${SCHEMA_VERSION}）。`
        + '请装回新版 WriteTool 再打开，否则可能丢数据。'
      );
    }

    if (cur < SCHEMA_VERSION) {
      // v0 → v1：初始结构（建表 + 补历史列）
      if (cur < 1) this._upgradeTo1();
      // v1 → v2：messages 加 reasoning_content
      if (cur < 2) this._upgradeTo2();
      // ⚠ 将来加 v3 时：if (cur < 3) this._upgradeTo3();
      this._setUserVersion(SCHEMA_VERSION);
    }
  }

  /** v1：schema.sql 全量建表 + 补上历史上后加的列 */
  _upgradeTo1() {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    this.db.exec(sql);
    this._addMissingColumns();
  }

  /**
   * v2：给 messages 加 reasoning_content（2026-10-21）。
   *
   * ⚠ 为什么必须补列而不是靠 schema.sql：
   *   建表语句是 `CREATE TABLE IF NOT EXISTS`，老库的表已经在了 → 整条跳过
   *   → 新列**不会**出现。用户升上来后第一次生成就会撞
   *   `no such column: reasoning_content`。
   *
   * 直接复用 `_addMissingColumns`（它先查 pragma table_info，只补真缺的），
   * 这样补列规则只有一份，不会两处不一致。
   */
  _upgradeTo2() {
    this._addMissingColumns();
  }

  /** 读库结构版本；读不到（空库/异常）一律当 0，走完整升级 */
  _userVersion() {
    try {
      const row = this.db.prepare('PRAGMA user_version').get();
      if (!row) return 0;
      // node:sqlite 返回 { user_version: N }；不同版本键名可能有差异，两个都试
      return Number(row.user_version ?? row['user_version']) || 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * 写库结构版本。
   *
   * ⚠ PRAGMA **不支持参数绑定**，只能拼进 SQL —— 所以这里强制转成整数。
   *   `user_version` 的值虽然来自内部常量，但读路径也用它（迁移里回写），
   *   一个被篡改的库文件可能让这个值变成奇怪的字符串，直接拼就是注入。
   */
  _setUserVersion(v) {
    this.db.exec(`PRAGMA user_version = ${Math.max(0, Math.trunc(Number(v) || 0))}`);
  }

  /**
   * 补列：给**已存在的旧库**加新列。
   *
   * ## 为什么 schema.sql 里加了列还不够
   *
   * 所有建表语句都是 `CREATE TABLE IF NOT EXISTS` ——
   * 表已经在了就整条跳过，**新加的列不会生效**。
   * 于是老用户的库升上来缺列，一查就是
   * `no such column: think_level`，而错误发生在查询里、
   * 离"少了一次迁移"这个原因很远。
   *
   * ## 为什么不用 ALTER TABLE 的 try/catch
   *
   * 那是最短写法，但它把「列已存在」和「SQL 写错了」当成同一类失败吞掉——
   * 真写错时表现是"迁移静默失败"，下一次仍然炸在同一处。
   * 所以先查 pragma table_info，只对**确实缺的**列执行 ALTER。
   */
  _addMissingColumns() {
    /** 表 → { 列名: 列定义 }。加列时在这里补一条即可。 */
    const wanted = {
      conversations: {
        think_level: "TEXT NOT NULL DEFAULT ''",
      },
      messages: {
        // 思考内容：必须落库，否则多轮对话回传不了（DeepSeek 直接 400）
        reasoning_content: 'TEXT',
      },
    };
    for (const [table, cols] of Object.entries(wanted)) {
      let have;
      try {
        have = this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
      } catch (_) {
        continue;   // 表还不存在（理论上不会，前面刚 exec 过 schema）
      }
      for (const [name, def] of Object.entries(cols)) {
        if (have.includes(name)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
      }
    }
  }

  /** 预编译语句缓存：Agent 循环里同一条查询会被调几十次，不缓存没有性能意义 */
  prep(sql) {
    if (!this._stmts[sql]) this._stmts[sql] = this.db.prepare(sql);
    return this._stmts[sql];
  }

  close() {
    this.db.close();
  }

  // ============================================================
  // 项目
  // ============================================================

  createProject({ id, name, coverPath = null, settingsJson = '{}' }) {
    this.prep(
      'INSERT INTO projects (id, name, cover_path, settings_json) VALUES (?,?,?,?)'
    ).run(id, name, coverPath, settingsJson);
    return id;
  }

  getProject(id) {
    const row = this.prep('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? { ...row, settings: JSON.parse(row.settings_json || '{}') } : null;
  }

  listProjects() {
    return this.prep('SELECT * FROM projects ORDER BY updated_at DESC').all();
  }

  /**
   * 改项目名。
   *
   * ⚠ 不改项目文件夹的名字（文件夹名就是 id，改名会让用户
   *   攒下的路径全部失效）。所以「重命名」只改显示名，
   *   磁盘上的目录保持原样。
   *
   * 同名时直接报错而不是静默接受：两个同名项目在弹窗里
   * 分不清，用户的直觉是"重名了，帮我合并/提示"。
   */
  renameProject(id, name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) throw new Error('项目名不能为空');
    const dup = this.prep('SELECT id FROM projects WHERE name = ? AND id != ?').get(n, id);
    if (dup) throw new Error(`已经有叫「${n}」的项目了`);
    const r = this.prep(
      "UPDATE projects SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(n, id);
    if (!r.changes) throw new Error('项目不存在');
    return n;
  }

  /**
   * 删项目。数据库这侧靠 ON DELETE CASCADE 清干净。
   *
   * ⚠ 磁盘上的项目文件夹**不在这里删**——那是不可逆的，
   *   必须由主进程在用户二次确认之后单独调 pfs.remove({rootDelete:true})。
   *   两边分开，才能做到"数据库先删、文件夹删失败时用户还能找回对话"。
   *
   * @returns {number} 被级联删除的行数（用来看有没有真的清掉）
   */
  deleteProject(id) {
    const r = this.prep('DELETE FROM projects WHERE id = ?').run(id);
    if (!r.changes) throw new Error('项目不存在');
    return { changes: r.changes };
  }

  // ============================================================
  // 设定库
  // ============================================================

  upsertSetting({ id, projectId, type, name, note = '', aliases = [], status = 'active' }) {
    const tx = this.db.prepare('BEGIN IMMEDIATE');
    tx.run();
    try {
      this.prep(
        `INSERT INTO settings (id, project_id, type, name, note, status)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (project_id, type, name)
         DO UPDATE SET note = excluded.note,
                       status = excluded.status,
                       updated_at = datetime('now','localtime')`
      ).run(id, projectId, type, name, note, status);
      const row = this.prep(
        'SELECT id FROM settings WHERE project_id = ? AND type = ? AND name = ?'
      ).get(projectId, type, name);
      const sid = row.id;
      this.prep('DELETE FROM setting_aliases WHERE setting_id = ?').run(sid);
      const ins = this.prep('INSERT OR IGNORE INTO setting_aliases (setting_id, alias) VALUES (?,?)');
      for (const a of aliases) {
        const t = String(a || '').trim();
        if (t) ins.run(sid, t);
      }
      this.db.prepare('COMMIT').run();
      return sid;
    } catch (e) {
      this.db.prepare('ROLLBACK').run();
      throw e;
    }
  }

  /**
   * 取某项目的设定，供检索层打分。
   * 只返回 status='active' 的——已退场/废弃的实体不该被检索出来污染上下文。
   * 返回形状与 run-verify.js 的 world数组一致：{project, name, type, note, aliases}
   */
  loadSettings(projectId) {
    const rows = this.prep(
      "SELECT id, project_id, type, name, note FROM settings WHERE project_id = ? AND status = 'active'"
    ).all(projectId);
    if (!rows.length) return [];
    const aliasRows = this.prep(
      `SELECT a.setting_id, a.alias FROM setting_aliases a
       JOIN settings s ON s.id = a.setting_id
       WHERE s.project_id = ?`
    ).all(projectId);
    const byId = new Map();
    for (const a of aliasRows) {
      if (!byId.has(a.setting_id)) byId.set(a.setting_id, []);
      byId.get(a.setting_id).push(a.alias);
    }
    return rows.map((r) => ({
      id: r.id,
      project: r.project_id,
      type: r.type,
      name: r.name,
      note: r.note,
      aliases: byId.get(r.id) || [],
    }));
  }

  /** 全部项目的设定，供 run-verify.js 的 worldOf() 按 project过滤 */
  loadAllSettings() {
    const projects = this.listProjects();
    const out = [];
    for (const p of projects) out.push(...this.loadSettings(p.id));
    return out;
  }

  deleteSetting(id) {
    return this.prep('DELETE FROM settings WHERE id = ?').run(id).changes;
  }

  // ============================================================
  // 伏笔（一等公民）
  // ============================================================

  createThread({ id, projectId, name, summary = '', plantedIn = null, importance = 3 }) {
    this.prep(
      `INSERT INTO plot_threads (id, project_id, name, summary, planted_in, importance)
       VALUES (?,?,?,?,?,?)`
    ).run(id, projectId, name, summary, plantedIn, importance);
    return id;
  }

  resolveThread(id, chapterId) {
    return this.prep(
      `UPDATE plot_threads
       SET resolved_in = ?, status = 'resolved', updated_at = datetime('now','localtime')
       WHERE id = ?`
    ).run(chapterId, id).changes;
  }

  /** 未回收的伏笔，按重要度降序——一致性检查与上下文注入都该优先看这些 */
  listOpenThreads(projectId) {
    return this.prep(
      `SELECT * FROM plot_threads WHERE project_id = ? AND status = 'open'
       ORDER BY importance DESC, name`
    ).all(projectId);
  }

  listThreads(projectId) {
    return this.prep(
      'SELECT * FROM plot_threads WHERE project_id = ? ORDER BY importance DESC, name'
    ).all(projectId);
  }

  // ============================================================
  // 章节
  // ============================================================

  createChapter({ id, projectId, title, content = '', parentChapterId = null, origin = 'agent' }) {
    this.prep(
      `INSERT INTO chapters (id, project_id, title, content, word_count, parent_chapter_id, origin)
       VALUES (?,?,?,?,?,?,?)`
    ).run(id, projectId, title, content, content.length, parentChapterId, origin);
    return id;
  }

  getChapter(id) {
    return this.prep('SELECT * FROM chapters WHERE id = ?').get(id) || null;
  }

  listChapters(projectId) {
    return this.prep(
      'SELECT id, title, word_count, origin, revision, updated_at FROM chapters WHERE project_id = ? ORDER BY created_at'
    ).all(projectId);
  }

  /**
   * 取最近的 N 章**正文**，用于风格画像。
   *
   * 为什么单开一个方法：listChapters 刻意不返回 content——
   * 侧栏列表有几百章，全量拉正文会卡住 UI。风格画像却必须读正文。
   * 早期 main.js 的 buildStyleProfile 直接用 listChapters 取 content，
   * 结果拿到 undefined，风格面板永远显示「不可用」。
   *
   * @param {string} projectId
   * @param {number} [limit] 取最近多少章，默认 12（更多收益递减）
   */
  listRecentChapterContents(projectId, limit = 12) {
    const rows = this.prep(
      `SELECT content FROM chapters
       WHERE project_id = ? AND content IS NOT NULL AND length(content) > 0
       ORDER BY created_at DESC LIMIT ?`
    ).all(projectId, limit);
    return rows.map((r) => r.content);
  }

  /**
   * 覆盖章节。revision 自增——每次覆盖都是一次修订，出问题时能按 revision 回溯。
   * 调用方负责在覆盖前把旧内容写到 .bak（见 backupChapter）。
   */
  updateChapterContent(id, content) {
    return this.prep(
      `UPDATE chapters
       SET content = ?, word_count = ?, revision = revision + 1,
           updated_at = datetime('now','localtime')
       WHERE id = ?`
    ).run(content, content.length, id).changes;
  }

  /** 把当前内容备份到 <chapterDir>/<id>.bak，返回备份路径 */
  backupChapter(id, chapterDir) {
    const ch = this.getChapter(id);
    if (!ch) return null;
    fs.mkdirSync(chapterDir, { recursive: true });
    const bak = path.join(chapterDir, `${id}.bak`);
    fs.writeFileSync(bak, ch.content, 'utf8');
    return bak;
  }

  deleteChapter(id) {
    return this.prep('DELETE FROM chapters WHERE id = ?').run(id).changes;
  }

  // ============================================================
  // 角色状态表
  // ============================================================

  setEntityState({ projectId, entityName, state, chapterId = null, settingId = null }) {
    this.prep(
      `INSERT INTO entity_states (project_id, setting_id, entity_name, state_json, updated_in_chapter)
       VALUES (?,?,?,?,?)
       ON CONFLICT (project_id, entity_name)
       DO UPDATE SET state_json = excluded.state_json,
                     setting_id = excluded.setting_id,
                     updated_in_chapter = excluded.updated_in_chapter,
                     updated_at = datetime('now','localtime')`
    ).run(projectId, settingId, entityName, JSON.stringify(state || {}), chapterId);
  }

  getEntityState(projectId, entityName) {
    const r = this.prep(
      'SELECT * FROM entity_states WHERE project_id = ? AND entity_name = ?'
    ).get(projectId, entityName);
    return r ? { ...r, state: JSON.parse(r.state_json || '{}') } : null;
  }

  listEntityStates(projectId) {
    return this.prep('SELECT * FROM entity_states WHERE project_id = ? ORDER BY entity_name').all(projectId)
      .map((r) => ({ ...r, state: JSON.parse(r.state_json || '{}') }));
  }

  // ============================================================
  // 对话（2026-11 界面改为「对话优先」后才真正启用）
  // ------------------------------------------------------------
  // schema 里的 conversations / messages 表从第 0 步就建好了，
  // 但整个第 0~3 步期间**没有任何代码读写它们**——
  // 界面是「编辑器 + 一个输入框」，没有多轮对话的概念。
  // 这批方法是为了新的对话式界面补的。
  // ============================================================

  /**
   * 新建对话。
   * @param {string} projectId
   * @param {string} [title] 首条消息的前 20 字，留空则用「新对话」
   */
  createConversation({ id, projectId, title = '' }) {
    const cid = id || `cv-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    this.prep('INSERT INTO conversations (id, project_id, title) VALUES (?,?,?)')
      .run(cid, projectId, (title || '新对话').slice(0, 60));
    return this.getConversation(cid);
  }

  /**
   * 取一条对话。
   *
   * ⚠ 列名用别名转成驼峰：渲染进程里写 `c.thinkLevel`，
   *   库里是 `think_level`。不带别名的话界面读到的永远是 undefined，
   *   表现是「档位设了不生效、切走再回来又变回默认」——
   *   而两边各自的测试都是绿的。
   */
  getConversation(id) {
    return this.prep(
      `SELECT id, project_id, title, think_level AS thinkLevel, created_at, updated_at
       FROM conversations WHERE id = ?`
    ).get(id) || null;
  }

  /** 按最近活跃排序——对话列表默认展示顺序 */
  listConversations(projectId, limit = 50) {
    return this.prep(
      `SELECT id, project_id, title, think_level AS thinkLevel, created_at, updated_at
       FROM conversations WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?`
    ).all(projectId, limit);
  }

  renameConversation(id, title) {
    return this.prep(
      `UPDATE conversations SET title = ?, updated_at = datetime('now','localtime') WHERE id = ?`
    ).run((title || '新对话').slice(0, 60), id).changes;
  }

  /**
   * 设这一条对话的思考强度档位。
   *
   * ⚠ 白名单校验。level 从渲染进程来，会被拼进 provider 的请求体：
   *   传个 `high; drop` 之类进去，轻则请求 400、
   *   重则在 provider 的映射表里命中不该命中的分支。
   *   所以这里只放行已知档位，其余一律归一成 'off'。
   *
   * @param {string} level off | low | medium | high | on | '' (空 = 跟随全局默认)
   * @returns {{ok:boolean, level:string}}
   */
  setConversationThinkLevel(id, level) {
    const raw = String(level == null ? '' : level).trim().toLowerCase();
    const LEGAL = new Set(['', 'off', 'on', 'low', 'medium', 'high']);
    const v = LEGAL.has(raw) ? raw : 'off';
    this.prep('UPDATE conversations SET think_level = ? WHERE id = ?').run(v, id);
    return { ok: true, level: v };
  }

  /**
   * 删对话。messages 表有 ON DELETE CASCADE，消息会跟着删——
   * 但仍显式处理一次：若外键约束被外部关掉（比如某些迁移脚本），
   * 手动清理能保证不留孤儿。
   */
  deleteConversation(id) {
    this.prep('DELETE FROM messages WHERE conversation_id = ?').run(id);
    return this.prep('DELETE FROM conversations WHERE id = ?').run(id).changes;
  }

  /** 追加消息；同时把对话的 updated_at 顶上去，让列表按活跃度排序 */
  addMessage({ id, conversationId, role, content = '', toolName = null, toolOk = null, tokensIn = 0, tokensOut = 0, ms = 0, traceId = null, reasoningContent = null }) {
    const mid = id || `ms-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    /**
     * ⚠ `reasoning_content` 必须存（2026-10-21）：
     *   DeepSeek 的推理模型在下一轮会校验"上一轮的思考内容有没有带回来"，
     *   只留在内存里的话，用户刷新页面或重开对话就再也接不上了，整轮 400。
     */
    this.prep(
      `INSERT INTO messages (id, conversation_id, role, content, tool_name, tool_ok,
                             tokens_in, tokens_out, ms, trace_id, reasoning_content)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(mid, conversationId, role, String(content || ''), toolName,
      toolOk === null || toolOk === undefined ? null : (toolOk ? 1 : 0),
      tokensIn | 0, tokensOut | 0, ms | 0, traceId,
      reasoningContent == null ? null : String(reasoningContent));
    this.prep(`UPDATE conversations SET updated_at = datetime('now','localtime') WHERE id = ?`).run(conversationId);
    return this.getMessage(mid);
  }

  getMessage(id) {
    return this.prep('SELECT * FROM messages WHERE id = ?').get(id) || null;
  }

  /**
   * 删掉一条消息。
   *
   * ⚠ 与 skill:deleteFile 一样靠 `skill_files` 的 ON DELETE CASCADE 不适用于这里 ——
   *   messages 没有子表，删了就是删了，所以界面上必须给二次确认。
   *
   * @returns {{deleted:number, id:string}}
   */
  deleteMessage(id) {
    const row = this.getMessage(id);
    if (!row) return { deleted: 0, id };
    // 删掉一条 user 消息时，把它后面**成对**的 assistant 回答一并删掉。
    // ⚠ 只删一条会让历史变成"用户问了没回答"，下一轮模型会把上一条 assistant
    //   当成自己的上一段续着写 —— 那种脏历史比留一条孤儿消息更难解释。
    let n = this.prep('DELETE FROM messages WHERE id = ?').run(id).changes;
    if (row.role === 'user') {
      const next = this.prep(
        `SELECT id FROM messages WHERE conversation_id = ? AND rowid > (
           SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid ASC LIMIT 1`)
        .get(row.conversation_id, id);
      if (next && next.id !== id) {
        const nx = this.getMessage(next.id);
        if (nx && nx.role === 'assistant') n += this.prep('DELETE FROM messages WHERE id = ?').run(next.id).changes;
      }
    }
    this.prep(`UPDATE conversations SET updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(row.conversation_id);
    return { deleted: n, id, conversationId: row.conversation_id };
  }

  /**
   * 撤回：删掉这条以及它之后的全部消息。
   *
   * 「撤回」和「删除」的区别就在这：
   *   删除 = 删掉这一条（多删了下一条成对的回答）
   *   撤回 = 从这条开始，后面全清 —— 让对话回到能重新提问的状态
   */
  deleteFromMessage(id) {
    const row = this.getMessage(id);
    if (!row) return { deleted: 0, id };
    const r = this.prep(
      'DELETE FROM messages WHERE conversation_id = ? AND rowid >= (SELECT rowid FROM messages WHERE id = ?)')
      .run(row.conversation_id, id);
    this.prep(`UPDATE conversations SET updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(row.conversation_id);
    return { deleted: r.changes, id, conversationId: row.conversation_id };
  }

  /**
 * 按时间正序——对话界面从上往下读。
 *
 * ⚠ 不能在子查询里用 `rowid` 做二级排序：`SELECT * FROM ( ... ORDER BY created_at DESC, rowid DESC )`
 * 里子查询只暴露 SELECT 列表里的列，rowid 不在其中 → `no such column: rowid`。
 * 改成在子查询里显式取 `rowid AS seq` 带出来。
 *
 * 为什么需要 seq：created_at 的精度是秒，同一秒内插入的多条消息顺序不确定，
 * 而流式回答常常在一秒内写入。只按 created_at 排会乱序。
 */
  listMessages(conversationId, limit = 500) {
    return this.prep(
      `SELECT id, conversation_id, role, content, tool_name, tool_ok,
              tokens_in, tokens_out, ms, trace_id, created_at, reasoning_content
       FROM (
         SELECT rowid AS seq, * FROM messages
         WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )
       ORDER BY seq ASC`
    ).all(conversationId, limit);
  }

  /** 删除某条消息之后的所有消息——「重新生成」时用它砍掉旧回答 */
  truncateMessagesAfter(conversationId, messageId) {
    const m = this.getMessage(messageId);
    if (!m) return 0;
    return this.prep('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?')
      .run(conversationId, m.created_at).changes;
  }

  countMessages(conversationId) {
    const r = this.prep('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(conversationId);
    return r ? r.c : 0;
  }

  // ============================================================
  // 技能（供输入框 @ 引用）
  // ============================================================

  /** 列技能。projectId 为空时只列全局内置（project_id IS NULL） */
  listSkills(projectId, includeDisabled = false) {
    const where = includeDisabled ? '' : 'AND enabled = 1';
    return this.prep(
      `SELECT * FROM skills WHERE (project_id = ? OR project_id IS NULL) ${where} ORDER BY type DESC, name`
    ).all(projectId);
  }

  /**
   * 按 id 取多条（渐进式加载的第二级：用户 @ 引用时才取正文）。
   *
   * ⚠ 逐个 get 而不是一条 IN 查询：技能最多十几条，
   *   而 IN 查询要处理占位符数量与空数组的边界，
   *   这里的出错概率比省下的那点时间高。
   */
  getSkillsByIds(ids) {
    return (ids || []).map((id) => this.getSkill(id)).filter(Boolean);
  }

  getSkill(id) {
    return this.prep('SELECT * FROM skills WHERE id = ?').get(id) || null;
  }

  createSkill({ id, projectId = null, name, promptContent = '', type = 'custom', enabled = true }) {
    const sid = id || `sk-${Date.now().toString(36)}`;
    this.prep(
      'INSERT INTO skills (id, project_id, name, prompt_content, type, enabled) VALUES (?,?,?,?,?,?)'
    ).run(sid, projectId, name, promptContent, type, enabled ? 1 : 0);
    return this.getSkill(sid);
  }

  /**
   * 改技能的名称与提示词。
   *
   * ⚠ 内置技能（project_id 为 NULL）**允许改内容但不允许改归属**：
   *   内置的提示词写得不好时用户要能改（否则只能干看着），
   *   但它仍属于全局——改成项目级会让「换项目写别的书」时丢掉这条经验。
   */
  updateSkill(id, { name, promptContent }) {
    const cur = this.getSkill(id);
    if (!cur) throw new Error('技能不存在');
    const n = name != null ? String(name).trim() : cur.name;
    if (!n) throw new Error('技能名不能为空');
    const p = promptContent != null ? String(promptContent) : cur.prompt_content;
    this.prep(
      `UPDATE skills SET name = ?, prompt_content = ?,
       updated_at = datetime('now','localtime') WHERE id = ?`
    ).run(n, p, id);
    return this.getSkill(id);
  }

  /**
   * 启用 / 停用。
   *
   * ⚠ 停用不等于删除：内置技能停用后随时能开回来，
   *   删除就回不去了（要等下次 seed，而 seed 只补缺失的）。
   */
  setSkillEnabled(id, enabled) {
    const r = this.prep(
      `UPDATE skills SET enabled = ?, updated_at = datetime('now','localtime') WHERE id = ?`
    ).run(enabled ? 1 : 0, id);
    if (!r.changes) throw new Error('技能不存在');
    return this.getSkill(id);
  }

  /**
   * 列出全部技能（含停用的）。
   *
   * listSkills 默认只返回启用的——那是给输入框 @ 用的。
   * 设置页要管理，就需要看见停用的那些。
   */
  listAllSkills(projectId) {
    return this.prep(
      `SELECT * FROM skills WHERE (project_id = ? OR project_id IS NULL)
       ORDER BY type DESC, name`
    ).all(projectId ?? null);
  }

  // ============================================================
  // Skill 配套文件
  // ============================================================

  /** 某技能的配套文件列表（不含内容，正文里要引用文件名） */
  listSkillFiles(skillId) {
    return this.prep(
      'SELECT id, path, kind, executable, length(content) AS size FROM skill_files WHERE skill_id = ? ORDER BY path'
    ).all(skillId);
  }

  /** 全部内容。⚠ 只给主进程——配套文件可能很大，别整个经 IPC。 */
  getSkillFiles(skillId) {
    return this.prep(
      'SELECT path, kind, content, executable FROM skill_files WHERE skill_id = ? ORDER BY path'
    ).all(skillId);
  }

  getSkillFile(skillId, path) {
    return this.prep(
      'SELECT path, kind, content, executable FROM skill_files WHERE skill_id = ? AND path = ?'
    ).get(skillId, path);
  }

  /**
   * 写一个配套文件。
   *
   * ⚠ 路径校验是硬约束，不是顺手加的：
   *   导入的 Skill 里 path 来自外部文件，而它会参与磁盘写入。
   *   `../../evil.txt` 或 `C:/Windows/...` 能写到任意位置。
   *   所以只接受相对路径，且不允许 `..`。
   */
  saveSkillFile(skillId, { path: p, kind = 'reference', content = '', executable = false }) {
    const rel = normalizeSkillPath(p);
    if (!rel.ok) throw new Error(rel.error);
    this.prep(
      `INSERT INTO skill_files (id, skill_id, path, kind, content, executable)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(skill_id, path) DO UPDATE SET
         content = excluded.content,
         kind = excluded.kind,
         executable = excluded.executable,
         updated_at = datetime('now','localtime')`
    ).run(`sf-${skillId}-${rel.value}`, skillId, rel.value, kind,
      String(content), executable ? 1 : 0);
    return this.getSkillFile(skillId, rel.value);
  }

  /**
   * 删一个配套文件。
   *
   * ⚠ 不删 SKILL.md 本身 —— 那是技能的正文，删了技能就废了。
   */
  deleteSkillFile(skillId, p) {
    const rel = normalizeSkillPath(p);
    if (!rel.ok) throw new Error(rel.error);
    if (rel.value.toLowerCase() === 'skill.md') {
      throw new Error('不能删除 SKILL.md —— 它是技能正文。请删除整个技能。');
    }
    return this.prep(
      'DELETE FROM skill_files WHERE skill_id = ? AND path = ?'
    ).run(skillId, rel.value).changes;
  }

  /**
   * 技能索引：name + description + 配套文件清单（**不含正文**）。
   *
   * ## 为什么从 handler 里搬到这里
   *
   * 原来是 skill:index 这个 handler 内联写的。2026-10-16 加技能自动路由
   * 时，主进程要在**不发 IPC** 的情况下拿到同一份索引——
   * 而再抄一遍就等于两处逻辑会漂移：改了 handler 忘了改路由，
   * 就会出现「界面显示能用的技能，自动路由看不见」。
   * 所以抽成方法，两边共用。
   *
   * ⚠⚠ 没有 description 的技能**必须被滤掉**，这是本方法唯一的
   *   硬性过滤，也是 2026-10-16 那 4 条 legacy 技能「装了等于没装」
   *   的根因：它们是单条纯文本、没有 frontmatter，parse 返回空
   *   description，于是永远进不了索引，模型永远看不见它们。   *
   * @param {string|null} projectId
   * @param {string[]} [only] 只索引这几个
   */
  skillIndex(projectId, only) {
    const list = (only && only.length)
      ? this.getSkillsByIds(only)
      : this.listSkills(projectId);
    const fmt = skillFmt();
    return list.map((sk) => {
      const meta = fmt.parse(sk.prompt_content || '');
      const files = this.listSkillFiles(sk.id);
      return {
        id: sk.id,
        name: sk.name,
        description: meta.description,
        hasFrontmatter: meta.hasFrontmatter,
        files: files.map((f) => f.path),
      };
    }).filter((x) => x.description);
  }

  deleteSkill(id) {
    const row = this.getSkill(id);
    // ⚠ 内置技能不给删。它是启动时 seed 进来的，
    //   删掉的话下次启动会又被补回来——用户以为删了，其实没删。
    if (row && row.type === 'built-in') {
      throw new Error('内置技能不能删除，可以先停用它');
    }
    return this.prep('DELETE FROM skills WHERE id = ?').run(id).changes;
  }

  /**
   * 种内置技能。**内置的会更新，用户的不会。**
   *
   * 2026-10-12：清单挪到了 builtin-skills.js，因为其中两条是**目录式**
   * Skill（SKILL.md + references/），把正文塞进 JS 字符串会有几百行
   * 而且反引号、${} 全都要转义。
   *
   * ## ⚠⚠ 2026-10-16：为什么不能再「已存在就跳过」
   *
   * 原来第一行就是 `if (this.getSkill(s.id)) { skipped++; continue; }`。
   * 那在「内置技能永远不变」的前提下是对的，但 2026-10-16 改了
   * 6 条内置技能的正��（补六项约束、修路径、加场景定义），
   * 幂等跳过就意味着：**用户装上新版，老库里那 6 条一条都不会变。**
   *
   * 症状很隐蔽：开发态跑 `seedBuiltinSkills` 看着好��（库是空的，
   * 全部 seeded），而真用户升级后拿到的是三个月前的旧正文。
   * 开发态和发布态表现不一致 —— 这类 bug 最难查。
   *
   * 现在改成：
   *   - 内置的（type='built-in'）→ 用磁盘上的新版**覆盖正文**。
   *     用户改过内置技能正文是允许的（界面不禁止），
   *     但**升级新版本时应该拿到新正文** —— 这是版本升级的常态。
   *   - 用户自建的（type='custom'）→ 绝不碰。
   *
   * ⚠ 覆盖时**保留 enabled**：用户关掉某个内置技能，
   *   升级后不该自己又打开。
   *
   * @param {function} loadBuiltin 读目录的函数（见 builtin-skills.js）
   * @returns {{seeded:number, updated:number, files:number,
   *            skipped:number, retired:number}}
   *
   * ⚠ 返回值加了 updated / retired 两个字段。
   *   老调用点（main.js 的日志）拼的是 `${n} 个`，
   *   对象会变成 [object Object] —— 那里要同步改。
   */
  seedBuiltinSkills(loadBuiltin) {
    const list = require('./builtin-skills.js').BUILTIN;
    const keepIds = new Set(list.map((s) => s.id));
    let seeded = 0;
    let updated = 0;
    let files = 0;
    let skipped = 0;

    for (const s of list) {
      const existing = this.getSkill(s.id);

      if (s.legacy) {
        // 旧式的单条提示词技能。2026-10-16 起内置清单里已经没有了，
        // 这个分支留着是为了兼容**旧版清单**（万一有第三方 fork 沿用）。
        if (existing) { skipped++; continue; }
        this.createSkill({
          id: s.id, projectId: null, name: s.name,
          promptContent: s.legacy, type: 'built-in', enabled: s.enabled !== false,
        });
        seeded++;
        continue;
      }

      // 目录式：从磁盘读 SKILL.md 与配套文件
      const loaded = loadBuiltin ? loadBuiltin(s.id) : null;
      if (!loaded) {
        // ⚠ 读不到要说清楚是哪一条。静默跳过的话，
        //   开发态一切正常、打包后技能却是空的 ——
        //   用户看到的只是「这个技能不存在」，完全猜不到是漏打包了。
        throw new Error(`内置技能「${s.name}」的目录读不到`
          + `（期望 app/builtin-skills/${s.id}/SKILL.md）。`
          + '通常是打包时漏了 builtin-skills 目录。');
      }

      if (existing) {
        // ⚠ 只覆盖 type='built-in'。同 id 若是 custom，
        //   那是用户自己建的同名技能，升级不该动它。
        if (existing.type !== 'built-in') { skipped++; continue; }

        const changed = this.updateBuiltinBody(s.id, loaded.content, s.name);
        if (changed) updated++; else skipped++;

        // 配套文件也要跟着更新：正文改了而 references 还是旧的，
        // 模型读到的字段模板和正文讲的对不上。
        for (const f of loaded.files) {
          if (f.path === 'SKILL.md') continue;
          const cur = this.getSkillFile(s.id, f.path);
          if (cur && cur.content === f.content) continue;
          this.saveSkillFile(s.id, { path: f.path, kind: f.kind, content: f.content });
          files++;
        }
        continue;
      }

      const meta = skillFmt().parse(loaded.content);
      this.createSkill({
        id: s.id, projectId: null,
        // ⚠ 显示名用清单里的（中文），不用 frontmatter 里的 name
        //   ——后者是目录名（小写英文）。界面上给用户看中文。
        name: s.name,
        promptContent: loaded.content,
        type: 'built-in', enabled: s.enabled !== false,
      });
      // 配套文件入库
      for (const f of loaded.files) {
        if (f.path === 'SKILL.md') continue;   // 正文已经在 prompt_content 里
        this.saveSkillFile(s.id, { path: f.path, kind: f.kind, content: f.content });
        files++;
      }
      seeded++;
      void meta;
    }

    // ---- 退役：从清单里消失的内置技能 ----
    //
    // ⚠⚠ 这里**不能调 deleteSkill()**：它对 type='built-in' 直接抛错
    //   （store.js:740，"内置技能不能删除，可以先停用它"）。
    //   那个保护是为「用户在界面上点删除」设计的——对的，
    //   界面上确实不该让用户删内置技能。
    //   但**版本升级**是另一回事：新版清单里已经没有这 4 条了，
    //   它们的内容都并进了新的目录式技能，留着只会在界面上
    //   出现功能重复、又永远进不了 skill:index 的僵尸条目。
    //   所以这里直接走 SQL，并显式限定 project_id IS NULL
    //   （项目内的技能绝不能碰）。
    //
    // skill_files 有 ON DELETE CASCADE，配套文件会一起清掉。
    let retired = 0;
    for (const r of this.prep(
      `SELECT id FROM skills
        WHERE type = 'built-in' AND project_id IS NULL`,
    ).all()) {
      if (keepIds.has(r.id)) continue;
      this.prep('DELETE FROM skills WHERE id = ?').run(r.id);
      retired++;
    }

    return { seeded, updated, files, skipped, retired };
  }

  /**
   * 覆盖内置技能的正文。
   *
   * ⚠⚠ **必须保留 enabled**。用户关掉某个内置技能是明确的选择，
   *   升级后自己又打开会让人以为出 bug —— 而且这种技能往往正是
   *   他不想让模型自动用的那个。
   *
   * ⚠ name 也一起更新：清单里的中文显示名可能改过
   *   （"小说写作助手" → "写新章节"）。留着旧名字会让用户
   *   以为自己看的是另一个技能。
   *
   * @returns {boolean} 内容是否真的变了
   */
  updateBuiltinBody(id, content, name) {
    const cur = this.getSkill(id);
    if (!cur) return false;
    const bodySame = cur.prompt_content === content;
    const nameSame = !name || cur.name === name;
    if (bodySame && nameSame) return false;
    this.prep(
      `UPDATE skills SET prompt_content = ?, name = COALESCE(?, name),
              updated_at = datetime('now','localtime')
         WHERE id = ?`,
    ).run(content, name || null, id);
    return true;
  }

  // ============================================================
  // AI 连接
  // ============================================================

  /**
   * 列出全部连接。
   *
   * ⚠ 这里的返回值**一定不含密钥**。
   *   这份数据会经 IPC 到渲染进程，密文不该跟着走
   *   （拿到密文等于拿到一条"在别的进程里解密"的路）。
   *   要读密钥只有一条路：主进程调 getConnectionSecret(id)。
   */
  listConnections() {
    const rows = this.prep(
      `SELECT c.*,
              CASE WHEN s.connection_id IS NULL THEN 0 ELSE 1 END AS has_key
         FROM connections c
         LEFT JOIN connection_secrets s ON s.connection_id = c.id
        ORDER BY c.is_preset DESC, c.created_at`
    ).all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      protocol: r.protocol,
      providerKey: r.provider_key,
      base: r.base,
      model: r.model,
      needKey: !!r.need_key,
      isPreset: !!r.is_preset,
      hasKey: !!r.has_key,
    }));
  }

  getConnection(id) {
    return this.listConnections().find((c) => c.id === id) || null;
  }

  createConnection({
    id, name, protocol = 'openai', providerKey = 'custom',
    base = '', model = '', needKey = true, isPreset = false,
  }) {
    const n = String(name == null ? '' : name).trim();
    if (!n) throw new Error('连接名称不能为空');
    this.prep(
      `INSERT INTO connections (id, name, protocol, provider_key, base, model, need_key, is_preset)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, n, protocol, providerKey, String(base).replace(/\/+$/, ''),
      model, needKey ? 1 : 0, isPreset ? 1 : 0);
    return this.getConnection(id);
  }

  /**
   * 改连接。
   *
   * ⚠ 用白名单挑字段而不是黑名单剔除——
   *   新加的敏感字段（将来若有人往表里加 token 列）
   *   自动被挡在渲染进程之外。config 那边的 publicConfig
   *   用的是黑名单，因为字段有三十多个、逐个列举会漏；
   *   这里字段少，白名单成本低且更安全。
   */
  updateConnection(id, patch = {}) {
    const cur = this.getConnection(id);
    if (!cur) throw new Error('连接不存在');
    const name = patch.name != null ? String(patch.name).trim() : cur.name;
    if (!name) throw new Error('连接名称不能为空');
    const protocol = patch.protocol || cur.protocol;
    if (!['ollama', 'openai', 'anthropic'].includes(protocol)) {
      throw new Error(`未知的协议：${protocol}`);
    }
    this.prep(
      `UPDATE connections
          SET name = ?, protocol = ?, provider_key = ?, base = ?, model = ?,
              need_key = ?, updated_at = datetime('now','localtime')
        WHERE id = ?`
    ).run(name, protocol, patch.providerKey || cur.providerKey,
      patch.base != null ? String(patch.base).replace(/\/+$/, '') : cur.base,
      patch.model != null ? String(patch.model) : cur.model,
      (patch.needKey != null ? patch.needKey : cur.needKey) ? 1 : 0,
      id);
    return this.getConnection(id);
  }

  /**
   * 删连接。密钥靠外键级联删，不留孤儿密文。
   */
  deleteConnection(id) {
    return this.prep('DELETE FROM connections WHERE id = ?').run(id).changes;
  }

  /** 取密钥密文。**只给主进程**，不经 IPC。 */
  getConnectionSecret(id) {
    const r = this.prep(
      'SELECT key_enc FROM connection_secrets WHERE connection_id = ?'
    ).get(id);
    return r ? r.key_enc : null;
  }

  /** 存密钥密文。传 null / 空串 = 清掉 */
  setConnectionSecret(id, keyEnc) {
    if (!keyEnc) {
      return this.prep('DELETE FROM connection_secrets WHERE connection_id = ?').run(id).changes;
    }
    this.prep(
      `INSERT INTO connection_secrets (connection_id, key_enc)
       VALUES (?,?)
       ON CONFLICT(connection_id) DO UPDATE SET
         key_enc = excluded.key_enc,
         updated_at = datetime('now','localtime')`
    ).run(id, keyEnc);
    return 1;
  }

  /**
   * 取服务级密钥密文（联网搜索等）。**只给主进程**，不经 IPC。
   *
   * @param {string} provider  'serper' / 'bing'
   */
  getServiceSecret(provider) {
    const r = this.prep('SELECT key_enc FROM service_secrets WHERE provider = ?').get(provider);
    return r ? r.key_enc : null;
  }

  /** 存服务级密钥密文。传 null / 空串 = 清掉 */
  setServiceSecret(provider, keyEnc) {
    if (!keyEnc) {
      return this.prep('DELETE FROM service_secrets WHERE provider = ?').run(provider).changes;
    }
    this.prep(
      `INSERT INTO service_secrets (provider, key_enc)
       VALUES (?,?)
       ON CONFLICT(provider) DO UPDATE SET
         key_enc = excluded.key_enc,
         updated_at = datetime('now','localtime')`
    ).run(provider, keyEnc);
    return 1;
  }

  /**
   * 【已删除】seedPresetConnections
   *
   * 原实现把 provider-presets 里的 14 家一次性写进 connections 表，
   * 界面上就是一屏用不上的东西（vLLM / DeepSeek / 智谱 / 硅基流动 /
   * 百炼 / 方舟 / Kimi / MiniMax / OpenRouter / OpenAI / Anthropic …），
   * 每条还带删除按钮 —— 而那个删除按钮是假的：
   * 用 provider_key 做幂等键，删了下次启动就补回来。
   *
   * 羽毛菌的判断是对的：「这些列举出来是干什么」「直接输入大模型的
   * 官网文档给的地址就行了」。**量表是模板，不是数据。**
   *
   * 现在量表只出现在「新建连接」的那一刻（见 ProviderCat 的 ProviderPicker），
   * 由用户点了哪一家才落哪一条库。
   *
   * ⚠ 不要再把这段加回来。它还有个副作用：连接表一旦非空，
   *   main.js 的 migrateToConnections 会以为"用户已经有连接了"而跳过迁移，
   *   于是老用户原来那条（带真实地址与密钥）永远进不来。
   *   测试 db/test-connections-skill.js 里有一条反向断言钉住这件事。
   */

  // ============================================================
  // 导入
  // ============================================================

  /**
   * 从 world-bible.json 导入。
   * @param {string} jsonPath world-bible.json 路径
   * @param {(projectId:string, title:string)=>string} ensureProject 项目不存在时创建
   */
  importWorldBible(jsonPath, ensureProject) {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const entries = raw.entries || raw;
    const projects = [...new Set(entries.map((e) => e.project))];
    let n = 0;
    for (const pid of projects) {
      if (!this.getProject(pid)) ensureProject(pid);
      for (const e of entries.filter((x) => x.project === pid)) {
        this.upsertSetting({
          id: `${pid}:${e.type}:${e.name}`,
          projectId: pid,
          type: e.type,
          name: e.name,
          note: e.note || '',
          aliases: e.aliases || [],
        });
        n++;
      }
    }
    return { projects: projects.length, settings: n };
  }
}

module.exports = {
  Store, norm, sqliteReady, normalizeSkillPath, setSkillFormat, SCHEMA_VERSION,
};
