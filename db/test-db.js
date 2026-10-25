/**
 * 数据层验收测试（不调模型，秒级）。
 *
 * 验收标准只有一条：**SQLite 版的检索行为必须与内存版一致**。
 * 前面所有实测数据（锚点 100%、链路 100%）都是在内存 world 数组上跑出来的，
 * 如果换到 SQLite 后检索行为变了，那些数据就全部作废。所以这里做逐项比对。
 *
 * 运行：node db/test-db.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Store, normalizeSkillPath } = require('./store.js');
const ROOT = path.resolve(__dirname, '..');
const { makeToolImpl, scoreEntry, QUERY_TOP_K, norm, resolveWorldPath } = require('../run-verify.js');

// 有 world-bible.json 用它，没有就用 samples/ 下的示例库（详见 run-verify.js 的 resolveWorldPath）
const WORLD_JSON = resolveWorldPath();

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`         · ${e.message}`);
  }
}

// ------------------------------------------------------------
// 分段测试：多连接 + Skill 目录式（2026-10-12）。
// 单独成文件是因为它们与「检索行为要与内存版一致」是不同主题。
// 共享这里的 check 计数器，所以汇总是总数。
// ------------------------------------------------------------
require('./test-connections-skill.js').run({
  check,
  section: (t) => console.log('', t),
  store: Store,
  norm: normalizeSkillPath,
  ROOT,
  assert,
  fs,
  path,
  os,
});

function main() {
  console.log('\n数据层验收测试（SQLite）\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'writetool-db-'));
  const store = new Store(path.join(tmp, 'test.db'));
  const memWorld = JSON.parse(fs.readFileSync(WORLD_JSON, 'utf8')).entries;

  // ----------------------------------------------------------
  console.log('一、schema 与导入');

  check('schema 建表成功（11 张表）', () => {
    const rows = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    const expected = [
      'projects', 'chapters', 'settings', 'setting_aliases', 'plot_threads',
      'skills', 'style_samples', 'conversations', 'messages', 'entity_states',
    ];
    for (const t of expected) assert.ok(rows.includes(t), `缺表 ${t}`);
  });

  check('导入 world-bible.json：2 项目 20 条设定', () => {
    const r = store.importWorldBible(WORLD_JSON, (pid) => {
      store.createProject({ id: pid, name: `项目 ${pid}` });
    });
    assert.strictEqual(r.projects, 2, `项目数应为 2，实际 ${r.projects}`);
    assert.strictEqual(r.settings, 20, `设定数应为 20，实际 ${r.settings}`);
  });

  check('导入幂等：重复导入不产生重复行', () => {
    store.importWorldBible(WORLD_JSON, (pid) => {
      store.createProject({ id: pid, name: `项目 ${pid}` });
    });
    const n = store.db.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
    assert.strictEqual(n, 20, `重复导入后应仍为 20 条，实际 ${n}`);
  });

  check('别名独立存储且可读回', () => {
    const s = store.loadSettings('novel-demo-01');
    const xie = s.find((e) => e.name === '谢九');
    assert.ok(xie, '谢九 应存在');
    assert.ok(xie.aliases.includes('小九'), `谢九别名应为 小九，实际 ${JSON.stringify(xie.aliases)}`);
  });

  // ----------------------------------------------------------
  console.log('\n二、检索行为与内存版逐项比对（关键）');

  const P1 = 'novel-demo-01';
  const dbWorld = store.loadSettings(P1);
  const memScope = memWorld.filter((e) => e.project === P1);

  check('loadSettings 返回形状与 world 数组一致', () => {
    assert.strictEqual(dbWorld.length, memScope.length, '条目数不一致');
    for (const e of dbWorld) {
      assert.ok(typeof e.name === 'string', 'name 必须是字符串');
      assert.ok(typeof e.type === 'string', 'type 必须是字符串');
      assert.ok(Array.isArray(e.aliases), 'aliases 必须是数组');
      assert.ok(typeof e.note === 'string', 'note 必须是字符串');
    }
  });

  const QUERIES = ['谢九', '洛三娘', '铁棺', '乱葬岗', '赤霄宗', '赤霄', '剑冢', '剑', '宗', '丹', '魂', '灵', '不存在'];

  check('同查询下 SQLite 与内存版打分完全一致', () => {
    const mismatches = [];
    for (const q of QUERIES) {
      for (const ty of [null, 'character', 'location']) {
        const a = dbWorld
          .map((e) => ({ e, s: scoreEntry(e, q, ty) }))
          .filter((x) => x.s > 0)
          .sort((x, y) => (y.s - x.s) || (x.e.name.length - y.e.name.length) || x.e.name.localeCompare(y.e.name));
        const b = memScope
          .map((e) => ({ e, s: scoreEntry(e, q, ty) }))
          .filter((x) => x.s > 0)
          .sort((x, y) => (y.s - x.s) || (x.e.name.length - y.e.name.length) || x.e.name.localeCompare(y.e.name));
        if (a.length !== b.length) {
          mismatches.push(`q=${q} type=${ty} 条数 ${a.length} vs ${b.length}`);
        } else {
          for (let i = 0; i < a.length; i++) {
            if (a[i].e.name !== b[i].e.name || a[i].s !== b[i].s) {
              mismatches.push(`q=${q} type=${ty} 第${i}位 ${a[i].e.name}/${a[i].s} vs ${b[i].e.name}/${b[i].s}`);
              break;
            }
          }
        }
      }
    }
    assert.strictEqual(mismatches.length, 0, `不一致项：\n         ${mismatches.join('\n         ')}`);
  });

  check('完整实体名稳定命中首位（双库各测一遍）', () => {
    const memTool = makeToolImpl(memWorld, { segments: [], chapters: [] });
    const dbTool = makeToolImpl(store.loadAllSettings(), { segments: [], chapters: [] });
    const probes = [
      ['谢九', 'novel-demo-01'], ['洛三娘', 'novel-demo-01'], ['铁棺', 'novel-demo-01'],
      ['乱葬岗', 'novel-demo-01'], ['赤霄宗', 'novel-demo-01'],
      ['凛江月', 'novel-demo-02'], ['见岢坛', 'novel-demo-02'], ['悬风钟', 'novel-demo-02'],
    ];
    for (const [q, pid] of probes) {
      const a = memTool.query_world_bible({ project_id: pid, query: q });
      const b = dbTool.query_world_bible({ project_id: pid, query: q });
      assert.ok(a.hits.length > 0, `内存版 ${q} 无命中`);
      assert.strictEqual(b.hits.length > 0, true, `SQLite 版 ${q} 无命中`);
      assert.strictEqual(
        b.hits[0].name, a.hits[0].name,
        `${q} 首位不一致：内存 ${a.hits[0].name} vs SQLite ${b.hits[0].name}`
      );
    }
  });

  check('top_k 截断生效且 truncated 标记正确', () => {
    const tool = makeToolImpl(store.loadAllSettings(), { segments: [], chapters: [] });
    const r = tool.query_world_bible({ project_id: P1, query: '剑' });
    assert.ok(r.hits.length <= QUERY_TOP_K, `返回 ${r.hits.length} 条，超过 top_k=${QUERY_TOP_K}`);
    if (r.total_matches > r.hits.length) {
      assert.strictEqual(r.truncated, true, '被截断时 truncated 应为 true');
      assert.ok(typeof r.hint === 'string' && r.hint.length > 0, '被截断时必须给出 hint');
    }
  });

  check('项目隔离：跨库实体不可见', () => {
    const tool = makeToolImpl(store.loadAllSettings(), { segments: [], chapters: [] });
    const r = tool.query_world_bible({ project_id: P1, query: '凛江月' });
    assert.strictEqual(r.count, 0, `A 库不应查到 B 库实体凛江月，实际 ${r.count} 条`);
  });

  check('缺 project_id 被拒', () => {
    const tool = makeToolImpl(store.loadAllSettings(), { segments: [], chapters: [] });
    const r = tool.query_world_bible({ query: '谢九' });
    assert.strictEqual(r.ok, false, '缺 project_id 应返回 ok:false');
  });

  // ----------------------------------------------------------
  console.log('\n三、伏笔表（新增能力）');

  check('创建伏笔并落库', () => {
    store.createChapter({ id: 'c1', projectId: P1, title: '第一章', content: '铁棺北侧第三根棺钉刻着「归」字。' });
    store.createThread({ id: 't1', projectId: P1, name: '归字棺钉', summary: '铁棺上的归字暗示来历', plantedIn: 'c1', importance: 5 });
    const t = store.db.prepare('SELECT * FROM plot_threads WHERE id = ?').get('t1');
    assert.ok(t, '伏笔未落库');
    assert.strictEqual(t.status, 'open');
    assert.strictEqual(t.importance, 5);
    assert.strictEqual(t.planted_in, 'c1');
  });

  check('未回收伏笔按重要度降序', () => {
    store.createThread({ id: 't2', projectId: P1, name: '小伏笔', summary: '', importance: 1 });
    store.createThread({ id: 't3', projectId: P1, name: '中伏笔', summary: '', importance: 3 });
    const open = store.listOpenThreads(P1);
    assert.deepStrictEqual(open.map((t) => t.name), ['归字棺钉', '中伏笔', '小伏笔']);
  });

  check('回收伏笔后从open 列表移出', () => {
    store.createChapter({ id: 'c9', projectId: P1, title: '第九章', content: '归字揭晓。' });
    store.resolveThread('t1', 'c9');
    const open = store.listOpenThreads(P1);
    assert.ok(!open.find((t) => t.id === 't1'), '已回收伏笔仍在 open 列表');
    const all = store.listThreads(P1);
    const t1 = all.find((t) => t.id === 't1');
    assert.strictEqual(t1.status, 'resolved');
    assert.strictEqual(t1.resolved_in, 'c9');
  });

  // ----------------------------------------------------------
  console.log('\n四、章节与状态表');

  check('章节覆盖：revision 自增 + 内容更新', () => {
    assert.strictEqual(store.updateChapterContent('c1', '改写后的内容。'), 1);
    const ch = store.getChapter('c1');
    assert.strictEqual(ch.content, '改写后的内容。');
    assert.strictEqual(ch.revision, 2, `revision 应为 2，实际 ${ch.revision}`);
    assert.strictEqual(ch.word_count, 7, '字数应同步更新');
  });

  check('覆盖前备份 .bak 可恢复', () => {
    const dir = path.join(tmp, 'chapters');
    const bak = store.backupChapter('c1', dir);
    assert.ok(fs.existsSync(bak), '备份文件未生成');
    assert.strictEqual(fs.readFileSync(bak, 'utf8'), '改写后的内容。');
  });

  check('外键约束生效：删项目级联删章节', () => {
    store.db.exec("INSERT INTO projects (id,name) VALUES ('tmp-p','临时')");
    store.createChapter({ id: 'tc1', projectId: 'tmp-p', title: '临时章' });
    store.db.prepare('DELETE FROM projects WHERE id = ?').run('tmp-p');
    const n = store.db.prepare('SELECT COUNT(*) AS c FROM chapters WHERE id = ?').get('tc1').c;
    assert.strictEqual(n, 0, '删项目后章节未级联删除');
  });

  check('角色状态表 upsert 幂等', () => {
    store.setEntityState({ projectId: P1, entityName: '夜枫', state: { location: '洛阳', alive: true } });
    store.setEntityState({ projectId: P1, entityName: '夜枫', state: { location: '剑冢', alive: true } });
    const s = store.getEntityState(P1, '夜枫');
    assert.strictEqual(s.state.location, '剑冢', '状态未更新');
    assert.strictEqual(s.state.alive, true);
    const n = store.db.prepare('SELECT COUNT(*) AS c FROM entity_states WHERE project_id=? AND entity_name=?').get(P1, '夜枫').c;
    assert.strictEqual(n, 1, `同名状态应只有 1 行，实际 ${n}`);
  });

  check('retired 设定不参与检索', () => {
    store.upsertSetting({
      id: `${P1}:character:谢九`, projectId: P1, type: 'character',
      name: '谢九', note: '已退场', aliases: ['小九'], status: 'retired',
    });
    const after = store.loadSettings(P1);
    assert.ok(!after.find((e) => e.name === '谢九'), 'retired 设定仍在 loadSettings 结果中');
    store.upsertSetting({
      id: `${P1}:character:谢九`, projectId: P1, type: 'character',
      name: '谢九', note: '赤霄宗外门弟子', aliases: ['小九'], status: 'active',
    });
  });

  check('章节按项目隔离列出', () => {
    const a = store.listChapters(P1).map((c) => c.id);
    const b = store.listChapters('novel-demo-02').map((c) => c.id);
    assert.ok(a.length > 0, 'A库 应有章节');
    assert.strictEqual(b.length, 0, 'B 库不应有 A 库的章节');
  });

  /**
   * listChapters 刻意不返回 content（侧栏列表有几百章，全量拉正文会卡 UI），
   * 风格画像却必须读正文 —— 所以两个方法必须分开，且行为要钉死。
   * 早期 main.js 误用 listChapters 取 content，拿到 undefined，
   * 风格面板永久显示「不可用」，且不报错，很难定位。
   */
  check('listChapters 不返回 content，listRecentChapterContents 返回', () => {
    const listed = store.listChapters(P1);
    assert.ok(listed.length > 0);
    assert.ok(!('content' in listed[0]), 'listChapters 不应返回 content');

    const bodies = store.listRecentChapterContents(P1, 5);
    assert.ok(Array.isArray(bodies));
    assert.ok(bodies.length > 0, '应能取到正文');
    assert.ok(bodies.every((b) => typeof b === 'string' && b.length > 0));
  });

  check('listRecentChapterContents 遵守 limit 且按时间倒序', () => {
    const all = store.listRecentChapterContents(P1, 100);
    const few = store.listRecentChapterContents(P1, 2);
    assert.ok(few.length <= 2, `limit 2 应最多返回 2 章，实际 ${few.length}`);
    if (all.length >= 2) {
      assert.strictEqual(few[0], all[0], '取最近的 N 章，第一个应是最新');
      assert.strictEqual(few[few.length - 1], all[few.length - 1]);
    }
  });

  check('listRecentChapterContents 按项目隔离', () => {
    const b = store.listRecentChapterContents('novel-demo-02', 10);
    assert.strictEqual(b.length, 0, 'B 库不应有 A 库的正文');
  });

  // ----------------------------------------------------------
  console.log('\n五、对话与技能（2026-11 对话式界面启用）');

  check('对话 CRUD 完整', () => {
    const c = store.createConversation({ projectId: P1, title: '第一章开头怎么写' });
    assert(c && c.id, '应返回创建好的对话');
    assert.strictEqual(store.getConversation(c.id).title, '第一章开头怎么写');

    store.renameConversation(c.id, '改过的标题');
    assert.strictEqual(store.getConversation(c.id).title, '改过的标题');

    store.addMessage({ conversationId: c.id, role: 'user', content: '帮我写开头' });
    store.addMessage({ conversationId: c.id, role: 'assistant', content: '夜枫走出城门…' });
    assert.strictEqual(store.countMessages(c.id), 2, '应有 2 条消息');

    const n = store.deleteConversation(c.id);
    assert(n > 0, '删除应返回影响行数');
    assert.strictEqual(store.getConversation(c.id), null, '对话应已删除');
    assert.strictEqual(store.countMessages(c.id), 0, '消息应级联删除');
  });

  /**
   * 思考强度跟着对话走（2026-10-13）。
   *
   * 羽毛菌的要求：「简单文字修改问答用低或者关闭，创意框架用高」——
   * 档位取决于这一轮要干什么，而一个对话通常就是一个任务。
   */
  check('思考档位能存在对话上，并跟着列表读回来', () => {
    const c = store.createConversation({ projectId: P1, title: '搭世界观框架' });
    // 别名必须是驼峰：界面写 c.thinkLevel，库里是 think_level。
    // 少了别名，界面读到的永远是 undefined，
    // 表现是"档位设了不生效、切走再回来又变回默认"。
    assert.strictEqual(c.thinkLevel, '', '新对话的档位应该是空串（=跟随全局默认）');

    store.setConversationThinkLevel(c.id, 'high');
    assert.strictEqual(store.getConversation(c.id).thinkLevel, 'high',
      'getConversation 没把 think_level 取出来');

    const inList = store.listConversations(P1).find((x) => x.id === c.id);
    assert(inList, '列表里找不到刚建的对话');
    assert.strictEqual(inList.thinkLevel, 'high',
      'listConversations 没把 think_level 取出来 —— 切对话时档位不会跟着变');
  });

  check('★ 非法档位被归一，不会原样落库', () => {
    // level 从渲染进程来，最终会被拼进请求体。
    // 不校验的话，"high; drop table" 这类值会一路走到 provider 的映射表里。
    const c = store.createConversation({ projectId: P1, title: '校验' });
    store.setConversationThinkLevel(c.id, "high'; DROP TABLE conversations;--");
    assert.strictEqual(store.getConversation(c.id).thinkLevel, 'off',
      '非法档位应归一成 off');
    // 表还在（上面那条 SQL 若真被执行了，这里会抛 no such table）
    assert.ok(Array.isArray(store.listConversations(P1)), 'conversations 表被搞掉了');
  });

  /**
   * ⚠ 这条钉的是"老库升上来"这条路。
   *
   * 建表语句全是 `CREATE TABLE IF NOT EXISTS` —— 表已经在了就整条跳过，
   * **新加的列不会生效**。于是老用户的库缺列，一查就是
   * `no such column: think_level`，而错误发生在查询里、
   * 离"少了一次迁移"这个原因很远。
   */
  check('★ 老库（没有 think_level 列）打开时自动补列', () => {
    const { DatabaseSync } = require('node:sqlite');
    const oldPath = path.join(tmp, 'old-schema.db');
    // 造一个"升级前"的 conversations：就是加 think_level 之前的那一版
    // （五列，缺 think_level）。不能只写三列——那样连 created_at
    // 都没有，失败原因会是"缺别的列"，跟这条用例要验的事无关。
    const raw = new DatabaseSync(oldPath);
    raw.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);
    raw.exec("INSERT INTO conversations (id, project_id, title) VALUES ('cv-old','p-old','老对话')");
    raw.close();

    const s2 = new Store(oldPath);
    const cols = s2.db.prepare('PRAGMA table_info(conversations)').all().map((r) => r.name);
    assert(cols.includes('think_level'), `补列失败，现有列：${cols.join(', ')}`);
    // 老数据必须还在——补列不能重建表
    assert.strictEqual(s2.getConversation('cv-old').title, '老对话', '补列把老数据搞丢了');
    assert.strictEqual(s2.getConversation('cv-old').thinkLevel, '', '补出来的列应有默认值');
    s2.close();
  });

  /**
   * ⚠ 这条用例是为一个真 bug 写的。
   *
   * 原写法是 `ORDER BY created_at DESC, rowid DESC` 放在子查询里，
   * 但 `SELECT * FROM (子查询)` 只暴露子查询 SELECT 列表里的列，
   * rowid 不在其中 → `no such column: rowid`。
   *
   * 而 rowid 二级排序是**必需的**：created_at 精度只到秒，
   * 流式回答常在同一秒内写入多条，只按 created_at 排会乱序。
   */
  check('同一秒内的多条消息顺序正确（rowid 二级排序）', () => {
    const c = store.createConversation({ projectId: P1, title: '顺序测试' });
    for (let i = 1; i <= 6; i++) {
      store.addMessage({ conversationId: c.id, role: i % 2 ? 'user' : 'assistant', content: `第${i}条` });
    }
    const ms = store.listMessages(c.id);
    assert.strictEqual(ms.length, 6, `应有 6 条，实际 ${ms.length}`);
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(ms[i].content, `第${i + 1}条`, `第 ${i + 1} 条顺序错：实际「${ms[i].content}」`);
    }
    store.deleteConversation(c.id);
  });

  check('listMessages 取最近 N 条但仍按时间正序返回', () => {
    const c = store.createConversation({ projectId: P1, title: '截断测试' });
    for (let i = 1; i <= 10; i++) {
      store.addMessage({ conversationId: c.id, role: 'user', content: `消息${i}` });
    }
    const ms = store.listMessages(c.id, 3);
    assert.strictEqual(ms.length, 3, `limit 3 应返回 3 条，实际 ${ms.length}`);
    // 取的是最近 3 条（第 8/9/10），但返回顺序要正序
    assert.strictEqual(ms[0].content, '消息8', `实际「${ms[0].content}」`);
    assert.strictEqual(ms[2].content, '消息10', `实际「${ms[2].content}」`);
    store.deleteConversation(c.id);
  });

  check('对话按项目隔离', () => {
    const a = store.createConversation({ projectId: P1, title: 'A 的对话' });
    const b = store.createConversation({ projectId: 'novel-demo-02', title: 'B 的对话' });
    const la = store.listConversations(P1).map((x) => x.id);
    const lb = store.listConversations('novel-demo-02').map((x) => x.id);
    assert(la.includes(a.id) && !la.includes(b.id), 'A 库不应出现 B 的对话');
    assert(lb.includes(b.id) && !lb.includes(a.id), 'B 库不应出现 A 的对话');
    store.deleteConversation(a.id);
    store.deleteConversation(b.id);
  });

  check('内置技能可 seed 且幂等', () => {
    // ⚠ 2026-10-12 起必须传 loadBuiltin：内置技能里有两条是**目录式**的
    //   （SKILL.md + references/ 在磁盘上，不在 JS 里）。
    //   不传会抛「目录读不到」——这是故意的：
    //   静默跳过的话，打包漏了目录用户却只看到「技能不见了」。
    const loadBuiltin = require(path.join(ROOT, 'db', 'builtin-skills.js')).loadBuiltin;
    const r = store.seedBuiltinSkills(loadBuiltin);
    assert(r.seeded > 0, '应至少装上一个内置技能');
    const list = store.listSkills(P1);
    assert(list.length >= r.seeded,
      `技能数 ${list.length} 应不少于新装的 ${r.seeded}`);
    // 重复 seed 不产生副本
    const again = store.seedBuiltinSkills(loadBuiltin);
    assert(again.seeded === 0, `重复 seed 又装了 ${again.seeded} 个`);
    assert.strictEqual(store.listSkills(P1).length, list.length, '重复 seed 不应增加技能');
    const builtin = list.filter((s) => s.type === 'built-in');
    assert(builtin.length >= 5, `内置技能应不少于 5 个，实际 ${builtin.length}`);
  });

  check('★ 两个目录式内置技能装上了，且配套文件也入库', () => {
    const list = store.listSkills(P1);
    const nw = list.find((s) => s.name === '写新章节');   // 原名「小说写作助手」，2026-10 改名
    const sc = list.find((s) => s.name === '技能创建助手');
    assert(nw, '写新章节（sk-novel-writer）没装上');
    assert(sc, '技能创建助手没装上');
    // ⚠ 正文要够长才说明真的读到了 SKILL.md（单条提示词只有三十来字）
    assert(nw.prompt_content.length > 800,
      `正文只有 ${nw.prompt_content.length} 字 —— 读到的可能是占位内容`);
    // 配套文件必须在库里
    const files = store.listSkillFiles(nw.id);
    assert(files.length >= 1, '写新章节的 references 没入库');
    assert(files.some((f) => f.path === 'references/templates.md'),
      `references/templates.md 不在库里：${JSON.stringify(files.map(f=>f.path))}`);
    // ⚠ 正文里提到的配套文件必须真的存在。
    //   模型会照着正文里的路径去找，找不到就是一次失败的读取。
    for (const sk of [nw, sc]) {
      for (const f of store.listSkillFiles(sk.id)) {
        const mentioned = sk.prompt_content.includes(f.path);
        assert(mentioned,
          `${sk.name} 的 ${f.path} 存了但正文里没提 —— `
          + '配套文件不写进正文，模型根本不知道它存在');
      }
    }
  });

  check('技能带可用的 prompt 内容', () => {
    const list = store.listSkills(P1);
    const withPrompt = list.filter((s) => s.prompt_content && s.prompt_content.length > 8);
    assert(withPrompt.length >= 5,
      `至少 5 个技能要有实质 prompt，实际 ${withPrompt.length} 个有`);
  });

  check('项目级技能与内置技能并存', () => {
    const custom = store.createSkill({ projectId: P1, name: '我的技能', promptContent: '按我的要求写' });
    const list = store.listSkills(P1);
    assert(list.some((s) => s.id === custom.id), '应列出项目级技能');
    assert(list.some((s) => s.type === 'built-in'), '应同时列出内置技能');
    // 另一个项目不应看到这个项目级技能
    const other = store.listSkills('novel-demo-02');
    assert(!other.some((s) => s.id === custom.id), 'B 库不应看到 A 库的技能');
    store.deleteSkill(custom.id);
  });

  check('禁用技能不出现在默认列表', () => {
    const off = store.createSkill({ projectId: P1, name: '关掉的技能', promptContent: 'x', enabled: false });
    assert(!store.listSkills(P1).some((s) => s.id === off.id), '禁用的技能不应出现在默认列表');
    assert(store.listSkills(P1, true).some((s) => s.id === off.id), 'includeDisabled 时应能看到');
    store.deleteSkill(off.id);
  });

  // ----------------------------------------------------------
  console.log('\n六、性能（数千条规模）');

  check('2000 条设定下查询延迟 < 50ms', () => {
    for (let i = 0; i < 2000; i++) {
      store.upsertSetting({
        id: `bulk-${i}`, projectId: P1, type: 'location',
        name: `批量地点${i}号`, note: `批量条目 ${i}`, aliases: [],
      });
    }
    const world = store.loadSettings(P1);
    const tool = makeToolImpl(world, { segments: [], chapters: [] });
    const t0 = Date.now();
    const r = tool.query_world_bible({ project_id: P1, query: '谢九' });
    const ms = Date.now() - t0;
    assert.ok(r.count > 0, '2000 条规模下应仍能查到谢九');
    assert.ok(ms < 50, `查询耗时 ${ms}ms，超过 50ms 预算`);
    console.log(`         · ${world.length} 条设定，查询 ${ms}ms，命中 ${r.count} 条`);
  });

  // ----------------------------------------------------------
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${'-'.repeat(52)}`);
  console.log(`用例 ${passed + failed}　通过 ${passed}　失败 ${failed}`);
  if (failed === 0) {
    console.log('数据层可用：检索行为与内存版一致，伏笔表已就位。');
  } else {
    console.log('存在失败项，不要在此基础上继续开发。');
    process.exitCode = 1;
  }
}

main();