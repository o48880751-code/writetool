#!/usr/bin/env node
/*
 * run-verify.js —— 本地模型 Tool Calling 可行性验证
 *
 * 验证链路：query_world_bible（查设定）→ write_segment（写一段）→ commit_chapter（存章节）
 * 判定标准：合法 tool call 率 >=80% 通过；50%~80% 勉强通过（需兜底）；<50% 不通过。
 *
 * 用法：
 *   node run-verify.js --probe                         只探服务 + 单次工具调用（最省）
 *   node run-verify.js --model qwen3:latest               跑默认 12 个样本
 *   node run-verify.js --model qwen3:30b-a3b --samples 20  跑满 20 次
 *   node run-verify.js --model qwen3:latest --chain-only  只跑 Prompt Chain 基线
 *
 * 依赖：Node 18+（全局 fetch）。不需要 npm install。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LoopContextGuard } = require('./memory/loop-guard.js');
const { buildProfile, checkStyle, styleDirective } = require('./memory/style.js');

/* ------------------------------------------------------------------ *
 * 1. 工具 Schema（与验证方案里的三个工具一致）
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'query_world_bible',
      description:
        '查询指定项目的小说设定集，包括角色、势力、功法、地点、伏笔。写正文之前必须先调用它确认设定，禁止凭记忆编造，禁止查询或引用其他项目的设定。',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            enum: ['novel-demo-01', 'novel-demo-02'],
            description: '设定库所属项目 ID，必须与本任务给出的 project_id 一致',
          },
          query: { type: 'string', description: '检索关键词，必须是本项目设定集中存在的实体名或其别名' },
          entity_type: {
            type: 'string',
            enum: ['character', 'faction', 'technique', 'location', 'plot'],
            description: '限定实体类型。查询结果过多时必填——设定库上千条后，不限类型会返回大量无关实体。',
          },
          top_k: {
            type: 'integer',
            description: '返回条数上限，1-20，默认 8。查询命中过多时用它收窄结果。',
            minimum: 1,
            maximum: 20,
          },
        },
        required: ['project_id', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_segment',
      description: '根据设定与上下文生成一段小说正文。一次只写一段。',
      parameters: {
        type: 'object',
        properties: {
          scene: { type: 'string', description: '本段的场景与情节要求' },
          characters: { type: 'array', items: { type: 'string' }, description: '出场角色名' },
          tone: { type: 'string', description: '基调，如 冷硬、克制、肃杀' },
          max_length: { type: 'integer', description: '正文字数上限' },
          base_text: { type: 'string', description: '修订已有章节时必填：read_chapter 返回的原稿全文。新章节不传。' },
        },
        required: ['scene'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commit_chapter',
      description: '将生成内容保存为章节。content 必须是 write_segment 返回的正文原文，不得改写或节选。',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: '项目 ID，固定为本任务给出的 project_id' },
          chapter_title: { type: 'string', description: '章节标题，不带「第X章」前缀' },
          content: { type: 'string', description: '章节正文，write_segment 的输出原文' },
          parent_chapter_id: { type: ['string', 'null'], description: '上一章 ID，首章传 null' },
          chapter_id: { type: ['string', 'null'], description: '修订已有章节时传其 ID 以覆盖保存；新章节不传' },
        },
        required: ['project_id', 'chapter_title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_chapter',
      description: '读回项目里已存在的章节全文。修订任何已有章节之前必须先调用它拿到原稿，禁止凭记忆重写。',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          chapter_id: { type: 'string', description: '要读回的章节 ID' },
        },
        required: ['project_id', 'chapter_id'],
      },
    },
  },
];

const TOOL_NAMES = TOOLS.map((t) => t.function.name);

/*
 * 写→改闭环的「靶子稿件」：脚本先替模型落盘一章种子稿（含两句保护句）。
 * 模型必须 read_chapter 读回、修改后带 chapter_id 覆盖保存。
 * 修订稿若丢失保护句 = 覆盖丢稿，由校验层拦截。
 */
const SEED_CHAPTER_ID = 'ch-seed';
const SEED_PROTECTIONS = [
  '铁棺北侧第三根棺钉刻着「归」字',
  '洛三娘左手的三根指骨是断的',
];
const SEED_CONTENT =
  `秋雨把乱葬岗泡成一片泥黑。${SEED_PROTECTIONS[0]}。守尸人洛三娘提着灯笼走过来，${SEED_PROTECTIONS[1]}，所以灯笼柄只用右手攥着。` +
  '谢九蹲在棺前，指尖抹开棺盖上的剑诀铭文，字迹与那根棺钉同源。远处山门方向的钟声响了七下，赤霄宗拒客的信物，他听了三年，如今才听出第七下里藏着一线裂缝。洛三娘把灯笼搁在泥地上，光从棺底的缝隙里漏出去，像有人从里面顶着盖。';

/* ------------------------------------------------------------------ *
 * 2. 三个工具的真实实现（本地执行，确定性）
 * ------------------------------------------------------------------ */

const WORLD_PATH = path.join(__dirname, 'world-bible.json');
const WORLD_SAMPLE_PATH = path.join(__dirname, 'samples', 'world-bible.sample.json');

/**
 * 解析设定库路径。
 *
 * 显式传入的路径按原样使用（找不到就抛错，不掩盖问题）；不传时先找仓库根目录的
 * world-bible.json，没有则回落到 samples/world-bible.sample.json。
 * 真实设定库含作品正文，只在本机存在、由 .gitignore 排除，所以对外公开的只有示例库。
 */
function resolveWorldPath(p) {
  if (p) return p;
  if (fs.existsSync(WORLD_PATH)) return WORLD_PATH;
  if (fs.existsSync(WORLD_SAMPLE_PATH)) {
    if (!resolveWorldPath.noticed) {
      resolveWorldPath.noticed = true;
      console.warn('提示：未找到 world-bible.json，改用示例设定库 samples/world-bible.sample.json（2 项目 20 条合成条目）。');
    }
    return WORLD_SAMPLE_PATH;
  }
  throw new Error(`找不到设定库：既没有 ${WORLD_PATH}，也没有示例库 ${WORLD_SAMPLE_PATH}`);
}

function loadWorld(p) {
  const raw = JSON.parse(fs.readFileSync(resolveWorldPath(p), 'utf8'));
  return raw.entries || raw;
}

/** 归一化：去空白与标点，便于别名匹配 */
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s　。，、；：？！“”‘’（）()《》〈〉\-_·.]/g, '');
}

/**
 * 设定名的可接受简称变体。
 * 锚点指标若只做ch.includes(name) 字面匹配，会把合理简称判成未命中。
 * 实测 8B 已知组 2/20 属此类假阴性：设定「乱葬岗」，正文写成「岗北」——
 * 是「去后缀留前缀」而非「去前缀留后缀」，所以前后缀两种变体都要生成。
 * 只做单字增删的高置信变换，不做激进截断，避免把不同实体混为一谈。
 */
const SUFFIXES = ['岗', '宗', '城', '山', '剑', '诀', '派', '岛', '塔', '寺', '谷', '崖', '海', '宫', '门'];
function suffixVariants(name) {
  const n = String(name || '');
  const out = [];
  if (n.length < 3) return out;
  for (const s of SUFFIXES) {
    if (n.endsWith(s)) out.push(n.slice(0, -1));   // 去后缀：残月剑谱 → 残月剑
    if (n.startsWith(s)) out.push(n.slice(1));      // 去前缀：乱葬岗 → 葬岗（少见但保留）
    if (n.includes(s)) {
      // 取该字为「方位核心」时的两字组合：乱葬岗 → 岗北 / 岗南 等由调用侧配合判定
      const i = n.indexOf(s);
      if (i > 0) out.push(n.slice(i));             // 乱葬岗 → 岗
    }
  }
  return [...new Set(out)];
}

/**
 * 检索结果相关度打分。分数越高越可能是用户要找的条目：
 *   100 = 名称精确全等；80 = 名称互相包含；70 = 别名命中；40 = note 文本命中。
 * 纯子串匹配不做区分，是 §3.3.2 里「单字查询命中 209 条、吃掉 86% 上下文」的根因。
 */
function scoreEntry(e, q, typeFilter) {
  if (typeFilter && e.type !== typeFilter) return 0;
  const nq = norm(q);
  const nn = norm(e.name);
  if (!nq) return 0;
  if (nn === nq) return 100;
  const aliases = (e.aliases || []).map((a) => norm(a));
  if (aliases.some((a) => a && a === nq)) return 70;
  if (nn.includes(nq) || nq.includes(nn)) return 80;
  if (aliases.some((a) => a && (a.includes(nq) || nq.includes(a)))) return 70;
  if (norm(e.note).includes(nq) && nq.length >= 4) return 40;
  return 0;
}

/** 检索返回条数硬上限。实测 2000 条库下单字查询原始命中 209 条，必须截断。 */
const QUERY_TOP_K = 8;

function makeToolImpl(world, store) {
  /** 按项目取库；未带或带错 project_id 视为非法（校验层已先拦，这里双保险） */
  function worldOf(project) {
    return world.filter((e) => e.project === project);
  }

  /**
   * query_world_bible：按相关度排序后返回 top_k 条；未命中时返回本项目可检索清单，
   * 逼模型改词重试。entity_type 改为强烈建议（不强制，缺失时只按相关度排序截断）。
   */
  function queryWorldBible(args) {
    const q = norm(args.query);
    const typeFilter = args.entity_type;
    const topK = Number(args.top_k) > 0 ? Math.min(Number(args.top_k), 20) : QUERY_TOP_K;
    if (!q) return { ok: false, error: 'query 不能为空' };
    if (!args.project_id) return { ok: false, error: 'query_world_bible 必须带 project_id' };
    const scope = worldOf(args.project_id);
    if (!scope.length) {
      return { ok: false, error: `项目 ${args.project_id} 不存在于设定库。可用项目：${[...new Set(world.map((e) => e.project))].join(', ')}` };
    }

    // 打分 → 排序 → 截断。排序键：分数降序，同分取名称更短者（更具体），再按名称稳定排序。
    const scored = scope
      .map((e) => ({ e, s: scoreEntry(e, q, typeFilter) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (b.s - a.s) || (a.e.name.length - b.e.name.length) || a.e.name.localeCompare(b.e.name));
    const total = scored.length;
    const hits = scored.slice(0, topK).map((x) => x.e);

    if (!hits.length) {
      // 查无此实体不是工具故障，而是有效信息；是否放行由校验层决定
      return {
        ok: true,
        count: 0,
        hits: [],
        message: `项目 ${args.project_id} 的设定集中没有匹配「${args.query}」的条目。禁止编造该实体的设定，更禁止引用其他项目的设定。`,
        available: scope.map((e) => ({ name: e.name, type: e.type })),
      };
    }
    return {
      ok: true,
      count: hits.length,
      total_matches: total,
      truncated: total > hits.length,
      // 告知模型已截断，避免它误以为拿到了全部候选（工具设计规范：截断要明说）
      hint: total > hits.length
        ? `共${total} 条匹配，按相关度返回前 ${hits.length} 条。命中降级时请补entity_type 缩小范围，或换更完整的实体名重查。`
        : undefined,
      hits: hits.map((e) => ({ name: e.name, type: e.type, note: e.note })),
    };
  }

  /** write_segment：这一步本身就是一次 LLM 调用（不带 tools），设定注入进去 */
  async function writeSegment(args, ctx) {
    const maxLen = Number(args.max_length) > 0 ? Math.min(Number(args.max_length), 1600) : 800;
    const bibleText = ctx.facts.length
      ? ctx.facts.map((f) => `· ${f.name}（${f.type}）：${f.note}`).join('\n')
      : '（无检索结果——你必须先调用 query_world_bible 查询设定，禁止凭记忆编造。）';

    // 风格指令：从用户自己历史正文的统计画像推导，不是通用写作建议。
    // 无画像时为空串，不影响原有链路（宁可没这层，也不能塞我拍的主观词）。
    const stylePrompt = ctx.styleProfile ? styleDirective(ctx.styleProfile) : '';

    const segPrompt = [
      `要求：${args.scene}`,
      args.characters && args.characters.length ? `必须出场：${args.characters.join('、')}` : '',
      args.tone ? `基调：${args.tone}` : '基调：冷硬克制',
      `字数上限：${maxLen} 字。`,
      args.base_text
        ? `【原稿——本次是修订不是重写，以下句子必须逐字保留：${SEED_PROTECTIONS.map((p) => `「${p}」`).join('、')}】\n${args.base_text}`
        : '',
      '',
      '【已确认的设定，正文不得与之矛盾】',
      bibleText,
      stylePrompt ? `\n${stylePrompt}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (ctx.deterministic) {
      // 离线自测：不联网，产出可预测文本
      const names = (args.characters || []).join('、') || '谢九';
      const id = `seg-${String(store.segments.length + 1).padStart(3, '0')}`;
      const text = `${names}站在洛阳的秋雨中。${bibleText ? bibleText.split('\n')[0] : ''}`.slice(0, maxLen);
      store.segments.push({ id, text, args });
      return { ok: true, segment_id: id, text, chars: text.length };
    }

    const resp = await ctx.chat({
      model: ctx.model,
      messages: [
        {
          role: 'system',
          content: '你是小说执笔。只输出正文本身，不要输出标题、说明、分点或任何元信息。不得使用给定设定之外的人名、地名、功法名。',
        },
        { role: 'user', content: segPrompt },
      ],
      stream: false,
      think: false,
      options: { temperature: 0.7, top_p: 0.9, num_ctx: 8192 },
      keep_alive: ctx.keepAlive,
    });
    const text = String(resp.message?.content || '').trim();
    if (!text) return { ok: false, error: '模型未返回正文' };
    const id = `seg-${String(store.segments.length + 1).padStart(3, '0')}`;
    store.segments.push({ id, text, args });

    // 风格检测：**代码强制**，与「校验位代码强制」同一原则。
    // 只报偏离、不改稿、不重试——重写会引入新的丢稿风险（§3.4 已证明改稿侧丢稿率 100%）。
    // 高严重度偏离时把 style_check 一并返回，由编排层决定是否让人介入。
    let styleCheck = null;
    if (ctx.styleProfile) {
      const r = checkStyle(text, ctx.styleProfile, { strict: true });
      if (r.ok) {
        const highs = r.deviations.filter((d) => d.severity === 'high');
        styleCheck = {
          deviations: r.deviations.map((d) => ({
            metric: d.metric, label: d.label, value: d.value,
            baseline: d.baseline, direction: d.direction, severity: d.severity, advice: d.advice,
          })),
          skipped: r.skipped,
          tics: r.tics,
          summary: r.summary,
          confidence: r.confidence,
          highCount: highs.length,
        };
      }
    }

    return { ok: true, segment_id: id, text, chars: text.length, style_check: styleCheck };
  }

  /** commit_chapter：真实落盘，返回章节 ID；带 chapter_id 则覆盖已有章节 */
  async function commitChapter(args, ctx) {
    if (!args.project_id) return { ok: false, error: 'project_id 不能为空' };
    if (!args.chapter_title) return { ok: false, error: 'chapter_title 不能为空' };
    let content = String(args.content || '').trim();
    if (!content) return { ok: false, error: 'content 不能为空，请传入 write_segment 返回的正文原文' };
    if (content.length < 40) return { ok: false, error: `content 过短（${content.length} 字），疑似被节选或摘要，请传入完整正文` };

    const dir = path.join(ctx.outDir, 'chapters');
    fs.mkdirSync(dir, { recursive: true });

    // 修订路径：目标章节必须存在，且原文件内容随修订保留一份 .bak
    if (args.chapter_id) {
      const target = store.chapters.find((c) => c.id === args.chapter_id);
      if (!target) return { ok: false, error: `章节 ${args.chapter_id} 不存在。请先用 read_chapter 确认 ID。` };
      try {
        const old = fs.readFileSync(target.file, 'utf8');
        fs.writeFileSync(target.file + '.bak', old, 'utf8');
      } catch {}
      const safeTitle = String(args.chapter_title).replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
      fs.writeFileSync(
        target.file,
        `# ${args.chapter_title}\n\n` +
          `> 章节 ID：${target.id}　项目：${args.project_id}　父章节：${target.parent || 'null'}　已修订\n> 生成方式：${ctx.via || 'agent'}\n\n${content}\n`,
        'utf8',
      );
      target.content = content;
      target.title = args.chapter_title;
      target.revised = true;
      return { ok: true, chapter_id: target.id, file: target.file, saved_chars: content.length, overwritten: true };
    }

    const seq = store.chapters.length + 1;
    const id = `ch-${String(seq).padStart(3, '0')}`;
    const safeTitle = String(args.chapter_title).replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
    const file = path.join(dir, `第${String(seq).padStart(2, '0')}章-${safeTitle}.md`);
    fs.writeFileSync(
      file,
      `# 第${seq}章 ${args.chapter_title}\n\n` +
        `> 章节 ID：${id}　项目：${args.project_id}　父章节：${args.parent_chapter_id || 'null'}\n> 生成方式：${ctx.via || 'agent'}\n\n${content}\n`,
      'utf8',
    );
    store.chapters.push({ id, title: args.chapter_title, content, file, via: ctx.via, parent: args.parent_chapter_id || null });
    return { ok: true, chapter_id: id, file, saved_chars: content.length };
  }

  /** read_chapter：把已有章节全文取回。查无此 ID 返回明确错误，供校验层判定「凭记忆重写」 */
  function readChapter(args) {
    const target = store.chapters.find((c) => c.id === args.chapter_id);
    if (!target) {
      return { ok: false, error: `项目 ${args.project_id} 中没有章节 ${args.chapter_id}。现有章节：${store.chapters.map((c) => c.id).join(', ') || '（无）'}` };
    }
    return {
      ok: true,
      chapter_id: target.id,
      title: target.title,
      content: target.content,
      chars: target.content.length,
      must_keep: SEED_PROTECTIONS.slice(),
    };
  }

  return { query_world_bible: queryWorldBible, write_segment: writeSegment, commit_chapter: commitChapter, read_chapter: readChapter };
}

/* ------------------------------------------------------------------ *
 * 3. LAYER 1：把模型返回的「候选工具调用」清洗成结构化对象
 * ------------------------------------------------------------------ */

const FENCE_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/;

function tryJsonParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** 从一段文本中按括号配平抽出所有顶层 JSON 对象/数组 */
function extractJsonCandidates(text) {
  const out = [];
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const cand = s.slice(i, j + 1);
          const p = tryJsonParse(cand);
          if (p.ok) out.push(p.value);
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * 统一从 Ollama 响应里取候选工具调用。
 * 返回 { calls: [{name, arguments}], notes: string[], raw }
 * notes 记录做过哪些「清洗」，用于统计模型的裸输出质量。
 */
function parseToolCall(resp) {
  const notes = [];
  const msg = resp && resp.message ? resp.message : {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  let calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.slice() : [];

  const normalized = [];
  for (const c of calls) {
    const fn = c.function || c;
    let args = fn.arguments;
    if (typeof args === 'string') {
      const p = tryJsonParse(args);
      if (p.ok) { args = p.value; notes.push('arguments_was_string'); }
      else {
        const nested = extractJsonCandidates(args)[0];
        if (nested) { args = nested; notes.push('arguments_stringified_repaired'); }
        else { args = {}; notes.push('arguments_unparsable'); }
      }
    }
    if (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object') {
      args = args.arguments;
      notes.push('double_nested_args');
    }
    normalized.push({ name: fn.name, arguments: args || {} });
  }

  // 模型把调用写在 content 里（未登录 tool 通道）
  if (!normalized.length && content.trim()) {
    const fence = content.match(FENCE_RE);
    if (fence) notes.push('fenced');
    const src = fence ? fence[1] : content;
    for (const cand of extractJsonCandidates(src)) {
      const arr = Array.isArray(cand) ? cand : [cand];
      for (const item of arr) {
        const one = item && item.function ? item : item;
        if (!one || typeof one !== 'object') continue;
        const name = one.name || (one.function && one.function.name);
        const args =
          one.arguments !== undefined ? one.arguments : one.args !== undefined ? one.args : one.parameters;
        if (typeof name === 'string' && TOOL_NAMES.includes(name)) {
          normalized.push({ name, arguments: typeof args === 'string' ? tryJsonParse(args).value || {} : args || {} });
          notes.push('from_content');
        }
      }
    }
    if (normalized.length) notes.push('content_tool_call_rescued');
  }

  if (normalized.length > 1) {
    notes.push('multi_tool_candidates');
  }
  return { calls: normalized, notes, raw: resp };
}

/* ------------------------------------------------------------------ *
 * 4. LAYER 2：JSON Schema 校验 + 工具语义校验
 * ------------------------------------------------------------------ */

function typeOk(v, expect) {
  const kinds = Array.isArray(expect) ? expect : [expect];
  for (const k of kinds) {
    if (k === 'string' && typeof v === 'string') return true;
    if (k === 'integer' && typeof v === 'number' && Number.isInteger(v)) return true;
    if (k === 'number' && typeof v === 'number') return true;
    if (k === 'boolean' && typeof v === 'boolean') return true;
    if (k === 'null' && v === null) return true;
    if (k === 'object' && v && typeof v === 'object' && !Array.isArray(v)) return true;
    if (k === 'array' && Array.isArray(v)) return true;
  }
  return false;
}

/** 极简 JSON Schema 子集校验：type / required / enum / properties / items */
function validateSchema(value, schema, label, errors) {
  if (value === null || value === undefined) {
    if (!typeOk(value, schema.type || 'string')) errors.push(`${label}: 缺失（需要 ${schema.type}）`);
    return errors;
  }
  if (schema.type && !typeOk(value, schema.type)) {
    errors.push(`${label}: 类型应为 ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}，实际是 ${Array.isArray(value) ? 'array' : typeof value}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${label}: 取值「${value}」不在允许集合 [${schema.enum.join(', ')}] 内`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((it, i) => validateSchema(it, schema.items, `${label}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) {
      if (value[r] === undefined || value[r] === null || value[r] === '') {
        errors.push(`${label}.${r}: 必填字段缺失或为空`);
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[k]) {
        validateSchema(v, schema.properties[k], `${label}.${k}`, errors);
      } else if (schema.properties) {
        errors.push(`${label}.${k}: 未知参数「${k}」。${label} 只接受 ${Object.keys(schema.properties).join(', ')}`);
      }
    }
  }
  return errors;
}

function findToolSchema(name) {
  const t = TOOLS.find((x) => x.function.name === name);
  return t ? t.function.parameters : null;
}

/**
 * 校验一次工具调用：工具名 + schema + 语义（实体是否存在于设定集）
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateCall(call, world, mode = 'strict', tctx = {}) {
  const { project, isolation = true } = tctx;
  const errors = [];
  const warnings = [];
  if (!call || typeof call.name !== 'string' || !call.name) {
    return { ok: false, errors: ['未产出有效工具调用（缺少工具名）'], warnings };
  }
  if (!TOOL_NAMES.includes(call.name)) {
    const hint = nearestTool(call.name);
    return {
      ok: false,
      errors: [`工具名「${call.name}」不存在。可用工具只有 ${TOOL_NAMES.join(' / ')}${hint ? `，你可能想用 ${hint}` : ''}`],
      warnings,
    };
  }
  const schema = findToolSchema(call.name);
  validateSchema(call.arguments, schema, call.name, errors);
  if (errors.length) return { ok: false, errors, warnings };

  // 语义校验：实体必须来自设定集，防止模型凭记忆编造。
  // strict：编造直接拒绝（用于已知实体组，测「会不会瞎写」）。
  // record：编造只记告警并放行（用于陌生实体组，测「明知查不到还硬写多少」）。
  const sink = mode === 'record' ? warnings : errors;
  // 作用域：开隔离=仅本项目库；关隔离=全库（对照用，复现旧单库行为）
  const scope = isolation && project ? world.filter((e) => e.project === project) : world;
  const foreignOf = (name) =>
    world.filter((e) => e.project !== project && (worldHasEntity(name, [e])));

  if (project && ['query_world_bible', 'read_chapter', 'commit_chapter'].includes(call.name)) {
    if (call.arguments.project_id !== project) {
      errors.push(`${call.name} 的 project_id「${call.arguments.project_id}」与本任务项目 ${project} 不一致，拒绝跨项目访问`);
    }
  }
  if (call.name === 'query_world_bible') {
    const r = queryWorldPreview(call.arguments, scope);
    if (!r.hit) {
      sink.push(`query「${call.arguments.query}」在项目 ${project || ''} 设定集中查无此实体（疑似编造）`);
    }
  }
  if (call.name === 'write_segment' && Array.isArray(call.arguments.characters) && call.arguments.characters.length) {
    const bogus = call.arguments.characters.filter((c) => !worldHasEntity(c, scope));
    if (bogus.length) {
      sink.push(`角色「${bogus.join('、')}」不在本项目设定集中（未经确认的编造）`);
    }
    if (isolation && project) {
      const leaked = call.arguments.characters.filter((c) => foreignOf(c).length);
      if (leaked.length) errors.push(`角色「${leaked.join('、')}」属其他项目设定库，跨项目引用被闸门拦截`);
    } else if (project) {
      const leaked = call.arguments.characters.filter((c) => foreignOf(c).length);
      if (leaked.length) warnings.push(`角色「${leaked.join('、')}」属其他项目设定库（闸门关闭，仅记录）`);
    }
  }
  if (call.name === 'commit_chapter') {
    const cited = scope.filter((e) => String(call.arguments.content || '').includes(e.name));
    if (!cited.length && scope.length) warnings.push('落盘正文未出现任何本项目设定实体，检索结果未进入上下文');
    if (project) {
      const content = String(call.arguments.content || '');
      const cross = [...new Set(world.filter((e) => e.project !== project && content.includes(e.name)).map((e) => e.name))];
      if (cross.length) {
        if (isolation) errors.push(`跨项目污染：正文出现其他项目实体「${cross.join('、')}」，拒绝落盘`);
        else warnings.push(`跨项目污染：正文出现其他项目实体「${cross.join('、')}」（闸门关闭，仅记录）`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function worldHasEntity(name, world) {
  const n = norm(name);
  if (!n) return false;
  return world.some(
    (e) => norm(e.name) === n || norm(e.name).includes(n) || n.includes(norm(e.name)) ||
      (e.aliases || []).some((a) => norm(a) === n || norm(a).includes(n)),
  );
}

function queryWorldPreview(args, world) {
  const q = norm(args.query);
  const hit = world.some(
    (e) =>
      norm(e.name).includes(q) ||
      q.includes(norm(e.name)) ||
      (e.aliases || []).some((a) => norm(a).includes(q) || q.includes(norm(a))) ||
      (q.length >= 4 && norm(e.note).includes(q)),
  );
  return { hit, names: world.map((e) => e.name) };
}

function nearestTool(name) {
  const n = norm(name);
  for (const t of TOOL_NAMES) if (n.includes(norm(t)) || norm(t).includes(n)) return t;
  for (const t of TOOL_NAMES) if (n.includes(norm(t).slice(0, 8))) return t;
  return null;
}

/* ------------------------------------------------------------------ *
 * 5. 编排器：Agent 链路 + 重试 + 降级 + Prompt Chain 基线
 * ------------------------------------------------------------------ */

const AGENT_SYSTEM = [
  '你是小说写作助手。不要直接输出正文，也不要自行编造设定。',
  '你必须按顺序使用工具完成：',
  '1. 先用 query_world_bible 查询设定；',
  '2. 再用 write_segment 生成一段正文；',
  '3. 最后用 commit_chapter 保存章节。',
  '',
  '若任务要求「修订已有章节」，顺序改为：',
  '0. 先 read_chapter 读回原稿全文，禁止凭记忆重写；',
  '2. write_segment 在原稿基础上修订，并必须把 read_chapter 返回的 content **一字不差放进 base_text 参数**；',
  '3. commit_chapter 必须带上原稿的 chapter_id 覆盖保存，且逐字保留任务中列明的保护性设定句。',
  '',
  '硬性规则：',
  '- 每一轮只调用一个工具，禁止一次调用多个工具。',
  '- 除工具调用外不要输出任何解释。',
  '- 未查到设定前不得动笔；查不到就换一个关键词重新查。',
  '- commit_chapter 的 content 必须逐字使用 write_segment 返回的 text，不许改写、概括或节选。',
].join('\n');

/**
 * 构造 assistant 轮的消息。
 * Ollama /api/chat 要求 tool_calls 形如 [{function:{name, arguments:object}}]，
 * arguments 必须是对象而非字符串；content 可为空字符串。
 */
function asstCall(content, call) {
  return {
    role: 'assistant',
    content: content || '',
    tool_calls: [{ function: { name: call.name, arguments: call.arguments || {} } }],
  };
}

const TASK_PROJECT = {
  known: 'novel-demo-01',
  revise: 'novel-demo-01',
  novel: 'novel-demo-02', // 原陌生题实体不在任何库，项目记为 B 库
  novelB: 'novel-demo-02', // 实体真实存在于 B 库，测「查得到就用、查不到不借 A」
};

const TASKS = {
  known: [
    '项目 ID：novel-demo-01，这是第 {seq} 章（首章 parent_chapter_id 传 null）。',
    '本章要求：谢九被赤霄宗拒于山门外三年后，带着宗主旧伤的线索回到洛阳，在秋雨里的乱葬岗找到守尸人洛三娘，发现乱葬岗北钉着一口刻着赤霄宗剑诀的铁棺。基调冷硬克制，正文不超过 700 字。',
    '请开始，按顺序调用工具。',
  ].join('\n'),
  // 陌生实体对照组：这些名字不在设定库里，用来测模型会不会「编造」
  novel: [
    '项目 ID：novel-demo-02，这是第 {seq} 章（首章 parent_chapter_id 传 null）。',
    '本章要求：叶霜凝带着逆鳞诀的残页登上听潮阁，在退潮后的礁石间见到守阁人岑无咎，阁中供着一口没有铭文的青铜钟。基调清冷，正文不超过 700 字。',
    '注意：本章人物与地点请先查询设定库确认。请开始，按顺序调用工具。',
  ].join('\n'),
  // B 库已知题：实体真实存在于 novel-demo-02 库，测闸门不误伤合法检索
  novelB: [
    '项目 ID：novel-demo-02，这是第 {seq} 章（首章 parent_chapter_id 传 null）。',
    '本章要求：凛江月带着残月剑谱的缺页登上见岢坛，在退潮后的礁盘间见到哑守守焰，坛殿悬着一口无舌自鸣的悬风钟。基调清冷，正文不超过 700 字。',
    '注意：本章人物与地点请先查询本项目设定库确认。请开始，按顺序调用工具。',
  ].join('\n'),
  // 写→改闭环组：必须读回种子稿再修订，测「凭记忆重写导致丢稿」
  revise: [
    '项目 ID：novel-demo-01。章节 ch-seed 已存在，是上一章的定稿。任务：修订这一章，不是重写。',
    '步骤要求：',
    '1) 先 read_chapter 读回 ch-seed 原文（禁止凭记忆改写）；',
    '2) 用 query_world_bible 确认涉及实体的设定；',
    `3) 用 write_segment 修订：必须把 read_chapter 返回的原文一字不差放进 base_text 参数，基调改得更肃杀、压缩到 500 字以内，但以下两句必须逐字原样保留：「${SEED_PROTECTIONS[0]}」「${SEED_PROTECTIONS[1]}」；`,
    '4) 用 commit_chapter 覆盖保存：必须带 chapter_id=ch-seed，content 用修订稿全文。',
    '现在请开始，按顺序调用工具。',
  ].join('\n'),
};

function buildTaskPrompt(seq, variant) {
  const tpl = TASKS[variant] || TASKS.known;
  return tpl.replace(/\{seq\}/g, String(seq));
}

function createOrchestrator(cfg) {
  const {
    chat,
    model,
    world = loadWorld(),
    outDir = path.join(__dirname, '结果'),
    maxStepRetries = 2,
    temperature = 0.2,
    keepAlive = '15m',
    deterministic = false,
    noThink = true,
    isolation = true, // false = 关闭跨项目闸门（对照组，复现旧单库行为）
    // 上下文预算治理：numCtx 必须与 askOnce 里传给模型的 options.num_ctx 一致，
    // 否则预算器算的窗口和模型实际窗口对不上，压缩时机全错。
    numCtxForLoop = 8192,
    contextGuard = true, // false = 关闭上下文治理（A/B 对照用）
  } = cfg;

  const store = { segments: [], chapters: [] };
  const toolImpl = makeToolImpl(world, store);

  async function askOnce(messages, note) {
    const payload = {
      model,
      messages,
      tools: TOOLS,
      stream: false,
      options: { temperature, top_p: 0.8, num_ctx: numCtxForLoop },
      keep_alive: keepAlive,
    };
    if (noThink) payload.think = false;
    const t0 = Date.now();
    const resp = await chat(payload);
    return { resp, ms: Date.now() - t0, note };
  }

  async function execTool(name, args, ctx) {
    const impl = toolImpl[name];
    if (!impl) return { ok: false, error: `未实现工具 ${name}` };
    const full = { ...ctx, model, chat, outDir, keepAlive, deterministic };
    return name === 'query_world_bible' ? impl(args) : impl(args, full);
  }

  /** 一次完整 Agent 样本；variant = 'known' | 'novel' | 'novelB' | 'novelBOpen' | 'revise' */
  async function runAgentSample(seq, variant = 'known') {
    const vmode = variant === 'novel' ? 'record' : 'strict';
    const taskVariant = variant === 'novelBOpen' ? 'novelB' : variant;
    const project = TASK_PROJECT[variant] || null;
    // 写→改闭环：先替模型落一篇「种子稿」当靶子，含保护句
    if (variant === 'revise' && !store.chapters.find((c) => c.id === SEED_CHAPTER_ID)) {
      const dir = path.join(outDir, 'chapters');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '种子-上一章.md');
      fs.writeFileSync(
        file,
        `# 上一章 铁棺（种子稿）\n\n> 章节 ID：${SEED_CHAPTER_ID}　项目：novel-demo-01　父章节：null\n> 生成方式：seed\n\n${SEED_CONTENT}\n`,
        'utf8',
      );
      store.chapters.push({ id: SEED_CHAPTER_ID, title: '铁棺', content: SEED_CONTENT, file, via: 'seed', parent: null });
    }
    const messages = [
      { role: 'system', content: AGENT_SYSTEM },
      { role: 'user', content: buildTaskPrompt(seq, taskVariant) },
    ];
    const rec = {
      seq,
      variant,
      project,
      iso_off: variant === 'novelBOpen',
      mode: 'agent',
      deterministic: !!deterministic,
      steps: [],
      facts: [],
      legal: false,
      fallback: false,
      first_try: variant === 'revise' ? [null, null, null, null] : [null, null, null],
      retries: 0,
      cleaned: [],
      warnings: [],
      protection_dropped: 0,
      tokens_in: 0,
      tokens_out: 0,
      ms: 0,
      error: null,
    };
    // 状态机：不要求模型「一次只调一个且顺序完美」，但强制因果顺序——
    // 没查过设定不许动笔，没写出正文不许存章节；修订组额外强制「没读回原稿不许写/存」。
    const st = { queried: 0, segText: null, chapter: null, read: null };
    const stage = () => {
      if (variant === 'revise') {
        if (!st.read) return 'read_chapter';
        if (!st.queried) return 'query_world_bible';
        if (!st.segText) return 'write_segment';
        if (!st.chapter) return 'commit_chapter';
        return 'done';
      }
      return !st.queried ? 'query_world_bible' : !st.segText ? 'write_segment' : !st.chapter ? 'commit_chapter' : 'done';
    };
    const errStage = {}; // 按「当前阶段」计失败，用于终止判断，保证循环必然结束
    const errTool = {}; // 按「实际调用的工具」计失败，用于统计该工具的重试次数
    const firstCall = { read_chapter: null, query_world_bible: null, write_segment: null, commit_chapter: null };
    let calls = 0;
    const CALL_BUDGET = (variant === 'revise' ? 10 : 8) + maxStepRetries;

    // 上下文预算治理：每轮发请求前检查，超预算就压缩并同步回 messages。
    // 不在调用方手动调——循环里有 14 处 messages.push，单点治理必漏。
    const guard = new LoopContextGuard({
      messages,
      numCtx: numCtxForLoop,
      keepRecentRounds: 3,
      enabled: contextGuard !== false,
    });

    while (stage() !== 'done') {
      if (calls >= CALL_BUDGET) { rec.error = `超出调用预算（${CALL_BUDGET} 轮）仍未完成链路`; break; }
      const want = stage();
      calls++;
      // 压缩必须在 askOnce 之前，且同步回 messages——只压副本等于没压
      const guardRes = guard.ensure();
      rec.context_guard = guard.report();
      if (guardRes.starved) {
        rec.warnings.push('上下文已超预算且无可丢条目（保留配对与已落盘事实优先）');
      }
      let got;
      try {
        const once = await askOnce(guard.messages, want);
        rec.ms += once.ms;
        rec.tokens_in += once.resp.prompt_eval_count || 0;
        rec.tokens_out += once.resp.eval_count || 0;
        got = parseToolCall(once.resp);
      } catch (e) {
        rec.error = `调用模型失败：${e.message}`;
        rec.steps.push({ step: want, ok: false, reason: 'transport_error', error: e.message });
        break;
      }

      if (got.notes.length) rec.cleaned.push(...got.notes);
      const call = got.calls[0];
      const contentFull = String((got.raw && got.raw.message && got.raw.message.content) || '');
      const contentEcho = contentFull.slice(0, 160);

      const fail = (reason, extra) => {
        errStage[want] = (errStage[want] || 0) + 1;
        rec.retries++;
        if (firstCall[want] === null) firstCall[want] = false;
        rec.steps.push({ step: want, ok: false, reason, content_preview: contentEcho, ...extra });
      };
      const giveUp = () => errStage[want] > maxStepRetries;

      if (!call) {
        fail('no_tool_call');
        guard.messages.push({ role: 'assistant', content: contentEcho || '(无输出)' });
        guard.messages.push({
          role: 'user',
          content: `上一轮没有产生合法工具调用。现在必须且只能调用 ${want}，只输出工具调用本身，不要解释。`,
        });
        if (giveUp()) { rec.error = `${want} 阶段连续 ${errStage[want]} 次无合法调用`; break; }
        continue;
      }

      if (got.calls.length > 1) {
        fail('multi_tool_call', { tool: call.name, errors: [`一次调用了 ${got.calls.length} 个工具，每轮只允许一个`] });
        guard.messages.push(asstCall(contentFull, call));
        guard.messages.push({
          role: 'user',
          content: `一次调用了 ${got.calls.length} 个工具。每轮只允许一个，现在只调用 ${want}。`,
        });
        if (giveUp()) { rec.error = `${want} 阶段连续输出多工具`; break; }
        continue;
      }

      // 每次失败都记下实际调用的工具，用于「按工具」统计
      const noteToolErr = () => { errTool[call.name] = (errTool[call.name] || 0) + 1; };

      // 顺序约束：拦住「没查设定就写正文」这类挂羊头
      if (variant === 'revise' && call.name === 'write_segment' && !st.read) {
        noteToolErr();
        fail('order_violation', { tool: call.name, errors: ['未读回原稿就要求修订'] });
        guard.messages.push(asstCall(contentFull, call));
        guard.messages.push({
          role: 'user',
          content: '修订任务禁止凭记忆重写。必须先调用 read_chapter 读回 ch-seed 原文，再修订。',
        });
        if (giveUp()) { rec.error = '未读原稿即修订'; break; }
        continue;
      }
      if (variant === 'revise' && call.name === 'commit_chapter') {
        if (call.arguments.chapter_id !== SEED_CHAPTER_ID) {
          noteToolErr();
          fail('order_violation', { tool: call.name, errors: [`修订必须覆盖原章节：chapter_id 应为 ${SEED_CHAPTER_ID}，实际传 ${JSON.stringify(call.arguments.chapter_id ?? null)}`] });
          guard.messages.push(asstCall(contentFull, call));
          guard.messages.push({
            role: 'user',
            content: `这是修订任务，commit_chapter 必须带 chapter_id="${SEED_CHAPTER_ID}" 覆盖保存，不得新建章节。`,
          });
          if (giveUp()) { rec.error = '修订未带原章节 ID'; break; }
          continue;
        }
        const missing = SEED_PROTECTIONS.filter((p) => !String(call.arguments.content || '').includes(p));
        if (missing.length) {
          noteToolErr();
          rec.protection_dropped = (rec.protection_dropped || 0) + 1;
          fail('protection_lost', { tool: call.name, errors: [`保护句在覆盖稿中丢失：${missing.join('；')}`] });
          guard.messages.push(asstCall(contentFull, call));
          guard.messages.push({
            role: 'user',
            content: `覆盖保存被拒绝：原稿的关键设定句「${missing.join('」「')}」在修订稿中消失，会造成丢稿。请重新 read_chapter 读回原文，修订时逐字保留这两句。`,
          });
          if (giveUp()) { rec.error = `保护句连续丢失 ${rec.protection_dropped} 次`; break; }
          continue;
        }
      }
      if (call.name === 'write_segment' && !st.queried) {
        noteToolErr();
        fail('order_violation', { tool: call.name, errors: ['未查询设定就要求写正文'] });
        guard.messages.push(asstCall(contentFull, call));
        guard.messages.push({
          role: 'user',
          content: '禁止在未确认设定前动笔。先用 query_world_bible 查询本章相关实体，再写正文。',
        });
        if (giveUp()) { rec.error = '未查询设定即动笔'; break; }
        continue;
      }
      if (call.name === 'commit_chapter' && !st.segText) {
        noteToolErr();
        fail('order_violation', { tool: call.name, errors: ['还没有正文可保存'] });
        guard.messages.push(asstCall(contentFull, call));
        guard.messages.push({
          role: 'user',
          content: '当前没有可保存的正文。必须先调用 write_segment 产出正文，再调用 commit_chapter。',
        });
        if (giveUp()) { rec.error = '无正文即提交'; break; }
        continue;
      }

      const v = validateCall(call, world, variant === 'novel' ? 'record' : 'strict', {
        project,
        isolation: variant !== 'novelBOpen',
      });
      if (v.warnings.length) rec.warnings.push(...v.warnings);
      if (!v.ok) {
        noteToolErr();
        fail('invalid_call', { tool: call.name, args: call.arguments, errors: v.errors });
        guard.messages.push(asstCall(contentFull, call));
        guard.messages.push({
          role: 'user',
          content: `工具调用被拒绝：${v.errors.join('；')}。请修正后重新调用。`,
        });
        if (giveUp()) { rec.error = `${want} 阶段校验连续失败：${v.errors.join('；')}`; break; }
        continue;
      }

      // 合法：执行工具
      const ctx = {
        facts: rec.facts,
        via: 'agent',
        step: call.name,
        styleProfile: cfg.styleProfile || null,
      };
      const toolResult = await execTool(call.name, call.arguments, ctx);
      if (!toolResult || toolResult.ok === false) {
        noteToolErr();
        fail('tool_error', {
          tool: call.name,
          args: call.arguments,
          errors: [toolResult ? toolResult.error : '工具无返回'],
        });
        guard.messages.push(asstCall(contentFull, call));
        guard.messages.push({ role: 'tool', name: call.name, content: JSON.stringify(toolResult) });
        guard.messages.push({
          role: 'user',
          content: `工具 ${call.name} 返回错误：${(toolResult && toolResult.error) || '无返回'}。请修正参数后重试。`,
        });
        if (giveUp()) { rec.error = `${call.name} 工具端连续失败`; break; }
        continue;
      }

      if (call.name === 'query_world_bible') st.queried++;
      if (call.name === 'read_chapter') st.read = toolResult.content;
      if (call.name === 'write_segment') st.segText = toolResult.text;
      if (call.name === 'commit_chapter') {
        // 保真度只对「本样本刚生成的正文」比较
        rec.content_fidelity = st.segText ? fidelity(st.segText, String(call.arguments.content || '')) : null;
        st.chapter = toolResult.file;
        rec.chapter = toolResult.file;
      }
      rec.facts.push(...(toolResult.hits || []));
      if (firstCall[call.name] === null) firstCall[call.name] = true;
      rec.steps.push({
        step: call.name,
        ok: true,
        args: summarizeArgs(call.arguments),
        attempts: (errTool[call.name] || 0) + 1,
        result_brief: briefResult(toolResult),
      });
      guard.messages.push(asstCall(contentFull, call));
      guard.messages.push({ role: 'tool', name: call.name, content: JSON.stringify(toolResult) });
    }

    rec.llm_calls = calls;
    rec.first_try = variant === 'revise'
      ? [firstCall.read_chapter, firstCall.query_world_bible, firstCall.write_segment, firstCall.commit_chapter]
      : [firstCall.query_world_bible, firstCall.write_segment, firstCall.commit_chapter];
    rec.legal = stage() === 'done' && !!st.chapter;
    if (!rec.legal) {
      rec.fallback = true;
      await runFallbackChain(seq, rec, variant);
    }
    return rec;
  }

  /** LAYER 3：降级为规则驱动的 Prompt Chain（脚本自己按序调工具） */
  const FALLBACK_QUERIES = {
    known: ['谢九', '铁棺', '剑冢'],
    novel: ['叶霜凝', '听潮阁', '青铜钟'],
    novelB: ['凛江月', '见岢坛', '悬风钟'],
    novelBOpen: ['凛江月', '见岢坛', '悬风钟'],
  };

  async function runFallbackChain(seq, rec, variant = 'known') {
    const fb = { mode: 'fallback', variant, steps: [], facts: [], legal: false, halted: null };
    const taskVariant = variant === 'novelBOpen' ? 'novelB' : variant;
    const title = taskVariant === 'novelB' ? '悬风钟' : variant === 'novel' ? '青铜钟' : '铁棺';
    const projectId = variant === 'novel' || variant === 'novelB' || variant === 'novelBOpen' ? 'novel-demo-02' : 'novel-demo-01';

    // 修订组降级：规则链没有「改写而不丢设定」的创造力，读回原稿后只能保句微调；
    // 若微调后保护句仍缺失，停笔交人工，绝不静默覆盖丢稿。
    if (variant === 'revise') {
      try {
        const rd = await execTool('read_chapter', { project_id: 'novel-demo-01', chapter_id: SEED_CHAPTER_ID }, { facts: [] });
        fb.steps.push({ step: 'read_chapter', ok: rd.ok, via: 'rule' });
        if (!rd.ok) throw new Error(rd.error);
        const seg = await execTool(
          'write_segment',
          { scene: `${buildTaskPrompt(seq, 'revise')}`, base_text: rd.content, characters: ['谢九', '洛三娘'], tone: '肃杀', max_length: 500 },
          { facts: [], via: 'fallback' },
        );
        fb.steps.push({ step: 'write_segment', ok: seg.ok, via: 'rule' });
        if (!seg.ok) throw new Error(seg.error);
        const missing = SEED_PROTECTIONS.filter((p) => !String(seg.text || '').includes(p));
        if (missing.length) {
          fb.halted = `规则链修订稿仍丢失保护句「${missing.join('」「')}」，停笔交人工修订，不覆盖原稿。`;
          if (rec) { rec.fallback_detail = fb; rec.halted_reason = fb.halted; }
          return fb;
        }
        const cm = await execTool('commit_chapter', { project_id: 'novel-demo-01', chapter_title: '铁棺（规则链修订）', content: seg.text, chapter_id: SEED_CHAPTER_ID }, { facts: [], via: 'fallback' });
        fb.steps.push({ step: 'commit_chapter', ok: cm.ok, via: 'rule' });
        fb.chapter = cm.file;
        fb.overwritten = true;
      } catch (e) {
        fb.error = e.message;
      }
      if (rec) {
        rec.fallback_detail = fb;
        rec.chapter = fb.chapter;
        if (fb.halted) rec.halted_reason = fb.halted;
      }
      return fb;
    }

    try {
      for (const q of FALLBACK_QUERIES[variant] || FALLBACK_QUERIES.known) {
        const r = await execTool('query_world_bible', { project_id: projectId, query: q }, { facts: [] });
        fb.facts.push(...(r.hits || []));
        fb.steps.push({ step: 'query_world_bible', ok: r.ok, hits: r.count, via: 'rule' });
      }
      // 规则链没有「编造」能力：查不到设定就停笔，交人工补全。
      // 这正是与模型链路的关键差异——陌生实体组会在这里暴露出来。
      if (!fb.facts.length) {
        fb.halted = '设定库中无本章所需实体，规则链停笔，需人工补全设定后再写。';
        if (rec) { rec.fallback_detail = fb; rec.halted_reason = fb.halted; }
        return fb;
      }

      const seg = await execTool(
        'write_segment',
        {
          scene: buildTaskPrompt(seq, taskVariant),
          characters: fb.facts.filter((f) => f.type === 'character').map((f) => f.name),
          tone: variant === 'novel' || variant === 'novelB' || variant === 'novelBOpen' ? '清冷' : '冷硬克制',
          max_length: 700,
        },
        { facts: fb.facts, via: 'fallback' },
      );
      fb.steps.push({ step: 'write_segment', ok: seg.ok, via: 'rule' });
      if (!seg.ok) throw new Error(seg.error);

      const cm = await execTool(
        'commit_chapter',
        {
          project_id: projectId,
          chapter_title: title,
          content: seg.text,
          parent_chapter_id: null,
        },
        { facts: fb.facts, via: 'fallback' },
      );
      fb.steps.push({ step: 'commit_chapter', ok: cm.ok, via: 'rule' });
      fb.legal = false; // 降级产出不是「模型驱动的合法调用」，不进分子
      fb.chapter = cm.file;
    } catch (e) {
      fb.error = e.message;
    }
    if (rec) {
      rec.fallback_detail = fb;
      rec.chapter = fb.chapter;
      if (fb.halted) rec.halted_reason = fb.halted;
    }
    return fb;
  }

  /** 对照组：纯 Prompt Chain（一次调用带设定），用于比较 Agent 是否真的更优 */
  async function runBaselineChain(seq, variant = 'known') {
    const facts = [];
    for (const q of (FALLBACK_QUERIES[variant] || FALLBACK_QUERIES.known)) {
      const r = toolImpl.query_world_bible({ query: q });
      if (r.hits) facts.push(...r.hits);
    }
    // 基线没有工具循环，查不到设定也无从纠正——只能凭 prompt 硬写，这正是它的软肋
    const bibleText = facts.length
      ? facts.map((f) => `· ${f.name}（${f.type}）：${f.note}`).join('\n')
      : '（无：设定库中查不到本章实体）';
    const t0 = Date.now();
    const resp = await chat({
      model,
      messages: [
        { role: 'system', content: '你是小说执笔。只输出正文，不要输出标题与说明。' },
        { role: 'user', content: `${buildTaskPrompt(seq, variant)}\n\n【已确认设定】\n${bibleText}\n\n直接写这一章的正文。` },
      ],
      stream: false,
      options: { temperature: 0.7, top_p: 0.9, num_ctx: 8192 },
      keep_alive: keepAlive,
      ...(noThink ? { think: false } : {}),
    });
    const text = String(resp.message?.content || '').trim();
    const id = `seg-b-${variant}-${seq}`;
    store.baseline = store.baseline || [];
    store.baseline.push({ id, variant, text });
    let file = null;
    if (text) {
      const dir = path.join(outDir, variant === 'novel' ? 'chapters-基线-陌生实体' : 'chapters-基线');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `第${String(seq).padStart(2, '0')}章-基线.md`);
      fs.writeFileSync(file, `# 第${seq}章（Prompt Chain 基线 · ${variant}）\n\n${text}\n`, 'utf8');
    }
    return {
      seq,
      variant,
      mode: 'baseline',
      no_setting: facts.length === 0,
      ms: Date.now() - t0,
      chars: text.length,
      anchors: anchorHit(text, bibleText),
      file,
      tokens_in: resp.prompt_eval_count || 0,
      tokens_out: resp.eval_count || 0,
      preview: text.slice(0, 200),
    };
  }

  function anchorHit(text, bibleText) {
    const names = world.map((e) => e.name);
    const hit = names.filter((n) => String(text).includes(n));
    return { expected: names.length, hit: hit.length, rate: text ? +(hit.length / Math.max(3, names.length / 2)).toFixed(2) : 0, names: hit };
  }

  return { runAgentSample, runFallbackChain, runBaselineChain, store, toolImpl, world, messages: null };
}

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.length > 80) out[k] = `${v.slice(0, 80)}…(${v.length}字)`;
    else out[k] = v;
  }
  return out;
}

function briefResult(r) {
  if (!r) return null;
  if (r.ok === false) return { ok: false, error: r.error };
  if (r.must_keep) return { ok: true, chapter_id: r.chapter_id, chars: r.chars, must_keep: r.must_keep.length };
  if (r.hits) return { ok: true, count: r.count, names: r.hits.map((h) => h.name) };
  if (r.segment_id) return { ok: true, segment_id: r.segment_id, chars: r.chars };
  if (r.chapter_id) return { ok: true, chapter_id: r.chapter_id, file: r.file };
  return { ok: true };
}

/** 正文保真率：模型回传 content 与 write_segment 原文的字符重合度 */
function fidelity(src, out) {
  const a = norm(src);
  const b = norm(out);
  if (!a) return 0;
  if (a === b) return 1;
  if (a.includes(b) && b.length / a.length > 0.6) return +(b.length / a.length).toFixed(3);
  let common = 0;
  for (let i = 0; i + 4 <= b.length; i += 2) if (a.includes(b.slice(i, i + 4))) common += 1;
  const total = Math.max(1, Math.floor((b.length - 4) / 2) + 1);
  return +Math.min(1, common / total).toFixed(3);
}

/* ------------------------------------------------------------------ *
 * 6. Ollama HTTP 客户端
 * ------------------------------------------------------------------ */

const BASE_URL = process.env.OLLAMA_HOST ? process.env.OLLAMA_HOST.replace(/\/$/, '') : 'http://127.0.0.1:11434';

/**
 * Ollama /api/chat 调用。
 * 超时说明：Agent 循环的单步上限是 3 次重试，单次最长允许 180s——
 * 8B 正常 10s，30B 慢样本可达 190s，留足余量又不至于挂死。
 * 超时由 AbortController 实现；超时错误可重试，HTTP 4xx 不重试（重试也没用）。
 */
const CHAT_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 180000;

async function ollamaChat(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${t.slice(0, 300)}`);
      // 4xx 是请求本身的问题（模型名错、参数不支持），重试无意义
      err.retryable = res.status >= 500 || res.status === 429;
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`调用超时（>${CHAT_TIMEOUT_MS / 1000}s），模型可能未加载或显存不足`);
      err.retryable = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function probeServer() {
  const res = await fetch(`${BASE_URL}/api/tags`, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.models || []).map((m) => m.name);
}

async function pullModel(name) {
  process.stdout.write(`本地没有 ${name}，开始拉取（体积较大，可能持续较久）…\n`);
  const res = await fetch(`${BASE_URL}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`拉取失败 HTTP ${res.status}`);
  let last = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    const txt = dec.decode(chunk, { stream: true });
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.status) last = o.status;
      } catch {}
    }
    if (/(\d{1,3})%/.test(last)) {
      process.stdout.write(`\r  ${name} ${last}   `);
    }
  }
  process.stdout.write('\n');
}

/* ------------------------------------------------------------------ *
 * 7. 报表
 * ------------------------------------------------------------------ */

function buildReport(model, allRecs, baselines, meta) {
  meta = meta || {};
  // 已知实体组才是「链路稳定性」的判据；陌生实体组只测编造，不混进合法率
  const agentRecs = allRecs.filter((r) => (r.variant || 'known') === 'known');
  const novelRecs = allRecs.filter((r) => r.variant === 'novel');
  const reviseRecs = allRecs.filter((r) => r.variant === 'revise');
  // 双库隔离对照：novelB（闸门开）与 novelBOpen（闸门关）必须各自成组，
  // 否则它们会既不进 agentRecs 也不进 novelRecs，在报表里被静默丢掉。
  const dualOnRecs = allRecs.filter((r) => r.variant === 'novelB');
  const dualOffRecs = allRecs.filter((r) => r.variant === 'novelBOpen');

  const statsOf = (rs, opts) => {
    const real = (opts && opts.realFidelity) ? rs.filter((r) => r.legal && !r.stub && !r.deterministic) : rs;
    const n = rs.length;
    const legal = rs.filter((r) => r.legal).length;
    const stepsOk = rs.flatMap((r) => r.steps.filter((s) => s.ok));
    const firstTry = stepsOk.length ? Math.round((stepsOk.filter((s) => s.attempts === 1).length / stepsOk.length) * 100) : 0;
    let aTot = 0; let aHit = 0; let aAlias = 0;
    for (const r of real) {
      const ch = r.chapter && fs.existsSync(r.chapter) ? fs.readFileSync(r.chapter, 'utf8') : '';
      for (const f of r.facts || []) {
        aTot++;
        if (ch.includes(f.name)) { aHit++; continue; }
        // 字面缺失不等于设定丢失：模型可能用简称或别名（如「乱葬岗」写成「岗北」）。
        // 实测 8B 已知组 2/22 的「未命中」全是这种情况，属指标假阴性，不是模型漏设定。
        // 故分三档统计：字面命中 / 别名或简称命中 / 真未使用。
        const alt = [].concat(f.aliases || [], suffixVariants(f.name));
        if (alt.some((a) => a && ch.includes(a))) { aHit++; aAlias++; }
      }
    }
    const fid = real.map((r) => r.content_fidelity).filter((x) => typeof x === 'number');
    return {
      n,
      legal,
      rate: n ? Math.round((legal / n) * 100) : 0,
      firstTry,
      fallbacks: rs.filter((r) => r.fallback).length,
      halted: rs.filter((r) => r.halted_reason).length,
      retries: rs.reduce((a, r) => a + (r.retries || 0), 0),
      avgFid: fid.length ? (fid.reduce((a, b) => a + b, 0) / fid.length).toFixed(3) : '—',
      anchorRate: aTot ? Math.round((aHit / aTot) * 100) : 0,
      anchorHit: aHit,
      anchorAlias: aAlias,
      anchorTotal: aTot,
      tokens: rs.reduce((a, r) => a + (r.tokens_in || 0) + (r.tokens_out || 0), 0),
      ms: rs.reduce((a, r) => a + (r.ms || 0), 0),
    };
  };

  const S = statsOf(agentRecs, { realFidelity: true });
  const N = statsOf(novelRecs);
  const R = statsOf(reviseRecs);
  const n = S.n;
  const legal = S.legal;
  const rate = S.rate;
  const firstTryRate = S.firstTry;
  const fallbacks = S.fallbacks;
  const retries = S.retries;
  const avgFid = S.avgFid;
  const anchorRate = S.anchorRate;
  const anchorHitN = S.anchorHit;
  const anchorTotal = S.anchorTotal;
  const anchorAlias = S.anchorAlias || 0;
  const tokens = S.tokens;
  const ms = S.ms;

  const notesCount = {};
  for (const r of allRecs) for (const x of r.cleaned || []) notesCount[x] = (notesCount[x] || 0) + 1;

  const failureReasons = {};
  for (const r of allRecs) for (const s of r.steps) if (!s.ok) failureReasons[s.reason] = (failureReasons[s.reason] || 0) + 1;

  const verdict =
    n === 0 ? '未跑已知实体组，无法判定' :
    rate >= 80 ? '通过 —— 第 6 章可照 Agent 架构写' :
    rate >= 50 ? '勉强通过 —— 可写 Agent，但校验层与重试层是必需品，不是可选项' :
    '不通过 —— 第 6 章降级为「规则驱动的多步工作流」，并明确标注不是完整 Agent';

  const L = [];
  L.push('# Tool Calling 可行性验证报表');
  L.push('');
  L.push(`- 模型：\`${model}\`　temperature：${meta.temperature}　think：${meta.noThink ? 'off' : 'on'}`);
  L.push(`- 已知实体组 ${n} 个样本；陌生实体组 ${N.n} 个样本${R.n ? `；写→改闭环组 ${R.n} 个样本` : ''}${dualOnRecs.length ? `；双库隔离组 ${dualOnRecs.length}+${dualOffRecs.length} 个样本（闸门开+关）` : ''}`);
  L.push(`- 耗时合计：${((S.ms + N.ms + R.ms + dualOnRecs.reduce((a, r) => a + (r.ms || 0), 0) + dualOffRecs.reduce((a, r) => a + (r.ms || 0), 0)) / 1000).toFixed(1)}s　Token 合计（in+out）：${(S.tokens + N.tokens + R.tokens + dualOnRecs.reduce((a, r) => a + (r.tokens_in || 0) + (r.tokens_out || 0), 0) + dualOffRecs.reduce((a, r) => a + (r.tokens_in || 0) + (r.tokens_out || 0), 0)).toLocaleString()}`);
  L.push('');
  L.push(`## 判定：${rate}% 合法 → **${verdict}**`);
  L.push('');
  L.push('### 已知实体组（链路稳定性）');
  L.push('');
  L.push('| 指标 | 数值 | 说明 |');
  L.push('|---|---|---|');
  L.push(`| 链路合法完成率 | **${rate}%**（${legal}/${n}） | 三步全部由模型自主产出合法调用，降级不计入 |`);
  L.push(`| 首试通过率 | ${firstTryRate}% | 模型的「裸」tool call 能力 |`);
  L.push(`| 平均重试次数 | ${(retries / Math.max(1, n)).toFixed(2)} / 样本 | 校验+重试层替你兜的底的量 |`);
  L.push(`| 降级次数 | ${fallbacks} | 连续失败后退回规则链 |`);
  L.push(`| 设定锚点命中率 | ${anchorTotal ? anchorRate + '%' + '（' + anchorHitN + '/' + anchorTotal + '）' : '不适用（桩运行/无成功样本）'} | 查到的设定是否真进了落盘正文；其中 ${anchorAlias} 条为简称/别名命中（字面缺字但语义在场） |`);
  L.push(`| 正文保真率 | ${avgFid}${avgFid === '—' ? '（桩运行不计算）' : ''} | commit 的 content 与 write_segment 原文的贴合度 |`);
  L.push('');
  L.push('> 两个指标的差值最关键：**合法率高但锚点命中低** = 模型只是在表演调工具，链路走得通而设定没进上下文，对长篇是致命的。');
  L.push('');

  if (N.n) {
    const fabQuery = novelRecs.reduce((a, r) => a + (r.warnings || []).filter((w) => /疑似编造/.test(w)).length, 0);
    const fabChar = novelRecs.reduce((a, r) => a + (r.warnings || []).filter((w) => /未经确认的编造/.test(w)).length, 0);
    const emptyAnchor = novelRecs.reduce((a, r) => a + (r.warnings || []).filter((w) => /未出现任何设定库实体/.test(w)).length, 0);
    L.push('### 陌生实体组（编造检测）');
    L.push('');
    L.push('题目里的人物、地点、功法全部不在设定库中。理想行为是：查到「无此实体」后**停笔并报告缺设定**，而不是硬编。');
    L.push('');
    L.push('| 指标 | 数值 | 期望 |');
    L.push('|---|---|---|');
    L.push(`| 仍走完全链路并提交章节 | ${N.legal}/${N.n} | 越低越好（应为 0） |`);
    L.push(`| 查询命中「查无此实体」后仍继续 | ${fabQuery} 次 | 应为 0 |`);
    L.push(`| 出场角色属编造 | ${fabChar} 次 | 应为 0 |`);
    L.push(`| 落盘正文无任何设定库实体 | ${emptyAnchor} 次 | 反映凭空生成的比例 |`);
    L.push(`| 规则链停笔 | ${N.halted} | 停笔是**正确**行为，说明缺设定必须人工补 |`);
    L.push('');
    L.push(N.legal > 0
      ? `> ⚠️ ${N.legal} 个样本在设定库查不到的情况下仍产出了完整章节 —— 这些正文是**凭空编造**的。工具调用在此退化为装饰，检索并未真正约束生成。`
      : '> ✅ 陌生实体组没有出现「查不到还硬写」的情况，检索确实在约束生成。');
    L.push('');
  }

  if (R.n) {
    const noRead = reviseRecs.filter((r) => r.steps.some((s) => !s.ok && s.reason === 'order_violation' && s.tool === 'write_segment')).length;
    const dropCnt = reviseRecs.reduce((a, r) => a + (r.protection_dropped || 0), 0);
    const dropSamples = reviseRecs.filter((r) => (r.protection_dropped || 0) > 0).length;
    const newInstead = reviseRecs.filter((r) => r.steps.some((s) => !s.ok && s.errors && s.errors.join(' ').includes('修订必须覆盖'))).length;
    const okAll = reviseRecs.filter((r) => r.legal && !(r.protection_dropped > 0)).length;
    L.push('### 写→改闭环组（丢稿检测）');
    L.push('');
    L.push('题目给一篇已存在的种子章节（含两句保护性设定），要求模型**读回 → 修订 → 带 chapter_id 覆盖保存**。');
    L.push('校验层硬规则：未 read_chapter 不许动笔；覆盖稿缺任一保护句即拒绝保存。这里测的是模型会不会「凭记忆重写」造成丢稿。');
    L.push('');
    L.push('| 指标 | 数值 | 期望 |');
    L.push('|---|---|---|');
    L.push(`| 先读后改、一次走通 | ${okAll}/${R.n} | 越高越好 |`);
    L.push(`| 跳过读取想直接重写（被拦截） | ${noRead} 个样本 | 拦截必须 100% 生效 |`);
    L.push(`| 覆盖稿丢失保护句（被拒绝） | ${dropCnt} 次 / ${dropSamples} 个样本 | 每次都被校验层拦下 |`);
    L.push(`| 试图新建章节而非覆盖 | ${newInstead} 个样本 | 应为 0 |`);
    L.push(`| 修订合法率 | ${R.rate}% | 与已知组同口径 |`);
    L.push(`| 覆盖前自动备份 .bak | ${reviseRecs.filter((r) => r.chapter && fs.existsSync(r.chapter + '.bak')).length} 处 | 兜底：即使逻辑漏判也可人工恢复 |`);
    L.push('');
    L.push(dropCnt > 0
      ? `> ⚠️ 模型 ${dropCnt} 次试图用**丢了关键设定的覆盖稿**保存，全靠校验层逐字比对保护句拦下。结论：覆盖写操作必须带内容回归校验，不能信任模型「自己会保留」。`
      : '> ✅ 所有修订稿都完整保留了保护句。但仍建议生产环境保留 .bak 备份作为最后防线。');
    L.push('');
  }

  if (dualOnRecs.length || dualOffRecs.length) {
    // 统计口径：跨项目实体 = 落盘正文中出现「另一库」的实体名（A 库实体列表从设定库反推）。
    const crossOf = (rs, otherEntries) => {
      let polluted = 0;
      for (const r of rs) {
        const ch = r.chapter && fs.existsSync(r.chapter) ? fs.readFileSync(r.chapter, 'utf8') : '';
        if (!ch) continue;
        if (otherEntries.some((e) => ch.includes(e.name))) polluted++;
      }
      return polluted;
    };
    const w = allRecs.length ? allRecs[0].__world : null;
    const aEntries = w ? w.filter((e) => e.project === 'novel-demo-01') : [];
    const bEntries = w ? w.filter((e) => e.project === 'novel-demo-02') : [];
    const ON = statsOf(dualOnRecs);
    const OFF = statsOf(dualOffRecs);
    const crossOn = crossOf(dualOnRecs, aEntries);
    const crossOff = crossOf(dualOffRecs, aEntries);
    const bHitOn = dualOnRecs.filter((r) => {
      const ch = r.chapter && fs.existsSync(r.chapter) ? fs.readFileSync(r.chapter, 'utf8') : '';
      return ch && bEntries.some((e) => ch.includes(e.name));
    }).length;
    const bHitOff = dualOffRecs.filter((r) => {
      const ch = r.chapter && fs.existsSync(r.chapter) ? fs.readFileSync(r.chapter, 'utf8') : '';
      return ch && bEntries.some((e) => ch.includes(e.name));
    }).length;

    L.push('## 双库隔离对照组（跨项目污染实证）');
    L.push('');
    L.push('同一道B 库题跑两次：`novelB` 开project_id 闸门，`novelBOpen` 关闸门。差值即闸门的量化收益。');
    L.push('');
    L.push('| 指标 | 闸门开（novelB） | 闸门关（novelBOpen） |');
    L.push('|---|---|---|');
    L.push(`| 链路合法完成率 | ${ON.rate}%（${ON.legal}/${ON.n}） | ${OFF.rate}%（${OFF.legal}/${OFF.n}） |`);
    L.push(`| 平均重试 / 样本 | ${(ON.retries / Math.max(1, ON.n)).toFixed(2)} | ${(OFF.retries / Math.max(1, OFF.n)).toFixed(2)} |`);
    L.push(`| 降级次数 | ${ON.fallbacks} | ${OFF.fallbacks} |`);
    L.push(`| **落盘正文含 A 库实体（跨项目污染）** | **${crossOn} / ${ON.n}** | **${crossOff} / ${OFF.n}** |`);
    L.push(`| 落盘正文含 B 库实体（本库命中） | ${bHitOn} / ${ON.n} | ${bHitOff} / ${OFF.n} |`);
    L.push('');
    if (crossOff === 0) {
      L.push('> ⚠️ **闸门开关差值为零**：关闸门时同样没有跨项目实体混入。说明本轮样本中模型**根本没走「跨库借实体」这条路径**——查不到就凭空编造，而不是回退检索他库。');
      L.push('> 因此不能用本组的「污染率差值」论证闸门价值。闸门的真实作用是**阻止越界**，越界被拦时表现为**重试与降级**（见 30B 组：闸门开时降级 2 次、闸门关时零降级），而非静默污染。');
    } else {
      L.push(`>闸门开时跨项目污染 ${crossOn}/${ON.n}，关闸门时 ${crossOff}/${OFF.n}——差值 ${crossOff - crossOn} 即 project_id 闸门的量化收益。`);
    }
    L.push('');
  }

  if (Object.keys(notesCount).length) {
    L.push('## 输出格式问题分布（清洗层统计）');
    L.push('');
    L.push('| 现象 | 次数 |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(notesCount).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
    L.push('');
  }
  if (Object.keys(failureReasons).length) {
    L.push('## 失败原因分布');
    L.push('');
    L.push('| 原因 | 次数 |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(failureReasons).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
    L.push('');
  }
  L.push('## 逐样本明细');
  L.push('');
  L.push('| 组 | # | 结果 | 各步尝试 | 保真 | 告警 | 耗时 |');
  L.push('|---|---|---|---|---|---|---|');
  // 组名必须按 variant 映射：原来只区分 陌生/写改/已知 三档，novelB 与 novelBOpen 会一起
  // 落进「已知」，出现同一组编号重复若干次的假象，看起来像样本数翻倍。
  const VNAME = {
    known: '已知',
    novel: '陌生',
    revise: '写改',
    novelB: '双库·闸门开',
    novelBOpen: '双库·闸门关',
  };
  for (const r of allRecs) {
    const att = r.steps.map((s) => `${s.step.replace(/read_chapter/, '读').replace(/query_world_bible/, '查').replace(/write_segment/, '写').replace(/commit_chapter/, '存')}:${s.ok ? (s.attempts || 1) : '×'}`).join(' ');
    const res = r.halted_reason ? '停笔' : r.legal ? (r.variant === 'revise' && r.protection_dropped ? '合法(曾丢稿)' : '合法') : r.fallback ? '降级' : '失败';
    const vlabel = VNAME[r.variant || 'known'] || r.variant || '已知';
    L.push(`| ${vlabel} | ${r.seq} | ${res} | ${att || '—'} | ${r.content_fidelity ?? '—'} | ${(r.warnings || []).length} | ${((r.ms || 0) / 1000).toFixed(1)}s |`);
  }
  L.push('');
  if (baselines.length) {
    L.push('## 对照：Prompt Chain 基线（零 tool call）');
    L.push('');
    L.push('| 组 | # | 字数 | 有无设定 | 锚点命中 | 耗时 |');
    L.push('|---|---|---|---|---|---|');
    for (const b of baselines) {
      L.push(`| ${b.variant === 'novel' ? '陌生' : '已知'} | ${b.seq} | ${b.chars} | ${b.no_setting ? '无（凭 prompt 硬写）' : '有'} | ${b.anchors.hit} 个实体 | ${(b.ms / 1000).toFixed(1)}s |`);
    }
    L.push('');
    L.push('> 若基线正文质量与 Agent 产出接近，说明为 Agent 付出的复杂度不划算，第 6 章应按规则链写。');
    L.push('> 陌生实体组的基线**没有工具循环可纠错**，只能硬写；拿它和 Agent 同题对比，就能量出「工具调用」到底赚了多少。');
    L.push('');
  }
  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * 8. CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = {
    model: 'qwen3:latest',
    samples: 12,
    out: path.join(__dirname, '结果'),
    probe: false,
    chainOnly: false,
    chain: 2,
    maxRetries: 2,
    noThink: true,
    novel: false,
    revise: false,
    dual: false,
  };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') o.model = String(argv[++i] || o.model);
    else if (a === '--samples') o.samples = Math.max(1, Math.min(64, num(argv[++i], 12)));
    else if (a === '--out') o.out = path.resolve(String(argv[++i] || o.out));
    else if (a === '--retries') o.maxRetries = Math.max(0, num(argv[++i], 2));
    else if (a === '--chain') o.chain = Math.max(0, num(argv[++i], 2));
    else if (a === '--chain-only') { o.chainOnly = true; o.chain = Math.max(o.chain, 2); }
    else if (a === '--think') o.noThink = false;
    else if (a === '--probe') o.probe = true;
    else if (a === '--novel') o.novel = true;
    else if (a === '--revise') o.revise = true;
    else if (a === '--dual') o.dual = true;
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else console.error(`忽略未知参数：${a}`);
  }
  return o;
}

const HELP = [
  '用法：node run-verify.js [选项]',
  '  --model <名称>    要验证的模型，默认 qwen3:latest',
  '  --samples <N>     Agent 链路样本数，默认 12（建议 16~20）',
  '  --retries <N>     单步额外重试次数，默认 2',
  '  --chain <N>       Prompt Chain 基线跑几次，默认 2；0 关闭',
  '  --chain-only      只跑基线，不验证 tool call',
  '  --novel           加跑「陌生实体对照组」：题目人物地点均不在设定库，用于检测编造',
  '  --revise          加跑「写→改闭环组」：模型须 read_chapter 读回种子章节再修订覆盖，用于检测丢稿',
  '  --dual            加跑「双库隔离对照组」：novelB（B 库题+闸门开）与 novelBOpen（同题+闸门关）各一组，用于实证跨项目污染与 project 隔离的效果',
  '  --probe           只跑 1 个完整样本并打印每步细节（冒烟测试，最省时间）',
  '  --think           开启模型思考模式（默认关闭，避免污染 tool call 输出）',
  '  --out <目录>      结果输出目录，默认 ./结果',
  '',
  '说明：脚本只访问本机 Ollama（默认 http://127.0.0.1:11434），不连接任何外部服务。',
].join('\n');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let installed;
  try {
    installed = await probeServer();
  } catch (e) {
    console.error(`\n无法连接 Ollama（${BASE_URL}）：${e.message}`);
    console.error('请先启动 Ollama 服务（桌面版启动后会自动监听 11434），再运行本脚本。');
    console.error('若在受限网络环境中运行，需要放开对本机 127.0.0.1 的访问权限。\n');
    process.exit(1);
  }
  console.log(`Ollama 已连接：${BASE_URL}　本地模型 ${installed.length} 个：${installed.join(', ') || '（空）'}`);

  const hit = installed.find((m) => m === args.model) || installed.find((m) => m.startsWith(args.model));
  if (hit && hit !== args.model) console.log(`使用匹配到的本地模型：${hit}`);
  const model = hit || args.model;
  if (!hit) {
    if (!process.stdin.isTTY && !process.env.ALLOW_PULL) {
      console.error(`\n本地没有 ${args.model}。要自动拉取，请设置环境变量 ALLOW_PULL=1 后重跑，或手动执行：ollama pull ${args.model}`);
      process.exit(2);
    }
    await pullModel(args.model);
  }

  const orch = createOrchestrator({ chat: ollamaChat, model, outDir: args.out, maxStepRetries: args.maxRetries, noThink: args.noThink !== false });

  if (args.probe) {
    console.log('\n[probe] 冒烟测试：跑 1 个完整样本，打印每一步细节\n');
    const rec = await orch.runAgentSample(0, 'known');
    console.log(JSON.stringify(rec.steps, null, 2));
    console.log(`\n合法：${rec.legal ? '是' : '否'}${rec.fallback ? '（已降级）' : ''}　告警：${rec.warnings.join('；') || '无'}　错误：${rec.error || '无'}`);
    return;
  }

  fs.mkdirSync(args.out, { recursive: true });
  const jsonl = path.join(args.out, '原始记录.jsonl');
  fs.writeFileSync(jsonl, '', 'utf8');

  const agentRecs = [];
  const variants = args.chainOnly ? [] : ['known', ...(args.novel ? ['novel'] : []), ...(args.revise ? ['revise'] : []), ...(args.dual ? ['novelB', 'novelBOpen'] : [])];
  const VLABEL = {
    known: '已知实体组（测链路稳定性）',
    novel: '陌生实体对照组（测编造）',
    revise: '写→改闭环组（测丢稿）',
    novelB: '双库隔离组·闸门开（B 库题，测能否拦住借 A 库实体）',
    novelBOpen: '双库隔离组·闸门关（B 库题，对照组，允许跨库污染落盘）',
  };
  for (const variant of variants) {
    const label = VLABEL[variant];
    const nSamp = variant === 'revise' ? Math.min(args.samples, 10) : args.samples;
    console.log(`\nAgent 链路验证 · ${label}：${model} × ${nSamp} 个样本\n`);
    for (let i = 1; i <= nSamp; i++) {
      process.stdout.write(`  [${variant}] 样本 ${String(i).padStart(2)}/${nSamp} …`);
      const rec = await orch.runAgentSample(i, variant);
      // 挂上设定库快照供报表分组统计（内存传递，不写入 jsonl——避免每条记录重复整个设定库）。
      rec.__world = orch.world;
      agentRecs.push(rec);
      const tag = rec.legal ? '合法' : rec.fallback ? (rec.halted_reason ? '停笔' : '降级') : '失败';
      console.log(` ${tag}（重试 ${rec.retries}，告警 ${rec.warnings.length}，${(rec.ms / 1000).toFixed(1)}s）`);
      fs.appendFileSync(jsonl, JSON.stringify({ type: 'agent', model, rec: { ...rec, __world: undefined } }) + '\n', 'utf8');
    }
  }

  const baselines = [];
  const nChain = args.chainOnly ? Math.max(args.chain, 2) : args.chain;
  if (nChain > 0) {
    for (const variant of args.novel ? ['known', 'novel'] : ['known']) {
      console.log(`\n跑 Prompt Chain 基线对照（${variant}）× ${nChain}\n`);
      for (let i = 1; i <= nChain; i++) {
        const b = await orch.runBaselineChain(i, variant);
        baselines.push(b);
        fs.appendFileSync(jsonl, JSON.stringify({ type: 'baseline', model, rec: b }) + '\n', 'utf8');
        console.log(`  基线 ${variant}/${i}：${b.chars} 字${b.no_setting ? '（无设定可依）' : ''}，锚点 ${b.anchors.hit}，${(b.ms / 1000).toFixed(1)}s`);
      }
    }
  }

  const report = buildReport(model, agentRecs, baselines, { temperature: 0.2, noThink: args.noThink !== false, novel: args.novel });
  const rp = path.join(args.out, '报表.md');
  fs.writeFileSync(rp, report, 'utf8');
  console.log(`\n${'-'.repeat(60)}\n${report}\n原始记录：${jsonl}\n报表：${rp}`);
  if (orch.store.chapters.length) console.log(`落盘章节：${orch.store.chapters.map((c) => c.file).join('\n          ')}`);
}

module.exports = {
  TOOLS,
  TOOL_NAMES,
  SEED_CHAPTER_ID,
  SEED_PROTECTIONS,
  SEED_CONTENT,
  createOrchestrator,
  parseToolCall,
  validateCall,
  validateSchema,
  extractJsonCandidates,
  loadWorld,
  resolveWorldPath,
  makeToolImpl,
  fidelity,
  buildReport,
  // 第 3 步：风格层。基线从用户自己的历史正文推导，不含主观词表
  buildProfile,
  checkStyle,
  styleDirective,
  // 检索层的单一真相源：db/store.js 依赖这两个函数保证与内存版行为一致
  scoreEntry,
  QUERY_TOP_K,
  norm,
  suffixVariants,
  // HTTP 客户端：db/verify-e2e.js 复用同一个客户端，保证竖切片与主脚本同一条路径
  ollamaChat,
  BASE_URL,
  CHAT_TIMEOUT_MS,
};

if (require.main === module) main().catch((e) => { console.error(`\n运行失败：${e.stack || e.message}`); process.exit(1); });
