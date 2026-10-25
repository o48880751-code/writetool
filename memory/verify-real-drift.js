/**
 * 真实章节上的状态漂移实测 —— 第2步待验 ① 的答案。
 *
 * ## 为什么要做
 *
 * 规则层面已经完备（test-drift.js 25 用例钉死误报边界），
 * 但「2700 章下漂移率多少」一直没有真实答案。
 * 合成数据验不出真问题——它既没有真实的实体称谓，也没有真实的长篇节奏。
 *
 * 本脚本用《墨染仙途》**真实正文**（章节内容/第一章.md，1654 字）
 * 在**真实设定库**（310 条）上跑状态回写，观察：
 *   1. 能抽到多少实体（抽取率）
 *   2. 位置判定是否成立
 *   3. 在有真实前序状态时，漂移规则会不会误报
 *
 * ⚠️ 诚实边界：**只有 1 个真实章节**（目录里就这一章），
 * 所以「漂移率」无法从单章得出。本脚本测的是
 * 「规则在真实文本上是否成立 + 抽取覆盖度」，
 * 不是「2700 章累计漂移率」。后者仍需长篇正文。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../db/store.js');
const { applyStateAfterCommit, deriveStateChanges, extractEntities } = require('./state-writer.js');
const { detectDrift, parseRealm } = require('./drift-rules.js');
const { discoverAliases } = require('./alias-discovery.js');

const NOVEL_DIR = path.join(os.homedir(), 'AI写小说', '墨染仙途');
const DB = path.join(__dirname, '..', 'data', 'modianditu.db');
const PID = 'modianditu';

if (!fs.existsSync(DB)) {
  console.log('先跑：node memory/import-modianditu.js');
  process.exit(2);
}

const store = new Store(DB);
const settings = store.loadSettings(PID);
const chaptersDir = path.join(NOVEL_DIR, '章节内容');
const files = fs.existsSync(chaptersDir)
  ? fs.readdirSync(chaptersDir).filter((f) => f.endsWith('.md'))
  : [];

console.log(`\n真实正文状态漂移实测　《墨染仙途》`);
console.log('='.repeat(60));
console.log(`设定库：${settings.length} 条　正文章节：${files.length} 章`);

if (!files.length) {
  console.log('\n章节内容目录为空，无法实测。');
  store.close();
  process.exit(2);
}

let pass = 0;
let fail = 0;
const judge = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? `　${detail}` : ''}`);
  if (cond) pass++; else fail++;
};

for (const f of files) {
  const text = fs.readFileSync(path.join(chaptersDir, f), 'utf8');
  console.log(`\n【${f}】${text.length} 字`);

  // ---- 一、实体抽取覆盖度 ----
  const found = extractEntities(text, settings);
  console.log(`\n  一、实体抽取：命中 ${found.size} 个`);
  const byType = {};
  for (const e of found.values()) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log('    按类型：', JSON.stringify(byType));
  console.log('    实体：', [...found.keys()].slice(0, 14).join('、'));

  // 真实正文的实体名覆盖率——这是设定库完备度的直接指标
  const coreChars = [...new Set(text.replace(/[^一-龥]/g, ''))];
  const covered = coreChars.filter((ch) => {
    return settings.some((s) => s.name.includes(ch) || (s.note || '').includes(ch));
  });
  const coverRate = coreChars.length ? Math.round((covered.length / coreChars.length) * 100) : 0;
  console.log(`    汉字覆盖率：${coverRate}%（${covered.length}/${coreChars.length} 个不同汉字在设定库里出现过）`);

  // ---- 二、状态回写 ----
  const chapterId = `real-${f.replace(/\.md$/, '')}`;
  // 用独立的临时库跑，避免污染正式导入的库
  const tmpDb = path.join(os.tmpdir(), `mdy-drift-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const tmp = new Store(tmpDb);
  tmp.createProject({ id: PID, name: '墨染仙途' });
  for (const s of settings) {
    tmp.upsertSetting({
      id: s.id, projectId: PID, type: s.type, name: s.name, note: s.note, aliases: s.aliases,
    });
  }
  tmp.createChapter({ id: chapterId, projectId: PID, title: f.replace(/\.md$/, ''), content: '' });

  const res = applyStateAfterCommit({
    store: tmp, projectId: PID, chapterId, text, settings: tmp.loadSettings(PID),
  });
  console.log(`\n  二、状态回写：${res.summary}`);
  if (res.conflicts.length) {
    res.conflicts.forEach((c) => console.log(`    ⚠️ ${c.entity} [${c.kind}] ${c.hint}`));
  }
  const states = tmp.listEntityStates(PID);
  states.forEach((s) => {
    const st = s.state;
    console.log(`    ${s.entity_name}：location=${st.location || '—'}　轨迹=${JSON.stringify(st.locationHistory || [])}　unverifiedMoves=${st.unverifiedMoves || 0}`);
  });

  judge('状态回写零冲突（单章首章不应报漂移）', res.conflicts.length === 0,
    res.conflicts.length ? `报了 ${res.conflicts.length} 处` : '');
  judge('至少写入了状态', states.length > 0, `${states.length} 条`);

  // ---- 三、简称发现（真实文本上的表现）----
  const found2 = discoverAliases(text, tmp.loadSettings(PID));
  console.log(`\n  三、简称发现：${found2.length} 条未登记简称`);
  found2.slice(0, 6).forEach((a) => console.log(`    ${a.entity} → ${a.suggested.join('、')}（×${a.occurrences}）`));

  // ---- 四、漂移规则在真实前序状态上的表现 ----
  console.log('\n  四、漂移规则（构造真实语境的演进序列）');
  // 夜枫在正文里是「处州城外青石村」的凡人，第一章就该在青石村
  const yefeng = settings.find((s) => s.name === '夜枫');
  const realmNow = yefeng ? (yefeng.note.match(/(?:凡人|练气|凝气|炼气|筑基|结丹|金丹|元婴|化神|炼虚|合体|大乘)[初中后期圆满]*/) || [])[0] : '';
  console.log(`    夜枫设定库记录的起始境界：${realmNow || '（未提取到）'}`);

  // 正常成长：凡人 → 炼气 → 筑基 …… 不应报
  const growth = [
    ['凡人', '炼气'], ['炼气', '筑基'], ['筑基', '筑基后期'],
    ['筑基后期', '结丹'], ['结丹', '金丹'],
  ];
  let growthBad = 0;
  for (const [a, b] of growth) {
    if (detectDrift({ 境界: a }, { 境界: b }).conflict) growthBad++;
  }
  judge('正常成长序列零误报', growthBad === 0, growthBad ? `${growthBad}/${growth.length} 被误报` : `${growth.length} 步全通过`);

  // 真倒退：金丹 → 结丹（跨阶）、筑基后期 → 筑基（掉小层）
  const reals = [
    [{ 境界: '金丹' }, { 境界: '结丹' }],
    [{ 境界: '筑基后期' }, { 境界: '筑基' }],
    [{ 境界: '元婴后期' }, { 境界: '元婴初期' }],
    [{ alive: false }, { alive: true }],
  ];
  let realBad = 0;
  for (const [a, b] of reals) {
    if (!detectDrift(a, b).conflict) realBad++;
  }
  judge('真倒退序列零漏报', realBad === 0, realBad ? `${realBad}/${reals.length} 漏报` : `${reals.length} 类全检出`);

  tmp.close();
  fs.rmSync(tmpDb, { force: true });
}

store.close();

console.log('\n' + '='.repeat(60));
console.log(`真实正文实测：${pass} 通过 / ${fail} 失败`);
console.log('\n诚实边界：');
console.log('  · 本章只能验证「规则在真实文本上成立」与「设定库覆盖度」；');
console.log('  · 「2700 章累计漂移率」仍无答案——目录里目前只有 1 个真实章节，');
console.log('    需要长篇正文跑完整序列才能测。这一条不假装已完成。');
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);