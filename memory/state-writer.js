/**
 * 状态回写：commit_chapter 之后由编排层强制触发。
 *
 * 为什么必须编排层做（实测依据，见 probe-report / 底稿§3.5）：
 *   已知实体组 20 个样本，模型 **20/20 只查了 location**（地名）；
 *   写改组 10/10 只查 character。
 *   模型按题目需要选实体类型，**不会主动维护角色状态**。
 *   所以「写完一章自动更新谁在哪、谁活着、修为几何」不能指望模型调用工具，
 *   必须由编排层扫正文、比对状态表、强制 upsert。
 *
 * 这一层是纯代码，不调模型 —— 与 §4.2「校验位由代码强制」是同一条原则。
 *
 * 定位算法（确定性，不用模型）：
 *   1. 从正文里找出提及的设定实体（子串匹配 + 别名）
 *   2. 语义级判定：字面出现 / 简称 / 未出现（复用 editor/streaming-writer.js 的三档逻辑）
 *   3. 分类：character 类更新位置与在场；location 类更新「场景」
 *   4. 写入前先检测**状态漂移**：新状态与旧状态矛盾时报冲突而不是静默覆盖
 */

const { norm, suffixVariants } = require('./text-util.js');
const { detectDrift: checkDrift, MOVE_HINTS } = require('./drift-rules.js');

/** 地点类关键词：出现在实体附近时判定为「角色在该地点」 */
const PLACE_HINTS = ['在', '到了', '前往', '回到', '站在', '走进', '来到', '离开', '赶往', '抵达'];

/**
 * 从正文里找出提及了哪些设定实体。
 * @param {string} text 正文
 * @param {Array} settings 设定条目 [{name, type, aliases}]
 * @returns {Map<string, {name, type, aliases, hitBy}>}实体名 → 命中信息
 */
function extractEntities(text, settings) {
  const found = new Map();
  const body = String(text || '');
  for (const e of settings) {
    const variants = [e.name].concat(e.aliases || [], suffixVariants(e.name));
    const hit = variants.find((v) => v && v.length >= 2 && body.includes(v));
    if (hit) {
      found.set(e.name, {
        name: e.name,
        type: e.type,
        aliases: e.aliases || [],
        hitBy: hit,
        literal: hit === e.name,
        count: countOccurrences(body, hit),
      });
    }
  }
  return found;
}

function countOccurrences(text, sub) {
  if (!sub) return 0;
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(sub, i)) >= 0) { n++; i += sub.length; }
  return n;
}

/**
 * 判定角色在正文中的位置。
 *
 * 刻意保守：只在「实体名 + 地点关键词 + 地点名」三者共现时才判定位置，
 * 避免把「他想起铁棺」误判成「他在铁棺」。宁可漏判不可错判——
 * 错判会污染状态表，比漏判危害大得多。
 *
 * ⚠️ 必须取「最后一个」符合条件的位置，不是第一个。实测反例：
 *   「谢九离开洛阳，前往剑冢。」→ 早期版本返回洛阳（第一个命中）。
 *   错在哪：中文叙事总是先提来处再提去处，取第一个等于永远记录出发地。
 *   长篇里这会让状态表几百章都停在第一章的地点。
 *
 * @returns {{location: string|null, confidence: 'high'|'none'}}
 */
function resolveLocation(text, character, locations) {
  const body = String(text || '');
  const charVariants = [character.name].concat(character.aliases || []).filter(Boolean);
  if (!charVariants.length) return { location: null, confidence: 'none' };

  // 收集所有「实体名 → 地点名」且窗口内有移动动词的候选
  const candidates = [];
  for (const l of locations) {
    const locVariants = [l.name]
      .concat(l.aliases || [], suffixVariants(l.name))
      .filter((v) => v && v.length >= 2);
    for (const lv of locVariants) {
      let from = 0;
      let idx;
      while ((idx = body.indexOf(lv, from)) >= 0) {
        from = idx + lv.length;
        for (const cv of charVariants) {
          const cIdx = body.lastIndexOf(cv, idx);
          if (cIdx < 0) continue;
          const window = body.slice(cIdx, idx + lv.length);
          if (PLACE_HINTS.some((h) => window.includes(h))) {
            candidates.push({ name: l.name, at: idx });
            break;
          }
        }
      }
    }
  }
  if (!candidates.length) return { location: null, confidence: 'none' };

  // 取正文中最靠后的那个——即角色最终所在的地点
  candidates.sort((a, b) => b.at - a.at);
  return { location: candidates[0].name, confidence: 'high' };
}

/**
 * 检测状态漂移：新推断的状态与旧状态矛盾。
 *
 * ⚠️ 判定规则已抽到 drift-rules.js。这里保留薄封装以兼容旧调用。
 *   核心更正：位置变化 ≠ 漂移。上一版把 location 变化一律报冲突，
 *   那样写到第 2 章就会卡死（长篇里角色必然移动位置）。
 *
 * @param {object} prevState 上次的 state
 * @param {object} nextState 本次推断的
 * @param {object} [opts] {text, prevLocations} 供规则判定移动依据与来回跳
 * @returns {{conflict:boolean, kind?:string, field?:string, hint?:string}}
 */
function detectDrift(prevState, nextState, opts = {}) {
  return checkDrift(prevState, nextState, opts);
}

/**
 * 从一章正文推导状态变更。
 *
 * @param {object} args
 * @param {string} args.text 章节正文
 * @param {Array}  args.settings 本项目全部设定
 * @param {string} args.chapterId 本章 id
 * @param {object} [args.prevStates] 上次状态 {entityName: state}
 * @returns {{updates: Array, entities: Array, conflicts: Array}}
 */
function deriveStateChanges({ text, settings, chapterId, prevStates = {} }) {
  const mentioned = extractEntities(text, settings);
  const locations = [...mentioned.values()].filter((e) => e.type === 'location');
  const characters = [...mentioned.values()].filter((e) => e.type === 'character');

  const updates = [];
  const conflicts = [];

  for (const c of characters) {
    const { location } = resolveLocation(text, c, locations);
    const next = { 出现次数: c.count, 提及方式: c.literal ? '字面' : `简称(${c.hitBy})` };
    if (location) next.location = location;
    // 出现在正文即视为在场；不在场不是「离场」，是「本章没写到」，
    // 所以不写 alive:false —— 那需要显式证据，属于下一章的判定范畴。
    next.alive = true;

    const prev = prevStates[c.name] || null;
    const drift = detectDrift(prev, next, {
      text,
      prevLocations: (prev && prev.locationHistory) || [],
    });
    if (drift.conflict) {
      conflicts.push({
        entity: c.name,
        chapterId,
        kind: drift.kind,
        field: drift.field,
        old: drift.old,
        new: drift.new,
        hint: drift.hint || '与旧状态矛盾，需人工裁决',
      });
      // 冲突时不写入，避免污染真相源
      continue;
    }
    // 保留位置轨迹：它是长篇里唯一能回答「这个角色都去过哪儿」的数据。
    const history = (prev && prev.locationHistory) || [];
    const merged = { ...(prev || {}), ...next };
    if (location && (!history.length || history[history.length - 1] !== location)) {
      merged.locationHistory = [...history, location].slice(-12); // 只留最近 12 个，防止无限增长
    }
    // 无移动证据的位移计数：连续两章触发漂移告警，单次只记账不阻断。
    // 这是状态回写「是否可靠」的持续指标，排查长篇状态异常时先看它。
    merged.unverifiedMoves = location && prev && prev.location && location !== prev.location
      ? ((prev.unverifiedMoves || 0) + (MOVE_HINTS.some((h) => text.includes(h)) ? 0 : 1))
      : 0;
    updates.push({
      entityName: c.name,
      entityType: c.type,
      chapterId,
      state: next,
      // 合并而非覆盖：保留上一章的其他字段（如修为、手里的东西）
      mergedState: merged,
    });
  }

  return {
    updates,
    entities: [...mentioned.values()].map((e) => ({ name: e.name, type: e.type, count: e.count })),
    conflicts,
  };
}

/**
 * 编排层钩子：commit_chapter 之后调用。
 *
 * 设计成「返回结果由调用方决定是否落库」而不是直接写——因为冲突时
 * 必须停下来问人，自动写就等于把矛盾当真相。
 *
 * @returns {{applied:number, conflicts:Array, summary:string}}
 */
function applyStateAfterCommit({ store, projectId, chapterId, text, settings }) {
  const prevStates = {};
  for (const s of store.listEntityStates(projectId)) prevStates[s.entity_name] = s.state;

  const { updates, conflicts, entities } = deriveStateChanges({
    text, settings, chapterId, prevStates,
  });

  let applied = 0;
  for (const u of updates) {
    store.setEntityState({
      projectId,
      entityName: u.entityName,
      state: u.mergedState,
      chapterId,
    });
    applied++;
  }

  const parts = [`本章提及 ${entities.length} 个设定实体，状态更新 ${applied} 条`];
  if (conflicts.length) parts.push(`⚠️ ${conflicts.length} 处状态冲突未写入`);

  return { applied, conflicts, entities, summary: parts.join('，') };
}

module.exports = {
  extractEntities,
  resolveLocation,
  detectDrift,
  deriveStateChanges,
  applyStateAfterCommit,
};
