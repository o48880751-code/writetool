/**
 * L2 自动路由的触发准确率评测。
 *
 * ## 要回答的问题
 *
 * 「用户不手动 @，模型能不能只凭 skill 的 description 判断该用哪个技能？」
 * 这是接线 L2 的唯一前置条件。不准就不能接——接了就是每轮给模型塞
 * 一堆可能误触发的正文，比不接更糟。
 *
 * ## 为什么必须实测，不能推理
 *
 * description 匹配听起来是「关键词命中」，但真实做法是让模型做一次
 * 意图分类。这件事在 8B 上准不准、有没有过拟合到某几条用例，
 * 只有跑出来才知道。任何凭印象给的数字都是编的。
 *
 * ## 两套索引对比
 *
 *   current  —— 今天真能进索引的（skill:index 会 filter 掉没有
 *               description 的，所以只有 2 个）
 *   proposed —— 给 4 条 legacy 补上 description，再加 novel-revisor
 *               与 novel-sync（来自 novel-skills-delivery，已适配）
 *
 * 差值就是「接线 L2 之前必须先补 description」的量化依据。
 *
 * ## 跑法
 *
 *   node eval-skill-routing.js --set current
 *   node eval-skill-routing.js --set proposed
 *   node eval-skill-routing.js --set proposed --model qwen3:30b-a3b --think
 *
 * ⚠ 温度固定 0：分类任务要可复现，否则两次跑的差异分不清是
 *   模型不稳还是评测集不稳。
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';

// ---------------------------------------------------------------
// 两套索引
// ---------------------------------------------------------------

/** 今天真能进 skill:index 的两个（description 取自内置文件，未改动） */
const CURRENT = [
  {
    id: 'sk-novel-writer',
    name: '小说写作助手',
    description:
      '写小说时使用。当用户要写小说、写新章节、续写章节、创建章节、'
      + '初始化小说项目、创建新书、梳理人物设定、整理世界观、补写章节摘要时自动触发。'
      + '会先读人物库、世界观与章节摘要再动笔，保证人物与设定前后一致。'
      + '也可用于检查已写章节与设定是否冲突。',
  },
  {
    id: 'sk-skill-creator',
    name: '技能创建助手',
    description:
      '创建和改进 Skill。当用户提到"创建技能""写个技能""做个助手""帮我做一个 XX"'
      + '"我想让 AI 学会 XX""把这个流程变成技能"时使用，即使用户没有明确说出'
      + '"技能"二字也应触发。也可用于改进、调试已有技能'
      + '——比如"这个技能不触发""为什么没生效"。',
  },
];

/** proposed：补齐 description + 加两个新技能 */
const PROPOSED = [
  CURRENT[0],
  CURRENT[1],
  {
    id: 'sk-novel-revisor',
    name: '章节修订助手',
    description:
      '修改已保存的章节。当用户要改章节、重写某一章、润色已保存的章节、'
      + '这章不对重写、这段改改、把上一章润一下、回去改剧情时使用。'
      + '只要修改对象是已存在的章节就用它，不要用写作技能。',
  },
  {
    id: 'sk-novel-sync',
    name: '一致性检查与文档同步',
    description:
      '检查前后矛盾与同步维护文档。当用户要同步文档、更新维护文档、'
      + '检查设定冲突、查一致性、人物会不会写岔、设定有没有打架、'
      + '把最近几章同步进设定文件、看看最近写的有没有问题时使用。'
      + '只报告冲突，不改写正文。',
  },
  {
    id: 'sk-builtin-outline',
    name: '列章纲',
    description: '列出本章的分段大纲。写新章前想先看结构、或用户说「先列个大纲」时使用。',
  },
  {
    id: 'sk-builtin-dialogue',
    name: '写对白',
    description: '只写人物对话，不写动作与叙述。用户说「写段对白」「他们俩怎么说的」时使用。',
  },
  {
    id: 'sk-builtin-rewrite',
    name: '润色改写',
    description: '保持原意与情节，只优化语言：删掉堆砌的形容词、压缩冗长句子。'
      + '用户说「润色」「这段写得糙」「改通顺」时使用。',
  },
  {
    id: 'sk-builtin-check',
    name: '检查设定',
    description: '对照已给的人物与世界观设定，列出正文里冲突的条目并标注位置，'
      + '不改写正文。用户说「有没有写岔」「对一下设定」时使用。',
  },
];

/**
 * proposed v2：按 v1 的 4 条失败逐条修 description。
 *
 * ⚠ 不是"改到全绿为止"——每条改动都对应一条实测失败，
 *   改动理由写在注释里。第二轮如果还有失败，说明是模型能力上限，
 *   不是描述能救的。
 *
 * 改动清单：
 *  1. sk-novel-writer 的 description 里「梳理人物设定/整理世界观」
 *     与 sk-novel-sync 的「设定有没有打架」抢同一批词 ——
 *     v1 实测两条都被判给了 sync。修法：**加分工句**，
 *     明确"梳理"归 writer、"检查矛盾"归 sync。
 *  2. 「继续写，第二百章」漏触发 —— writer 的描述只有
 *     「续写章节」，没覆盖「继续写 + 章号」这种说法。补进去。
 *  3. sk-skill-creator 漏触发 —— 它的描述以「创建和改进 Skill」开头，
 *     但用户说「我想要个技能」时前面还有「我想要个」，模型读成了
 *     列大纲。修法：把「我想要个技能」这个说法原样写进描述。
 */
const PROPOSED_V2 = [
  {
    id: 'sk-novel-writer',
    name: '小说写作助手',
    description:
      '写新章节、续写、初始化新书，或**梳理与整理**已有设定时使用。'
      + '用户说「续写下一章」「接着上一章往下写」「继续写，第二百章」'
      + '「开个坑写本修仙的」「创建一本新书」「把人物设定梳理一下」'
      + '「整理世界观」时都算。'
      + '⚠ 与「一致性检查与文档同步」的分工：本技能负责**从头梳理和整理**，'
      + '对方负责**检查是否前后矛盾、对账、把正文同步进文档**。',
  },
  {
    id: 'sk-novel-revisor',
    name: '章节修订助手',
    description:
      '修改**已经存在的章节**。用户说「第七章写得不行，重写一遍」'
      + '「把上一章润一下」「这里剧情不对，退回去改」「这章重写」时使用。'
      + '⚠ 只要修改对象是已保存的章节，就用它，不要用「小说写作助手」'
      + '（那个是写新章节）。',
  },
  {
    id: 'sk-novel-sync',
    name: '一致性检查与文档同步',
    description:
      '**检查矛盾与同步文档**。用户说「同步文档」「检查有没有前后矛盾」'
      + '「这个人物会不会写岔」「把最近十章同步进设定文件」'
      + '「设定有没有打架」「看看最近写的有没有问题」时使用。'
      + '⚠ 与「小说写作助手」的分工：对方负责从头梳理设定，'
      + '本技能负责**挑毛病**——找出设定与正文的矛盾，并提出同步建议。'
      + '只报告，不改写正文。',
  },
  {
    id: 'sk-skill-creator',
    name: '技能创建助手',
    description:
      '创建和改进 Skill。用户说「我想要个技能」「创建技能」「写个技能」'
      + '「做个助手」「帮我做一个 XX」「把这个流程变成技能」时使用，'
      + '即使用户没有说出「技能」二字也应触发。'
      + '⚠ 用户是想要一个**技能本身**，不是想要技能帮你写的那件事'
      + '（「我想要个技能，让它写章前列大纲」= 要技能，不是要大纲）。'
      + '也可用于排查「这个技能怎么不生效」。',
  },
  {
    id: 'sk-builtin-outline',
    name: '列章纲',
    description: '列出本章的分段大纲。用户说「先列个大纲」「这章分几段」时使用。',
  },
  {
    id: 'sk-builtin-dialogue',
    name: '写对白',
    description: '只写人物对话，不写动作与叙述。用户说「写段对白」「他们俩怎么说的」时使用。',
  },
  {
    id: 'sk-builtin-rewrite',
    name: '润色改写',
    description: '保持原意与情节，只优化语言：删掉堆砌的形容词、压缩冗长句子。'
      + '用户说「润色」「这段写得糙」「改通顺」时使用。',
  },
  {
    id: 'sk-builtin-check',
    name: '检查设定',
    description: '对照已给的人物与世界观设定，列出正文里冲突的条目并标注位置，'
      + '不改写正文。用户说「有没有写岔」「对一下设定」时使用。',
  },
];

const SETS = { current: CURRENT, proposed: PROPOSED, proposed2: PROPOSED_V2 };

/**
 * real：从磁盘现读的 6 条真实技能（build-eval-index.js 生成）。
 *
 * ⚠ 这是唯一有意义的那个集合。current / proposed / proposed2 里的
 *   description 都是手抄的，手抄会漂移 —— 2026-10-16 早上磁盘上的正文
 *   已经按六项约束改过了，测出来的数字不代表真机。
 */
try {
  SETS.real = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'shots-verify', 'eval-index.json'), 'utf8'),
  );
} catch (_) {
  console.error('⚠ 读不到 eval-index.json —— 先跑 node build-eval-index.js');
  console.error('  只能用 --set current|proposed|proposed2（手抄的，可能已过期）');
}

// ---------------------------------------------------------------
// 评测集：32 条
//
// 分三类，分布刻意不均——真实使用里绝大多数消息跟技能无关，
// 那一类的准确率才是能不能上线的关键。
// ---------------------------------------------------------------

const CASES = [
  // ---- A. 应触发写作类（12 条）----
  { q: '帮我续写下一章', want: ['sk-novel-writer'] },
  { q: '接着上一章往下写', want: ['sk-novel-writer'] },
  { q: '写下一章吧，主角该去见那个长老了', want: ['sk-novel-writer'] },
  { q: '开个坑，写本修仙的', want: ['sk-novel-writer'] },
  { q: '创建一本新书', want: ['sk-novel-writer'] },
  { q: '把人物设定梳理一下，主角的动机不清楚', want: ['sk-novel-writer'] },
  { q: '整理一下世界观，力量体系太散了', want: ['sk-novel-writer'] },
  { q: '章节摘要该补了', want: ['sk-novel-writer'] },
  { q: '继续写，第二百章', want: ['sk-novel-writer'] },
  // ⚠ 边界：这两条上一版标了「不该触发」，现在改判。
  //   「这次写两千字左右」是在给写作要求 → 该触发 writer。
  //   「这段太慢了，帮我看看问题在哪」是求诊断不是求动手 →
  //   该给 polish（它就是干这个的），但也可以不触发。
  //   这里选后者更保守：用户没要求改，就不该塞一段改写规程进去。
  { q: '这次写两千字左右', want: ['sk-novel-writer'] },
  { q: '这段太慢了，帮我看看问题在哪', want: [] },
  { q: '我卡住了，写不下去', want: [] },           // 边界：情绪表达，不该触发

  // ---- B. 应触发修订/同步类（real 集才有对应技能，8 条）----
  { q: '第七章写得不行，重写一遍', want: ['sk-novel-revisor'] },
  { q: '把上一章润一下', want: ['sk-novel-polish'] },
  { q: '这里剧情不对，退回去改', want: ['sk-novel-revisor'] },
  { q: '同步文档', want: ['sk-novel-sync'] },
  { q: '检查一下最近几章有没有前后矛盾', want: ['sk-novel-sync'] },
  { q: '这个人物会不会写岔了', want: ['sk-novel-sync'] },
  { q: '把最近十章同步进设定文件', want: ['sk-novel-sync'] },
  { q: '设定有没有打架的地方', want: ['sk-novel-sync'] },

  // ---- C. 应触发单点技能（6 条）----
  { q: '先列个大纲看看这章结构', want: [] },   // 列章纲已并入写新章节，不该单独触发
  { q: '写一段他们两个的对话', want: ['sk-novel-dialogue'] },
  { q: '润色一下这几段', want: ['sk-novel-polish'] },
  { q: '这段写得糙，改通顺', want: ['sk-novel-polish'] },
  { q: '对一下设定，看有没有写岔', want: ['sk-novel-sync'] },
  { q: '我想要个技能，让它每次写章前先列大纲', want: ['sk-skill-creator'] },

  // ---- C2. 六项约束各自的触发词（2026-10-16 新增）----
  // 这几条是为了钉住羽毛菌提的六项，不靠它们验证就等于没验。
  { q: '这章发生在哪里我没想好', want: ['sk-novel-writer'] },        // 场景定义
  { q: '同步文档', want: ['sk-novel-sync'] },                       // 同步文档
  { q: '更新维护文档', want: ['sk-novel-sync'] },                   // 维护文档
  { q: '补写章节摘要', want: ['sk-novel-writer'] },                 // 维护文档
  { q: '检查设定冲突', want: ['sk-novel-sync'] },                   // 一致性
  { q: '继续写，第二百章', want: ['sk-novel-writer'] },             // 章节输出要求

  // ---- D. 不该触发任何技能（12 条，占比最高）----
  { q: '这句话怎么改通顺：「的地得」总是分不清', want: [] },
  { q: '帮我算下这个月花了多少钱', want: [] },
  { q: '今天天气怎么样', want: [] },
  { q: '把这个文件复制一份到桌面', want: [] },
  { q: 'python 怎么读一个 json 文件', want: [] },
  { q: '帮我起个名字，主角姓叶', want: [] },   // 边界：沾"名字"，易误触发设定类
  { q: '第三章一共多少字', want: [] },
  { q: '界面右上角那个按钮是干什么的', want: [] },
  { q: '你好', want: [] },
  { q: '谢了', want: [] },
  { q: '把它导出成 docx', want: [] },
  { q: '这段英文帮我翻译一下', want: [] },
];

// ---------------------------------------------------------------
// 路由器提示词
//
// ⚠ 这是被测对象本身，不是评测脚手架。改它就等于改了被测系统，
//   所以它写死在这里、逐字送进模型，跟主进程将来拼的字符串一致。
// ---------------------------------------------------------------

function routerPrompt(index, question) {
  const lines = index.map(
    (s) => `- ${s.id}（${s.name}）：${s.description}`,
  );
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

// ---------------------------------------------------------------
// 调模型
// ---------------------------------------------------------------

function chat(model, prompt, { think = false, timeoutMs = 300000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  return fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: ctl.signal,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      // ⚠⚠ think 是**顶层字段**，不在 options 里。
      //   照 provider.js:160 的实测记录写：「不能省略 false ——
      //   不传 think 时 Ollama 默认开着思考」。
      //   第一版把它塞进 options，模型每次都吐思考链，
      //   一条 111 秒 —— 环境问题伪装成了"模型慢"。
      ...(think ? { think: true } : { think: false }),
      options: {
        temperature: 0,
        num_ctx: 8192,
      },
    }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .finally(() => clearTimeout(timer));
}

/** 从模型输出里抠出 id 数组。容忍代码块、前后废话、尾逗号。 */
function extractIds(raw) {
  const text = String(raw || '');
  const m = text.match(/\[[\s\S]*?\]/);
  if (!m) return null;                    // 连数组都没输出 = 格式失败
  try {
    const v = JSON.parse(m[0].replace(/,\s*([\]}])/g, '$1'));
    return Array.isArray(v) ? v.map((x) => String(x)) : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------
// 打分
// ---------------------------------------------------------------

function score(got, want, failed) {
  const gotSet = new Set(got);
  const wantSet = new Set(want);
  const tp = [...wantSet].filter((x) => gotSet.has(x)).length;
  const fp = [...gotSet].filter((x) => !wantSet.has(x)).length;
  const fn = [...wantSet].filter((x) => !gotSet.has(x)).length;
  return {
    tp, fp, fn,
    exact: fp === 0 && fn === 0,
    // ⚠⚠ failed 的行**不能**算 blankGood。
    //   出错时 got=[]，而该选零个的用例期望也是 [] —— 于是「环境全崩」
    //   会显示成「不该触发的 15 条全部正确」。
    //   这是判据自己制造假绿，比模型答错更难发现。
    failed: !!failed,
    blankOk: !failed && wantSet.size === 0 && gotSet.size === 0,
    blankBad: !failed && wantSet.size === 0 && gotSet.size > 0,
  };
}

async function run() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 ? argv[i + 1] : d;
  };
  const setName = arg('set', 'proposed');
  const model = arg('model', 'qwen3:latest');
  const think = argv.includes('--think');
  const only = arg('only', '');

  const index = SETS[setName];
  if (!index) throw new Error(`未知索引集 ${setName}，可选：${Object.keys(SETS).join(' / ')}`);

  const cases = only ? CASES.filter((c) => c.q.includes(only)) : CASES;

  console.log(`索引集 ${setName}（${index.length} 个技能）｜模型 ${model}｜think=${think}`);
  console.log(`用例 ${cases.length} 条`);

  // ⚠⚠ 预热，否则延迟数字没有可比性。
  //   实测：冷启动首条约 3.5 秒，模型热留显存后约 0.18 秒 —— **差 19 倍**。
  //   不预热的话，「上一组 P50 2600ms、这一组 P50 176ms」根本不是
  //   索引变短的效果，是冷热差异。谁拿这两个数字对比谁被骗。
  //   （准确性不受影响 —— 冷热不影响选对选错。只影响延迟。）
  process.stdout.write('预热… ');
  try {
    await chat(model, '回复 ok', { timeoutMs: 300000 });
    console.log('完成\n');
  } catch (e) {
    console.log(`失败（${e.message}）—— 延迟数字会含冷启动，别拿来对比\n`);
  }

  console.log('');

  const rows = [];
  let parseFail = 0;

  for (const c of cases) {
    const t0 = Date.now();
    let ids = null;
    let err = '';
    try {
      const r = await chat(model, routerPrompt(index, c.q), { think });
      ids = extractIds(r?.message?.content);
      if (ids === null) parseFail++;
    } catch (e) {
      err = e.message;
      parseFail++;
    }
    const ms = Date.now() - t0;
    const got = ids || [];
    const s = score(got, c.want, !!err);
    rows.push({ q: c.q, want: c.want, got, ...s, ms, err });

    const mark = s.exact ? 'OK  ' : (err ? 'ERR ' : 'FAIL');
    console.log(
      `${mark} ${String(ms).padStart(6)}ms  ${c.q}`
      + (s.exact ? '' : `\n        期望 [${c.want.join(',')}]  实得 [${got.join(',')}]${err ? '  err=' + err : ''}`),
    );
  }

  // ---- 汇总 ----
  // ⚠⚠ 指标只在「模型真的答了」的行上算。
  //   把 err / 格式失败的行算进去，环境问题会伪装成模型表现——
  //   第一版就栽在这：38 条全 404，而「不该触发」显示 15/15。
  const n = rows.length;
  const okRows = rows.filter((r) => !r.failed);
  if (!okRows.length) {
    console.log('\n⚠ 没有一行拿到有效响应，全部指标不予计算。');
    console.log(`  错误样本：${rows[0] ? rows[0].err : '(无)'}`);
    console.log(`  模型 tag 是否存在？curl ${BASE}/api/tags 看一眼。`);
    process.exit(2);
  }
  const agg = (f) => okRows.reduce((a, r) => a + f(r), 0);
  const tp = agg((r) => r.tp);
  const fp = agg((r) => r.fp);
  const fn = agg((r) => r.fn);
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  const blankCases = okRows.filter((r) => r.want.length === 0);
  const blankGood = blankCases.filter((r) => r.got.length === 0).length;
  const posCases = okRows.filter((r) => r.want.length > 0);
  const posExact = posCases.filter((r) => r.exact).length;

  console.log('\n──────── 汇总 ────────');
  console.log(`用例 ${n}｜有效 ${okRows.length}｜出错/格式失败 ${parseFail}`);
  console.log(`整体精确率 ${(precision * 100).toFixed(1)}%｜召回率 ${(recall * 100).toFixed(1)}%｜F1 ${(f1 * 100).toFixed(1)}%`);
  console.log(`该触发且完全正确 ${posExact}/${posCases.length}（${(posExact / posCases.length * 100).toFixed(1)}%）`);
  console.log(`不该触发且确实没触发 ${blankGood}/${blankCases.length}（${(blankGood / blankCases.length * 100).toFixed(1)}%）`);
  const lat = okRows.map((r) => r.ms).sort((a, b) => a - b);
  const m = okRows.length;
  console.log(`延迟 P50 ${lat[Math.floor(m * 0.5)]}ms｜P95 ${lat[Math.floor(m * 0.95)]}ms`);

  // ---- 落盘：给跨集对比用 ----
  const out = path.join(__dirname, 'shots-verify', `routing-${setName}-${model.replace(/[:.]/g, '_')}${think ? '-think' : ''}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    set: setName, model, think,
    n, ok: okRows.length, parseFail,
    precision, recall, f1,
    posExact, posTotal: posCases.length,
    blankGood, blankTotal: blankCases.length,
    p50: lat[Math.floor(m * 0.5)], p95: lat[Math.floor(m * 0.95)],
    rows,
  }, null, 2));
  console.log(`\n结果已写：${out}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
