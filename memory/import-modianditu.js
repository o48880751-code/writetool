/**
 * 《墨染仙途》真实设定库 → SQLite 导入器。
 *
 * ## 为什么必须做这件事
 *
 * 前面所有检索层与摘要层的实测都跑在 `world-bible.json`（13+7 条合成数据）上。
 * 真实设定库是 `AI写小说/墨染仙途/小说资料/` 下**10 个分册、114 万字**的非结构化 Markdown，
 * 人物库单文件 26 万字。两者的规模差三个数量级，噪声形态也完全不同
 * （合成库的噪声是随机汉字，真实库的噪声是「规则设定」——命名约束、五行用字、库位说明）。
 *
 * 不导入真实库就上生产，等于在 20 条数据上验证完直接跳到数千条。
 *
 * ## 导入策略：只解析能可靠解析的部分，不猜
 *
 * 人物库格式：`### 名字（归属）` + 后续 `- **字段**：值` 列表。
 * 能可靠提取的：名字、归属（括号内）、境界值、剧情作用（截断）、身份。
 * **不能可靠解析的**（如「一档/二档姓氏规则」这类整段规范）明确跳过——
 * 宁可少导，不可导错。设定库最不能出错的就是设定本身。
 *
 * 用法：
 *   node memory/import-modianditu.js <小说资料目录> [项目ID]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../db/store.js');
const { parseRealm } = require('./drift-rules.js');

/** 分册 → 设定类型。类型必须与 settings.type 的 CHECK 约束一致 */
const SHELF_TYPE = {
  '人物库.md': 'character',
  '功法与阵法集.md': 'technique',
  '宗门集.md': 'faction',
  '地图相关.md': 'location',
  '妖兽灵宠集.md': 'character',   // 妖兽按实体参与剧情，归 character
  '丹药与法宝集.md': 'technique',
  '特殊道具集.md': 'plot',
  '副本集合.md': 'plot',
  '天界大事年表.md': 'plot',
  // ⚠️ 世界观.md 不能当实体分册解析——它是整段规范文本，
  // 里面的宗门/地点是内嵌在表格与条目中的（实测「青阳宗」在 382 行的表格单元里）。
  // 它由 extractInlineEntities 单独处理。
};

/**
 * 明确不是实体的标题词——命中即跳过。
 *
 * 实测踩过的坑：早期把 `### 夜枫核心功法` 这种**章节标题**当成了实体名，
 * 于是库里出现「夜枫核心功法」「与夜枫线关联」这种伪实体，
 * 检索「夜枫」时它们挤占首位（首位精确命中 0/9）。这类词必须排除。
 */
const NOT_ENTITY = /^(规则|命名|约束|注意|说明|禁止|附|第[一二三四五六七八九十]|附录|目录|备注|索引|卷|部)/;
// 「XX核心功法」「XX线关联」「与XX关系」等是结构标题不是实体
const STRUCTURAL = /(核心功法|线关联|的?关系|体系|总览|一览|清单|汇总|要点|命名规范|使用说明|等级体系|对照表|索引)$/;

/** 从一行里抠出字段值 */
function field(line, keys) {
  for (const k of keys) {
    const m = line.match(new RegExp(`\\*\\*${k}\\*\\*[:：]\\s*(.+)$`));
    if (m) return m[1].trim();
  }
  return '';
}

/** 清理 markdown 标记与强调符，压成纯文本 */
function clean(s, maxLen = 300) {
  if (!s) return '';
  return String(s)
    .replace(/\*\*/g, '')
    .replace(/^[-·]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * 解析人物档案。
 *
 * 格式有两种，都必须认：
 *   `### 夜枫`                ← 不带括号（主角与女主就是这种）
 *   `### 钟岩（东玄大陆）`     ← 带括号
 * 早期正则强制要求括号，导致 147 条 h3 只解析出 144 条，
 * 而漏掉的恰好是「夜枫」「汪宁」——**两个最重要的人物**。
 */
function parseProfiles(md, type) {
  const lines = md.split('\n');
  const out = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.name) out.push(cur);
    cur = null;
  };

  for (const raw of lines) {
    // 括号可选
    const m = raw.match(/^###\s+(.{1,40}?)(?:（(.{0,60}?)）)?\s*$/);
    if (m) {
      flush();
      const name = clean(m[1], 30);
      if (!name || name.length < 2) { cur = null; continue; }
      if (NOT_ENTITY.test(name) || STRUCTURAL.test(name)) { cur = null; continue; }
      cur = {
        type,
        name,
        affiliation: clean(m[2] || '', 60),
        realm: '',
        identity: '',
        role: '',
      };
      continue;
    }
    // h2 及更高级标题结束当前档案（进入下一个集合区）
    if (/^#{1,2}\s/.test(raw)) { flush(); continue; }
    if (!cur) continue;

    if (!cur.realm) {
      // 境界字段常常带时间线（「第三卷元婴初期 → 第四卷化神后期」），
      // 只取**第一个**可解析的境界作为起始值——完整时间线留在 note 里。
      const r = field(raw, ['境界']);
      if (r) {
        const first = r.match(/(?:凡人|练气|凝气|炼气|筑基|结丹|金丹|元婴|化神|炼虚|合体|大乘)[初中后期圆满]*/);
        if (first && parseRealm(first[0])) cur.realm = clean(first[0], 20);
      }
    }
    if (!cur.identity) {
      const i = field(raw, ['身份', '职位', '所属', '势力']);
      if (i) cur.identity = clean(i, 120);
    }
    if (!cur.role) {
      const r = field(raw, ['剧情作用', '剧情功能', '作用', '定位', '心性弧线']);
      if (r) cur.role = clean(r, 220);
    }
  }
  flush();
  return out;
}

/** 从整册正文里抽「明确写成条目的事物名」（功法/丹药/地点/妖兽名） */
function parseNamedItems(md, type) {
  const out = [];
  const seen = new Set();
  // 标题型：`## 某某` / `### 某某`
  const re = /^#{2,3}\s+(.{2,30}?)\s*$/gm;
  let m;
  while ((m = re.exec(md))) {
    let name = clean(m[1], 30)
      .replace(/[（(].*?[)）]/g, '')     // 去括号注释
      .replace(/^[〇一二三四五六七八九十]+、/, '')
      .trim();
    if (!name || name.length < 2 || name.length > 20) continue;
    if (/^(第[一二三四五六七八九十]+|附录|目录|说明|备注|索引)/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    // 抓标题后第一段非空文字作为 note
    const tail = md.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const noteLine = tail.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
    out.push({ type, name, affiliation: '', realm: '', identity: '', role: clean(noteLine || '', 180) });
  }
  return out;
}

/**
 * 从规范型正文里抽内嵌实体。
 *
 * ## 为什么需要
 *
 * `世界观.md`（12.9 万字）是**整段规范文本**，不是实体档案册。
 * 实测「青阳宗」在第 382 行的表格单元里、「赤火真气」在功法集的正文描述里——
 * 不做这一步，检索这些词会直接 0 命中，而它们恰恰是全书最重要的名词。
 *
 * ## 策略：靠后缀模式识别，不靠穷举
 *
 * 中文小说里实体名有极强的后缀规律：
 *   X宗/X门/X派/X盟 → 势力　X城/X州/X境/X山/X谷/X海 → 地点
 *   X诀/X经/X法/X术/X功 → 功法　X剑/X刀/X枪/X印/X鼎 → 法宝
 * 只收 2~6 字、带明确后缀、且不在常见词表里的词。
 * **宁可漏收，不可错收**——设定库里塞错东西比少东西危险得多。
 */
const INLINE_PATTERNS = [
  // 注意：后缀正则**不要带 $ 锚**——拼接时会自己加 `${suffix}` 再跟后面。
  // 早期写成 /(宗|门|...)$/ 再拼 `...${suffix.source}$` 变成双锚点，永远匹配不上。
  { type: 'faction', suffix: /(宗|门|派|盟|阁|楼|殿|宫|教|帮|世家)/, min: 2, max: 6 },
  { type: 'location', suffix: /(城|州|县|境|域|山|岭|谷|海|渊|岛|原|荒|秘境|界)/, min: 2, max: 6 },
  { type: 'technique', suffix: /(诀|经|法|术|功|刀法|剑法|心法|真解|秘术|神通)/, min: 2, max: 7 },
];

/**
 * 通用词黑名单——这些是**类别名**不是实体名。
 * 「修士」「宗门」在正文里出现上千次，收进库毫无检索价值，
 * 只会让单字查询命中数暴涨。
 */
const GENERIC_WORDS = new Set([
  '修士', '宗门', '门派', '长老', '弟子', '宗主', '掌门', '功法', '法术', '法宝',
  '秘境', '洞天', '家族', '王朝', '帝国', '境界', '修为', '灵石', '丹药', '法器',
  '阵法', '禁地', '仙界', '魔界', '人界', '天界', '妖界', '冥界', '神界',
  '修士之城', '宗门和', '境内', '诸宗', '各宗', '本宗', '上宗', '大宗门',
  '修士们', '宗门内', '宗门中', '区域内', '世界上', '空间内', '本质上',
  '功法等', '宗门等', '秘境等', '修士等', '界等', '境内亦',
]);

/**
 * 判定候选词是否是真实体。
 *
 * ## 为什么必须有这道闸（实测教训）
 *
 * 没有这道闸时抽检 25 条，绝大多数是碎片：
 *   「交谈得知乾灵宗」「本质是环境」「各附庸宗门和海」「建议夜枫前往海」
 * ——后缀在，但词左边是动词/介词，语法上根本不构成名词短语。
 * 库从 378 条涨到 3647 条，其中 3269 条是垃圾。
 *
 * 规则（宁可漏收，不可错收）：
 *   1. 不在通用词黑名单
 *   2. 长度 2~6
 *   3. 词首不能是动词/介词/代词
 *   4. 词尾不能是连接词
 *   5. 不能含「本质/建议/交谈/得知」这类语义标志
 */
const BAD_HEAD = /^[取得来去说出自前往上下内外这本该看听闻见遇知想需可会想要]/;
const BAD_TAIL = /[和及或与的了着过是在有为被把从]$/;
const BAD_SEMANTIC = /(本质|建议|交谈|得知|包括|例如|之类|等等|各自|若干|诸多|各类|种种|成为|作为)/;

/**
 * 泛指类别词——语法合法、不是动词开头，但**不是实体**。
 *
 * 实测来源：`### 萧氏皇族·年轻一辈` 与 `### 三大隐世家族·传人`，
 * 前缀归一后主名变成「年轻一辈」「传人」——它们指的是一整类人，
 * 不是一个具体角色。收进库会让检索「传人」命中毫无意义的条目。
 */
const GENERIC_NOUNS = new Set([
  '年轻一辈', '传人', '后代', '子孙', '本代', '上代', '老一辈', '小辈',
  '弟子们', '长老们', '族人', '修士们', '众人', '各方', '各方势力',
  '一代', '几代', '数代', '全族', '一族', '一族人', '三类', '几类',
]);

function isRealEntity(name) {
  if (!name || name.length < 2 || name.length > 6) return false;
  if (GENERIC_WORDS.has(name)) return false;
  if (GENERIC_NOUNS.has(name)) return false;
  if (BAD_HEAD.test(name)) return false;
  if (BAD_TAIL.test(name)) return false;
  if (BAD_SEMANTIC.test(name)) return false;
  return true;
}

function extractInlineEntities(md) {
  const found = new Map();
  const lines = md.split('\n');
  for (const line of lines) {
    // 跳过纯规则/说明行——它们里的枚举不是实体清单
    const text = line.replace(/\*\*/g, '').replace(/[>|]/g, ' ');
    for (const p of INLINE_PATTERNS) {
      const re = new RegExp(`([\\u4e00-\\u9fa5]{${p.min},${p.max}}${p.suffix.source})`, 'g');
      let m;
      while ((m = re.exec(text))) {
        const name = m[1];
        if (!isRealEntity(name)) continue;
        if (found.has(name)) { found.get(name).hits++; continue; }
        found.set(name, { type: p.type, name, hits: 1 });
      }
    }
  }
  return [...found.values()];
}

/**
 * 从标题层级抽实体名——**这是最可靠的来源**。
 *
 * ## 关键认识一：正文正则抽取是错的工具
 *
 * 早期对全部正文跑「带后缀的中文串」正则，抽检 25 条里绝大多数是碎片
 * （"交谈得知乾灵宗""本质是环境""各附庸宗门和海"），
 * 库从 378 条涨到 3647 条，其中 3269 条是垃圾。
 *
 * ## 关键认识二：作者已经用标题标好了实体名
 *
 *   `#### 青阳宗（五行兼备）`      ← 宗门集，四级标题
 *   `### 问道院（正道盟·越国分院）` ← 宗门集，三级标题
 *   `### 夜枫` / `### 汪宁`         ← 人物库
 * 只解析标题就能拿到高精度清单，零误抽。
 *
 * ## 关键认识三：中文数字章节号必须排除
 *
 * 地图相关.md 用「二之一、三大区域」「三之二、伊岚境」这种编号做标题，
 * 早期没排除，导致 location 类型 11 条里 9 条是章节号。
 * 另外功法名常带书名号（《混元真灵决》），入库应剥掉——
 * 否则模型检索「混元真灵决」会漏命中。
 */
function parseHeadings(md, type) {
  const out = [];
  const seen = new Set();
  const lines = md.split('\n');
  let inFence = false;

  // 章节号：「二之一、」「三之二、」「第十九、」等
  const CHAPTER_NO = /^[〇一二三四五六七八九十百]+\s*之?\s*[一二三四五六七八九十]?\s*[、.．]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    // 只取 h2~h4：h1 是分册标题，h5 以下是正文小节
    const m = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (!m) continue;

    let title = clean(m[2], 40);
    if (!title) continue;
    title = title.replace(/^[▸▶◆·※\-—]\s*/, '');

    // 章节编号形态有两种：前缀式「二之二、天启帝国（本陆主宰）」与描述式「二之一、三大区域」。
    // 前缀式后面跟的才是实体名；描述式后面跟的是概括性标题（三大区域、总则），
    // 不是实体——靠「有无括号注释」区分：真实实体都会附一句说明。
    const numbered = title.match(/^[〇一二三四五六七八九十百]+\s*之\s*[一二三四五六七八九十]?\s*[、.．]\s*(.*)$/);
    if (numbered) {
      const rest = numbered[1];
      const hasNote = /[（(].+[)）]\s*$/.test(rest);
      if (!hasNote) continue;              // 描述式章节标题，整条跳过
      title = clean(rest, 40);
    } else if (/^[〇一二三四五六七八九十百]+\s*[、.．]/.test(title)) {
      continue;                            // 纯编号
    }
    if (!title) continue;

    // 去掉括号注释与书名号拿到纯名字。
    // 书名号必须**全局剥**——`^《|》$` 只能处理首尾，
    // 「雷系功法《九雷乾罡诀》」会残留成「雷系功法《九雷乾罡诀」。
    let name = title
      .replace(/[（(].*?[)）]/g, '')
      .replace(/^[〇一二三四五六七八九十]+、/, '')
      .replace(/[《》〈〉]/g, '')                    // 全局剥书名号
      .replace(/^(?:雷系|火系|水系|木系|金系|土系|冰系|风系)?(?:功法|剑经|剑道|掌法|心法|秘术|法术)/, '')
      .trim();

    // 前缀式命名归一：「圣皇·萧麟圣」→ 主名「萧麟圣」+ 别名「圣皇」。
    //
    // 为什么必须在导入层解决而不是靠检索打分救：
    // 模型检索与正文书写的都是「萧麟圣」，库里却存「圣皇·萧麟圣」，
    // 靠「名称互相包含=80 分」只能拿到部分分，且同分时排序不稳定。
    // 实测这会让首位精确命中从 3/9 掉下来。
    const aliases = [];
    const dot = name.match(/^(.{1,6})[·・](.+)$/);
    if (dot && dot[2].length >= 2) {
      const prefix = dot[1];
      const main = dot[2].trim();
      // 前缀必须是「称号/身份/组织」这类修饰语，不能是「年轻一辈」「传人」这种
      // 泛指——它们是被修饰的类别，不是某个实体的别名。
      if (!/^(年轻|老|一代|传人|后代|子孙|本代|上代|全部|各|其他|更多|少数|多数)/.test(prefix)
          && prefix.length >= 2 && main.length >= 2) {
        aliases.push(prefix);
        name = main;
      } else {
        name = `${prefix}·${main}`;   // 不是别名关系，保留原名
      }
    }

    if (!name || name.length < 2 || name.length > 20) continue;
    // 标题同样要过实体闸——`### 萧氏皇族·年轻一辈` 里的「年轻一辈」是泛指不是实体，
    // 「出自宗」这类动词开头的碎片同理。两条路径共用同一道闸，防止一边漏一边不漏。
    if (NOT_ENTITY.test(name) || STRUCTURAL.test(name)) continue;
    if (!isRealEntity(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    // note = 标题后第一段有实质内容的文字
    const tail = lines.slice(i + 1, i + 12).join('\n');
    const noteLine = tail.split('\n').find(
      (l) => l.trim() && !l.startsWith('#') && !l.startsWith('---') && !/^>/.test(l.trim())
    );
    out.push({ type, name, aliases, affiliation: '', realm: '', identity: '', role: clean(noteLine || '', 200) });
  }
  return out;
}

/**
 * 导入主流程。
 * @returns {{projects:object, byShelf:object, total:number, skipped:object}}
 */
function importModianditu(dbPath, sourceDir) {
  const store = new Store(dbPath);
  const projectId = 'modianditu';

  if (!store.getProject(projectId)) {
    store.createProject({ id: projectId, name: '墨染仙途' });
  }
  const existing = new Set(store.loadSettings(projectId).map((s) => `${s.type}|${s.name}`));

  const byShelf = {};
  const skipped = {};
  const skippedNames = [];   // 被实体闸拦下的泛指名（「年轻一辈」「传人」等）
  let total = 0;

  const addOne = (type, name, note, affiliation, realm, aliases) => {
    const key = `${type}|${name}`;
    if (existing.has(key)) return 'dup';
    const parts = [];
    if (affiliation) parts.push(`【${affiliation}】`);
    if (realm) parts.push(`境界：${realm}`);
    if (note) parts.push(note);
    const id = `${projectId}:${type}:${name}`;
    store.upsertSetting({
      id,
      projectId,
      type,
      name,
      note: parts.join(' ').slice(0, 500),
      aliases: (aliases || []).filter(Boolean),
    });
    existing.add(key);
    total++;
    return 'added';
  };

  // 人物库走档案解析（能拿到境界/身份/剧情作用），其余走标题解析
  const PROFILE_SHELVES = { '人物库.md': 'character' };

  for (const file of Object.keys(SHELF_TYPE)) {
    const p = path.join(sourceDir, file);
    if (!fs.existsSync(p)) { skipped[file] = '文件不存在'; continue; }
    const md = fs.readFileSync(p, 'utf8');
    const type = SHELF_TYPE[file];

    let items;
    if (PROFILE_SHELVES[file]) {
      // 档案解析 + 标题解析合并（档案拿到的是带字段的完整档案）
      const profiles = parseProfiles(md, type);
      const headings = parseHeadings(md, type).filter(
        (h) => !profiles.some((x) => x.name === h.name)
      );
      items = profiles.concat(headings);
    } else {
      items = parseHeadings(md, type);
    }

    let added = 0;
    let dup = 0;
    for (const it of items) {
      // 所有入库路径共用同一道闸。实测漏掉这一步时：
      // 「年轻一辈」「传人」「出自宗」这类泛指会进库——
      // 它们来自 parseProfiles（人物档案）而非 parseHeadings，
      // 只在标题路径加闸完全挡不住。
      if (!isRealEntity(it.name)) { skippedNames.push(it.name); continue; }
      const noteParts = [];
      if (it.identity) noteParts.push(it.identity);
      if (it.role) noteParts.push(it.role);
      const r = addOne(it.type, it.name, noteParts.join(' ').slice(0, 400), it.affiliation, it.realm, it.aliases);
      if (r === 'added') added++; else dup++;
    }
    byShelf[file] = { type, parsed: items.length, added, dup };
  }

  store.close();
  return { projectId, byShelf, total, skipped, skippedNames };
}

module.exports = { importModianditu, parseProfiles, parseHeadings, isRealEntity, SHELF_TYPE };

// ---- CLI ----
if (require.main === module) {
  const src = process.argv[2]
    || path.join(os.homedir(), 'AI写小说', '墨染仙途', '小说资料');
  const db = process.argv[3]
    || path.join(__dirname, '..', 'data', 'modianditu.db');

  if (!fs.existsSync(src)) {
    console.log(`找不到目录：${src}`);
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(db), { recursive: true });
  if (fs.existsSync(db)) fs.unlinkSync(db); // 导入器是全量重建，删旧库避免残留

  const t0 = Date.now();
  const r = importModianditu(db, src);

  console.log(`\n导入《墨染仙途》设定库 → ${db}`);
  console.log('='.repeat(60));
  console.log(`来源：${src}`);
  console.log(`总条目：${r.total}　耗时：${Date.now() - t0}ms\n`);
  console.log('分册明细：');
  for (const [file, v] of Object.entries(r.byShelf)) {
    console.log(`  ${file.padEnd(18)} ${v.type.padEnd(10)} 解析 ${String(v.parsed).padStart(4)}　新增 ${String(v.added).padStart(4)}　重复 ${v.dup}`);
  }
  if (Object.keys(r.skipped).length) {
    console.log('\n跳过：');
    for (const [f, why] of Object.entries(r.skipped)) console.log(`  ${f}：${why}`);
  }
  console.log('');
}