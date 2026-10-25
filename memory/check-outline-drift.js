/**
 * 故事纲漂移检测 —— 羽毛菌的真实需求。
 *
 * ## 为什么测故事纲而不是正文
 *
 * 羽毛菌原话：「目前只有大纲，漂移率应该不会太大，我是先写卷纲，再分故事纲，
 * 再细分章纲，主要看故事纲有没有漂移。」
 *
 * 这改变了漂移检测的对象。从「正文写出来的状态漂移」变成
 * **「大纲之间的设定是否自相矛盾」**——两件事的形态完全不同：
 *
 *   正文的漂移：模型写错，人看不出来的隐式矛盾。**机器很难测。**
 *   故事纲的漂移：作者自己写错了境界线、章号、时间跨度。**机器完全能测。**
 *
 * 因为卷纲里境界推进是**显式有序声明**：
 *   第一卷：**境界**：凡人 → 通脉期 → 凝气境 → 筑基期
 *   第二卷：**境界**：筑基后期 → 结丹初期 → … → 假婴
 *   第三卷：**境界**：假婴 → 元婴初期（约 205 岁）
 * 上一卷终点必须等于下一卷起点，不等就是漂移。
 *
 * ## 检测三类漂移
 *
 * 1. **境界断层**：上一卷终点 ≠ 下一卷起点（该接续的没接上）
 * 2. **境界倒退**：下一卷起点 < 上一卷终点（写反了）
 * 3. **章号断层/重叠**：卷与卷的章号区间不连续
 *
 * 用法：node memory/check-outline-drift.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseRealm } = require('./drift-rules.js');

const SRC = path.join(os.homedir(), 'AI写小说', '墨染仙途', '小说资料');

const NEGATION = /(不突破|不破|未突破|不达|尚未|推至|留待|待重设|推迟|不破合体)/;

/**
 * 从一段境界线文本里取出**有序的境界序列**。
 *
 * 输入形如：
 *   凡人 → 通脉期 → 凝气境 → 筑基期
 *   化神初期（落地受伤）→ 化神中期 → **入华洲境后第一次五行合一失败**
 *   卷末逃出（**炼虚后期巅峰**）——**本卷不突破合体**（合体推至卷9第一幕中段）
 *
 * 必须处理的干扰：
 *   · 括号注释——注释里的境界不该进序列，否则「炼虚后期巅峰（卷首·承接卷8）」
 *     会把承接的上一卷境界也吸进来
 *   · **否定表达**——「本卷不突破合体」「合体推至卷9」里的"合体"是**没达到**，
 *     不是已达到。不处理会误报倒退：实测卷8 因此被报成
 *     「炼虚后期巅峰 → 合体」的境界倒退，而原文明确写的是"不突破"。
 *   · 加粗标记与书名号
 */
function parseRealmLine(text) {
  if (!text) return [];
  const stripped = text
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\*\*/g, '')
    .replace(/《|》/g, '');

  // 先按箭头/顿号切分
  const parts = stripped
    .split(/[→>》>]+|[、，,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const p of parts) {
    // 整段是否含否定/推迟表达——含则整段跳过
    //（例如「卷末逃出——本卷不突破合体」「合体推至卷9第一幕中段」）
    if (NEGATION.test(p)) continue;

    const m = p.match(/(凡人|练气|凝气|通脉|炼气|筑基|结丹|金丹|假婴|元婴|化神|炼虚|合体|大乘|渡劫|仙人)/);
    if (!m) continue;

    // 小层必须**紧邻境界词**才作数。
    // 反例：「华洲境末第二次赤火真气圆满·突破炼虚」——「圆满」离「炼虚」很远，
    // 它修饰的是「赤火真气」不是境界。不限定位置会解析成「炼虚圆满」，
    // 跨卷比较时把炼虚初期误判成倒退。
    const idx = p.indexOf(m[1]) + m[1].length;
    const tail = p.slice(idx);
    const subMatch = tail.match(/^(初期|中期|后期|巅峰|圆满|大成)/);
    out.push({
      raw: p,
      realm: m[1],
      sub: subMatch ? subMatch[1] : null,
    });
  }
  return out;
}

/**
 * 比较两个境界的先后。
 *
 * ⚠️ 返回值语义曾经是错的：把「相等」与「不可比」都返回 0，
 * 结果卷2「假婴」→ 卷3「假婴」明明是正常接续，却被报成"不可比"。
 * 现在必须返回 null 表示不可比，0 表示「相等且可比」。
 *
 * @returns {number|null} >0 a 更高；<0 a 更低；0 相等；null 不可比
 */
function compareRealm(a, b) {
  const ORDER = ['凡人', '通脉', '练气', '凝气', '炼气', '筑基', '结丹', '金丹',
    '假婴', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫', '仙人'];
  const SUB = [null, '初期', '大成', '中期', '后期', '巅峰', '圆满'];
  const ai = ORDER.indexOf(a.realm);
  const bi = ORDER.indexOf(b.realm);
  if (ai < 0 || bi < 0) return null;          // 不可比，不是"相等"
  if (ai !== bi) return ai - bi;
  // 同阶比小层；任一方小层不可识别时只比大阶（视作该阶最低）
  const as = SUB.indexOf(a.sub);
  const bs = SUB.indexOf(b.sub);
  if (as < 0 || bs < 0) return 0;
  return as - bs;
}

/** 从文件名解析卷号与章号区间 */
function parseVolumeMeta(filename, content) {
  const vMatch = filename.match(/第([一二三四五六七八九十]+)卷/);
  const VOL = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11 };
  const vol = vMatch ? VOL[vMatch[1]] : null;

  // 章号区间。真实文件有两种写法：
  //   `# 第四卷：霜星远征（687—980·共294章）`      ← 无「第…章」前缀，用破折号
  //   `# 第六卷：初入天界（第 1103-1337 章）`      ← 带「第…章」前缀，连字符
  // 早期只认后一种，导致卷4/卷5 章号解析失败、被误报成「缺 416 章」。
  let chapters = null;
  const a1 = content.match(/^#\s+.*?第\s*(\d+)\s*[-–—~]\s*(\d+)\s*章/m);
  if (a1) {
    chapters = [Number(a1[1]), Number(a1[2])];
  } else {
    const a2 = content.match(/^#\s+[^\n（(]*[（(]\s*(\d+)\s*[-–—~]\s*(\d+)/m);
    if (a2) chapters = [Number(a2[1]), Number(a2[2])];
  }

  const volName = content.match(/^#\s+(.+)$/m);
  return { vol, filename, chapters, title: volName ? volName[1].trim() : filename };
}

/** 抽出卷纲里的境界线声明 */
function extractRealmLine(content) {
  const m = content.match(/^\s*[-*]?\s*\*\*境界(?:线)?\*\*[:：]\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// ============================================================
// 来源一：卷纲（卷1-6 有，卷7-11 还没写）
// ============================================================
const files = fs.readdirSync(SRC).filter((f) => /第[一二三四五六七八九十]+卷大纲\.md$/.test(f));

console.log(`\n故事纲漂移检测　《墨染仙途》\n${'='.repeat(64)}`);

if (!files.length) {
  console.log('找不到卷纲文件');
  process.exit(2);
}

const volumes = files.map((f) => {
  const content = fs.readFileSync(path.join(SRC, f), 'utf8');
  const meta = parseVolumeMeta(f, content);
  const realmLine = extractRealmLine(content);
  return { ...meta, content, realmLine, source: '卷纲' };
}).sort((a, b) => (a.vol || 99) - (b.vol || 99));

// ============================================================
// 来源二：章节摘要（含卷7-11 的境界线，是跨卷接续的唯一依据）
// ============================================================
const SUMMARY = path.join(SRC, '章节摘要.md');
let summaries = [];
if (fs.existsSync(SUMMARY)) {
  const sc = fs.readFileSync(SUMMARY, 'utf8');
  const blocks = sc.split(/\n(?=## 第)/).filter((b) => /^## 第/.test(b));
  summaries = blocks.map((b) => {
    const h = b.match(/^##\s+第([一二三四五六七八九十]+)卷[^\n]*/);
    const VOL = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11 };
    const ch = b.match(/第\s*(\d+)\s*[-–—~]\s*(\d+)\s*章/);
    const rl = b.match(/^\s*[-*]?\s*\*\*境界\*\*[:：]\s*(.+)$/m);
    return {
      vol: h ? VOL[h[1]] : null,
      chapters: ch ? [Number(ch[1]), Number(ch[2])] : null,
      realmLine: rl ? rl[1].trim() : null,
      source: '章节摘要',
    };
  }).filter((x) => x.vol).sort((a, b) => a.vol - b.vol);
}

// ---- 一、卷清单 ----
console.log('\n一、卷纲清单\n');
console.log('  卷  文件'.padEnd(28) + '章号区间'.padEnd(18) + '境界线首尾');
console.log('  ' + '-'.repeat(64));
for (const v of volumes) {
  const seq = v.realmLine ? parseRealmLine(v.realmLine) : [];
  const first = seq.length ? `${seq[0].realm}${seq[0].sub || ''}` : '—';
  const last = seq.length ? `${seq[seq.length - 1].realm}${seq[seq.length - 1].sub || ''}` : '—';
  const range = v.chapters ? `${v.chapters[0]}-${v.chapters[1]}` : '—';
  console.log(`  ${String(v.vol || '?').padEnd(4)}${v.filename.padEnd(24)}${range.padEnd(18)}${first} → ${last}`);
}

// ---- 二、境界断层 ----
console.log(`\n二、境界接续检查（本卷终点 vs 下卷起点）\n`);
let boundaryIssues = 0;
for (let i = 0; i < volumes.length - 1; i++) {
  const a = volumes[i];
  const b = volumes[i + 1];
  const seqA = a.realmLine ? parseRealmLine(a.realmLine) : [];
  const seqB = b.realmLine ? parseRealmLine(b.realmLine) : [];

  if (!seqA.length || !seqB.length) {
    console.log(`  ? 卷${a.vol} → 卷${b.vol}：境界线缺失（${!seqA.length ? a.filename : b.filename}）`);
    boundaryIssues++;
    continue;
  }
  const endA = seqA[seqA.length - 1];
  const startB = seqB[0];
  const cmp = compareRealm(endA, startB);

  if (cmp === null) {
    console.log(`  ? 卷${a.vol}「${endA.raw}」→ 卷${b.vol}「${startB.raw}」：境界词不在序表内，无法判定`);
    boundaryIssues++;
  } else if (cmp > 0) {
    console.log(`  ✗ 卷${a.vol} → 卷${b.vol} 境界倒退：${endA.raw} → ${startB.raw}`);
    boundaryIssues++;
  } else if (cmp === 0) {
    console.log(`  ✓ 卷${a.vol} → 卷${b.vol} 接续正常（终点＝起点）：${endA.raw} → ${startB.raw}`);
  } else {
    // cmp < 0：本卷终点低于下卷起点——通常是中间有突破描写，属正常
    console.log(`  ✓ 卷${a.vol} → 卷${b.vol} 接续正常：${endA.raw} → ${startB.raw}（卷内完成突破）`);
  }
}

// ---- 三、单卷内境界倒退 ----
console.log(`\n三、单卷内境界倒退\n`);
let intraIssues = 0;
for (const v of volumes) {
  const seq = v.realmLine ? parseRealmLine(v.realmLine) : [];
  let bad = 0;
  for (let i = 1; i < seq.length; i++) {
    const cmp = compareRealm(seq[i - 1], seq[i]);
    if (cmp > 0) {
      console.log(`  ✗ 卷${v.vol}「${seq[i - 1].raw}」→「${seq[i].raw}」倒退`);
      bad++;
    }
  }
  if (!bad) console.log(`  ✓ 卷${v.vol}：${seq.length} 段境界线无倒退`);
  intraIssues += bad;
}

// ---- 四、章号连续性 ----
console.log(`\n四、章号区间连续性\n`);
let chapterIssues = 0;
const withCh = volumes.filter((v) => v.chapters);
for (let i = 0; i < withCh.length - 1; i++) {
  const a = withCh[i];
  const b = withCh[i + 1];
  const endA = a.chapters[1];
  const startB = b.chapters[0];
  const expected = endA + 1;
  if (startB === expected) {
    console.log(`  ✓ 卷${a.vol}(至${endA}) → 卷${b.vol}(自${startB}) 连续`);
  } else {
    const gap = startB - expected;
    console.log(`  ${gap > 0 ? '✗' : '?'} 卷${a.vol}章号止于 ${endA}，卷${b.vol} 自 ${startB} 起`
      + `${gap > 0 ? `（缺 ${gap} 章）` : `（重叠 ${-gap} 章）`}`);
    chapterIssues++;
  }
}

// ---- 五、卷纲 vs 章节摘要：双源交叉校验（漂移检测的核心价值）----
//
// 同一条境界线存在两份独立记录（卷纲 + 章节摘要）时，两者不一致就是真漂移信号——
// 说明改了一处忘了改另一处。这是长篇设定最容易出问题的地方。
console.log(`\n五、双源交叉校验（卷纲 vs 章节摘要）\n`);
let crossIssues = 0;
for (const v of volumes) {
  const s = summaries.find((x) => x.vol === v.vol);
  if (!s) continue;
  if (!v.realmLine || !s.realmLine) continue;

  const seqV = parseRealmLine(v.realmLine);
  const seqS = parseRealmLine(s.realmLine);
  if (!seqV.length || !seqS.length) continue;

  const endV = seqV[seqV.length - 1];
  const endS = seqS[seqS.length - 1];
  const startV = seqV[0];
  const startS = seqS[0];

  const cmpEnd = compareRealm(endV, endS);
  const cmpStart = compareRealm(startV, startS);

  const endMatch = cmpEnd === null || cmpEnd === 0;
  const startMatch = cmpStart === null || cmpStart === 0;

  if (endMatch && startMatch) {
    console.log(`  ✓ 卷${v.vol}：两源一致（${startV.raw} → ${endV.raw}）`);
  } else {
    crossIssues++;
    if (!startMatch) {
      console.log(`  ✗ 卷${v.vol} 起点不一致：卷纲「${startV.raw}」vs 摘要「${startS.raw}」`);
    }
    if (!endMatch) {
      console.log(`  ✗ 卷${v.vol} 终点不一致：卷纲「${endV.raw}」vs 摘要「${endS.raw}」`);
    }
  }
}

// ---- 六、完整 11 卷接续链（用章节摘要，因为它覆盖到卷11）----
if (summaries.length >= 2) {
  console.log(`\n六、完整接续链（${summaries.length} 卷，来自章节摘要）\n`);
  let chainIssues = 0;
  for (let i = 0; i < summaries.length - 1; i++) {
    const a = summaries[i];
    const b = summaries[i + 1];
    const seqA = parseRealmLine(a.realmLine || '');
    const seqB = parseRealmLine(b.realmLine || '');
    if (!seqA.length || !seqB.length) {
      console.log(`  ? 卷${a.vol} → 卷${b.vol}：境界线缺失或无法解析`);
      chainIssues++;
      continue;
    }
    const endA = seqA[seqA.length - 1];
    const startB = seqB[0];
    const cmp = compareRealm(endA, startB);

    // 章号连续性
    const chOk = !a.chapters || !b.chapters || b.chapters[0] === a.chapters[1] + 1;

    if (cmp === null) {
      console.log(`  ? 卷${a.vol}「${endA.raw}」→ 卷${b.vol}「${startB.raw}」：不可比`);
      chainIssues++;
    } else if (cmp > 0) {
      console.log(`  ✗ 卷${a.vol} → 卷${b.vol} 境界倒退：${endA.raw} → ${startB.raw}`);
      chainIssues++;
    } else {
      const note = cmp === 0 ? '（终点＝起点）' : '（卷内突破）';
      const chNote = chOk ? '' : `　⚠️章号断层：卷${a.vol}止于 ${a.chapters[1]}，卷${b.vol}自 ${b.chapters[0]}`;
      if (!chOk) chainIssues++;
      console.log(`  ${cmp === 0 ? '✓' : '✓'} 卷${a.vol} → 卷${b.vol}：${endA.raw} → ${startB.raw}${note}${chNote}`);
    }
  }
  console.log(`\n  跨卷问题：${chainIssues} 项`);
}

console.log(`\n${'='.repeat(64)}`);
const total = boundaryIssues + intraIssues + chapterIssues + crossIssues;
console.log(`检查项：卷纲卷间接续 ${volumes.length - 1}｜卷内倒退 ${volumes.length}`
  + `｜章号接续 ${Math.max(0, withCh.length - 1)}｜双源交叉 ${Math.min(volumes.length, summaries.length)}`);
console.log(`发现问题：${total} 项`);
if (total === 0) {
  console.log('\n结论：卷纲与章节摘要的境界线、章号区间**完全自洽**，未发现漂移。');
} else {
  console.log('\n结论：发现上述问题。其中双源不一致最值得优先修——');
  console.log('     那说明改设定时只改了一处，卷纲与摘要已经对不上了。');
}
console.log('='.repeat(64));