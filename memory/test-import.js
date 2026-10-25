/**
 * 真实设定库导入器的验收。
 *
 * 验收标准只有一条：**不导错**。
 * 设定库里塞错东西比少东西危险得多——「交谈得知乾灵宗」这种碎片
 * 会让检索命中一堆无意义条目，模型读了只会更糊。
 *
 * 真实库规模：`AI写小说/墨染仙途/小说资料/` 下 10 分册 114 万字。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { importModianditu, parseProfiles, parseHeadings, isRealEntity } = require('./import-modianditu.js');

const SRC = path.join(os.homedir(), 'AI写小说', '墨染仙途', '小说资料');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('\n一、实体名闸门（曾把 3269 条碎片灌进库）');

check('通用词被拒（类别名不是实体名）', () => {
  for (const w of ['修士', '宗门', '功法', '法宝', '境界', '天界', '修士之城', '宗门和']) {
    assert(isRealEntity(w) === false, `${w} 应被拒`);
  }
});

check('动词/介词开头的碎片被拒', () => {
  // 实测抽检里出现过的真实碎片
  for (const w of ['交谈得知乾灵宗', '本质是环境', '各附庸宗门和海', '建议夜枫前往海', '出自宗', '看境界']) {
    assert(isRealEntity(w) === false, `${w} 应被拒`);
  }
});

check('真实实体名被收', () => {
  for (const w of ['青阳宗', '乾灵宗', '问道院', '天启帝国', '夜枫', '汪宁', '九雷乾罡诀', '北川境']) {
    assert(isRealEntity(w) === true, `${w} 不应被拒`);
  }
});

console.log('\n二、标题解析（比正文正则可靠的核心）');

check('四级标题能解析（宗门集用 #### 青阳宗）', () => {
  const md = '#### 青阳宗（五行兼备）\n青阳宗立派三百年。\n';
  const r = parseHeadings(md, 'faction');
  assert(r.length === 1, `应解析 1 条，实际 ${r.length}`);
  assert(r[0].name === '青阳宗', `名字错误：${r[0].name}`);
});

check('前缀章节号被剥离并保留实体名（二之二、伊岚境）', () => {
  const md = '### 三之二、伊岚境（西）\n伊岚境多风。\n';
  const r = parseHeadings(md, 'location');
  assert(r.length === 1, `应解析 1 条，实际 ${r.length}`);
  assert(r[0].name === '伊岚境', `名字错误：${r[0].name}`);
});

check('后缀式章节号整条跳过（二之一、三大区域）', () => {
  const md = '### 二之一、三大区域\n三个大区。\n';
  const r = parseHeadings(md, 'location');
  assert(r.length === 0, `章节号不该被当实体，实际 ${JSON.stringify(r.map((x) => x.name))}`);
});

check('书名号全局剥除（雷系功法《九雷乾罡诀》）', () => {
  const md = '### 雷系功法《九雷乾罡诀》\n九雷乾罡诀，共九重。\n';
  const r = parseHeadings(md, 'technique');
  assert(r.length === 1);
  assert(!/[《》]/.test(r[0].name), `残留书名号：${r[0].name}`);
  assert(r[0].name === '九雷乾罡诀', `名字错误：${r[0].name}`);
});

check('代码块内的标题不被误解析', () => {
  const md = '```\n### 代码块里的假标题\n内容\n```\n### 真标题（说明）\n内容\n';
  const r = parseHeadings(md, 'character');
  assert(r.length === 1, `应只解析 1 条，实际 ${JSON.stringify(r.map((x) => x.name))}`);
  assert(r[0].name === '真标题');
});

console.log('\n三、人物档案解析（括号可选——夜枫汪宁就是不带括号的那种）');

check('不带括号的档案能解析', () => {
  const md = '### 夜枫\n- **性别/外观**：男，黑发\n- **境界**：元婴初期\n';
  const r = parseProfiles(md, 'character');
  assert(r.length === 1, `应解析 1 条，实际 ${r.length}`);
  assert(r[0].name === '夜枫');
  assert(r[0].realm === '元婴初期', `境界未提取：${r[0].realm}`);
});

check('带括号的档案能解析并留归属', () => {
  const md = '### 钟岩（东玄大陆）\n- **身份**：散修\n';
  const r = parseProfiles(md, 'character');
  assert(r[0].affiliation === '东玄大陆', `归属丢失：${r[0].affiliation}`);
});

check('结构标题不当作实体（夜枫核心功法 这类）', () => {
  const md = '### 夜枫核心功法\n- **说明**：雷系\n';
  const r = parseProfiles(md, 'character');
  assert(r.length === 0, `结构标题不该进库：${JSON.stringify(r.map((x) => x.name))}`);
});

check('境界时间线只取起始值（汪宁元婴→化神→合体→大乘）', () => {
  const md = '### 汪宁\n- **境界**：第三卷元婴初期巅峰 → 第四卷元婴后期 → 第九卷合体期\n';
  const r = parseProfiles(md, 'character');
  assert(r[0].realm === '元婴初期', `应取首个境界，实际 ${r[0].realm}`);
});

console.log('\n四、端到端导入（真实库）');

check('导入《墨染仙途》真实设定库', () => {
  if (!fs.existsSync(SRC)) throw new Error(`找不到 ${SRC}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdy-import-'));
  const db = path.join(tmp, 'x.db');
  const r = importModianditu(db, SRC);
  assert(r.total > 300, `导入条目过少：${r.total}`);

  const { Store } = require('../db/store.js');
  const store = new Store(db);
  const set = store.loadSettings('modianditu');

  // 关键实体必须在
  for (const k of ['夜枫', '汪宁', '青阳宗', '乾灵宗', '太玄门', '问道院', '萧麟圣', '天启帝国', '伊岚境', '北川境']) {
    assert(set.some((x) => x.name === k), `关键实体缺失：${k}`);
  }
  // 类型不能被章节号污染
  for (const x of set) {
    assert(!/^[〇一二三四五六七八九十百]+\s*之/.test(x.name), `location 混入章节号：${x.name}`);
    assert(!/[《》〈〉]/.test(x.name), `残留书名号：${x.name}`);
  }
  // 碎片不该出现（实测抽检里出现过的）
  for (const frag of ['交谈得知', '本质是', '建议夜枫', '出自宗', '看境界']) {
    assert(!set.some((x) => x.name.includes(frag)), `碎片入库：${frag}`);
  }
  // 每类至少一条，否则摘��保底名额无处可保
  for (const t of ['character', 'faction', 'location', 'technique', 'plot']) {
    assert(set.some((x) => x.type === t), `类型为空：${t}`);
  }

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`      实际导入 ${r.total} 条`);
});

check('前缀命名归一且不误伤泛指（年轻一辈/传人）', () => {
  if (!fs.existsSync(SRC)) throw new Error('找不到源目录');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdy-alias-'));
  const db = path.join(tmp, 'y.db');
  importModianditu(db, SRC);
  const { Store } = require('../db/store.js');
  const store = new Store(db);
  const set = store.loadSettings('modianditu');

  // 「圣皇·萧麟圣」应归一为「萧麟圣」+ 别名「圣皇」
  const x = set.find((s) => s.name === '萧麟圣');
  assert(x, '未归一：找不到「萧麟圣」');
  assert(x.aliases.includes('圣皇'), `别名丢失：${JSON.stringify(x.aliases)}`);

  // 泛指前缀不该被当成实体主名
  assert(!set.some((s) => s.name === '年轻一辈'), '「年轻一辈」被当成实体');
  assert(!set.some((s) => s.name === '传人'), '「传人」被当成实体');

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`导入器：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);

// 局部 require 断言（放在末尾避免污染上方作用域）
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}