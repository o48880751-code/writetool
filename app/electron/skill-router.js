/**
 * 技能自动路由（L2）。
 *
 * ## 这层解决什么
 *
 * 技能本来只有一条进上下文的路：`buildRefBlock`（main.js）——
 * 用户在输入框上方的 @ 浮层里手动勾选。**没勾 = 一字不进。**
 *
 * 后果是：用户装了 6 个技能，得自己记住「续写要勾哪个」「同步要勾哪个」，
 * 而技能之间职责相邻、名字相近，勾错的人不少。
 *
 * 本模块让它自动：发消息前先问模型一句「按 description，这几条该用哪个」，
 * 命中的技能正文拼进上下文。
 *
 * ## 为什么不塞进 agent-loop
 *
 * 因为 agent-loop 的工具循环是**给模型自己发起的调用**用的，
 * 而路由是我们替模型问的一次**前置判断**，发生在消息拼装阶段、
 * 在 agent-loop 启动之前。塞进去会让「工具循环」里混进一个
 * 「我们问模型的问题」，两者的失败处理会互相污染。
 *
 * ## 为什么单独一个文件
 *
 * 这是唯一一处「要用小模型做分类」的逻辑，而分类能力是整个产品里
 * 最容易悄悄退化的地方（模型换了、提示词改了、技能改了，数字都会变）。
 * 混进 main.js 就只能真连模型验——而真连模型要 44 次调用，
 * 每次几十秒到几分钟。拆出来才能喂桩做边界测试，
 * 真跑用 eval-skill-routing.js。
 *
 * ## 硬约束
 *
 * 1. **失败必须静默降级**：路由判错、模型超时、解析不出来 ——
 *    全部退回「没注入任何技能」，也就是退回 1.0.5 的行为。
 *    绝不能让用户发不出消息。
 * 2. **不覆盖手动 @**：用户手动勾的技能永远优先。自动路由只**补充**。
 * 3. **不注入已停用的**：enabled=0 的技能不进索引。
 */

const SKILL_ROUTER_TIMEOUT_MS = 15000;

/** 一次最多自动注入几个技能。多了会把上下文吃光 */
const MAX_AUTO_SKILLS = 2;

/**
 * 拼路由用的提示词。
 *
 * ⚠ 这是**被测对象**。eval-skill-routing.js 里的 routerPrompt 与它
 *   逐字一致——改这里必须同步改那边，否则测出来的数字不代表线上。
 *
 * @param {Array<{id:string,name:string,description:string}>} index
 * @param {string} question 用户这一条消息
 */
function buildRouterPrompt(index, question) {
  const lines = index.map((s) => `- ${s.id}（${s.name}）：${s.description}`);
  return [
    '你是一个技能路由器。你的任务是根据用户请求，从技能清单里挑出需要启用的技能。',
    '',
    '技能清单：',
    ...lines,
    '',
    '判断规则：',
    '1. 只在用户确实要做清单里某项技能的事时才选它。',
    '2. 闲聊、问知识、问操作方法、情绪表达，都不选。',
    '3. 拿不准就不选。宁可漏选也不要误选——误选的代价是多塞一段无关正文。',
    '4. 可以不选任何技能，此时输出空数组。',
    '',
    '只输出一行 JSON，不要任何解释、不要 markdown 代码块：',
    '{"ids":["技能id"]}',
    '',
    '用户请求：' + question,
  ].join('\n');
}

/**
 * 从模型输出里抠出 id 数组。
 *
 * ⚠ 容忍代码块、前后废话、尾逗号。8B 模型很爱给答案套 ```json。
 *
 * @returns {string[]|null} null 表示格式不可用（调用方应降级）
 */
function extractIds(raw) {
  const text = String(raw == null ? '' : raw);
  const m = text.match(/\[[\s\S]*?\]/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0].replace(/,\s*([\]}])/g, '$1'));
    return Array.isArray(v) ? v.map(String) : null;
  } catch (_) {
    return null;
  }
}

/**
 * 判断某条消息值不值得跑一次路由。
 *
 * ⚠ 短路条件每一个都对应一类「跑了也是白跑」的情况：
 *   - 没开开关
 *   - 没有技能可路由
 *   - 用户手动勾过了（勾了就说明他明确要，再猜一遍是添乱）
 *   - 空消息 / 太短（「继续」两个字让模型判也判不准）
 */
function shouldRoute(opt) {
  if (!opt.enabled) return false;
  if (!opt.index || !opt.index.length) return false;
  if (opt.manualIds && opt.manualIds.length) return false;
  const q = String(opt.question == null ? '' : opt.question).trim();
  if (q.length < 2) return false;
  return true;
}

/**
 * 跑一次路由。
 *
 * @param {object} opt
 * @param {boolean} opt.enabled      开关
 * @param {Array}  opt.index         候选技能 [{id,name,description}]
 * @param {string} opt.question      用户消息
 * @param {Array}  [opt.manualIds]   用户已手动勾的技能 id
 * @param {Function} opt.ask         问模型：async (prompt, {timeoutMs}) => string
 * @returns {Promise<{ids:string[], reason:string}>}
 *          reason 便于日志与界面提示：ok / disabled / manual / empty / fail
 */
async function route(opt) {
  if (!shouldRoute(opt)) {
    const reason = !opt.enabled ? 'disabled'
      : (opt.manualIds && opt.manualIds.length) ? 'manual'
        : (!opt.index || !opt.index.length) ? 'empty'
          : 'tooshort';
    return { ids: [], reason };
  }

  let raw = '';
  try {
    raw = await opt.ask(buildRouterPrompt(opt.index, opt.question), {
      timeoutMs: SKILL_ROUTER_TIMEOUT_MS,
    });
  } catch (e) {
    // ⚠ 静默降级。路由失败绝不能影响用户发消息——
    //   退回 1.0.5 的行为（什么都不注入）完全可接受。
    return { ids: [], reason: 'fail:timeout' };
  }

  const ids = extractIds(raw);
  if (ids === null) return { ids: [], reason: 'fail:parse' };

  // ⚠ 只保留索引里真实存在的 id。模型偶尔会编一个 id
  //   （尤其相邻技能名很像时），照单全收会取到 undefined 的正文。
  const valid = new Set(opt.index.map((s) => s.id));
  const picked = ids.filter((id) => valid.has(id)).slice(0, MAX_AUTO_SKILLS);

  return { ids: picked, reason: 'ok' };
}

module.exports = {
  route,
  shouldRoute,
  buildRouterPrompt,
  extractIds,
  SKILL_ROUTER_TIMEOUT_MS,
  MAX_AUTO_SKILLS,
};
