/**
 * 生成结束后，把正文自动写回章节文件。
 *
 * ## 为什么要有这个模块（2026-10-18，羽毛菌报的 bug）
 *
 * 原话：「我让助手重写第一章后，它只输出了文字，并没有把文章内容
 *   重新写进第一章文件。输出完文字后，应该要去目录里查看有没有文件，
 *   有的话直接覆盖，没有文件就新建文件」
 *
 * 根因不在模型，在**系统提示的两条分支互斥**：
 *   【一】要内容     → 直接输出正文，不要任何元信息
 *   【二】要写进文件 → 调 write_note
 * 「重写第一章」落在【一】，模型于是只吐字，一个文件都不碰。它没有犯错，
 * 它严格照做了。
 *
 * ## 为什么不让模型自己写（改提示词不就行了）
 *
 * 这个项目已经踩过一次同样的坑：**模型从不主动维护状态**
 * （实测 20/20 只查 location、10/10 只查 character，状态回写必须由
 * 编排层强制）。把"记得落盘"押在模型的自觉性上，结果就是它十次里忘八次，
 * 而用户看到的是"软件坏了"。
 *
 * 落盘是**软件的事**，模型只负责写正文。所以做成编排层的一步：
 * 生成结束 → 判断这一轮是不是在写某一章 → 是就写回去。
 *
 * ## 误写的代价不对称（这是整个判定保守的原因）
 *
 * 聊天里问「第一章写得怎么样」，模型回一段分析。如果这段被当成正文
 * 写进 章节/第一章.md，用户的原稿就没了（虽然有 .bak 能找回来，
 * 但那一刻足以让人不敢再用）。反过来，漏写一次的代价只是"还得手动说一句
 * 存到第一章"。
 *
 * 所以：**只认「明确的写作意图 + 明确的章节指代」，有歧义一律不写**，
 * 内容留在对话里，用户自己决定。
 *
 * ## 纯逻辑
 *
 * 这个文件不碰 fs、不碰 electron、不碰数据库。目标解析与内容清洗
 * 全是入参出参，好让 `test-auto-save.js` 能直接钉住每一条判定。
 */

/**
 * 强写作动词。命中才算"要内容"。
 *
 * ⚠ 刻意不收**裸的「写」**：`怎么写`、`写着写着`、`写得好不好`全都会误命中，
 *   而这个字在小说讨论里出现频率极高。
 * ⚠ 「生成」收进来是因为它在本产品里只用于"生成正文/生成简介"，
 *   而生成简介走的是另一条通道（`generate:start`），不会到这里。
 */
const WRITE_VERBS = [
  '重写', '改写', '续写', '补写', '扩写', '精简', '润色', '重制',
  '重新写', '再写', '继续写', '接着写', '帮我写', '给我写', '从头写',
  '写一遍', '写一版', '重来一遍', '生成第', '完善这', '完成这',
];

/**
 * 写作动词的**组合**形态。
 *
 * ⚠ 裸的「写」不能进 WRITE_VERBS（`第一章写得怎么样`会误命中），
 *   但「写第五章」「帮我写第一章」是用户最自然的说法 —— 判据里第一次跑
 *   就漏了它（`resolve({userText:'写第五章'})` 返回 null）。
 *   所以按「写 + 至多 6 个字 + 第N章」这个**结构**来认，而不是认单个字。
 */
const WRITE_PATTERNS = [
  /写[^，。,.!?！？\n]{0,6}第\s*([0-9]{1,4}|[零〇一二两三四五六七八九十百千]{1,6})\s*章/,
  /(新写|重写|改写|续写|补写)[^，。,\n]{0,4}(这|该|那一?)(章|节)/,
];

/**
 * 分析类词。**同时命中写作动词和分析词 → 不写**。
 *
 * 典型误判场景：「重写第一章，先说说哪里不好」——用户要的是诊断，
 * 模型回一段评价 + 一段改写。这时写进文件就把评价也带进去了。
 */
const ADVICE_WORDS = [
  '分析', '看看', '检查', '评价', '点评', '对比', '总结', '概括',
  '说说', '聊聊', '建议', '怎么看', '有没有问题', '合不合理', '问题在哪',
];

/**
 * 显式拒绝落盘。命中立刻放弃——这是用户明确表态，不需要任何推断。
 *
 * ⚠ 不要往里加「先」：`先写第一章` 是正常写作要求，加了会把整个功能废掉。
 */
const DENY_WORDS = [
  '不要写', '别写', '不用写', '不要保存', '不用保存', '不要改', '别改',
  '不要动', '别动', '只给我看', '只输出', '先别写', '先别看',
];

/** 短于这个长度不当正文。一个章节正文不可能只有几百字，而"好的，我明白了"这种会。 */
const MIN_CHARS = 400;

/** 新建章节的默认目录（与项目模板 TEMPLATE_DIRS 保持一致） */
const CHAPTER_DIR = '章节';

// ============================================================
// 中文数字
// ============================================================

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };

/**
 * 中文数字 → 整数。支持 一 / 十 / 十一 / 二十 / 一百零三 / 两千。
 * 解析不了返回 null（调用方据此放弃，绝不猜）。
 */
function cnToInt(s) {
  const t = String(s || '').replace(/\s/g, '');
  if (!t) return null;
  if (/^[0-9]+$/.test(t)) return Number(t);
  let total = 0;
  let section = 0;
  let num = 0;
  let seen = false;
  for (const ch of t) {
    if (CN_DIGIT[ch] != null) {
      num = CN_DIGIT[ch];
      seen = true;
    } else if (CN_UNIT[ch] != null) {
      const u = CN_UNIT[ch];
      // ⚠ 「十一」开头：十前面没有数字，按 1 算，否则会算成 0+10=10 但 num 为 0 时
      //   后面加 1 就变成 11 —— 所以这里必须先补 1
      section += (num || 1) * u;
      num = 0;
      seen = true;
    } else {
      return null;
    }
  }
  total += section + num;
  return seen ? total : null;
}

/**
 * 整数 → 中文数字（1 ~ 9999）。用于把「第1章」和「第一章」两种写法归一。
 */
function intToCn(n) {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0 || num > 9999) return String(n);
  if (num < 10) return d[num];
  if (num < 20) return num === 10 ? '十' : `十${d[num % 10]}`;
  if (num < 100) {
    const t = Math.floor(num / 10);
    const r = num % 10;
    return r ? `${d[t]}十${d[r]}` : `${d[t]}十`;
  }
  if (num < 1000) {
    const h = Math.floor(num / 100);
    const rest = num % 100;
    if (!rest) return `${d[h]}百`;
    if (rest < 10) return `${d[h]}百零${d[rest]}`;
    return `${d[h]}百${intToCn(rest)}`;
  }
  const k = Math.floor(num / 1000);
  const rest = num % 1000;
  if (!rest) return `${d[k]}千`;
  if (rest < 100) return `${d[k]}千零${intToCn(rest)}`;
  return `${d[k]}千${intToCn(rest)}`;
}

// ============================================================
// 意图判定
// ============================================================

/**
 * 这一轮用户到底在要什么。
 *
 * @returns {{write:boolean, deny:boolean, advice:boolean, hit:string[]}}
 */
function detectIntent(userText) {
  const t = String(userText || '');
  const byVerb = WRITE_VERBS.filter((w) => t.includes(w));
  const byPattern = WRITE_PATTERNS.some((re) => re.test(t));
  const deny = DENY_WORDS.filter((w) => t.includes(w));
  const advice = ADVICE_WORDS.filter((w) => t.includes(w));
  return {
    write: byVerb.length > 0 || byPattern,
    deny: deny.length > 0,
    advice: advice.length > 0,
    hit: byVerb.concat(byPattern ? ['写第N章'] : []),
  };
}

/**
 * 抽出用户提到的章节号（去重、保序）。
 *
 * 只认 `第X章` 这一种写法 —— 这是中文小说里唯一不会歧义的说法。
 * 「第一章」和「第1章」都收，归一成数字。
 */
function extractChapterNumbers(userText) {
  const t = String(userText || '');
  const re = /第\s*([0-9]{1,4}|[零〇一二两三四五六七八九十百千]{1,6})\s*章/g;
  const out = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const n = cnToInt(m[1]);
    if (n && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

// ============================================================
// 文件树
// ============================================================

/** 把 ProjectFs.tree() 的嵌套结构摊平成 [{path, name}] */
function collectFiles(node, out = []) {
  if (!node) return out;
  if (node.type === 'file') {
    /**
     * ⚠⚠ 路径必须归一成 `/`（2026-10-18，判据抓出来的真 bug）。
     *
     * `ProjectFs.tree()` 里的 childRel 是 `path.join()` 拼的 —— 在 Windows 上
     * 返回 **反斜杠**（`章节\第一章.md`）。而本模块所有判断都按 `/` 写：
     *   · `path.startsWith('章节/')` → 永远是 false
     *   · `activePath === f.path` 之类的比较 → 永远不相等
     * 后果是"打开着第一章说重写一下"这条路线**静默失效**，而用假的 fs
     * 造夹具（手写 `/` 路径）时**永远测不出来**。
     */
    if (node.path) {
      out.push({
        path: String(node.path).replace(/\\/g, '/'),
        name: node.name || String(node.path).split(/[\\/]/).pop(),
      });
    }
    return out;
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const c of kids) collectFiles(c, out);
  return out;
}

/**
 * 文件名是否就是「第 N 章」。
 *
 * ⚠ 用正则而不是 `includes`：`第1章` 是 `第11章` 的**前缀**吗？
 *   不是（第/1/1/章 里没有子串 第/1/章），所以 includes 在这组上恰好安全；
 *   但 `第一章` 对 `第一章节细纲` 会命中，那是不该写的文件。
 *   正则末尾的 `(?![\s\S])` 太严（文件名后面常带标题），
 *   所以放宽到「章后面不能紧跟数字或"节"」。
 */
function nameMatchesChapter(name, n) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  // ⚠ 辅助文档不是正文：`第一章细纲.md` 里含「第一章」，但写进去的是小说，
  //   一旦命中，模型的正文会把用户的细纲整个盖掉。
  if (/摘要|细纲|大纲|梗概|设定|人物|笔记/.test(base)) return false;
  const forms = [String(n), intToCn(n)];
  return forms.some((f) => {
    const re = new RegExp(`第\\s*${f}\\s*章(?!\\s*[节卷部])`);
    return re.test(base);
  });
}

// ============================================================
// 正文清洗
// ============================================================

/**
 * 去掉开头那句"好的，以下是重写后的第一章："
 *
 * ⚠ 只处理**整行且以冒号结尾**的这一种形态，且长度上限 40 字。
 *   放宽一点就会开始吃正文首句 —— 那是把用户稿子改坏，比留一句废话严重得多。
 */
function stripPreamble(text) {
  const lines = String(text || '').split('\n');
  if (lines.length < 2) return { text: String(text || ''), stripped: '' };
  const first = lines[0].trim();
  if (!first || first.length > 40) return { text: String(text || ''), stripped: '' };
  const looksMeta = /^(好的|好|以下是|下面是|这是|以下为|已按|按你的要求|收到)/.test(first)
    && /[:：]\s*$/.test(first);
  if (!looksMeta) return { text: String(text || ''), stripped: '' };
  return { text: lines.slice(1).join('\n').replace(/^\n+/, ''), stripped: first };
}

// ============================================================
// 主判定
// ============================================================

/**
 * 决定这一轮生成要不要落盘、落到哪。
 *
 * @param {object} o
 * @param {string} o.userText   本轮用户消息原文
 * @param {string} [o.activePath] 界面当前打开的文件（相对路径），可为空
 * @param {object} [o.tree]      ProjectFs.tree() 结果
 * @param {string} o.content     生成的正文
 * @param {boolean} [o.wroteByTool] 本轮模型是否已经调过 write_note
 * @param {boolean} [o.stopped]  用户是否中途停止
 * @returns {{path:string, mode:'replace'|'create', content:string, why:string}|null}
 */
function resolve(o) {
  const opt = o || {};
  const userText = String(opt.userText || '');
  const raw = String(opt.content || '');

  // ---- 0) 已经写过了，别写第二遍 ----
  // 模型自己调了 write_note：它已经落过盘，再写一次就是双重写入，
  // 而且会用同一份内容覆盖它刚写的东西（备份还会多出一份）。
  if (opt.wroteByTool) return null;

  // ---- 1) 用户按了停止：半截稿子不能拿去覆盖 ----
  if (opt.stopped) return null;

  // ---- 2) 意图 ----
  const it = detectIntent(userText);
  if (it.deny) return null;
  if (!it.write) return null;
  // 又要写又要点评 → 输出里混着评价，不落
  if (it.advice) return null;

  // ---- 3) 内容 ----
  const cleaned = stripPreamble(raw);
  const body = cleaned.text.trim();
  if (body.length < MIN_CHARS) return null;

  // ---- 4) 定位目标 ----
  const files = collectFiles(opt.tree);
  const nums = extractChapterNumbers(userText);

  // 4a) 用户点名了章节 —— 最可靠的信号
  if (nums.length === 1) {
    const n = nums[0];
    const hits = files.filter((f) => nameMatchesChapter(f.name, n));

    if (hits.length === 1) {
      return { path: hits[0].path, mode: 'replace', content: body, why: `用户点名了第${n}章，目录里有这个文件` };
    }
    if (hits.length > 1) {
      // 多个同名（比如 章节/第一章.md 与 卷纲/第一章.md）：只认 章节/ 下那一个，
      // 还多于一个就说明这份项目结构我们看不懂，交给用户。
      const inChapterDir = hits.filter((f) => f.path.startsWith(`${CHAPTER_DIR}/`));
      if (inChapterDir.length === 1) {
        return { path: inChapterDir[0].path, mode: 'replace', content: body, why: `用户点名了第${n}章，命中 章节/ 下的文件` };
      }
      return null;
    }
    // 一个都没命中 → 新建
    return { path: `${CHAPTER_DIR}/第${intToCn(n)}章.md`, mode: 'create', content: body, why: `用户点名了第${n}章，目录里没有，新建` };
  }

  // 4b) 用户提到多章 → 别猜
  if (nums.length > 1) return null;

  // 4c) 没点名，但界面正打开着某一章 → 写它
  //
  // ⚠ 只认 `章节/` 下的文件。用户正打开 `设定/世界观.md` 时说"重写一下"，
  //   指的是哪一章完全无从判断，写了就是把设定文档变成小说正文。
  const active = String(opt.activePath || '').replace(/\\/g, '/');
  if (active && active.startsWith(`${CHAPTER_DIR}/`) && /\.(md|txt|markdown)$/i.test(active)) {
    // 摘要文件不是正文
    if (/摘要/.test(active)) return null;
    const exists = files.some((f) => f.path === active);
    if (exists) {
      return { path: active, mode: 'replace', content: body, why: '没点名章节，但界面正打开着这一章' };
    }
  }

  return null;
}

/**
 * 执行落盘计划。
 *
 * ⚠ 为什么把 io 全做成注入：主进程那边 `pfs` / `fs` / `toolMod` 都是
 *   模块级依赖，一旦写死在函数里，就只能靠"真启动软件、真连模型、
 *   真发一句重写第一章"来验证 —— 而这条路径的失败方式是**悄悄不写**，
 *   不测就等于没写。注入之后 applyPlan 能用真 fs 跑完整流程。
 *
 * @param {object} plan resolve() 的返回值
 * @param {object} io
 * @param {(rel:string)=>boolean} io.exists
 * @param {(rel:string)=>string|null} io.backup   备份，返回备份文件名
 * @param {(rel:string, content:string)=>any} io.write
 * @param {(info:object)=>void} [io.notify]
 * @returns {object|null} 通知载荷
 */
function applyPlan(plan, io) {
  if (!plan || !io) return null;
  const existed = !!io.exists(plan.path);
  /**
   * ⚠ 备份失败**不拦写入**：备份是保险，把正文写进去才是用户要的。
   *   吞掉异常但把结果留成 null —— 界面据此就不再显示"原稿已备份"，
   *   免得给一个假的安心。
   */
  let backup = null;
  if (existed && typeof io.backup === 'function') {
    try { backup = io.backup(plan.path); } catch (_) { backup = null; }
  }
  io.write(plan.path, plan.content);
  const info = {
    path: plan.path,
    mode: plan.mode,
    chars: plan.content.length,
    backup,
    why: plan.why,
  };
  if (typeof io.notify === 'function') {
    try { io.notify(info); } catch (_) { /* 通知失败不影响已经写好的文件 */ }
  }
  return info;
}

module.exports = {
  resolve,
  applyPlan,
  detectIntent,
  extractChapterNumbers,
  nameMatchesChapter,
  stripPreamble,
  collectFiles,
  cnToInt,
  intToCn,
  MIN_CHARS,
  CHAPTER_DIR,
  WRITE_VERBS,
  ADVICE_WORDS,
  DENY_WORDS,
};
