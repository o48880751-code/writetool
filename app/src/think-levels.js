/**
 * 思考强度的档位表。
 *
 * ## 为什么要单独一个文件
 *
 * 档位列表由**服务商量表**决定（`electron/provider-presets.js` 里
 * 每家的 `think.style`），而它有两个消费方：
 *
 *   1. 设置页「AI 提供商」——告诉用户这家支持什么、参数长什么样
 *   2. 聊天输入框旁边的控件——用户实际切换的地方
 *
 * 两处各写一份的后果不是"多写几行"，而是**两边会分叉**：
 * 设置页显示四档、聊天框只给开关，用户按设置页的预期点了「中」，
 * 而实际发出去的是别的东西，且界面上完全看不出来。
 * 所以档位只在这里定义一次。
 *
 * ## 三种形态
 *
 *   levels     关闭 / 低 / 中 / 高     （Ollama、DeepSeek、OpenAI 系…）
 *   boolean    关闭 / 开启             （百炼那类只有开关的）
 *   model-only 没有档位概念            （靠模型名区分，如 QwQ）
 *
 * `model-only` 与认不出的形态都返回 `null` —— 界面上**不给控件**。
 * 硬给四档就是骗用户：点了「中」和「高」发过去的字节完全一样。
 */

/** 档位的显示名 */
export const LEVEL_LABEL = {
  off: '关闭',
  on: '开启',
  low: '低',
  medium: '中',
  high: '高',
};

/**
 * 档位图标（2026-10-14）。
 *
 * ⚠ 用几何字符而不是 emoji：emoji 会渲染成彩色字形，
 *   跟菜单里"选中项整行蓝色"的配色打架 —— 颜色不可控。
 *   几何字符能跟随 currentColor，选中变蓝、未选中变灰，一致。
 */
export const LEVEL_ICON = {
  off: '⊖',      // ⊖ 减号圆，语义就是"不做"
  on: '◉',       // ◉ 实心圆，只有开关的形态用
  low: '↘',      // ↘ 往右下，低
  medium: '→',   // → 平的，中
  high: '↗',     // ↗ 往右上，高
};

/**
 * 「默认」档（2026-10-14）。
 *
 * ⚠ 它不是真的第六档，而是一个**特殊值**：选中它等于
 *   "把这一档的选择权交回给模型/服务商"。
 *
 * 为什么要它：菜单里四档看着是并列的，但用户其实分不清
 * 「低」和「中」差在哪。与其逼他每次都做一个他判断不了的决定，
 * 不如给一个"我不管，你按默认来"的出口。
 *
 * 所以它显示在**最上面**且与其它档之间留出分隔 ——
 * 它的性质与下面那几个不同，视觉上要能看出来。
 */
export const DEFAULT_LEVEL = 'default';

/** 菜单顶部的「默认」项文案 */
export const DEFAULT_LABEL = '默认';
export const DEFAULT_HINT = '按这家服务商的默认档来，不用我每次挑。';

/**
 * 档位的说明。鼠标悬停时显示。
 *
 * 文案按羽毛菌的说法写：「简单文字修改问答用低或者关闭，创意框架用高」——
 * 用户看到的应该是"什么时候用哪个"，而不是"medium 与 high 的区别"。
 */
export const LEVEL_HINT = {
  off: '不思考。最快、最省，改错别字、调格式、简单问答用这个。',
  low: '想一点。日常问答与文字修改，比关略慢一点。',
  medium: '默认档。多数写作任务够用。',
  high: '想得深，慢且费 token。搭世界观框架、推剧情走向、理顺复杂冲突时用。',
  on: '这家只有开与关，没有档位。',
};

/**
 * 从服务商量表的条目算出可用档位。
 *
 * @param {object|null} preset `caps.providers` 里的一项（要带 think.style）
 * @returns {{levels: string[]|null, note: string}}
 */
export function thinkLevelsOf(preset) {
  const style = preset && preset.think && preset.think.style;
  const note = (preset && preset.think && preset.think.note) || '';
  if (style === 'levels') return { levels: ['off', 'low', 'medium', 'high'], note };
  if (style === 'boolean') return { levels: ['off', 'on'], note };
  // ⚠ 下面三种都「不渲染控件」，但要分开写，不能靠兜底碰巧对：
  //   none       —— 服务商量表明说这家不提供思考开关（vLLM / 方舟 / Kimi…）
  //   model-only —— 靠模型名区分，本身就没有开关
  //   undefined  —— 量表还没加载，或这家的条目没写 think 字段
  // 之前这三种都落到同一个 return，结果对；但哪天有人给 'none'
  // 写个新含义（比如"固定开"），这里就会静默沿用旧行为。
  if (style === 'none') return { levels: null, note };
  if (style === 'model-only') return { levels: null, note };
  return { levels: null, note };
}

/**
 * 归一化一个档位值。
 *
 * ⚠ 必须做这一步：档位存在两处（对话级 / 全局默认），
 *   两处的合法值集合**不一样**——全局是按连接算的，
 *   而用户在 Ollama（四档）下把对话设成「中」，
 *   之后换到百炼（只有开关），那条对话里存的还是 'medium'。
 *   不归一的话请求体里会出现百炼不认的值，服务端 400，
 *   而界面上那个控件显示的又是"开启"——用户完全看不懂为什么报错。
 *
 * @param {string} v 存着的值
 * @param {string[]|null} levels 这条连接可用的档位
 * @returns {string} 一定落在 levels 里（levels 为空则原样返回）
 */
export function normalizeLevel(v, levels) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!levels || !levels.length) return s;

  // ⚠⚠ 'default' 不是 levels 里的值（它是"交给服务商决定"的意思），
  //   但**必须在这里放行**。2026-10-14 加这一档时漏了，
  //   结果是：用户在菜单里点「默认」，下一次渲染就
  //   被 `levels.includes('default')` 判为认不出，退回 levels[0]（"关闭"）——
  //   界面显示「关闭」，用户以为自己关掉了思考，实际是他刚点的「默认」被吃掉了。
  //   这类"点了没反应还反着来"的 bug 极难自查，所以在这里钉死。
  if (s === DEFAULT_LEVEL) return DEFAULT_LEVEL;

  if (levels.includes(s)) return s;
  // 认不出的值：退回该连接的第一档（对四档是 off，对开关是 off）
  return levels[0];
}
