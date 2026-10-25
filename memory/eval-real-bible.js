/**
 * 真实设定库上的检索层与摘要层验收。
 *
 * ## 为什么必须单独做
 *
 * 前面所有检索实测都跑在 13+7 条合成库上。真实库是
 * `AI写小说/墨染仙途/小说资料/` 下 10 分册 **114 万字**，
 * 导入后 375 条实体、note 平均数百字。
 *
 * 两者的噪声形态完全不同：
 *   - 合成库噪声 = 随机汉字（"城阁魂""丹魄魄"）
 *   - 真实库 note = **规则条款**（命名约束、五行用字、库位说明、卷级时间线）
 *
 * 合成库上"短 note 挤掉真设定"的问题已经修掉了，但真实库里反过来：
 * **超长 note 会不会把单条检索撑爆上下文**？这是合成库测不出来的。
 *
 * 用法：node memory/eval-real-bible.js
 */

const fs = require('node:fs');
const path = require('node:path');

const { Store } = require('../db/store.js');
const { makeToolImpl, scoreEntry, QUERY_TOP_K, norm } = require('../run-verify.js');
const { summarizeBible, estimateTokens } = require('./context-budget.js');

const DB = path.join(__dirname, '..', 'data', 'modianditu.db');
const PID = 'modianditu';

if (!fs.existsSync(DB)) {
  console.log(`找不到 ${DB}\n先跑：node memory/import-modianditu.js`);
  process.exit(2);
}

const store = new Store(DB);
const settings = store.loadSettings(PID);

console.log(`\n真实设定库验收　《墨染仙途》　${settings.length} 条实体\n`);
console.log('='.repeat(64));

// ---------------------------------------------------------------
console.log('\n一、数据规模与形态');

const byType = {};
for (const s of settings) byType[s.type] = (byType[s.type] || 0) + 1;
console.log('  按类型：', JSON.stringify(byType));

const noteLens = settings.map((s) => (s.note || '').length).sort((a, b) => b - a);
const avg = Math.round(noteLens.reduce((a, b) => a + b, 0) / noteLens.length);
console.log(`  note 长度：最长 ${noteLens[0]}｜中位 ${noteLens[Math.floor(noteLens.length / 2)]}｜平均 ${avg}`);
console.log(`  超500字的条目：${noteLens.filter((l) => l > 500).length} 条`);
console.log(`  note 为空或极短（<12字）：${noteLens.filter((l) => l < 12).length} 条`);

// ---------------------------------------------------------------
console.log('\n二、检索层：噪声形态变了，单字查询还炸吗');

const tool = makeToolImpl(settings, { segments: [], chapters: [] });
const q = (x) => tool.query_world_bible({ project_id: PID, query: x });

const singleChars = ['夜', '灵', '剑', '宗', '丹', '枫', '天', '子'];
console.log('  单字查询（真实库）：');
for (const c of singleChars) {
  const r = q(c);
  const bytes = JSON.stringify({ ok: r.ok, count: r.count, hits: r.hits });
  const tok = estimateTokens(bytes);
  const flag = r.count > QUERY_TOP_K ? `（已截断到 ${QUERY_TOP_K}）` : '';
  console.log(`    「${c}」→ 命中 ${String(r.count).padStart(3)}${flag}  返回约 ${String(tok).padStart(4)} token`);
}

// ---------------------------------------------------------------
console.log('\n三、真实查询词：主角与核心实体能否精确命中');

const probes = [
  ['夜枫', '主角'], ['萧麟圣', '圣皇'], ['青阳宗', '宗门'],
  ['处州', '地点'], ['炼虚', '境界'], ['赤火真气', '功法'],
  ['升仙会', '组织'], ['汪宁', '女主'], ['混元真灵决', '功法'],
];
console.log('  查询词命中率：');
let exactHit = 0;
for (const [name, kind] of probes) {
  const r = q(name);
  const top = r.hits[0];
  const isTop = top && top.name === name;
  if (isTop) exactHit++;
  console.log(
    `    ${name.padEnd(6)}(${kind.padEnd(4)}) 命中 ${String(r.count).padStart(3)}　`
    + `首位=${top ? top.name : '无'}${isTop ? ' ✓' : (r.count ? ' ✗ 首位不符' : ' ✗ 未命中')}`
  );
}
console.log(`  → 首位精确命中 ${exactHit}/${probes.length}`);

// ---------------------------------------------------------------
console.log('\n四、超长 note 会不会撑爆上下文（合成库测不出这一项）');

console.log('  单条检索返回的 note 长度分布：');
const sampleHits = [];
for (const [name] of probes) {
  const r = q(name);
  for (const h of (r.hits || []).slice(0, 3)) sampleHits.push(h);
}
const hitNoteLens = sampleHits.map((h) => (h.note || '').length).sort((a, b) => b - a);
if (hitNoteLens.length) {
  console.log(`    最长 ${hitNoteLens[0]} 字　最短 ${hitNoteLens[hitNoteLens.length - 1]} 字`);
  const worst = q(probes[0][0]);
  const worstBytes = JSON.stringify(worst);
  const worstTok = estimateTokens(worstBytes);
  console.log(`    最坏单次检索：${worst.count} 命中 → ${worstBytes.length} 字节 ≈ ${worstTok} token`);
  console.log(`    占 num_ctx(8192) 的 ${Math.round((worstTok / 8192) * 100)}%`);
  console.log(`    占历史预算(6144) 的 ${Math.round((worstTok / 6144) * 100)}%`);
}

// ---------------------------------------------------------------
console.log('\n五、摘要层：真实库上各类型是否都有保底');

const sum = summarizeBible(settings, { maxChars: 1200, floorPerType: 3 });
console.log(`  纳入 ${sum.included}／丢弃 ${sum.dropped}　${sum.chars} 字`);
console.log('  按类型：', JSON.stringify(sum.byTypeCount));
console.log('  缺失类型：', sum.missingTypes.length ? sum.missingTypes.join(',') : '无');
console.log(`  预算占用：${Math.round((estimateTokens(sum.text) / 6144) * 100)}% of 历史预算`);

console.log('\n  关键实体是否在摘要里（否则模型不知道主角是谁）：');
for (const [name] of probes) {
  console.log(`    ${name.padEnd(6)} ${sum.text.includes(name) ? '在' : '不在 ← 需检索'}`);
}

// ---------------------------------------------------------------
console.log('\n六、上下文增长的真实曲线（累积式注入）');

console.log('  假设每章注入 system + 摘要 + 上章尾部 + 本章检索结果：');
const sysTok = 180;
const bibleTok = estimateTokens(sum.text);
const prevTailTok = estimateTokens('文'.repeat(700 * 0.6));
const perQueryTok = 0;
let hist = 0;
for (let ch = 1; ch <= 20; ch++) {
  // 检索结果按 top_k=8 条、单条 note 数百字计
  const qres = Math.min(ch * 2, 4) * 3 * Math.ceil(180 / 1.5);
  const total = sysTok + bibleTok + prevTailTok + qres + hist;
  const pct = Math.round((total / 8192) * 100);
  const marker = pct > 100 ? '  ← 超预算' : (pct > 80 ? '  ← 接近预算' : '');
  if (ch <= 6 || ch % 5 === 0) {
    console.log(`    第${String(ch).padStart(2)}章  ≈${String(total).padStart(6)} token  ${String(pct).padStart(4)}%${marker}`);
  }
  hist = total;
}

console.log('\n' + '='.repeat(64));
console.log('结论依据见上方各项；判定标准：');
console.log('  · 单字查询命中数已截断到 top_k，返回 token 控制在预算内');
console.log('  · 9 个核心实体首位精确命中 ≥ 8');
console.log('  · 摘要无缺失类型，关键实体多数在摘要内');
console.log('  · 上下文曲线显示需要压缩的起始章号');
console.log('='.repeat(64));

store.close();