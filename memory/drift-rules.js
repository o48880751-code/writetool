/**
 * 状态漂移检测：区分「正常演化」与「真漂移」。
 *
 * 上一版把 location 变化一律当冲突，这是错的：
 * 长篇里角色必然移动位置（第 1 章在洛阳、第 300 章在剑冢），
 * 按老逻辑写到第 2 章就会冲突停摆，状态表直接卡死。
 *
 * 修正后的分类（实测驱动，见 test-drift.js）：
 *
 *   正常演化，不报：
 *     - location 变了但本章有移动动词（in 洛阳→剑冢 是剧情）
 *     - 境界/修为提升
 *     - 出现次数等统计字段变化
 *
 *   真漂移，必须报：
 *     - alive: false → true（复活需要显式证据，不能默认成立）
 *     - 单调字段倒退（金丹 → 筑基，违反物理顺序）
 *     - 数值字段回落（年龄 30→28）
 *     - 连续两章位置都在变、且两章正文都没有移动动词
 *
 * 关于位置：这里刻意**不**把「往返」当漂移。
 * 早期版本想用「位置来回跳」做判据，实测是错的——长篇里往返是常态
 * （进城买东西、出城、再次进城），按往返报冲突会疯狂误报。
 * 真正的 bug 判据是「无证据跳变」：一次位移没写移动动词可能是漏更新，
 * 但连续两次都这样，说明状态回写本身坏了，或模型在硬跳。
 */

/**
 * 单调字段的序：数值越大越强，倒退即漂移。
 *
 * ## 这张表已按《墨染仙途》真实设定校准（2026-10-11）
 *
 * 校准依据：`AI写小说/墨染仙途/小说资料/` 下的真实设定库。实测统计：
 *   人物库.md 中出现的境界词频次最高的是
 *   元婴后期(41) / 合体期(38) / 元婴中期(34) / 元婴初期(29) / 炼虚后期(15) …
 *
 * **关键修正**：通用修仙体系里「结丹、金丹」是同一阶的两个叫法，
 * 但《墨染仙途》两者都用（"结丹修士"、"金丹期"），且分属不同阶。
 * 早期版本只写了 炼气→筑基→金丹→… 漏掉「结丹」，
 * 会让"结丹 → 金丹"这种**实际是晋升**的演化被误判成"跳级"或漏判。
 *
 * 命名混用已用别名对齐（如「元婴初期」「元婴中期」「元婴后期」「元婴期」等价）。
 * 换书必须重校这张表——**序表错了，倒退检测形同虚设**。
 */
const ORDINALS = {
  境界: [
    '凡人', '练气', '凝气', '炼气', '筑基', '结丹', '金丹',
    '元婴', '化神', '炼虚', '合体', '大乘', '渡劫', '仙人',
  ],
  修为: [
    '凡人', '练气', '凝气', '炼气', '筑基', '结丹', '金丹',
    '元婴', '化神', '炼虚', '合体', '大乘', '渡劫', '仙人',
  ],
  实力: [
    '凡人', '练气', '凝气', '炼气', '筑基', '结丹', '金丹',
    '元婴', '化神', '炼虚', '合体', '大乘', '渡劫', '仙人',
  ],
};

/**
 * 境界小层的序（同一大阶内的初中后期）。
 * 单独存一份是因为「元婴」到「元婴初期」在大阶表里是同一个词，
 * 但在小层表里是晋升——两个维度都要判。
 */
const ORDINAL_SUBTiers = ['初期', '中期', '后期', '圆满'];

/**
 * 解析境界值 → {tier: 大阶下标, sub: 小层下标}
 *
 * 支持「元婴后期」「元婴期」「元婴」「筑基中期」等写法。
 * 无法解析时返回 null——**宁可判不出，不可判错**。
 */
function parseRealm(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  // ⚠️ 陷阱：「元婴后期」不能先 replace(/期$/,'')——它把「后期」切成「后」，
  // 导致小层子串匹配失败、sub 恒为 0，**静默漏判所有「XX期」写法的倒退**。
  // 这里的「期」不是层级词（凝气期/筑基期= 该阶本身），只有结尾裸「期」才可去。
  const bare = s.replace(/期$/, '');

  let tier = -1;
  let sub = 0;
  // 小层必须在**原始串**上找（「元婴后期」含「后期」，裸串里已被切坏）
  for (const t of ORDINAL_SUBTiers) {
    if (s.includes(t)) { sub = ORDINAL_SUBTiers.indexOf(t); break; }
  }
  // 大阶用裸串匹配，避免结尾「期」干扰
  for (let i = ORDINALS.境界.length - 1; i >= 0; i--) {
    if (bare.includes(ORDINALS.境界[i])) { tier = i; break; }
  }
  if (tier < 0) return null;
  // 「元婴」这种无小层后缀的写法视为该阶初期（最低），避免误判倒退
  return { tier, sub };
}

/** 统计字段：每次都会变，不参与漂移判定 */
const STAT_FIELDS = new Set(['出现次数', '提及方式', '本章字数']);

/**
 * 移动动词：出现即认为位置变化有剧情依据。
 *
 * 刻意**不含单字「在」**——实测它太泛：「谢九在此」「站在原地」「墓碑在风里」
 * 都会命中，导致无证据跳变永远检不出来（漂移检测形同虚设）。
 * 只保留有明确位移语义的词。
 */
const MOVE_HINTS = [
  '到了', '前往', '回到', '走进', '来到', '离开', '赶往', '抵达',
  '落入', '进了', '出了', '走向', '返回', '现身', '启程', '动身',
  '抵达了', '回到', '远赴', '折返', '逃出', '闯入', '登上', '下山', '上山',
];

function ordinalIndex(field, value) {
  const list = ORDINALS[field];
  if (!list || value == null) return -1;
  return list.indexOf(String(value));
}

/**
 * 检测状态漂移。
 *
 * @param {object} prevState 上次的 state
 * @param {object} nextState 本次推断的
 * @param {object} [opts]
 * @param {string} [opts.text] 本章正文——用于判断位置变化有无移动动词
 * @param {string[]} [opts.prevLocations] 之前出现过的位置序列，用于检测来回跳
 * @returns {{conflict:boolean, kind?:string, field?:string, old?:any, new?:any, hint?:string}}
 */
function detectDrift(prevState, nextState, opts = {}) {
  if (!prevState || !Object.keys(prevState).length) return { conflict: false };
  const text = String(opts.text || '');

  for (const [k, v] of Object.entries(nextState)) {
    if (v === null || v === undefined) continue;
    if (!(k in prevState)) continue;
    if (prevState[k] === v) continue;
    if (STAT_FIELDS.has(k)) continue;

    // ---- 存活状态：只有「复活」方向需要报，「死亡」是正常剧情 ----
    if (k === 'alive') {
      if (prevState[k] === false && v === true) {
        return {
          conflict: true,
          kind: 'resurrection',
          field: k,
          old: prevState[k],
          new: v,
          hint: `旧状态为已死，本章却判定在场。复活必须有显式证据（起死回生的描写），不能默认成立，需人工裁决`,
        };
      }
      continue; // true → false 是正常剧情（本章写到死）
    }

    // ---- 位置：变化本身不是漂移，关键看有没有移动依据 ----
    if (k === 'location') {
      const hasMove = MOVE_HINTS.some((h) => text.includes(h));
      if (hasMove) continue; // 有移动动词，位置变化是剧情

      // 无移动动词却换了位置。单次可疑但可能是漏更新，不阻断；
      // 连续两章都这样 → 状态回写坏了或模型在硬跳，必须报。
      if (prevState.unverifiedMoves >= 1) {
        return {
          conflict: true,
          kind: 'unverified-move-chain',
          field: k,
          old: prevState[k],
          new: v,
          hint: `连续第 ${prevState.unverifiedMoves + 1} 章位置在变、且本章正文无移动动词描写。`
            + `可能是状态回写漏更新或模型写错，需人工裁决`,
        };
      }
      continue;
    }

    // ---- 单调字段：倒退即漂移 ----
    if (ORDINALS[k]) {
      const o = parseRealm(prevState[k]);
      const n = parseRealm(v);
      if (o && n) {
        // 两维比较：大阶优先，小层次之
        const regressed = n.tier < o.tier
          || (n.tier === o.tier && n.sub < o.sub);
        if (regressed) {
          return {
            conflict: true,
            kind: 'ordinal-regression',
            field: k,
            old: prevState[k],
            new: v,
            hint: `${k}从「${prevState[k]}」倒退到「${v}」。境界不可逆，需人工裁决是回溯改写还是设定记错`,
          };
        }
        continue;
      }
      // 解析不出（换书、换体系、或写了「半步金丹」这类非标准表述）→
      // 退回字符串比较，判不出就不判，绝不误报
      const oi = ordinalIndex(k, prevState[k]);
      const ni = ordinalIndex(k, v);
      if (oi >= 0 && ni >= 0 && ni < oi) {
        return {
          conflict: true,
          kind: 'ordinal-regression',
          field: k,
          old: prevState[k],
          new: v,
          hint: `${k}从「${prevState[k]}」倒退到「${v}」。境界不可逆，需人工裁决`,
        };
      }
      continue;
    }

    // ---- 其他字段的数值倒退（如年龄、伤势等级）----
    const on = Number(prevState[k]);
    const nn = Number(v);
    if (Number.isFinite(on) && Number.isFinite(nn) && nn < on) {
      return {
        conflict: true,
        kind: 'numeric-regression',
        field: k,
        old: prevState[k],
        new: v,
        hint: `${k}从 ${on} 回落到 ${nn}。若该字段不应减少，需人工裁决`,
      };
    }
  }
  return { conflict: false };
}

module.exports = {
  detectDrift,
  ORDINALS,
  ORDINAL_SUBTiers,
  parseRealm,
  MOVE_HINTS,
  STAT_FIELDS,
};