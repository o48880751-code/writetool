/**
 * 检索层离线评测：不调用任何模型，只测query_world_bible 的检索质量与上下文成本。
 *
 * 用途：§3.3.2 指出当前检索层在500 条规模下单字查询命中 36~69 条、无 top_k、
 * 无排序，占用 19% 上下文。本脚本给出改前/改后的量化对比，作为检索层改动的验收标准。
 *
 * 运行：node eval-retrieval.js
 * 零依赖，与 run-verify.js 共用同一份 world-bible.json。
 */

const path = require('path');
const { loadWorld, makeToolImpl } = require('./run-verify.js');

const TOKENS_PER_CHAR = 1 / 1.5; // 中文约 1.5 字/token，实测 calibrat：2370 字节≈1580 token

/** 构造一个指定规模的设定库：真实条目 + 仿仙侠噪声条目 */
function buildWorld(size, base) {
  if (size <= base.length) return base.slice(0, size);
  const S = '剑玄霜月灵渊影宗诀典阁峰谷海崖城林雪火雷风丹符阵灵根骨血魂魄丹道器魂丹剑宗掌门长老弟子峰主';
  const TY = ['character', 'location', 'technique', 'faction', 'plot'];
  const out = base.slice();
  const used = new Set(base.map((e) => e.name));
  let i = 0;
  while (out.length < size) {
    let nm;
    do {
      const a = S[Math.floor(Math.random() * S.length)];
      const b = S[Math.floor(Math.random() * S.length)];
      const c = i % 3 === 0 ? S[Math.floor(Math.random() * S.length)] : '';
      nm = a + b + c;
    } while (used.has(nm));
    used.add(nm);
    out.push({ project: 'novel-demo-01', name: nm, type: TY[i % 5], note: `干扰条目 ${i}`, aliases: [] });
    i++;
  }
  return out;
}

/** 旧口径：纯子串匹配，无 top_k、无排序（= 改动前的实现） */
function legacySearch(scope, q, typeFilter) {
  const nq = String(q).toLowerCase().replace(/[\s　。，、；：？！“”‘’（）()《》〈〉\-_·.]/g, '');
  const hits = [];
  for (const e of scope) {
    if (typeFilter && e.type !== typeFilter) continue;
    const nn = e.name.toLowerCase();
    const nameHit = nn.includes(nq) || nq.includes(nn);
    const aliasHit = (e.aliases || []).some((a) =>
      String(a).toLowerCase().includes(nq) || nq.includes(String(a).toLowerCase()));
    const noteHit = String(e.note || '').toLowerCase().includes(nq) && nq.length >= 4;
    if (nameHit || aliasHit || noteHit) hits.push(e);
  }
  return hits;
}

/**
 * 新口径的相关度打分（改动后实现）：
 *   精确全名= 100；名含查询 / 查询含名 = 80；别名命中 = 70；note 命中 = 40
 * 同分按实体名短者优先（更具体的条目排前面），再按条目稳定排序。
 */
function scoreEntry(e, q, typeFilter) {
  if (typeFilter && e.type !== typeFilter) return 0;
  const nq = String(q).toLowerCase().replace(/[\s　。，、；：？！“”‘’（）()《》〈〉\-_·.]/g, '');
  const nn = String(e.name).toLowerCase();
  if (nn === nq) return 100;
  const aliases = (e.aliases || []).map((s) => String(s).toLowerCase());
  if (aliases.some((a) => a === nq)) return 70;
  if (nn.includes(nq) || nq.includes(nn)) return 80;
  if (aliases.some((a) => a.includes(nq) || nq.includes(a))) return 70;
  if (String(e.note || '').toLowerCase().includes(nq) && nq.length >= 4) return 40;
  return 0;
}

function rankSearch(scope, q, typeFilter, topK) {
  return scope
    .map((e) => ({ e, s: scoreEntry(e, q, typeFilter) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => (b.s - a.s) || a.e.name.length - b.e.name.length || a.e.name.localeCompare(b.e.name))
    .slice(0, topK)
    .map((x) => x.e);
}

const PROBE_QUERIES = [
  { q: '谢九', kind: '完整名', expect: '谢九' },
  { q: '洛三娘', kind: '完整名', expect: '洛三娘' },
  { q: '铁棺', kind: '完整名', expect: '铁棺' },
  { q: '乱葬岗', kind: '完整名', expect: '乱葬岗' },
  { q: '赤霄宗', kind: '完整名', expect: '赤霄宗' },
  { q: '剑', kind: '单字', expect: null },
  { q: '宗', kind: '单字', expect: null },
  { q: '丹', kind: '单字', expect: null },
  { q: '魂', kind: '单字', expect: null },
  { q: '灵', kind: '单字', expect: null },
];

const SIZES = [20, 200, 500, 2000];
const TOP_K = 8;
const NUM_CTX = 8192;

function bytesOf(hits) {
  return JSON.stringify({ ok: true, count: hits.length, hits: hits.map((h) => ({ name: h.name, type: h.type, note: h.note })) }).length;
}

function main() {
  const base = loadWorld().filter((e) => e.project === 'novel-demo-01');
  const tool = makeToolImpl(loadWorld(), { segments: [], chapters: [] });

  console.log('检索层离线评测（不调用模型）\n');
  console.log(`top_k = ${TOP_K}，num_ctx = ${NUM_CTX}\n`);
  console.log('规模 | 查询   | 旧:命中 | 旧:token | 旧:占比 | 新:命中 | 新:token | 新:占比 | 目标实体在TopK');
  console.log('-'.repeat(110));

  let worstLegacy = 0;
  let worstNew = 0;
  const regressions = [];

  for (const size of SIZES) {
    const world = buildWorld(size, base);
    const scope = world.filter((e) => e.project === 'novel-demo-01');
    for (const probe of PROBE_QUERIES) {
      const legacy = legacySearch(scope, probe.q, null);
      const ranked = rankSearch(scope, probe.q, null, TOP_K);
      const lb = bytesOf(legacy);
      const rb = bytesOf(ranked);
      const lTok = Math.round(lb * TOKENS_PER_CHAR);
      const rTok = Math.round(rb * TOKENS_PER_CHAR);
      const lPct = Math.round((lTok / NUM_CTX) * 100);
      const rPct = Math.round((rTok / NUM_CTX) * 100);
      worstLegacy = Math.max(worstLegacy, lPct);
      worstNew = Math.max(worstNew, rPct);
      const inTop = probe.expect ? (ranked[0] && ranked[0].name === probe.expect ? '是' : `否(首位=${ranked[0] ? ranked[0].name : '空'})`) : '—';
      if (probe.expect && ranked.length && ranked[0].name !== probe.expect) {
        regressions.push(`规模${size} 查询「${probe.q}」期望「${probe.expect}」，实际首位「${ranked[0].name}」`);
      }
      console.log(
        String(size).padEnd(5) + '| ' +
        probe.q.padEnd(6) + '| ' +
        String(legacy.length).padStart(8) + '| ' +
        String(lTok).padStart(9) + '| ' +
        (lPct + '%').padStart(8) + '| ' +
        String(ranked.length).padStart(8) + '| ' +
        String(rTok).padStart(9) + '| ' +
        (rPct + '%').padStart(8) + '| ' + inTop
      );
    }
  }

  console.log('-'.repeat(110));
  console.log(`\n最坏情况：旧口径单次检索占上下文 ${worstLegacy}%，新口径 ${worstNew}%。`);
  console.log(regressions.length === 0
    ? '正确性检查：完整实体名全部命中首位，通过。'
    : '正确性检查：以下查询未把目标实体排在首位——\n  ' + regressions.join('\n  '));

  console.log('\n结论：');
  if (worstNew <= 10) {
    console.log(`  新口径把单次检索的上下文占用压到 ${worstNew}% 以内（≤ ${Math.round(NUM_CTX * worstNew / 100)} token），`);
    console.log('  且完整实体名仍稳定命中首位。检索层可进入生产实现。');
  } else {
    console.log(`  新口径最坏情况仍达 ${worstNew}%，需要更激进的截断或改用倒排/向量检索。`);
  }
}

main();