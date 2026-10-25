/**
 * 内置 Skill 的种子数据。
 *
 * ## 为什么要单独一个文件
 *
 * 2026-10-12 之前，内置技能是 store.js 里的一段数组，装的是
 * 「续写正文」「写对白」这类**只有一条提示词**的技能——
 * 它们没有配套文件，也没有 frontmatter。
 *
 * 现在内置技能是**目录式**的：一个 SKILL.md 加若干 references/。
 * 把它们写进 JS 字符串会让那个文件几百行、没法读，
 * 而且正文里的反引号、${} 全都要转义——很容易写坏。
 *
 * 所以正文放**独立 .md 文件**，这里只负责读进来并组装。
 * 顺带的好处：改 Skill 正文不用改 JS。
 *
 * ## ⚠ 关于内容来源（2026-10-12 重要改动）
 *
 * novel-writer 与 skill-creator 两个 Skill 是参考 WorkBuddy / Claude
 * 的 Skill 改写的。**不是照搬**——原因很具体：
 *
 * 原版通篇依赖工具调用（`file_write`、`question`、`create_project`、
 * `skill_lookup`、`create_skill`），而这个产品**没有工具执行循环**
 * （请求体里根本没有 tools 字段，见 main.js 的 SYSTEM_PROMPT 注释）。
 *
 * 照搬的后果：模型被要求调用不存在的工具，实际会输出
 * 「我将调用 file_write」这种字面量文本**混进正文**——
 * 这正是 main.js 里记着的那个已修 bug。
 *
 * 所以适配版做的是：保留核心工作流，把工具步骤改写成
 * 这个产品实际能执行的动作（展示内容 → 用户点保存 → 写入文件）。
 *
 * ⚠ 章节目录名也跟着改了：原版写 `章节内容/`，
 *   这个产品建项目时生成的是 `章节/`（见 project-fs.js）。
 *   照搬路径会让模型去找一个不存在的目录。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 内置技能清单。
 *
 * ## 2026-10-16 重做：从「6 条」变成「6 条」但结构全换
 *
 * 羽毛菌指出旧版偏文笔，资料读取、场景定义、章节输出硬性要求、
 * 维护文档、同步文档、安全约束这六项「好像都没有」。核对后：
 * 六项里只有场景定义真缺，其余五项软件已经在管，只是不在 skill 层。
 *
 * 但核对时查出一件更要紧的事：**旧的 4 条 legacy 技能没有 frontmatter**，
 * 而 `main.js` 的 skill:index 有 `.filter((x) => x.description)` ——
 * **它们连索引都进不去**。也就是说旧版真能被模型看见的只有 2 个技能。
 * 用户看到「装了几个」和「模型能用几个」不是一回事。
 *
 * 所以这次做三件事：
 *
 * 1. **全部改成目录式**（每条都有 SKILL.md，frontmatter 完整）。
 *    目录式不是形式主义——`legacy` 字段存的是单条纯文本，
 *    没有 frontmatter 就永远进不了 skill:index。
 * 2. **把六项约束并进正文**：
 *    - 资料读取 → sk-novel-writer 的 Step 1/2
 *    - 场景定义 → sk-novel-writer 的 Step 3（新写的一节）
 *    - 章节输出硬性要求 → sk-novel-writer 的 Step 5
 *    - 维护文档 → sk-novel-writer 的 Step 7 + sk-novel-sync 的模式 B
 *    - 同步文档 → sk-novel-sync 的模式 A/B
 *    - 安全约束 → 各技能末尾的「写入前必须问用户」
 * 3. **删掉 4 条 legacy**（列章纲/写对白/润色改写/检查设定）：
 *    - 列章纲 → 并进 sk-novel-writer 的 Step 3
 *    - 检查设定 → 并进 sk-novel-sync（两者职责重叠，评测里实测
 *      同一个请求被判给两个不同技能，用户根本分不清该勾哪个）
 *    - 写对白 → sk-novel-dialogue
 *    - 润色改写 → sk-novel-polish
 *
 * ⚠⚠ **description 里的「分工句」不是废话**。2026-10-16 实测：
 *   8B 模型会把「把人物设定梳理一下」判给 novel-sync 而不是 novel-writer，
 *   因为两者的关键词重叠。加一句「本技能负责梳理， 对方负责挑毛病」
 *   之后，这条用例才判对。**改任何一个技能的 description 时，
 *   要同时看它的邻居会不会抢同一个说法**。
 *
 * @type {Array<{
 *   id: string, name: string,
 *   files?: Array<{path: string, kind: string}>,
 *   enabled: boolean
 * }>}
 */
const BUILTIN = [
  // ---------------------------------------------------------
  // 小说写作三件套：写新的 / 改已有的 / 对账
  // ---------------------------------------------------------
  {
    id: 'sk-novel-writer',
    name: '写新章节',
    files: [
      { path: 'SKILL.md', kind: 'reference' },
      { path: 'references/templates.md', kind: 'reference' },
    ],
    enabled: true,
  },
  /**
   * 长篇结构工程（2026-10-19 新增）。
   *
   * 为什么单独一个技能而不是并进 writer：
   *   ① writer 的 SKILL.md 已经 3917 字符，注入上限是 **4000**（`SKILL_CHARS`），
   *      再塞结构化的内容会被 `clip()` 截断 —— 而截断是静默的，
   *      表面上"加了功能"，实际模型只看到半截。
   *   ② 两者的使用时机不同：writer 是每章都用，outline 是排卷纲/建表时用。
   *      合在一起等于每次写正文都背着整份大纲方法论，白烧上下文。
   *
   * ⚠ description 必须写得**窄且分工明确**（「只做结构，不写正文」）：
   *   8B 模型的路由靠关键词，writer 和 outline 的"大纲/章节"高度重叠，
   *   不写清楚会互相抢活（2026-10-16 在 novel-sync 上踩过一次）。
   */
  {
    id: 'sk-novel-outline',
    name: '长篇结构工程',
    files: [
      { path: 'SKILL.md', kind: 'reference' },
      { path: 'references/templates.md', kind: 'reference' },
    ],
    enabled: true,
  },
  {
    id: 'sk-novel-revisor',
    name: '修订已保存章节',
    files: [
      { path: 'SKILL.md', kind: 'reference' },
      { path: 'references/templates.md', kind: 'reference' },
    ],
    enabled: true,
  },
  {
    id: 'sk-novel-sync',
    name: '一致性检查与文档同步',
    files: [
      { path: 'SKILL.md', kind: 'reference' },
      { path: 'references/templates.md', kind: 'reference' },
    ],
    enabled: true,
  },

  // ---------------------------------------------------------
  // 文笔专项：范围小、触发频繁，适合手动 @
  // ---------------------------------------------------------
  {
    id: 'sk-novel-dialogue',
    name: '写对白',
    files: [
      { path: 'SKILL.md', kind: 'reference' },
      { path: 'references/templates.md', kind: 'reference' },
    ],
    enabled: true,
  },
  {
    id: 'sk-novel-polish',
    name: '润色改写',
    files: [
      { path: 'SKILL.md', kind: 'reference' },
      { path: 'references/templates.md', kind: 'reference' },
    ],
    enabled: true,
  },
  {
    id: 'sk-humanize',
    name: '去 AI 味与文风模仿',
    files: [
      { path: 'SKILL.md', kind: 'reference' },
    ],
    enabled: true,
  },
  {
    id: 'sk-skill-creator',
    name: '技能创建助手',
    files: [
      { path: 'SKILL.md', kind: 'reference' },
      { path: 'references/templates.md', kind: 'reference' },
    ],
    enabled: true,
  },
];

/**
 * 读一个内置技能的正文目录。
 *
 * 正文放在 `app/builtin-skills/<id>/`。
 * ⚠ 打包时必须在 files 列表里包含这个目录，否则
 *   开发态能读、打包后读不到——第 9 章踩过这个坑。
 *
 * @returns {{content: string, files: Array}|null}
 */
function builtinRoot() {
  // ⚠ 两种布局都要试：
  //   开发态  db/ → ../app/builtin-skills/
  //   打包态  resources/modules/db → ../builtin-skills/
  //     （app.asar 里也有一份，但 db 读不到 app.asar 内部）
  const cands = [
    path.join(__dirname, '..', 'app', 'builtin-skills'),
    path.join(__dirname, '..', 'builtin-skills'),
  ];
  for (const c of cands) {
    if (fs.existsSync(c)) return c;
  }
  return cands[0];
}

function loadBuiltin(id) {
  const dir = path.join(builtinRoot(), id);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return null;

  const files = [];
  const readOne = (rel) => {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) return null;
    files.push({
      path: rel,
      kind: /^scripts?\//.test(rel) ? 'script'
        : /^assets?\//.test(rel) ? 'asset' : 'reference',
      content: fs.readFileSync(p, 'utf8'),
    });
    return files[files.length - 1];
  };

  readOne('SKILL.md');
  // 只扫这三��目录，不递归。理由：
  //   Skill 的规范就是这三层，多一层说明用户放错地方了，
  //   静默接受会让界面上的配套文件列表与实际不符。
  for (const sub of ['references', 'reference', 'scripts', 'script', 'assets', 'asset']) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.startsWith('.')) continue;      // 跳过 .DS_Store 之类
      const full = path.join(d, f);
      if (!fs.statSync(full).isFile()) continue;
      readOne(`${sub}/${f}`);
    }
  }
  return { content: fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), files };
}

module.exports = { BUILTIN, loadBuiltin };