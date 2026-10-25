/**
 * 地名词条抽取 —— 补齐设定库缺失的地理实体。
 *
 * ## 为什么单独做
 *
 * 真实正文《墨染仙途·第一章》实测：汉字覆盖率仅 **55%**，
 * 缺失的主要是「处州」「青石村」「青石镇」「越国」「岚州」这类地名——
 * 它们高频出现在正文与大纲里，却没有被写成独立条目。
 * 直接后果是状态抽取判不出位置、检索召回不到场景。
 *
 * ## 关键认识：地名不能用正文正则抽（已在导入器上栽过一次）
 *
 * 实测对 `世界观.md + 地图相关.md + 第一卷大纲.md` 跑「带地名后缀的中文串」正则，
 * 词频最高的是：伊岚境(16)、**三大境域(15)、帝国境(12)**、三灵域(9)、
 * **宗门集(8)**、**圣塔在城(4)**、**极大之城(4)** —— 一半是碎片。
 *
 * 正确做法与人物库同理：**从结构化位置抽，不从正文抽**。
 * 地名的权威来源有三个，按可信度排序：
 *   1. 卷纲的 `**地图**：` 行 —— 作者手写的路线，括号里还带归属说明
 *   2. `地图相关.md` 的标题层级 —— 带括号注释的才是实体
 *   3. 正文里「地名（说明）」的括号结构 —— 说明文字必须够长（≥4 字）
 *
 * 用法：node memory/import-geo-entries.js
 */

const fs = require('node:fs');
const path = require('node:path');

const { Store } = require('../db/store.js');

const SRC = 'C:/Users/26775/AI写小说/墨染仙途/小说资料';
const PID = 'modianditu';

/** 地名后缀表：命中即认为是候选地名 */
const GEO_SUFFIX = /(州|城|村|镇|县|山|谷|岭|崖|海|域|境|岛|原|荒|坊|集|港|关|峡|泽|川|陆|洲)$/;

/** 通用词黑名单——类别名不是地名 */
const GEO_GENERIC = new Set([
  '大城', '小城', '极小城', '三城', '山城', '关城', '海城', '陆城',
  '全境', '本境', '其余境', '帝国境', '各国境', '本陆境', '三境域', '三大境域',
  '九境', '人道九境', '各境', '该境', '此境', '边境', '内地', '区域', '地带',
  '各地', '此处', '各地', '所在', '境内', '城外', '城内', '村中', '山中',
  '宗门集', '凡人界', '修士界', '修真界', '修仙界',
]);

/** 明显不是地名的（动词/连接词开头） */
const GEO_BAD_HEAD = /^[的了在到从向往和与及走来到去过进出上下其中此这那]`?[的地得]?|^[取得了着过是被把从往]/;

/**
 * 判定是否为真实地名。
 * @param {string} name
 * @returns {boolean}
 */
/**
 * 无后缀但确属地理实体的名字。
 * 「越国」是「州」而不是「国」结尾——后缀表覆盖不到，但它贯穿全书。
 */
const GEO_NO_SUFFIX = new Set([
  '越国', '东玄', '天启帝国', '南岳盟', '北庭盟', '正道盟', '魔道盟',
  '苍澜', '东玄大陆', '西灵大陆', '圣元大陆', '南离大陆', '九州', '九域',
]);

/**
 * 抽象概念——清单里会出现，但不是地名。
 *
 * 实测踩坑：清单抽取一开就带进「高境」「跨境」「同境」「跨陆」「地域」
 * 「内城」「草原」这类。它们有条目形态、有说明文字，但不是地点实体——
 * 收进设定库会让检索「境」命中一堆抽象词。
 */
const ABSTRACT_NOUNS = new Set([
  '高境', '低境', '跨境', '同境', '跨陆', '地域', '区域', '界域',
  '草原', '内城', '外城', '上城', '下城', '新城', '旧城',
  '大陆', '境内', '城外', '城内', '域内', '界内', '本土', '本地',
  '天界修炼环境', '落地沦陷区域', '沦陷区域', '修炼环境', '环境', '气氛', '氛围',
  '两地', '三地', '各地', '各处', '所有地', '本地',
]);

function isGeoEntry(name) {
  if (!name || name.length < 2 || name.length > 8) return false;
  if (GEO_GENERIC.has(name)) return false;
  if (ABSTRACT_NOUNS.has(name)) return false;
  if (GEO_BAD_HEAD.test(name)) return false;
  if (GEO_NO_SUFFIX.has(name)) return true;      // 无后缀但确属地理
  if (!GEO_SUFFIX.test(name)) return false;
  if (name.length === 1) return false;
  // 「圣塔在城」这类动词在中间的，一律拒
  if (/[在了过是被把从向往和与及]/.test(name.slice(0, -1))) return false;
  return true;
}

/**
 * 从 `**地图**：A（说明） → B（说明） → C` 形式的行里抽地名。
 * 括号说明保留为 note——它是「这个地名是什么」的唯一权威描述。
 */
function extractFromMapLine(line, volume) {
  const out = [];
  if (!line) return out;
  const body = line.replace(/\r$/, '').replace(/^\s*[-*]?\s*\*\*地图\*\*\s*[:：]\s*/, '').replace(/\*\*/g, '');
  // 按 → 与 · 切
  const parts = body.split(/[→·]/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    // 「东玄大陆（越国 → 问道院 → 乾灵宗 → 海外小岛 → 苍澜海域）」这类嵌套
    const inner = p.match(/[（(]([^）)]*[）)]?)/);
    const note = inner ? inner[1].trim() : '';
    const main = (inner ? p.replace(/[（(][^）)]*[）)]?/, '') : p).trim();
    // 主名可能是「东玄大陆」这样带括号的整体，也可能被逗号连接
    for (const cand of main.split(/[、，,]/).map((s) => s.trim()).filter(Boolean)) {
      if (!isGeoEntry(cand)) continue;
      out.push({ name: cand, note: note.slice(0, 120), from: `卷${volume}地图行` });
    }
  }
  return out;
}

/**
 * 从正文里抽「地名（≥4字说明）」——括号说明够长才算作者定义的实体。
 *
 * ⚠️ 早期版本抽出来一半是碎片：「阵法机关」「统治区域」「偶有交集」
 * 「离开小岛」「初入东海」「一个幻境」——因为括号里包的是任何东西，
 * 前面那个词只是恰好带了地名后缀。
 *
 * 收紧成两条硬规则：
 *   1. **地名必须跨来源复现**——只在正文出现一次、但出现在结构化来源
 *      （卷纲地图行 / 地图分册标题）里的才算真地名。碎片不会同时出现在两处。
 *   2. 括号说明必须**描述这个地名是什么**，而不是描述一件动作：
 *      含「万章/第NNN章/幕/段/卷」的是章节号，含动词打头的（如「初入」「离开」）
 *      是事件描述——两者都排除。
 */
const CHAPTER_REF = /(第\s*\d+\s*[—\-~至]\s*\d+\s*章|第[一二三四五六七八九十]+[幕段章]|\d+[—\-~]\d+章|L\d+)/;
const EVENT_VERB = /^(初|再|又|已|刚|正|将|被|到|进|出|回|离|取|得|失|死|生|开|闭|动|静|战|逃|归)/;

function extractFromParenthesized(files) {
  const out = [];
  for (const f of files) {
    const p = path.join(SRC, f);
    if (!fs.existsSync(p)) continue;
    const md = fs.readFileSync(p, 'utf8');

    // 形如「青石镇（越国·小型散修势力）」
    const re = /([一-龥]{2,4})\s*[（(]([^）)]{4,60})[）)]/g;
    let m;
    while ((m = re.exec(md))) {
      const name = m[1];
      const note = m[2].trim();
      if (!isGeoEntry(name)) continue;
      if (CHAPTER_REF.test(note)) continue;       // 括号里是章节号 → 事件不是地名定义
      if (EVENT_VERB.test(note)) continue;        // 括号里是事件描述
      out.push({ name, note: note.slice(0, 120), from: f, structured: false });
    }

    // 形如「X是…」
    const re2 = /([一-龥]{2,4})是([一-龥]{6,40})/g;
    while ((m = re2.exec(md))) {
      const name = m[1];
      const note = m[2].trim();
      if (!isGeoEntry(name)) continue;
      if (CHAPTER_REF.test(note) || EVENT_VERB.test(name)) continue;
      out.push({ name, note: note.slice(0, 120), from: `${f}·定义句`, structured: false });
    }
  }
  return out;
}

/**
 * 导入地理词条。
 * @param {string} dbPath
 * @returns {{added:number, existed:number, byType:object, samples:Array}}
 */
function importGeoEntries(dbPath) {
  const store = new Store(dbPath);
  if (!store.getProject(PID)) store.createProject({ id: PID, name: '墨染仙途' });

  const existing = new Set(store.loadSettings(PID).map((s) => `${s.type}|${s.name}`));
  const geoOf = new Set(store.loadSettings(PID).filter((s) => s.type === 'location').map((s) => s.name));

  const candidates = new Map();   // name → {note, from[], structured}

  const push = (name, note, from, structured) => {
    if (!isGeoEntry(name)) return;
    if (!candidates.has(name)) candidates.set(name, { name, note: note || '', from: [], structured: false });
    const c = candidates.get(name);
    if (!c.note && note) c.note = note;
    if (from && !c.from.includes(from)) c.from.push(from);
    if (structured) c.structured = true;
  };

  // ---- 来源1：各卷的地图行 ----
  const VOL = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11 };
  const outlineFiles = fs.readdirSync(SRC).filter((f) => /第[一二三四五六七八九十]+卷大纲\.md$/.test(f));
  for (const f of outlineFiles) {
    const md = fs.readFileSync(path.join(SRC, f), 'utf8');
    const line = md.replace(/\r\n/g, '\n').match(/^\s*[-*]?\s*\*\*地图\*\*\s*[:：]\s*(.+)$/m);
    const vol = VOL[f.match(/第([一二三四五六七八九十]+)卷/)[1]];
    for (const g of extractFromMapLine(line ? line[1] : null, vol)) {
      push(g.name, g.note, g.from, true);
    }
    // 副本地图行也是权威来源
    const dline = md.replace(/\r\n/g, '\n').match(/^\s*[-*]?\s*\*\*副本(?:地图)?\*\*\s*[:：]\s*(.+)$/m);
    for (const g of extractFromMapLine(dline ? dline[1] : null, vol)) {
      push(g.name, g.note, `${g.from}·副本`, true);
    }
  }

  // ---- 来源2：地图分册标题 ----
  const mapMd = path.join(SRC, '地图相关.md');
  if (fs.existsSync(mapMd)) {
    const md = fs.readFileSync(mapMd, 'utf8').replace(/\r\n/g, '\n');
    const re = /^#{2,4}\s+(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(md))) {
      let t = m[1].replace(/^[▸▶◆·※\-—]\s*/, '');
      // 章节号两种形态：「二之二、」与「二、」，都要剥
      const numbered = t.match(/^[〇一二三四五六七八九十百]+\s*(?:之\s*[一二三四五六七八九十]?\s*)?[、.．]\s*(.*)$/);
      if (numbered) t = numbered[1].trim();
      const note = (t.match(/[（(]([^）)]+)[）)]\s*$/) || [])[1] || '';
      const name = t.replace(/[（(][^）)]*[）)]\s*$/, '').trim();
      if (!note) continue;                 // 无括号说明的多半是分类标题
      if (!isGeoEntry(name)) continue;    // 抽象词（如「修炼环境」）不是地名
      push(name, note, '地图相关.md·标题', true);
    }
  }

  // ---- 来源3：正文的括号定义与「X是…」定义句 ----
  for (const g of extractFromParenthesized([
    '世界观.md', '地图相关.md', '第一卷大纲.md', '第二卷大纲.md', '第三卷大纲.md',
    '第四卷大纲.md', '第五卷大纲.md', '第六卷大纲.md', '宗门集.md',
  ])) {
    push(g.name, g.note, g.from);
  }

  // ---- 清单式定义抽取（最准的来源）----
  //
  // 早期用「跨来源复现」当闸，结果把真地名也拦了——
  // 「赤玉高原」「九州」「处州」都只在单个文件出现一次，
  // 因为**地理清单本身就是唯一的权威定义处**，不需要第二处提及。
  //
  // 实测找到的准确判据：**真地名以条目形式出现在地理清单里**：
  //   • 牧云草原：赤玉高原西北，广袤草原，向北延伸至千霜雪原。
  //   - **九州（第七卷大纲 L121-130 定名）*
  //   • 身份：越国处州凡人 → 问道院
  // 而碎片（阵法机关、统治区域、偶有交集）是散在句子里的，
  // 前面没有条目结构也没有冒号定义。
  const checklistFiles = [
    '世界观.md', '地图相关.md', '第一卷大纲.md', '第二卷大纲.md',
    '第三卷大纲.md', '第四卷大纲.md', '第五卷大纲.md', '第六卷大纲.md',
    '宗门集.md', '副本集合.md',
  ];
  for (const f of checklistFiles) {
    const p = path.join(SRC, f);
    if (!fs.existsSync(p)) continue;
    const md = fs.readFileSync(p, 'utf8');
    // CRLF：行尾有 \r，$ 锚点会失效（实测「• 赤玉高原：…」整行匹配不上）
    for (const line of md.split('\n').map((l) => l.replace(/\r$/, ''))) {
      // 清单条目。两种形态都要认：
      //   `• 赤玉高原：北庭盟正北…`      ← 项目符号后有空格
      //   `**九州（地界名）**：`          ← 括号说明在加粗里，后面只跟冒号
      //
      // ⚠️ 不要在名字与冒号之间插「[^）)]*」这类可选的中间段——
      // 它会贪婪吃掉名字的后半截（实测「赤玉高原」只匹配到「赤玉」）。
      // 括号说明单独用第二个分支处理。
      const m = line.match(/^\s*[-*•·]?\s*\**\s*([一-龥]{2,8})\s*\**\s*[：:]\s*(.{4,100})$/)
        || line.match(/^\s*[-*•·]?\s*\**\s*([一-龥]{2,8})\s*\**[（(][^）)]{0,40}[）)]\s*\**\s*[：:]\s*(.{0,100})$/);
      if (!m) continue;
      const name = m[1];
      const note = m[2].replace(/\*\*/g, '').trim();
      if (!isGeoEntry(name)) continue;
      if (CHAPTER_REF.test(note) || EVENT_VERB.test(note)) continue;
      push(name, note, `${f}·清单`, true);   // 条目结构化 → structured
    }
  }

  // ---- 核心地名白名单（人工确认）----
  //
  // 演进记录——这一段推翻过两次，值得留档：
  //
  //   尝试一：对全文跑「带地名后缀的中文串」正则 + 统计跨文件提及数。
  //     结果：候选从 39 条暴涨到 143 条，抽检 30 条里全是碎片
  //     （"国更穷的一州""平日沉于深海""道直接传出海""陆西面不设州"），
  //     而真正重要的「处州」「越国」「青石村」一个都没进来。
  //     根因：中文里「州/城/海」这类字出现极频繁，模板化文字
  //     （"第X卷""闭关""不出海"）跨文件重复率极高，
  //     **「跨文件提及数」这个信号对碎片同样成立**。
  //
  //   尝试二：要求候选有条目形态（`名称：说明`）。
  //     结果：漏掉「处州」——它在全书里从没被写成独立条目。
  //
  //   结论：**自动化抽不出核心地名，只能人工确认。**
  //   理由与人物库导入器一致：设定库里塞错东西比少东西危险得多。
  //   这里收的是羽毛菌确认过的高频地理实体，其余靠检索时按需补。
  const CORE_GEO = [
    { name: '处州', note: '越国境内较穷的一州，夜枫出身地' },
    { name: '越国', note: '东玄大陆南部的凡人国家，夜枫与汪宁的故乡' },
    { name: '岚州', note: '越国邻州，夜大田所说问道院所在' },
    { name: '青石村', note: '处州城外的村庄，夜枫一家四口住处' },
    { name: '青石镇', note: '处州附近小镇，夜大田跑货遇仙师处' },
    { name: '白云山', note: '升仙会举办地，五大宗门设分坛招录' },
    { name: '赤云峰', note: '乾灵宗七峰之一，夜枫入门后所在' },
    { name: '乾灵宗', note: '正道盟五大宗门之一，夜枫入门宗门' },
    { name: '问道院', note: '越国的过渡宗门，李哲任长老，夜枫与汪宁早期成长处' },
  ];
  for (const g of CORE_GEO) {
    push(g.name, g.note, '核心地名·人工确认', true);
  }

  // ---- 复现闸：只拦「既无结构、又只有单处提及」的 ----
  //
  // 演进记录（踩坑过程）：
  //   1. 最初完全没闸 → 碎片满天飞（「阵法机关」「统治区域」「偶有交集」）
  //   2. 加「跨来源复现」闸 → **误伤真地名**。实测「越国处州」「沧州」
  //      「赤云坊」都只在单个文件出现——因为地理清单本身就是唯一的
  //      权威定义处，不需要第二处提及。
  //   3. 加「清单条目结构」识别（`名称：说明`）→ 大部分真地名都能命中
  //   4. 最终闸：**有结构（structured）就收，没有结构才要求两处提及**
  //
  // 「冰原」被拦是对的——它是「寂灵冰原」的简称，该走别名不该新建条目。
  const fileCount = (c) => new Set(c.from.map((f) => f.split('·')[0])).size;
  const rejected = [];
  for (const [name, c] of [...candidates]) {
    if (!c.structured && fileCount(c) < 2) {
      rejected.push(name);
      candidates.delete(name);
    }
  }

  // ---- 入库 ----
  let added = 0;
  let existed = 0;
  const samples = [];
  for (const [name, c] of candidates) {
    if (geoOf.has(name)) { existed++; continue; }
    const key = `location|${name}`;
    if (existing.has(key)) { existed++; continue; }
    store.upsertSetting({
      id: `${PID}:location:${name}`,
      projectId: PID,
      type: 'location',
      name,
      note: `【${c.from.join(' / ')}】${c.note}`.slice(0, 500),
      aliases: [],
    });
    existing.add(key);
    geoOf.add(name);
    added++;
    samples.push({ name, from: c.from, note: c.note.slice(0, 50) });
  }

  const total = store.loadSettings(PID).filter((s) => s.type === 'location').length;
  store.close();
  return { added, existed, candidates: candidates.size, rejected, samples, locationTotal: total };
}

module.exports = { importGeoEntries, isGeoEntry, extractFromMapLine, GEO_SUFFIX };

// ---- CLI ----
if (require.main === module) {
  const db = process.argv[2] || path.join(__dirname, '..', 'data', 'modianditu.db');
  if (!fs.existsSync(db)) {
    console.log(`找不到 ${db}\n先跑：node memory/import-modianditu.js`);
    process.exit(2);
  }

  console.log(`\n地名词条抽取 → ${db}`);
  console.log('='.repeat(60));
  const r = importGeoEntries(db);
  console.log(`候选 ${r.candidates} 个（复现闸拦下 ${r.rejected.length}）｜新增 ${r.added} 条｜已存在 ${r.existed} 条`);
  if (r.rejected.length) {
    console.log(`拦下的碎片：${r.rejected.slice(0, 20).join('、')}${r.rejected.length > 20 ? '…' : ''}`);
  }
  console.log(`地点类总数：${r.locationTotal} 条\n`);
  console.log('新增地名（按来源）：');
  for (const s of r.samples) {
    console.log(`  ${s.name.padEnd(8)} ${s.from[0]}${s.note ? `　${s.note}` : ''}`);
  }
  console.log('='.repeat(60));
}