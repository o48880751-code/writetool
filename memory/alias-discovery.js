/**
 * 简称发现：从正文里找出「模型在用、但设定库没登记」的别名。
 *
 * 为什么需要（实测依据，2026-10-11）：
 *   跑真实模型生成 3 章，「岗北」出现 5 次、「岗」出现 9 次——
 *   模型稳定地用「岗北」指代设定库里的「乱葬岗」，
 *   但 world-bible.json 只登记了别名「岗子」，没登记「岗北」。
 *   后果：状态回写判不出「谢九在乱葬岗」，location 字段缺失。
 *
 * 这不是 bug 而是设定库的真实缺口：**人写设定时不会穷举所有简称，
 * 而模型会自己造。** 与其让模型迁就设定库，不如把它的用法收编进来。
 *
 * 策略：保守发现 + 人工确认。
 *   - 只在「方位后缀」这个明确模式下发现（岗北/岗南/城里/冢中…）
 *   - 只发现长度 ≥ 2 且不与其他实体名冲突的候选
 *   - **绝不自动写入设定库**——返回给调用方，由人决定是否登记
 */

// 原本 require('../run-verify.js') 取 suffixVariants——但那是 80KB 的验证脚本，
// 内含工具执行、结果落盘、模型调用等一堆副作用。打包后该文件不在安装包里，
// **只要有人 require 这个模块就会直接崩**。
// 与 state-writer.js 是同一个毛病，已一并收敛到 text-util.js。
const { suffixVariants } = require('./text-util.js');

/** 方位/位置后缀：模型描述「在某地某处」时最常用的构造 */
const POSITION_SUFFIXES = [
  '北', '南', '东', '西', '中', '里', '上', '下', '内', '外',
  '深处', '尽头', '边缘', '口', '畔', '侧', '角', '底', '顶',
];

/** 通用地/物后缀——模型造简称时几乎总会带上其中一个 */
const PLACE_TAILS = ['岗', '坡', '岭', '谷', '崖', '洞', '城', '镇', '村', '山', '寺', '塔', '宫', '林', '泽', '原', '墓', '窟', '台', '坊', '寨', '堡'];

/**
 * 找出一个地名周围的所有方位变体。
 * 「乱葬岗」→ ['乱葬岗北', '乱葬岗南', '岗北', '岗南']
 * @param {string} name 地名（如「乱葬岗」）
 * @returns {string[]}候选简称
 */
function positionVariants(name) {
  const n = String(name || '');
  const out = new Set();
  for (const s of POSITION_SUFFIXES) {
    out.add(n + s);      // 乱葬岗北
    if (n.length >= 2) {
      const tail = n[n.length - 1];
      out.add(tail + s); // 岗北
    }
  }
  return [...out];
}

/**
 * 扫描正文，发现未登记的简称。
 *
 * @param {string} text 正文
 * @param {Array} settings 设定条目
 * @returns {{entity:string, suggested:string[], reason:string}[]} 发现建议
 */
function discoverAliases(text, settings) {
  const body = String(text || '');
  const registered = new Set();
  for (const e of settings) {
    registered.add(e.name);
    for (const a of e.aliases || []) registered.add(a);
    for (const v of suffixVariants(e.name)) registered.add(v);
  }

  const locations = settings.filter((e) => e.type === 'location');
  const suggestions = [];
  // 已收集的候选（用于去冗余）
  const collected = new Map(); // entity → Set(候选)

  for (const loc of locations) {
    if (!collected.has(loc.name)) collected.set(loc.name, new Set());

    const candidates = new Set();

    // 形态一：地名 + 方位后缀（乱葬岗北、岗北）
    // 注意：**不要求地名本身在正文出现**。实测里模型可能第一次就用简称
    // （如正文只写「岗北」而从不用「乱葬岗」全名），若加"全名必须出现"
    // 的前置条件，发现器在这种章节上完全失效。
    for (const v of positionVariants(loc.name)) {
      if (v.length >= 2 && body.includes(v)) candidates.add(v);
    }

    for (const c of candidates) {
      if (registered.has(c)) continue;         // 已登记，不算发现
      if (c.length < 2) continue;              // 单字太容易误命中
      if (!body.includes(c)) continue;
      // 排除与其他实体名冲突的情况
      const conflict = settings.some((e) => e.name.includes(c) && e.name !== loc.name);
      if (conflict) continue;
      // 排除本身就是另一个完整实体名
      if (settings.some((e) => e.name === c)) continue;
      collected.get(loc.name).add(c);
    }
  }

  // 统一去冗余后再产出建议：
  // 「乱葬岗下」与「岗下」语义等价（后者是前者去掉前缀），
  // 只留最短的那个，否则一次扫描就把设定库塞进几十条同义别名。
  for (const [entity, set] of collected) {
    const list = [...set].sort((a, b) => a.length - b.length);
    const keep = [];
    for (const cand of list) {
      // 若已保留的某个更短候选是本候选的子串（本候选 = 短候选 + 方位后缀），则丢弃本候选
      const redundant = keep.some((k) => cand.startsWith(k) || cand.includes(k));
      if (!redundant) keep.push(cand);
    }
    if (!keep.length) continue;
    suggestions.push({
      entity,
      suggested: keep,
      reason: `正文用「${keep.join('」「')}」指代「${entity}」，但设定库未登记该简称`,
      occurrences: keep.reduce((a, k) => a + countIn(body, k), 0),
    });
  }
  return suggestions;
}

function countIn(text, sub) {
  let n = 0, i = 0;
  while ((i = text.indexOf(sub, i)) >= 0) { n++; i += sub.length; }
  return n;
}

/**
 * 把发现的简称写回设定库（**必须由人显式调用**，不自动执行）。
 *
 * @param {object} args
 * @param {import('../db/store.js').Store} args.store
 * @param {string} args.projectId
 * @param {{entity:string, suggested:string[]}[]} args.suggestions
 * @returns {{updated:string[], notes:string[]}}
 */
function applyAliasDiscovery({ store, projectId, suggestions }) {
  const updated = [];
  const notes = [];
  for (const s of suggestions) {
    const row = store.prep(
      "SELECT id, name, note FROM settings WHERE project_id = ? AND name = ?"
    ).get(projectId, s.entity);
    if (!row) { notes.push(`跳过：${s.entity} 不在设定库中`); continue; }

    const cur = store.loadSettings(projectId).find((x) => x.name === s.entity);
    const aliases = [...(cur ? cur.aliases : [])];
    for (const a of s.suggested) {
      if (!aliases.includes(a)) aliases.push(a);
    }
    store.upsertSetting({
      id: row.id,
      projectId,
      type: (cur && cur.type) || 'location',
      name: s.entity,
      note: (cur && cur.note) || row.note || '',
      aliases,
    });
    updated.push(`${s.entity} += ${s.suggested.join('、')}`);
  }
  return { updated, notes };
}

module.exports = { discoverAliases, applyAliasDiscovery, positionVariants, POSITION_SUFFIXES };
