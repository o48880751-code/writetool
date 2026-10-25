/**
 * Electron 主进程。
 *
 * ## 职责边界
 *
 * 主进程是唯一能碰文件系统与 SQLite 的地方。渲染进程（React）只能通过
 * preload 暴露的 `window.api` 调用它——**渲染进程不给 node 集成**，
 * 这是安全底线：模型生成的内容会进入编辑器，如果渲染进程有 fs 权限，
 * 一段恶意的正文就可能读走用户文件。
 *
 * ## 复用已有模块
 *
 * 数据层 / 记忆层 / 编排层都在上一阶段写好且有 174 个用例守护，
 * 这里直接 require，不重写。路径用 `__dirname/../..` 定位项目根。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { FONTS, FONT_DIR, fontById } = require('./font-presets');

/**
 * 自定义字体协议 appfont://。
 *
 * ⚠ 必须在 app ready **之前**注册，且标 privileged（standard + secure +
 * bypassCSP）：否则渲染进程的 @font-face url('appfont://...') 既拿不到文件，
 * 又会被 CSP 的 font-src 拦（默认回退到 default-src 'self'）。
 * 字体文件由主进程下载到 userData/fonts，再用这个协议喂给界面。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'appfont',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

/**
 * 下载文件到本地，带进度回调与重定向跟随。
 * @param {(loaded:number,total:number)=>void} [onProgress]
 */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const run = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) return reject(new Error('字体下载重定向过多'));
          res.resume();
          return run(new URL(res.headers.location, u).href, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`字体下载失败 HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let loaded = 0;
        const ws = fs.createWriteStream(dest);
        res.on('data', (c) => {
          loaded += c.length;
          if (total && onProgress) onProgress(loaded, total);
        });
        res.pipe(ws);
        ws.on('finish', () => resolve(dest));
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('字体下载超时')));
    };
    run(url, 0);
  });
}

// ---- 模块根目录：开发态与打包态路径不同 ----
// 开发：__dirname = app/electron → 上一级就是项目根，db/ memory/ 在那儿
// 打包：db/ memory/ 被复制到 resources/modules（asar 外的 extraResources）
const IS_PACKED = app.isPackaged;
const ROOT = IS_PACKED
  ? path.join(process.resourcesPath, 'modules')
  : path.join(__dirname, '..', '..');

/**
 * 复用已验证的后端模块。
 *
 * 注意：这些模块都在 db/ memory/ 下，用 CJS require。
 * 找不到就直接崩——宁可启动失败也不要「看起来能跑但设定库是空的」。
 *
 * ⚠ 修掉的真 bug：原来第 39 行的 buildProfile/checkStyle/styleDirective
 * **没有加进下面的 let 声明**，靠隐式全局赋值才「能用」。
 * 后果：三个函数泄漏到 globalThis；一旦本文件加上 'use strict'
 * 或构建产物注入严格模式，立刻 ReferenceError → 走 catch → **应用启动即崩**。
 * 缩进也比相邻行多两格，说明这行是后期追加时漏改了声明。
 */
let Store, summarizeBible, applyStateAfterCommit, LoopContextGuard,
    buildProfile, checkStyle, styleDirective,
    ProjectFs, mdParse, mdStat, Trash, versionInfo, validateDownloadUrl,
    // ⚠ provider / presets / secret 必须声明在**这里**（与下面的 require 同一作用域）。
    // 曾经写成「赋值在 try 块里跑、声明留在文件中部（原第 93 行）」：
    // 赋值先执行、`let` 声明在后 → 命中 TDZ：
    //   ReferenceError: Cannot access 'provider' before initialization
    // 表现是装完后双击 exe 弹「main process 出错」，**软件完全打不开**；
    // 而 `node --check` 是通过的 —— TDZ 是运行时错误，不是语法错误。
    // （这条与上面 buildProfile 那次的差别：那次是不声明靠隐式全局侥幸能用，
    //   这次是声明了但位置太靠后，直接崩。）
    provider, presets, secret, agentLoop, toolMod, createApprovalGate,
    connParams;
try {
  ({ Store } = require(path.join(ROOT, 'db', 'store.js')));
  ({ summarizeBible } = require(path.join(ROOT, 'memory', 'context-budget.js')));
  ({ applyStateAfterCommit } = require(path.join(ROOT, 'memory', 'state-writer.js')));
  ({ LoopContextGuard } = require(path.join(ROOT, 'memory', 'loop-guard.js')));
  ({ buildProfile, checkStyle, styleDirective } = require(path.join(ROOT, 'memory', 'style.js')));
  // 这两个在 app/electron/ 里，与本文件同级——不能走 ROOT（打包态指向
  // resources/modules，那里没有 app 的源码）
  ({ ProjectFs } = require('./project-fs.js'));
  ({ parse: mdParse, stat: mdStat } = require('./markdown-render.js'));
  ({ versionInfo, validateDownloadUrl } = require('./version-info.js'));
  ({ Trash } = require('./trash.js'));
  // provider 与 secret-store 是同目录模块，走相对 require ——
  // 打包后它们在 app.asar/electron/ 下，跨目录 require 找不到。
  provider = require('./provider.js');
  secret = require('./secret-store.js');
  presets = require('./provider-presets.js');
  // ⚠ 工具层同理：agent-loop 编排、tools 执行。
  //   agent-loop 里的循环是有 18 条用例钉着的编排逻辑，
  //   不在 main.js 里实现就是为了能脱离 Electron 单测它。
  agentLoop = require('./agent-loop.js');
  toolMod = require('./tools.js');
  ({ createApprovalGate } = require('./approval.js'));
  // 连接级生成参数（窗口 / 输出上限 / 输出预留）的计算规则抽在这里，
  // 与 approval.js 同理：纯函数才好单测，混进 main.js 就只能靠手点验证。
  connParams = require('./conn-params.js');
} catch (e) {
  // 写进日志再崩，日志路径见下方 LOG_PATH 定义
  try {
    fs.writeFileSync(
      path.join(app.getPath('temp'), 'writetool-startup-error.log'),
      `模块加载失败\nROOT=${ROOT}\n${e.message}\n${e.stack}\n`,
      'utf8'
    );
  } catch (_) { /* 路径都拿不到就没什么可做的了 */ }
  throw e;
}

// 用户数据目录：Electron 惯例，放 AppData 而不是安装目录（安装目录可能只读）
const USER_DIR = app.getPath('userData');
const DB_PATH = path.join(USER_DIR, 'writetool.db');
const CONFIG_PATH = path.join(USER_DIR, 'config.json');

let store = null;
let win = null;

/**
 * 项目文件夹管理器。每个项目一个目录。
 *
 * 放在 %APPDATA%/writetool/projects/ 而不是安装目录——安装目录可能只读，
 * 而且软件一升级用户资料就没了。
 */
let pfs = null;

/** 回收站。绑在 pfs 上——两者都是项目文件夹层面的能力 */
let trash = null;


// ---------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------
const DEFAULT_CONFIG = {
  /**
   * AI 提供商。
   *
   * ⚠ engine 只有两个值，不要扩第三个数：
   *   'ollama' —— 原生 Ollama 协议（/api/chat、think 字段）
   *   'openai' —— OpenAI 兼容协议（/v1/chat/completions、SSE）
   *   vLLM / 阿里云百炼 / OpenRouter / DeepSeek 全都走 'openai'，
   *   它们之间的差异只有「思考参数形态」，由 thinkStyle 区分。
   *   加一个新服务商 = 加一个 thinkStyle，不要加一个 engine。
   *
   * base 一律填「到接口之前的根地址」：
   *   Ollama:  http://127.0.0.1:11434
   *   vLLM:    http://127.0.0.1:8000
   *   百炼:     https://dashscope.aliyuncs.com/compatible-mode/v1
   */
  engine: 'ollama',
  base: 'http://127.0.0.1:11434',
  /**
   * OpenAI 兼容系内部的思考参数风格。
   *   'openrouter' → reasoning: {effort}（档位）
   *   'dashscope'  → enable_thinking（布尔，顶层字段）
   *
   * 核实来源见 provider.js 文件头的注释。
   */
  thinkStyle: 'openrouter',
  model: 'qwen3:latest',
  /** 兼容旧配置：老版本只有 ollamaBase */
  ollamaBase: 'http://127.0.0.1:11434',
  /**
   * 上下文窗口（**老字段，仅作迁移兜底**）。
   *
   * ⚠ 2026-10-14 起改为**按连接**存，见 `connParams`。
   *   原因：同一个数在两边含义不同 ——
   *   本地它是 num_ctx（服务端按它分配 KV cache，**真吃显存**），
   *   云端它是"模型窗口有多大"（客户端传不了，只用来算压缩阈值）。
   *   共用一个全局值会出现两种坏情况：
   *     从云端切回本地 → 200000 被当 num_ctx 发出去，Ollama 直接爆显存；
   *     从本地切到云端 → 压缩器把 200K 窗口当 8192 用，
   *     历史被压得只剩两千 token，前文设定全丢。
   *   这两个老字段只在"该连接还没存过参数"时兜底一次。
   */
  numCtx: 8192,
  /**
   * 单次输出上限（max_tokens）。老字段，同上改为按连接存。
   *
   * ⚠ 必须独立于 numCtx。原来它是用 numCtx 推算的（系数 0.5），
   *   于是云端设 8192 只能输出 4096 token ≈ 3000 字中文，
   *   写一章 5000 字的正文会被拦腰截断，而且没有任何提示。
   */
  maxOutput: 8192,
  /**
   * 连接级生成参数：`{ [connectionId]: { numCtx, maxOutput, reserve } }`。
   *
   * 详见 connParamsOf()。不在这里铺开写。
   */
  connParams: {},
  temperature: 0.3,
  /**
   * 思考强度：off | low | medium | high。
   *
   * 默认 off——实测开启后 token 数涨到 4~5 倍，
   * 而写续写正文这类活基本不需要推理。
   * 需要推理的场景（设定推演、人物动机）再手动调高。
   */
  thinkLevel: 'off',
  fontSize: 16,
  fontFamily: 'system-ui',
  theme: 'light',
  notify: 'window',        // window | sound | both | none
  currentProject: null,
  /**
   * 工具总开关。**默认关**。
   *
   * ⚠ 为什么默认关而不是默认开：
   *   开了就等于「模型能在你电脑上跑命令」成为默认行为，
   *   而用户装一个写作软件时并没有预期这件事。
   *   而且早期的小模型极易滥用工具——一句话问十几次，
   *   每次都要人点「允许」，体验反而是坏的。
   *   用户在设置里主动打开，才说明他知道这是什么。
   */
  toolsEnabled: false,
  /**
   * 联网搜索走哪家：'serper' | 'bing'。默认 serper。
   *
   * ⚠ 为什么默认不是 Bing：微软已关闭 Bing Web Search 的**新申请入口**
   *   （Azure Marketplace 上的 Bing Search 资源陆续下线），
   *   个人开发者现在基本拿不到 Key —— 羽毛菌实测就是这个结果。
   *   Serper 注册即可拿免费额度。老的 Bing 实现保留，已配的人不受影响。
   */
  searchProvider: 'serper',
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('[config] 读取失败，用默认值：', e.message);
  }
  return { ...DEFAULT_CONFIG };
}

let config = loadConfig();

function saveConfig(patch) {
  config = { ...config, ...patch };
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

/**
 * ⚠ 参数的计算规则（默认值、预留怎么算、怎么按连接隔离）
 *   全在 `./conn-params.js` —— 纯函数，有独立单测（test-conn-params.js）。
 *   写在这里就只能靠手点界面验证，而"换个连接会不会串味"手点是验不出来的。
 */

/**
 * 取某条连接的生成参数。
 *
 * ## 为什么按连接存，而不是一个全局值
 *
 * `numCtx` 这个数在两边的**含义不同**：
 *   - 本地（Ollama / vLLM）：它是 `num_ctx`，会发给服务端让它按这个值
 *     分配 KV cache —— **真吃显存**。给大了直接 OOM。
 *   - 云端：客户端根本传不了它，它的唯一用途是告诉**上下文压缩器**
 *     "这个模型的窗口有多大"，好算出该在什么时候丢历史。
 *
 * 共用一个全局值会坏在两个方向：
 *   从云端切回本地 → 200000 被当 num_ctx 发出去，Ollama 爆显存；
 *   从本地切到云端 → 压缩器把 200K 窗口当 8192 用，历史压到只剩两千 token，
 *   写长篇时表现为"写着写着忘了开头的设定"。
 *
 * ## 输出预留为什么必须存在
 *
 * Anthropic 官方文档明确：**input + max_tokens 共享同一个 context window**。
 *   - 输入本身就超窗 → 每次请求都 400 `invalid_request_error`（"prompt is too long"）
 *   - Claude 4.5+ → 请求被接受，但生成到窗口上限时**停下**，
 *     `stop_reason: "model_context_window_exceeded"`
 * 用户看到的是"写了一半突然没了"。所以窗口必须切一块给输出。
 *
 * 默认取 maxOutput 的一半而非全量：maxOutput 是**上限**，实际输出通常远小于它，
 * 按上限预留等于每次都白扔一半窗口。（主流客户端也这么取，比如 32K 输出配 16K 预留。）
 * 用户可以在设置里自己填，填了就按他的来。
 *
 * @param {string} connId
 * @returns {{numCtx:number, maxOutput:number, reserve:number, autoReserve:number, reserveAuto:boolean}}
 */
function connParamsOf(connId) {
  const all = (config.connParams && typeof config.connParams === 'object') ? config.connParams : {};
  // 计算规则在 conn-params.js（纯函数，可单测）。这里只负责取到该连接那份，
  // 并把迁移前的老字段作为兜底传进去。
  return connParams.resolveConnParams(connId ? all[connId] : null, {
    numCtx: config.numCtx,
    maxOutput: config.maxOutput,
  });
}

/**
 * 写入某条连接的生成参数。
 * @param {string} connId
 * @param {object} patch { numCtx?, maxOutput?, reserve? }
 */
function setConnParams(connId, patch = {}) {
  if (!connId) return { ok: false, error: '没有指定连接' };
  const r = connParams.applyConnParams(config.connParams || {}, connId, patch);
  if (!r.ok) return r;
  saveConfig({ connParams: r.all });
  return { ok: true, params: connParamsOf(connId) };
}

// ---------------------------------------------------------------
// Ollama 客户端（流式）
// ---------------------------------------------------------------

/** 检查 Ollama 是否在线，返回 {ok, version, models} */
function checkOllama() {
  return new Promise((resolve) => {
    const req = http.request(
      `${config.ollamaBase}/api/version`,
      { method: 'GET', timeout: 3000 },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', async () => {
          try {
            const version = JSON.parse(body).version;
            const models = await listModels();
            resolve({ ok: true, version, models });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: `连不上 Ollama（${e.message}）。请确认已启动 ollama serve。` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Ollama 响应超时' }); });
    req.end();
  });
}

function listModels() {
  return new Promise((resolve) => {
    const req = http.request(
      `${config.ollamaBase}/api/tags`,
      { method: 'GET', timeout: 3000 },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve((j.models || []).map((m) => m.name));
          } catch (e) { resolve([]); }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

/**
 * 流式生成：把 Ollama 的 NDJSON 逐块推到渲染进程。
 *
 * 用普通 http 模块而不是 fetch，是为了能精确控制超时与中止——
 * 生成一章可能跑几分钟，用户随时要能点停。
 */
/**
 * @param {function} onThink 思考过程的分片。**与正文严格分开**
 * @param {function} onChunk 正文分片
 *
 * ⚠ 为什么必须分开：实测 Ollama 0.40.2 + qwen3，开启 think 后
 *   流式响应里**只有 thinking 字段，content 一片都没有**
 *   （297 个分片全是 thinking）。第一版只读 content，
 *   于是开思考 = 编辑器里一个字都不出现，而界面还在转圈。
 *
 *   而且思考绝不能混进正文——它是模型的内部推理，
 *   落到编辑器里就是用户的稿子里多出一段"嗯，用户让我写…"。
 */
/**
 * 流式生成。走 provider 适配层，不自己拼协议。
 *
 * ## 为什么把原来那 80 行删掉
 *
 * 原实现里写死了三件事，缺一件就换一个提供商就崩：
 *   1. 端点 `${config.ollamaBase}/api/chat`
 *   2. 每行是裸 JSON（OpenAI 兼容是 SSE，前面有 `data: `）
 *   3. token 数读 `prompt_eval_count` / `eval_count`
 * 而幂等保护、思考分片分离这些真正要紧的逻辑，
 * 现在由 provider.chatStream 统一承担并已被 41 条用例覆盖。
 *
 * @returns {function():void} 取消函数
 */
function streamGenerate(payload, onChunk, onDone, onError, onThink) {
  const cfg = providerConfig({
    model: payload.model,
    temperature: payload.temperature,
    // 本次生成的档位优先。conv:send 已经把它解析成最终值，
    // 这里只做透传——不解析，避免"优先级规则有两个地方实现"。
    thinkLevel: payload.thinkLevel,
  });
  return provider.chatStream(cfg, payload.messages || [], {
    onChunk,
    onThink,
    onDone: (meta) => onDone(meta || null),
    onError,
  });
}

/**
 * 从 config 组装 provider 需要的配置。
 *
 * ⚠ 密钥在这里注入，而且**只在内存里**。
 *   返回的对象可能被别处 JSON.stringify 后写进日志——
 *   所以下面刻意不把它挂在 config 上（config 会进 debugLog）。
 */
/**
 * 这条连接该用哪种思考参数形态。
 *
 * ⚠ 形态记在量表里（provider-presets.js 的 think.thinkStyle），
 *   不是全局设置。多连接下用户可能一条百炼、一条智谱：
 *   百炼要 enable_thinking（顶层布尔），智谱要 thinking.type（对象）。
 *   共用一个全局值的话，切到百炼发出去的还是 reasoning.effort ——
 *   服务端不认，而界面上完全看不出来（按钮有反馈、不报错）。
 *
 * 认不出（自定义连接、量表还没加载）就返回空串，由调用方退回全局设置。
 */
function thinkStyleOf(c) {
  if (!c) return '';
  const p = presets.get(c.providerKey);
  return (p && p.think && p.think.thinkStyle) || '';
}

/**
 * ⚠⚠ `config` 里的 engine/base/thinkStyle 是**老字段**（迁移前留下的），
 * 与"当前连接"是两套东西。一旦 activeConnectionId 指到别处，
 * 界面显示云端连接、实际发的却是老字段里那个本地地址——
 * 用户看着满头雾水（羽毛菌 2026-10-13 报「本地模型连不上」）。
 *
 * 所以：**有连接就以连接为准**；只有"一条连接都没有"的老用户
 * 才退回老字段。三个字段各自的理由见下面的注释。
 */
function providerConfig(over = {}) {
  // ⚠ 优先用指定的连接；没指定就用 config 里的当前连接。
  //   拿不到连接（首次启动还没 seed）时退回老配置字段 ——
  //   迁移前的老用户不该因为"connections 表是空的"就发不出请求。
  const c = over.connection || store.getConnection(config.activeConnectionId);
  const fallbackProto = config.engine === 'openai' ? 'openai' : 'ollama';
  /**
   * ⚠ 窗口与输出上限**按连接取**，不用 config.numCtx / config.maxOutput。
   *   那两个是迁移前留下的全局字段，只在"这条连接还没存过参数"时兜底一次。
   *   详见 connParamsOf() 的注释。
   */
  const cp = connParamsOf(c ? c.id : null);
  /**
   * ⚠⚠ 模型列表 / 对话路径**按连接取预置表里的 modelsPath / chatPath**
   * （2026-10-14 修「硅基流动接入不行」）。
   *
   * 之前 provider.js 把这两个路径写死成 `/v1/models`、`/v1/chat/completions`，
   * 而硅基流动等预置的 base 已经带 `/v1`
   * （`https://api.siliconflow.cn/v1`），拼出来变成 `/v1/v1/...` 全 404。
   * 现在从这里把每家正确的路径透传给 provider 层，不再写死。
   *
   * 老连接 / 自定义连接没有 providerKey 时，按引擎给兜底默认；
   * 自定义 OpenAI 兼容若 base 自己带了 `/v1`，界面上填的就是完整地址，
   * 那种情况兜底 `/v1/chat/completions` 会双版本——但自定义预置本身
   * 已经声明了 chatPath，所以正常不会走到兜底。
   */
  const preset = (c && c.providerKey) ? presets.get(c.providerKey) : null;
  const proto = c ? c.protocol : fallbackProto;
  const modelsPath = (preset && preset.modelsPath)
    || (proto === 'ollama' ? '/api/tags' : proto === 'anthropic' ? '/v1/models' : '/models');
  const chatPath = (preset && preset.chatPath)
    || (proto === 'anthropic' ? '/v1/messages' : proto === 'ollama' ? '/api/chat' : '/v1/chat/completions');
  return {
    engine: proto,
    base: String(
      (over.base != null ? over.base : (c ? c.base : config.base))
      || config.ollamaBase || ''
    ).replace(/\/+$/, ''),
    model: over.model != null
      ? over.model
      : (c ? c.model : config.model),
    apiKey: secret.load(c ? c.id : null),
    modelsPath,
    chatPath,
    // ⚠ 输出上限必须单独传（不靠 numCtx 推算），否则云端会被本地那个
    //   "省显存"的 8192 压成 4096 token ≈ 3000 字，长章节直接被截断。
    numCtx: cp.numCtx,
    maxOutput: cp.maxOutput,
    reserve: cp.reserve,
    // 本次生成的临时温度优先（调用方可能传了 temperature），
    // 否则用全局设置。null 与 undefined 都要退回全局值。
    temperature: over.temperature == null ? config.temperature : over.temperature,
    // 思考强度的三级优先：本次调用 > 全局默认。
    // 对话级的值由 conv:send 解析后放在 over.thinkLevel 里传进来——
    // 这一层不认识"对话"，硬塞进来会多一条通往数据库的依赖。
    //
    // ⚠ 判据用 `!= null` 而不是 `?`：
    //   档位的合法值里 'off' 是**真值**，但空串 '' 也是合法值（=跟随默认）。
    //   写成 `over.thinkLevel ? ... : ...` 的话，
    //   用户显式选的 "" 会被当成"没给"，退回全局——
    //   表现是"我明明选了关闭，它还是开着"。
    thinkLevel: over.thinkLevel != null ? over.thinkLevel : (config.thinkLevel || 'off'),
    /**
     * ⚠⚠ **有连接时绝不能退回 config.thinkStyle**（2026-10-13 修）。
     *
     * 现场：config.thinkStyle 停在 'openrouter'（上一条 OpenRouter 连接留下的），
     * 而当前连接是 Ollama。thinkStyleOf(Ollama) 返回空串（Ollama 走 think 字段，
     * 不看 thinkStyle），于是 `'' || 'openrouter'` → **o llama 请求被打上了
     * openrouter 的思考形态**。
     *
     * 后果不只是"参数不对"：engine='ollama' 时 buildThinkParams
     * 根本不看 thinkStyle，所以**探测能过、生成时才炸**——
     * 用户看到的正是「探测说连上了，发消息却连不上/报错」。
     *
     * 修法：thinkStyle 是**连接级**属性（和 think.thinkStyle 一样在量表里），
     * 不是全局设置。老的 config.thinkStyle 只在"一条连接都没有"时兜底。
     */
    thinkStyle: c
      ? (thinkStyleOf(c) || 'openrouter')
      : (config.thinkStyle || 'openrouter'),
    includeUsage: config.includeUsage !== false,
    /** 墙钟上限。开思考时给得更长（实测 thinking 949~1347 字） */
    wallClockMs: Number(config.wallClockMs) || 0,
  };
}

let activeRequest = null;
/** 本次生成累计的正文：风格检测需要完整文本，不能只看最后一个分片 */
let streamedText = '';
/**
 * 思考内容单独累加。
 *
 * ⚠ 它**绝不进 streamedText**——落库、风格检测、落盘校验全都只该看到正文。
 * 思考混进去的话，用户的对话记录里会出现「嗯，用户让我写…」这种内容。
 */
let streamedThink = '';
/** 本次生成使用的风格画像（无基准时为 null） */
let activeProfile = null;

// ---------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------
function createWindow() {
  log('createWindow 开始');
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#faf9f7',
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 安全底线：渲染进程不给 node 集成
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  // 不等 ready-to-show：软件渲染下它可能不触发（实测窗口一直隐藏）。
  // did-finish-load 后直接显示，再加一个兜底定时器防止极端情况下不显示。
  // 渲染进程的 console 与崩溃都要透出来，否则前端报错在终端里完全看不见
  /**
 * 渲染进程日志透出。
 *
 * ⚠ 修掉的真 bug（可观测性失效）：原来用旧签名
 *   `(_e, level, message, line, sourceId)`
 * 但本项目是 **Electron 44.7**，该事件签名已改为
 *   `(event: Event, messageDetails: MessageDetails)`
 * MessageDetails 的字段是 `message / versionId / source / level / sourceUrl / lineNumber`，
 * **没有 `line`，没有 `sourceId`**。
 * 于是解构结果 level=MessageDetails 对象、message/line/sourceId 全是 undefined，
 * 日志变成 `renderer:[object Object] undefined (undefined:undefined)`——
 * 而文件头写着「调试期靠这个文件；出问题先看它」，
 * 结果**渲染进程的所有报错在日志里都是无意义的 [object Object]**。
 */
  // 用 function 而非箭头函数：需要 arguments 来兼容旧签名
  win.webContents.on('console-message', function (_e, details, legacyMessage, legacyLine, legacySourceId) {
    // 兼容两种签名：Electron ≥37 传 MessageDetails，旧版传分离参数
    const d = details && typeof details === 'object' && 'message' in details
      ? details
      : {
          level: details,
          message: legacyMessage,
          lineNumber: legacyLine,
          sourceUrl: legacySourceId,
        };
    const lv = typeof d.level === 'number'
      ? (['debug', 'info', 'warning', 'error'][d.level] || d.level)
      : d.level;
    const file = d.sourceUrl ? String(d.sourceUrl).split('/').pop() : '';
    const loc = file ? ` (${file}:${d.lineNumber})` : '';
    log(`renderer:${lv} ${d.message}${loc}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`渲染进程加载失败 ${code} ${desc} ${url}`);
  });
  win.webContents.on('preload-error', (_e, p2, err) => {
    log(`preload 失败 ${p2}: ${err.message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`渲染进程崩溃: ${JSON.stringify(details)}`);
    // 渲染进程没了，还在跑的流式请求就成了孤儿：
    // 它会继续往一个已销毁的窗口 send，且 streamedText 一直累加不重置。
    cleanupActiveGeneration();
  });

  // 窗口关闭时中止在跑的生成并清理共享状态。
  // macOS 上 window-all-closed 不退出 app，窗口可以重开——
  // 不清理的话主进程会带着上一次的状态继续跑。
  win.on('closed', () => {
    cleanupActiveGeneration();
    win = null;
  });

  /**
   * ⚠ 窗口可用性必须在建窗之后刷新。
   *
   * 审批闸门在模块加载时就建好了，那时 win 还是 null。
   * 不刷新的话 available 永远是建窗前算出来的那个值——
   * 而它决定「危险命令是弹窗问用户，还是直接拒绝」。
   */
  if (typeof refreshApprovalAvailability === 'function') refreshApprovalAvailability();

  win.webContents.on('did-finish-load', async () => {
    win.show();
    log('渲染进程已加载，窗口显示');
    // 自检截图：把渲染结果落盘，用于确认界面真的画出来了
    if (process.env.WRITETOOL_SHOT) {
      /**
       * 等界面真的渲染完再截图，而不是固定延时。
       *
       * ⚠ 之前是 setTimeout 2500。四栏版之后 React 要先等 config:get
       *   与 project.list 两个 IPC 往返才退出「加载中…」，
       *   2.5 秒偶尔不够——截出来是一张「加载中…」的空白页，
       *   看起来像界面坏了。
       *
       *   判据：主工作区容器（data-pane="main"）挂上就是渲染完成。
       *   最多等 8 秒，超时也截（至少能看到当前状态，比不截有用）。
       */
      const started = Date.now();
      const shoot = async () => {
        const elapsed = Date.now() - started;
        let ready = false;
        try {
          /**
           * 判据：`#root` 里已经有内容，且不含「加载中」。
           *
           * ⚠⚠⚠⚠ 连错四次，全表现为"截出一张加载中的空白页"：
           *   ① `.ProseMirror` —— TipTap 编辑器，只在「正文编辑」标签挂载，
           *      主区默认停在「对话」标签 → 永远等不到。
           *   ② `[data-pane="files"] input` —— 文件树搜索框，空项目时也在。
           *   ③ `header select || 找按钮` —— 那个分支里根本没有 header，
           *      表达式恒为 false，却仍判定为"已完成"。
           *   ④ `document.body.innerText` —— ★ **innerText 依赖布局**，
           *      而这个窗口是 `show: false`（无头环境没有显示器），
           *      没布局时 innerText 返回**空字符串**，
           *      于是 `indexOf('加载中') === -1` 恒成立，600ms 就判定完成。
           *
           * textContent 不依赖布局，是这里唯一可靠的取值方式。
           *
           * 教训：**判据本身也要能被证伪**。
           * 前三次都"看起来对"，实际从没验证过它在"未完成"时返回 false。
           */
          const has = await win.webContents.executeJavaScript(
            '(function () {' +
            '  var r = document.getElementById("root");' +
            '  if (!r || !r.children.length) return false;' +
            '  var t = r.textContent || "";' +
            '  return t.length > 0 && t.indexOf("加载中") === -1;' +
            '})()'
          );
          ready = has === true;
        } catch (_) { ready = false; }
        if (!ready && elapsed < 8000) {
          setTimeout(shoot, 300);
          return;
        }
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.WRITETOOL_SHOT, img.toPNG());
          log(`截图已保存 ${process.env.WRITETOOL_SHOT}（等待 ${elapsed}ms，渲染${ready ? '已完成' : '未完成'}）`);
        } catch (e) { log('截图失败', e.message); }
        app.quit();
      };
      setTimeout(shoot, 600);
    }
  });
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
      log('兜底显示窗口');
    }
  }, 3000);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const target = devUrl || path.join(__dirname, '..', 'dist', 'index.html');
  log('准备加载：', target);
  try {
    if (devUrl) win.loadURL(devUrl);
    else win.loadFile(target);
    log('load 调用已发出');
  } catch (e) {
    log('load 调用抛异常：', e.message);
  }

  log('BrowserWindow 已创建');

  // 外部链接走系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---- 文件日志 ----
// Windows 上 Electron 是 GUI 子系统，stdout 常常不可见（实测 console.log 无输出）。
// 调试期靠这个文件；出问题先看它，不要猜。
const LOG_PATH = path.join(app.getPath('temp'), 'writetool-debug.log');
function log(...args) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${args.join(' ')}\n`, 'utf8');
  } catch (e) { /* 日志失败不能影响主流程 */ }
}

// ---- Chromium 运行参数 ----
//
// 必须在 app ready 之前设置，否则不生效。
//
// 实测过程（无显示器/沙箱环境）：只调 disableHardwareAcceleration 仍会卡死——
// loadFile 之后 did-finish-load 与 did-fail-load 都不触发，渲染进程根本没起来。
// 逐个加开关后 `in-process-gpu` 是让渲染进程活过来的关键（GPU 独立进程起不来）。
//
// 写作工具不需要 GPU——所有计算都在 Ollama 本地做，
// 代价只是滚动稍慢，换来「在任何机器上都能起」更重要。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');
log('main.js 已加载，Electron', process.versions.electron);

app.whenReady().then(async () => {
  fs.mkdirSync(USER_DIR, { recursive: true });
  store = new Store(DB_PATH);
  pfs = new ProjectFs(path.join(USER_DIR, 'projects'));
  trash = new Trash(pfs);
  fs.mkdirSync(pfs.root, { recursive: true });

  /**
   * 密钥加密能力检测。
   *
   * ⚠ 必须在 app ready 之后调：safeStorage 在 ready 之前不可用，
   *   直接调会抛。检测结果决定了密钥是落盘（加密）还是只在内存里，
   *   界面上要如实告知用户——"填了就是存好了"这句话只在真加密时成立。
   */
  secret.init();

  /**
   * 把 secret-store 接到数据库上。
   *
   * ⚠ 必须在任何存/取密钥之前。少了这一步，
   *   secret.save 会静默返回「缺少连接标识」——
   *   而界面上按钮照常点、也没报错，用户以为存好了。
   */
  secret.bind(
    (id) => store.getConnectionSecret(id),
    (id, enc) => store.setConnectionSecret(id, enc)
  );

  /**
   * 服务级密钥（联网搜索等）接到**另一张表**。
   *
   * ⚠ 不能复用上面那条：connection_secrets 的 connection_id 有外键，
   *   而服务级密钥不属于任何连接，写进去会被数据库拒绝。
   */
  secret.bindService(
    (provider) => store.getServiceSecret(provider),
    (provider, enc) => store.setServiceSecret(provider, enc)
  );

  /**
   * 字体目录 + 自定义协议。
   *
   * 开源字体文件大（5~20MB），且 CSP 禁止渲染进程直接联网，
   * 所以下载在主进程完成，落到 userData/fonts，再用 appfont:// 喂给界面。
   * 协议处理用标准 Response（Electron 主进程全局可用），
   * 路径做了越界校验——只能读 fontsDir 内的文件。
   */
  const fontsDir = path.join(app.getPath('userData'), FONT_DIR);
  fs.mkdirSync(fontsDir, { recursive: true });
  const MIME_BY_EXT = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.woff': 'font/woff' };
  protocol.handle('appfont', (request) => {
    try {
      const u = new URL(request.url);
      // ⚠ 关键：appfont://Iansui.ttf 这种写法里 Iansui.ttf 会被 URL 解析器当成
      // **host**（pathname 是 '/'），不是 path。若只用 pathname 取文件名会拿到空串、
      // 把字体目录当文件读 → 404、字体永远加载不出来。
      // 所以 host 形式（appfont://file.ttf）与 path 形式（appfont:///file.ttf）都兼容。
      const raw = (u.pathname && u.pathname !== '/' && u.pathname !== '')
        ? u.pathname
        : u.hostname;
      const name = path.basename(decodeURIComponent(raw));
      const fp = path.join(fontsDir, name);
      if (!fp.startsWith(fontsDir + path.sep)) return new Response('forbidden', { status: 403 });
      const buf = fs.readFileSync(fp);
      const ct = MIME_BY_EXT[path.extname(fp).toLowerCase()] || 'application/octet-stream';
      return new Response(buf, { headers: { 'content-type': ct, 'access-control-allow-origin': '*' } });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });

  if (!secret.isEncrypted()) {
    log('系统凭据服务不可用：API 密钥将只保存在本次运行中，重启后需重填。');
  }

  /**
   * 配置迁移：老版本只有 ollamaBase。
   * ⚠ 幂等——新字段已有值就不动，用户手改过的地址不能被覆盖。
   */
  if (config.base == null && config.ollamaBase) {
    saveConfig({ base: config.ollamaBase });
  }
  if (config.engine == null) saveConfig({ engine: 'ollama' });

  /**
   * 连接迁移（2026-10-12）。
   *
   * 老配置是"全局一条"：engine + base + model + apiKeyEnc。
   * 新结构是 connections 表。这里把老的搬成第一条连接，
   * **连密钥一起搬**——否则升级后用户的 API 密钥凭空消失，
   * 而界面上只显示"未填写"，他不会想到是升级导致的。
   *
   * 幂等：connections 表非空就说明迁过了（或用户自己建过）。
   */
  try {
    migrateToConnections();
  } catch (e) {
    log('连接迁移失败（不影响使用，会退回老配置）：', e.message);
  }

  // 内置技能（续写正文 / 写对白 / 润色改写…），供输入框 @ 引用。
  // 幂等：已存在则跳过，启动时不会重复写库。
  try {
    // ⚠ 传 loadBuiltin：目录式技能的正文在磁盘上，不在 JS 里。
    //   少传这个参数会让两个目录式技能抛「目录读不到」——
    //   抛出来比静默跳过好：静默跳过的话开发态一切正常，
    //   用户却发现「技能列表里没有这两个」。
    // ⚠ 把解析器交给 store：打包后 db 与 app.asar 不在同一个相对位置，
    //   store 自己 require 会找不到（见 store.js 里那段注释）。
    store.setSkillFormat(skillFormat);
    const bs = require(path.join(__dirname, '..', '..', 'db', 'builtin-skills.js'));
    const r = store.seedBuiltinSkills(bs.loadBuiltin);
    log(`内置技能就绪：新装 ${r.seeded} 个（已有 ${r.skipped} 个），`
      + `配套文件 ${r.files} 个`);
  } catch (e) {
    log('内置技能初始化失败：', e.message);
  }

  buildMenu();
  createWindow();
  log('数据库：', DB_PATH);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * 应用菜单栏（全中文）。
 *
 * 不设这一项时 Electron 用默认英文菜单（File / Edit / View / Window），
 * 中文界面里非常突兀——用户截图时就标出来了。
 *
 * 角色名留空表示不给「窗口」和「帮助」加默认子项，
 * 但自己加的应用相关项（如「重载」「开发者工具」「关于」）要显式写出来。
 */
function buildMenu() {
  const { Menu, shell, dialog } = require('electron');
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: 'WriteTool',
      submenu: [
        { role: 'about', label: '关于 WriteTool' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '新建项目',
          accelerator: 'CmdOrCtrl+N',
          click: () => win && win.webContents.send('menu:action', 'new-project'),
        },
        {
          label: '新建对话',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => win && win.webContents.send('menu:action', 'new-conversation'),
        },
        { type: 'separator' },
        {
          label: '保存章节',
          accelerator: 'CmdOrCtrl+S',
          click: () => win && win.webContents.send('menu:action', 'save-chapter'),
        },
        {
          label: '导入设定库…',
          click: () => win && win.webContents.send('menu:action', 'import-bible'),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { role: 'find', label: '查找' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', click: () => win && win.reloadIgnoringCache() },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }]
          : [{ role: 'close', label: '关闭' }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------
// IPC：全部能力在这里挂出去
// ---------------------------------------------------------------

/** 统一包一层，避免渲染进程到处 try/catch */
const handle = (channel, fn) => {
  ipcMain.handle(channel, async (_evt, payload) => {
    try {
      return { ok: true, data: await fn(payload) };
    } catch (e) {
      console.error(`[ipc:${channel}]`, e);
      return { ok: false, error: e.message, stack: e.stack };
    }
  });
};

// ---- 配置 ----
/**
 * 读配置。**剥掉密钥相关字段**。
 *
 * ⚠ 安全：config 里存着 apiKeyEnc（safeStorage 密文）。
 *   它不是明文，但一旦交给渲染进程，就等于给了它一条
 *   「把密文传出去 → 在自己的进程里解密」的路径
 *   （渲染进程拿不到 safeStorage，但拿到密文就已经不是好事）。
 *   密钥只能通过 provider:keyStatus 拿到**脱敏后**的状态。
 */
handle('config:get', () => publicConfig());

/**
 * 给渲染进程看的配置：剔除密钥相关字段。
 *
 * ⚠ 这里用的是**解构剔除**而不是逐字段挑选。
 *   两种做法我选了前者，理由与代价都写在这：
 *
 *   逐字段挑选（白名单）更安全 —— 以后新增的敏感字段自动挡在外面。
 *   但 config 里有三十来个字段（字号、主题、模型、思考强度、笔名…），
 *   白名单意味着新增一个设置就得同步改这里，漏一个的表现是
 *   「那个设置界面里改了没反应」，排查起来比密钥泄露还费劲。
 *
 *   解构剔除的代价是：以后加一个叫 apiToken / secretKey / password
 *   的字段而忘了加进这个解构，它就会漏出去。
 *   → 代价由下面的测试钉住：扫 main.js 里所有 handle 返回 config 的地方。
 */
function publicConfig() {
  const { apiKeyEnc, apiKey, apiKeyMemory, ...rest } = config;
  return rest;
}

/**
 * 改配置。**挡掉密钥字段**。
 *
 * ⚠ 否则渲染进程可以往 config 里塞 apiKeyEnc，
 *   覆盖掉用户自己存的密钥——那既是安全问题也是数据丢失。
 *   密钥只能走 provider:setKey。
 */
handle('config:set', (patch) => {
  const p = { ...(patch || {}) };
  delete p.apiKeyEnc;
  delete p.apiKey;
  delete p.apiKeyMemory;
  return saveConfig(p);
});

// ---------------------------------------------------------------
// AI 提供商（多连接）
// ---------------------------------------------------------------

/**
 * 把老配置的「全局一条连接」搬成 connections 表里的第一条。
 *
 * ## 幂等
 *
 * 判据是 connections 表非空。表非空意味着「迁过了」或「用户自己建过」，
 * 两种情况都不该再动 —— 往表里塞一条重复的 Ollama，
 * 用户会看到两条几乎一样的连接，而且不知道哪条是哪个。
 *
 * ## 密钥一起搬
 *
 * 这是迁移里最容易漏的一步。老密文在 config.apiKeyEnc，
 * 新的按连接 id 存在 connection_secrets 表里。漏搬的后果：
 * 用户升级后密钥「凭空消失」，界面上只写「未填写」，
 * 他完全不会想到是自己升级导致的 —— 这种问题会变成一堆投诉。
 *
 * ⚠ 搬完**不删 config.apiKeyEnc**：留在那儿当备份。
 *   万一 connections 表出问题，回退路径还在。
 *   代价是密文多存一份，但它永远不会经 IPC 出去。
 *
 * ## 协议识别
 *
 * 老配置只有 engine（ollama/openai）没有协议，
 * 用 base 反查量表。能认出是哪家就按那家的协议走，
 * 认不出就按老 engine 走 —— 保持行为不变，不擅自「修正」。
 */
function migrateToConnections() {
  if (store.listConnections().length > 0) return 0;

  const base = String(config.base || config.ollamaBase || '').replace(/\/+$/, '');
  const guessKey = presets.guessByBase(base);
  const preset = presets.get(guessKey);

  const engine = config.engine === 'openai' ? 'openai' : 'ollama';
  // ⚠ 反查认出是某家云服务时用它的协议；认出本地或认不出，
  //   都按老 engine 走，保持原有行为。
  const known = guessKey && guessKey !== 'custom-openai';
  const protocol = known ? preset.protocol : engine;
  const realBase = base || (protocol === 'ollama' ? 'http://127.0.0.1:11434' : '');

  const id = 'conn-migrated';
  store.createConnection({
    id,
    name: known ? preset.name : '原来的连接',
    protocol,
    providerKey: guessKey || 'custom-openai',
    base: realBase,
    model: String(config.model || ''),
    needKey: protocol !== 'ollama',
  });

  const enc = config.apiKeyEnc;
  if (enc) {
    try {
      store.setConnectionSecret(id, enc);
      log('已将旧配置的 API 密钥迁移到新结构。');
    } catch (e) {
      log('密钥迁移失败（密钥仍在旧位置，可手动重填）：', e.message);
    }
  }

  saveConfig({ activeConnectionId: id });
  log(`连接已迁移：${store.getConnection(id).name}（${protocol}）`);
  return 1;
}


/**
 * 设置里能选的服务商清单。
 *
 * ⚠ 直接返回 provider-presets.js 的内容，界面不写死任何一家的地址。
 *   硬编码在界面里的后果很具体：换服务商要改前端代码，
 *   而前端改了要重新构建才生效——用户看到的还是旧地址。
 */
handle('provider:capabilities', () => ({
  providers: presets.PROVIDERS,
  customs: presets.customs().map((c) => c.key),
}));

// ---- 连接（多连接）----

handle('provider:listConnections', () => store.listConnections());

/**
 * 当前连接的生成参数：窗口 / 输出上限 / 输出预留。
 *
 * ⚠ 返回体里带 `isLocal`，让界面自己决定文案 ——
 *   同一个"上下文窗口"在本地是"吃多少显存"、在云端是"模型窗口多大"，
 *   提示语必须不一样，否则用户不知道填多大。
 */
handle('provider:connParams', ({ connectionId } = {}) => {
  const id = connectionId || config.activeConnectionId;
  const c = store.getConnection(id);
  return {
    connectionId: c ? c.id : null,
    isLocal: c ? c.protocol === 'ollama' : false,
    connName: c ? c.name : '',
    ...connParamsOf(c ? c.id : null),
  };
});

/**
 * 写入连接级生成参数。
 *
 * ⚠ 走的是内层信封（返回 {ok:false, error} 也算 IPC 成功），
 *   与 provider:deleteConnection 一致：外层表示"IPC 通没通"，
 *   内层表示"业务上接不接受"。
 */
handle('provider:setConnParams', ({ connectionId, ...patch } = {}) => {
  const id = connectionId || config.activeConnectionId;
  return setConnParams(id, patch);
});

handle('provider:createConnection', (p = {}) => {
  const proto = ['ollama', 'openai', 'anthropic'].includes(p.protocol)
    ? p.protocol : 'openai';
  const preset = presets.get(p.providerKey);
  return store.createConnection({
    id: p.id || `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: p.name || preset.name,
    protocol: p.protocol ? proto : preset.protocol,
    providerKey: p.providerKey || 'custom-openai',
    base: p.base != null ? p.base : preset.base,
    model: p.model || '',
    needKey: p.needKey != null ? p.needKey : preset.needKey,
  });
});

handle('provider:updateConnection', ({ id, ...patch }) => store.updateConnection(id, patch));

handle('provider:deleteConnection', ({ id }) => {
  // ⚠ 至少留一条。全删了界面就没法用了，而且用户没法自己恢复。
  if (store.listConnections().length <= 1) {
    return { ok: false, error: '至少要保留一条连接' };
  }
  secret.forget(id);
  return { ok: !!store.deleteConnection(id) };
});

/**
 * 切换当前用的连接。
 *
 * ⚠ 切换时要把 model 一起存进 config：同一家的不同模型差别很大，
 *   切过去就换模型会让用户正在写的对话"莫名其妙换了个脑子"。
 *   界面上切连接时如果明确提示了，那另说；目前是静默切换，
 *   所以模型跟着连接走。
 */
handle('provider:activate', ({ id }) => {
  const c = store.getConnection(id);
  if (!c) return { ok: false, error: '连接不存在' };
  // 换连接 → 内存里的旧明文密钥作废（下一个连接未必用同一个 key）
  secret.forget(id);
  /**
   * ⚠ 同时把老字段（engine / base / model）**同步**成新连接的值（2026-10-13）。
   *
   * 老字段是迁移前留下的，现在只作为"一条连接都没有"时的兜底——
   * 但它们还散落在别处被读：旧通道 ollama:check、版本检查页、
   * 以及 providerConfig 里的 fallback。留着不同步的后果很具体：
   *
   *   用户从 DeepSeek 切回本地 Ollama →
   *     activeConnectionId 指向 Ollama（对）
   *     engine 仍停在 'ollama'、base 仍是本地地址（碰巧也对）
   *   再切到某个 OpenAI 兼容的云服务 →
   *     engine 变成 'openai'，base 仍是 http://127.0.0.1:11434（错了）
   *
   * 而 config.thinkStyle 那次就是这么留在 'openrouter' 的——
   * 之后切回 Ollama，Ollama 请求被打上了 openrouter 的思考形态。
   *
   * 同步它们是"让兜底路径也指向当前连接"，不是修正历史。
   */
  saveConfig({
    activeConnectionId: id,
    model: c.model,
    engine: c.protocol === 'openai' ? 'openai' : c.protocol,
    base: c.base,
    // ollamaBase 只在协议是 ollama 时有意义
    ...(c.protocol === 'ollama' ? { ollamaBase: c.base } : {}),
    /**
     * ⚠ thinkStyle 要**清掉**，不能"同步成当前连接的"。
     *
     * 它不是"当前用什么形态"这个语义，而是"兜底时用什么形态"——
     * 而兜底只在没有连接时才发生（见 providerConfig 的注释）。
     * 一条连接都没有的时候，本来就无所谓哪个服务商；
     * 而留着上一条连接的脏值，只会让下一条新连接继承别人的形态
     * （现场就是 Ollama 请求被打上了 openrouter 的思考形态）。
     */
    thinkStyle: '',
  });
  return { ok: true, connection: store.getConnection(id) };
});

/**
 * 断开连接（= 取消"正在使用"）。
 *
 * ## 为什么需要它，而不是删掉这条连接
 *
 * 连接是**存在库里的资源**，与"当前用哪条"是两件事。羽毛菌的原话：
 * 「除非用户主动断开连接，应该是要一直保持连接的」。
 * 没有这个通道时，用户想换服务商只有两条路：删掉旧连接（连密钥一起丢），
 * 或者不声不响地改配置——两种都把"换模型"做成了破坏性操作。
 *
 * 断开后 activeConnectionId 置空，界面回到"选一条"的状态；
 * 连接本身、地址、密钥全部留着，再进来点一下就切回去。
 *
 * ⚠ model 不清：它是"上次用的模型"，清掉的话重连后又是空模型名，
 *   用户得再选一次。要换模型请在连接详情里改（换模型不等于断开）。
 */
handle('provider:disconnect', () => {
  saveConfig({ activeConnectionId: '' });
  return { ok: true, activeConnectionId: '' };
});

/** 某条连接的密钥状态（脱敏） */
handle('provider:keyStatus', ({ id } = {}) => {
  const cid = id || config.activeConnectionId;
  return {
    has: !!secret.load(cid),
    encrypted: secret.isEncrypted(),
    masked: secret.masked(),
  };
});

/**
 * 存密钥。
 *
 * ⚠ 明文**不落 config.json**、也不落 connections 表。
 *   存的是 safeStorage 加密后的 base64，写进 connection_secrets 表。
 *   渲染进程只能拿到 masked（末 4 位），拿不到明文：
 *   一旦传过去，任何一处日志或截图都可能把它带出去。
 */
handle('provider:setKey', ({ id, apiKey } = {}) => {
  const cid = id || config.activeConnectionId;
  const r = secret.save(apiKey == null ? '' : String(apiKey), cid);
  return { ok: r.ok, encrypted: r.encrypted, error: r.error, masked: secret.masked() };
});

/**
 * 探测连通性。界面上「测试连接」按钮直接用它。
 *
 * ⚠ 传进来的地址/密钥只用于这一次探测，**不写进任何地方**。
 *   用户可能正在试一个地址，没打算保存；
 *   探测就写盘的话，取消一次也会留下垃圾配置。
 * ⚠ 按连接 id 探测（而不是全局），否则测的是"当前连接"，
 *   而用户在界面上编辑的是左栏选中的那条 —— 两者常常不是同一条。
 *
 * ⚠ 额外返回 latencyMs（毫秒）：界面上要给"已连接 · 312ms"这样的证据。
 *   只回一个 ok:true，用户没理由相信"真的连上了"——
 *   那是这轮反馈机制要解决的事（2026-10-13）。
 */
handle('provider:probe', async (p = {}) => {
  const c = p.id ? store.getConnection(p.id) : null;
  const cfg = providerConfig({
    connection: c,
    base: p.base,
    model: p.model,
  });
  if (p.apiKey) cfg.apiKey = String(p.apiKey);
  // ⚠ 传了空串说明用户清空了地址，那要报错（不能退回当前连接的地址）
  if (p.base != null && !String(p.base).trim()) {
    return { ok: false, engine: cfg.engine, error: '地址不能为空' };
  }
  if (!cfg.base) return { ok: false, engine: cfg.engine, error: '请先填服务地址' };
  if (cfg.model === undefined && !c) {
    return { ok: false, engine: cfg.engine, error: '请先选一个模型' };
  }
  const t0 = Date.now();
  const r = await provider.probe(cfg);
  return { ...r, latencyMs: Date.now() - t0 };
});

/** 旧通道保留一层：老版本界面还在调它 */
handle('ollama:check', async () => {
  const r = await provider.probe(providerConfig());
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, version: r.version, models: r.models };
});

// ---- 项目 ----
handle('project:list', () => store.listProjects());
handle('project:create', ({ id, name }) => {
  store.createProject({ id, name });
  // 建项目的同时建文件夹并写入初始资料模板。
  // 不做这一步，项目在数据库里存在但文件夹不存在，文件树会是空的——
  // 用户会以为功能坏了，而不是"资料还没建"。
  const made = pfs.ensureProject(id);
  saveConfig({ currentProject: id });
  return { projects: store.listProjects(), createdFolder: made.created, dir: made.dir };
});
/**
 * 导入一个**已有的小说文件夹**——原地指过去，不复制。
 *
 * ## 为什么不复制
 *
 * 用户可能已经有一个写了很久、还配着一整套自己的整理脚本的文件夹。
 * 复制一份进去等于当场分叉：从这一刻起有两份内容，
 * 用户在原来的脚本里改的东西软件看不到，反之亦然。
 * **原地指过去**才是他要的。
 *
 * ## 绑定的生命周期
 *
 * 只存内存（pfs.externalDirs），**不落库**。
 * 重启后需要重新绑定——换来的是：库里不会攒一堆
 * 几个月后指向已删除目录的绝对路径。
 *
 * ## 绝不写入
 *
 * 绑定后 ensureProject 会拒绝往里写模板（目录被挪走时直接报错），
 * project:delete 也只从软件里摘掉、不删文件夹。
 * 软件对用户的原稿只有读写的权限。
 */
handle('project:importFolder', async ({ dir } = {}) => {
  // 支持两种调用：界面上点按钮（弹选择框）或直接传路径（自动化测试/脚本）
  let target = dir;
  if (!target) {
    const r = await dialog.showOpenDialog({
      title: '选择已有的小说文件夹',
      properties: ['openDirectory'],
      buttonLabel: '导入这里',
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    target = r.filePaths[0];
  }
  target = path.resolve(target);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`不是有效的文件夹：${target}`);
  }

  // 项目名取文件夹名
  const name = path.basename(target) || '导入的小说';

  // 同名项目已经绑过同一个目录 → 直接打开，不重复建
  const existing = store.listProjects().find((p) => p.name === name);
  if (existing && pfs.isExternal(existing.id) && pfs.projectDir(existing.id) === target) {
    saveConfig({ currentProject: existing.id });
    return { projects: store.listProjects(), id: existing.id, dir: target,
             name, reused: true, ...pfs.countTree(existing.id) };
  }

  // 项目 id 唯一。⚠ 不能直接用文件夹名：resolveIn 会拒收含 / \ .. 的 id，
  //   而中文文件夹名虽然能用，但万一用户文件夹里带斜杠就整个项目打不开。
  //   走与其它实体一致的时间戳 id（ch-/pt-/sk- 那套）。
  const id = `pj-${Date.now().toString(36)}`;
  if (store.getProject(id)) throw new Error('项目 ID 冲突，请重试');

  store.createProject({ id, name });
  // ⚠ 先绑再ensureProject 的顺序不能反：
  //   ensureProject 会检查 isExternal 并拒绝写模板。
  pfs.bindExternal(id, target);
  pfs.ensureProject(id);
  saveConfig({ currentProject: id });

  return { projects: store.listProjects(), id, dir: target, name, ...pfs.countTree(id) };
});

handle('project:open', ({ id }) => {
  // ⚠ 导入的外部项目可能文件夹已被挪走 —— ensureProject 会抛。
  //   **先确认文件夹能用，再切当前项目**：
  //   反过来的话，失败时 currentProject 已经落库了，
  //   用户回到主界面以为还在那个项目里，其实正在往别处写。
  try {
    // 打开项目时补建文件夹：用户可能删过文件夹再打开，
    // 或从旧版本（那时没有项目文件夹）升上来。
    pfs.ensureProject(id);
  } catch (e) {
    return { ...config, openError: e.message };
  }
  saveConfig({ currentProject: id });
  return config;
});

/**
 * 改项目显示名。
 *
 * ⚠ 只改数据库里的 name，不改文件夹名。文件夹名就是项目 id，
 *   改它会让用户攒下的所有路径引用失效。
 *   所以「重命名」之后磁盘目录还是老名字——这是有意的取舍，
 *   界面上不解释的话用户会以为没改成功。
 */
handle('project:rename', ({ id, name }) => {
  const n = store.renameProject(id, name);
  return { ok: true, name: n, projects: store.listProjects() };
});

/**
 * 删项目。
 *
 * ## 顺序：先删文件夹，再删数据库记录
 *
 * 反过来做的话（先删数据库），一旦删文件夹失败，
 * 数据库里已经没有这个项目、用户也没法再从界面触发删除，
 * 文件夹就成了孤儿——只能手动去 AppData 里清。
 *
 * 所以先删文件夹（这一步可失败、可重试），成功后再删记录。
 *
 * ## rootDelete 这个口子
 *
 * `remove({rootDelete:true})` 能删整个项目文件夹，
 * 它只在这里被调用——渲染进程拿不到这个口子：
 * `fs:remove` 通道传进来的 relPath 必然非空，
 * 而 `resolveIn(id, '')` 会直接抛「路径越界」。
 */
handle('project:delete', ({ id, keepFiles = false }) => {
  const row = store.getProject(id);
  if (!row) throw new Error('项目不存在');

  // ⚠⚠ 导入的外部项目：**只从软件里摘掉，绝不删文件夹**。
  //
  // keepFiles 是用户勾选的，但外部目录是用户自己的原稿，
  // 软件对它没有删除权。这里替用户改成保留 —— 不给"不小心勾错"
  // 留任何余地。真要删，用户自己去文件管理器里删，那是他熟悉的地方。
  const isExternal = pfs.isExternal(id);
  if (isExternal) keepFiles = true;

  let folderErr = null;
  let dir = null;
  if (!keepFiles) {
    dir = pfs.projectDir(id);
    if (fs.existsSync(dir)) {
      try {
        pfs.remove(id, '', { rootDelete: true });
      } catch (e) {
        folderErr = e.message;
      }
    }
  }
  // 文件夹删不掉就不删数据库记录——宁可留着让用户重试，
  // 也不要出现"界面里没了、磁盘上还在、用户不知道怎么办"
  if (folderErr) {
    return { ok: false, error: `项目文件夹没能删除（${folderErr}），项目仍然保留。` };
  }

  store.deleteProject(id);
  pfs.unbindExternal(id);
  // 当前项目被删了就把配置里指向它的指针清掉，
  // 否则下次启动会试图打开一个不存在的项目
  if (config.currentProject === id) saveConfig({ currentProject: null });
  return { ok: true, projects: store.listProjects(), dir, keptFiles: !!keepFiles,
           external: isExternal };
});

/**
 * 把项目名变成能安全用作目录名的字符串。
 *
 * Windows 的目录名不能含 \ / : * ? " < > |，而项目名是用户随便起的
 * （"剑与剑：卷一" 这种带冒号的完全合法）。
 * 直接拿它拼导出路径会抛 EINVAL，用户看到的是一句英文。
 *
 * ⚠ 注释里别举例真实的项目名——打包测试有一条「主进程不预置任何项目」
 *   是逐字符串匹配的（它不区分注释与代码，这正是它该保守的地方），
 *   举例用了真名就会让那条测试变红，而红的原因与它要防的东西无关。
 */
function safeFileName(name) {
  return String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 60);
}

/**
 * 导出项目 = 把整个项目文件夹复制一份到用户选的位置。
 *
 * 为什么是"复制文件夹"而不是打包成 zip：
 *   zip 需要一个依赖（archiver / yazl），而这个模块的全部依赖
 *   目前是 0。文件夹复制用 fs.cp 就够，且用户拿到的是
 *   能直接双击打开的目录——对写作工具来说这更实用
 *   （要迁移到别的电脑时，拷文件夹比解压 zip 少一步）。
 */
handle('project:export', async ({ id }) => {
  const row = store.getProject(id);
  if (!row) throw new Error('项目不存在');
  const src = pfs.projectDir(id);
  if (!fs.existsSync(src)) throw new Error('项目文件夹不存在');

  const stamp = new Date().toISOString().slice(0, 10);
  const suggested = safeFileName(row.name) || id;
  const r = await dialog.showSaveDialog(win, {
    title: '导出项目文件夹',
    defaultPath: path.join(app.getPath('documents'), `${suggested}-备份-${stamp}`),
    buttonLabel: '导出',
  });
  if (r.canceled || !r.filePath) return { canceled: true };

  const dest = r.filePath;
  if (fs.existsSync(dest)) throw new Error('目标位置已存在，换个名字或先移走它');
  fs.cpSync(src, dest, { recursive: true, errorOnExist: true });

  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full);
      else {
        files++;
        try { bytes += fs.statSync(full).size; } catch (_) {}
      }
    }
  };
  walk(dest);
  return { ok: true, dest, files, bytes };
});

// ---- 章节 ----
handle('chapter:list', ({ projectId }) => store.listChapters(projectId));
handle('chapter:get', ({ id }) => store.getChapter(id));
handle('chapter:create', ({ projectId, title, content, parentChapterId, origin }) => {
  const id = `ch-${Date.now().toString(36)}`;
  store.createChapter({ id, projectId, title, content, parentChapterId, origin });
  return { id, ...store.getChapter(id) };
});
handle('chapter:save', ({ id, content }) => {
  // 覆盖前先备份：revision 自增，出问题能回溯
  const dir = path.join(USER_DIR, 'chapters');
  store.backupChapter(id, dir);
  store.updateChapterContent(id, content);
  return store.getChapter(id);
});
handle('chapter:delete', ({ id }) => store.deleteChapter(id));

// ---- 设定库 ----
handle('settings:list', ({ projectId }) => store.loadSettings(projectId));
handle('settings:summary', ({ projectId, maxChars }) => {
  const settings = store.loadSettings(projectId);
  // 在场角色与当前地点 pin 进摘要——它们是「当前事实」不是「候选」
  const states = store.listEntityStates(projectId);
  const pinned = new Set();
  for (const s of states) {
    pinned.add(s.entity_name);
    if (s.state && s.state.location) pinned.add(s.state.location);
  }
  return summarizeBible(settings, { maxChars: maxChars || 1200, pinned: [...pinned] });
});
handle('settings:upsert', ({ projectId, type, name, note, aliases }) =>
  store.upsertSetting({ id: `${projectId}:${type}:${name}`, projectId, type, name, note, aliases })
);
handle('settings:importBible', async ({ projectId, jsonPath }) => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择设定库 JSON',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  store.importWorldBible(result.filePaths[0], (pid) => {
    if (!store.getProject(pid)) store.createProject({ id: pid, name: pid });
  });
  return { canceled: false, imported: true, jsonPath: jsonPath || result.filePaths[0] };
});

// ---- 检索 ----
handle('bible:query', ({ projectId, query, entityType, topK }) => {
  const settings = store.loadSettings(projectId);
  if (!settings.length) return { ok: true, count: 0, hits: [] };

  const q = String(query || '').replace(/\s+/g, '').toLowerCase();
  if (!q) return { ok: true, count: 0, hits: [] };

  const k = topK || 8;
  const scored = [];
  for (const s of settings) {
    if (entityType && s.type !== entityType) continue;
    const name = String(s.name || '').toLowerCase();
    const aliases = (s.aliases || []).map((a) => String(a).toLowerCase());
    let score = 0;
    if (name === q) score = 100;
    else if (name.includes(q) || q.includes(name)) score = 80;
    else if (aliases.some((a) => a === q)) score = 70;
    else if (aliases.some((a) => a.includes(q) || q.includes(a))) score = 60;
    else if (String(s.note || '').toLowerCase().includes(q) && q.length >= 3) score = 40;
    if (score > 0) scored.push({ ...s, _score: score });
  }
  // 同分取名称更短者（更可能是主名），保证结果可复现
  scored.sort((a, b) => (b._score - a._score) || a.name.length - b.name.length
    || a.name.localeCompare(b.name, 'zh'));
  const hits = scored.slice(0, k).map(({ _score, ...rest }) => rest);
  return { ok: true, count: scored.length, hits, truncated: scored.length > k };
});

// ---- 状态 ----
handle('state:list', ({ projectId }) => store.listEntityStates(projectId));
handle('state:writeback', ({ projectId, chapterId }) => {
  const ch = store.getChapter(chapterId);
  if (!ch) throw new Error(`章节不存在：${chapterId}`);
  const settings = store.loadSettings(projectId);
  const res = applyStateAfterCommit({
    store, projectId, chapterId, text: ch.content, settings,
  });
  return res;
});
handle('state:set', ({ projectId, entityName, state, chapterId }) => {
  store.setEntityState({ projectId, entityName, state, chapterId });
  return store.getEntityState(projectId, entityName);
});

// ---- 伏笔 ----
handle('thread:list', ({ projectId }) => store.listOpenThreads(projectId));
handle('thread:create', ({ projectId, name, summary, plantedIn, importance }) => {
  const id = `pt-${Date.now().toString(36)}`;
  store.createThread({ id, projectId, name, summary, plantedIn, importance });
  return store.listOpenThreads(projectId);
});
handle('thread:resolve', ({ id, chapterId }) => {
  store.resolveThread(id, chapterId);
  return { ok: true };
});

// ---- 技能（供输入框 @ 引用）----
handle('skill:list', ({ projectId }) => store.listSkills(projectId));
handle('skill:create', ({ projectId, name, promptContent }) =>
  store.createSkill({ projectId, name, promptContent })
);
handle('skill:delete', ({ id }) => ({ deleted: store.deleteSkill(id) }));
handle('skill:listAll', ({ projectId }) => store.listAllSkills(projectId));
handle('skill:update', ({ id, name, promptContent }) =>
  store.updateSkill(id, { name, promptContent }));
handle('skill:setEnabled', ({ id, enabled }) =>
  ({ skill: store.setSkillEnabled(id, enabled) }));

// ---- Skill 配套文件（目录式 Skill）----

handle('skill:files', ({ id }) => store.listSkillFiles(id));

/** 读一个配套文件的完整内容（点开看时才取） */
handle('skill:file', ({ id, path }) => store.getSkillFile(id, path));

/**
 * 写配套文件。
 *
 * ⚠ path 来自用户输入也来自导入的 Skill，所以走 store 的路径校验
 *   （不许绝对路径、不许 ..、必须在三个目录之一）。
 *   那层校验是硬约束——绕过去就等于开了任意文件读写。
 */
handle('skill:saveFile', ({ id, path, content, kind, executable }) =>
  store.saveSkillFile(id, { path, content, kind, executable }));

handle('skill:deleteFile', ({ id, path }) =>
  ({ deleted: store.deleteSkillFile(id, path) }));

/**
 * 导入一份 SKILL.md（粘贴或选文件读到的内容）。
 *
 * ## 为什么必须校验而不是直接存
 *
 * 渐进式加载下 description 是模型判断"要不要用这个技能"的**唯一依据**。
 * 缺 description 的技能装了等于没装——用户会以为"装了但没生效"。
 * 所以这里明确返回 errors，让界面上弹出来。
 *
 * @returns {{ok, name, description, errors, warnings, body}}
 */
handle('skill:import', ({ content, name, projectId }) => {
  const v = skillFormat.validate(content);
  const parsed = skillFormat.parse(content);
  return {
    ok: v.ok,
    name: parsed.name || name || '',
    description: parsed.description,
    body: parsed.body,
    extra: parsed.extra,
    errors: v.errors,
    warnings: v.warnings,
  };
});

/**
 * 校验并落库一份 SKILL.md。
 *
 * ⚠ 校验不通过**也允许存**，但把警告原样返回给界面。
 *   硬拦下来的话，用户存一份半成品（比如还没写 description 的草稿）
 *   就会被拒绝，而那是完全合理的用法——他要先存着再改。
 *   真正致命的是"用户永远不知道它不生效"，所以要**说**而不是**挡**。
 */
handle('skill:importCommit', ({ content, name, projectId, files }) => {
  const parsed = skillFormat.parse(content);
  const n = String(parsed.name || name || '').trim();
  if (!n) throw new Error('技能必须有名称');

  const id = `sk-${skillFormat.sanitizeName(n)}-${Date.now().toString(36)}`;
  const sk = store.createSkill({
    id,
    projectId: projectId || null,
    name: n,
    promptContent: content,
    type: 'custom',
    enabled: true,
  });

  // 配套文件。⚠ 逐个存且不因单个失败而整体回滚——
  //   一个 Skill 里一个文件有问题，不该让整份 SKILL.md 都装不上。
  const results = [];
  for (const f of (files || [])) {
    try {
      store.saveSkillFile(id, {
        path: f.path,
        kind: f.kind || (f.path.startsWith('scripts/') ? 'script' : 'reference'),
        content: f.content || '',
      });
      results.push({ path: f.path, ok: true });
    } catch (e) {
      results.push({ path: f.path, ok: false, error: e.message });
    }
  }
  return { skill: sk, files: results };
});

/**
 * 导出成可带走的结构。
 *
 * ⚠ 导出的是**原文**（含 frontmatter）而不是解析后的字段：
 *   用户拿去另一个工具用的时候，需要的就是原始 SKILL.md。
 *   解析后重组会丢掉他写在 frontmatter 里的未知字段。
 */
handle('skill:export', ({ id }) => {
  const sk = store.getSkill(id);
  if (!sk) throw new Error('技能不存在');
  return {
    name: sk.name,
    content: sk.prompt_content,
    files: store.getSkillFiles(id),
  };
});

/**
 * 渐进式加载：给系统提示用的技能索引。
 *
 * ## 三级加载（与 Claude 的 Skill 同一套思路）
 *
 *   1. 这里返回的只有 name + description —— 每轮对话都带
 *   2. SKILL.md 正文 —— 用户 @ 引用时才带
 *   3. references/ —— 模型自己决定要不要读
 *
 * ⚠ 为什么不把正文也拼进来：用户开 8 个技能、每个两千字，
 *   就是一万六千字常驻上下文 —— 相当于每轮对话都在为不用到的技能付费，
 *   而且长上下文会明显拉低模型的注意力。
 *
 * @param {string|null} projectId
 * @param {string[]} [only] 只索引这几个（用户 @ 引用的那些）
 */
handle('skill:index', ({ projectId, only }) => {
  const list = only && only.length
    ? store.getSkillsByIds(only)
    : store.listSkills(projectId);
  const fmt = require(path.join(__dirname, 'skill-format.js'));
  return list.map((sk) => {
    const meta = fmt.parse(sk.prompt_content || '');
    const files = store.listSkillFiles(sk.id);
    return {
      id: sk.id,
      name: sk.name,
      // ⚠ 没有 description 的技能不该被索引：
      //   一条"没有描述的技能"进索引只会占位置，不会被触发。
      description: meta.description,
      hasFrontmatter: meta.hasFrontmatter,
      files: files.map((f) => f.path),
    };
  }).filter((x) => x.description);
});

/**
 * 取一个技能的完整内容（@ 引用时用）。
 *
 * 连带返回配套文件**清单**但不返回内容——
 * 模型看到文件名后可以再通过 skill:file 逐个取。
 * 一次全塞进来会让正文体积翻好几倍。
 */
handle('skill:lookup', ({ id }) => {
  const sk = store.getSkill(id);
  if (!sk) throw new Error('技能不存在');
  return {
    id: sk.id,
    name: sk.name,
    content: sk.prompt_content,
    files: store.listSkillFiles(sk.id),
  };
});

// ---- 对话 ----
handle('conv:list', ({ projectId }) => {
  const list = store.listConversations(projectId);
  // 附消息数——列表要显示「聊了多少轮」，删除前的确认文案也用它
  return list.map((c) => ({ ...c, messageCount: store.countMessages(c.id) }));
});
/**
 * 新建对话。
 *
 * ⚠ 零项目时的报错必须**指得出路**。
 *   原来写的是「先创建或选择一个项目」——用户读到的信息是
 *   "我该去建项目"，但他不知道该点哪里：项目入口在第 4 栏第 2 行的
 *   「（未选项目）⇅」上，而他现在正盯着第 1 栏的「＋ 新对话」。
 *   文案里带位置，比多写一段文档有用。
 */
handle('conv:create', ({ projectId, title }) => {
  if (!projectId) {
    throw new Error('还没有小说项目。点最右边第 4 栏顶部的「（未选项目）」，'
      + '在弹出的窗口里选「＋ 新建」。');
  }
  return store.createConversation({ projectId, title });
});
handle('conv:rename', ({ id, title }) => store.renameConversation(id, title));

/**
 * 设这一条对话的思考强度。
 *
 * 与 config:set 分开而不是复用：config 是**全局默认**，
 * 这个值是**这一条对话的**。混在一个通道里，
 * 以后想加"这条对话的模型/温度"就得再拆一次。
 */
handle('conv:setThink', ({ conversationId, level }) => {
  if (!conversationId) throw new Error('缺少 conversationId');
  return store.setConversationThinkLevel(conversationId, level);
});
handle('conv:delete', ({ id }) => ({ deleted: store.deleteConversation(id) }));
handle('conv:messages', ({ conversationId }) => {
  if (!conversationId) return [];
  return store.listMessages(conversationId, 300);
});

/**
 * 发送一条消息并流式生成回答。
 *
 * 与旧 generate:start 的关键差别：**带上对话历史**。
 * 旧版每次只发 system + 一个 user prompt，那是「续写」；
 * 新版把历史按 role 拼进去，模型才知道自己在跟谁聊。
 */
handle('conv:send', async (payload) => {
  const { conversationId, projectId, text, refs = [], model, temperature } = payload;
  if (!conversationId) throw new Error('缺少 conversationId');
  if (activeRequest) return { started: false, reason: '已有生成在进行中' };

  /**
   * 1.5) 必须有一条"正在使用"的连接。
   *
   * ⚠ 2026-10-13 加的：「断开连接」把 activeConnectionId 清空了，
   *   这时 providerConfig 会退回老字段 config.base —— 多数情况下是
   *   默认的 127.0.0.1:11434，于是用户看到的是
   *   「connect ECONNREFUSED 127.0.0.1:11434」，
   *   跟他真正的原因（我还没选模型）隔了十万八千里。
   *
   * ⚠ 放在落库**之前**：拦下来时不应该留下一条没有回答的用户消息。
   */
  if (!store.getConnection(config.activeConnectionId)) {
    throw new Error(
      '还没有在用任何模型。点左上角「设置 → AI 提供商」，'
      + '选一条已保存的连接，或新建一条。'
    );
  }

  // 1) 落库用户消息
  store.addMessage({ conversationId, role: 'user', content: text || '' });

  // 2) 首次发消息时用内容当标题（列表里全是「新对话」没法分辨）
  const conv = store.getConversation(conversationId);
  if (conv && (!conv.title || conv.title === '新对话')) {
    store.renameConversation(conversationId, (text || '').slice(0, 16) || '新对话');
  }

  /**
   * 2.5) 思考强度：**本次传的 > 这条对话存的 > 全局默认**。
   *
   * 档位是每轮生成的参数，不是连接属性——同一家服务商，
   * 改错别字要「关」、搭世界观框架要「高」。
   * 所以它在输入框旁边能随手改，并跟着对话记住。
   *
   * 界面上改了档位会顺手落库：这样切走再回来还是这一档，
   * 不依赖界面记得额外再调一次 conv:setThink。
   * 落库失败**不拦生成**——档位存不住是小事，这一轮发不出去是大事。
   */
  let thinkLevel = payload.thinkLevel;
  if (thinkLevel == null) {
    const stored = (conv && conv.thinkLevel) || '';
    thinkLevel = stored || config.thinkLevel || 'off';
  } else {
    try { store.setConversationThinkLevel(conversationId, thinkLevel); }
    catch (e) { log('档位没存住（不影响这次生成）：', e.message); }
  }

  // 3) 历史消息（含刚落库的那条）
  const history = store.listMessages(conversationId, 20)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  /**
   * 4) 引用与当前状态拼进最后一条 user 消息
   *
   * ⚠⚠ 窗口与预留**必须按当前连接取**（2026-10-14 改）。
   *
   * 原来传的是 `config.numCtx`（全局，默认 8192）。云端连接的模型窗口
   * 动辄 128K~200K，压缩器却按 8192 算 —— 历史预算只有六千 token，
   * 写长篇时前文设定被大量丢弃，用户看到的是"写着写着忘了开头设的规矩"。
   * 而且这类退化**没有任何报错**，只会显得模型变笨。
   *
   * `reserve` 是留给输出的那一块：Anthropic 的 input + max_tokens
   * 共享同一个窗口，不留就会在生成到窗口上限时被掐停。
   */
  const cp = connParamsOf(config.activeConnectionId);
  const guard = new LoopContextGuard({
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    numCtx: cp.numCtx,
    reserve: cp.reserve,
  });
  const extras = [buildRefBlock(refs), buildStateBlock(projectId)].filter(Boolean).join('\n\n');
  const lastUser = [...guard.messages].reverse().find((m) => m.role === 'user');
  if (lastUser && extras) lastUser.content = `${lastUser.content}\n\n${extras}`;

  guard.ensure();

  /**
   * body 现在由 provider 层构造。
   *
   * ⚠ 这里只传 messages 与本次的临时覆盖值：
   *   端点、思考参数形态、token 上限、SSE 解析全在 provider 里，
   *   那边有 41 条用例钉着（think 字段对百炼要放顶层、
   *   OpenAI 兼容不能带 options 之类，漏一条就是 400）。
   */
  streamedText = '';
  streamedThink = '';
  activeProfile = null;

  /**
   * 工具开关。三层判断，任一关掉就完全不启用工具：
   *   1. 总开关（设置里）
   *   2. 本条消息显式带 toolsEnabled（界面上临时允许）
   *   3. 必须有项目 —— 终端被钉死在项目文件夹里，没项目就没有 cwd，
   *      给一个空 cwd 等于把命令放到系统目录跑，那不是「限定在项目文件夹」。
   *
   * ⚠ 关闭时**只是不下发 tools**：不报错、不提示。
   *   用户没开这个功能，模型压根不知道有工具，
   *   于是表现跟旧版一模一样（这正是我们要的向后兼容）。
   */
  const toolsWanted = payload.toolsEnabled != null
    ? !!payload.toolsEnabled
    : !!config.toolsEnabled;
  const canUseTools = toolsWanted && !!projectId && !!pfs.projectDir(projectId);

  /**
   * 界面上那两个 chip（⌘终端 / 🔍联网）勾了哪些。
   *
   * ⚠ 三态必须分清楚，糊成一团就会出现"开关点了没反应"：
   *   - payload.tools 是数组  → 按勾的来（一个没勾就完全不给工具）
   *   - 没传 / 不是数组       → 全部允许（老客户端与新调用方的默认）
   *   - canUseTools 为 false  → 一律 null，chip 勾了也不给
   */
  const toolDefs = canUseTools ? toolMod.pickToolDefs(payload.tools) : null;

  const run = agentLoop.createAgentRun({
    cfg: providerConfig({
      model: model || config.model,
      temperature,
      thinkLevel,
    }),
    messages: guard.messages,
    toolDefs,
    ctx: {
      cwd: canUseTools ? pfs.projectDir(projectId) : null,
      apiKey: loadSearchKey(),
      // ⚠ 默认 serper：Bing 的新申请入口已关闭，个人开发者拿不到 Key
      searchProvider: config.searchProvider === 'bing' ? 'bing' : 'serper',
      httpRequest: provider.httpRequest,
      approve: askUserToApprove,
    },
    handlers: {
      onChunk: (chunk) => {
        streamedText += chunk;
        if (win && !win.isDestroyed()) win.webContents.send('generate:chunk', chunk);
      },
      onThink: (thinkText) => {
        streamedThink += thinkText;
        if (win && !win.isDestroyed()) win.webContents.send('generate:think', thinkText);
      },
      onToolStart: (call) => {
        if (win && !win.isDestroyed()) win.webContents.send('tool:start', toolCard(call, 'running'));
      },
      onToolEnd: (call, result) => {
        if (win && !win.isDestroyed()) win.webContents.send('tool:end', toolCard(call, result));
      },
      onDone: (meta) => {
        const out = streamedText;
        // 落库助手回答——对话历史必须持久化，刷新页面后还要能接着聊
        if (out.trim()) {
          store.addMessage({
            conversationId, role: 'assistant', content: out,
            tokensIn: meta?.tokensIn || 0, tokensOut: meta?.tokensOut || 0, ms: meta?.ms || 0,
          });
        }
        if (win && !win.isDestroyed()) win.webContents.send('generate:done', meta || {});
        // 生成完成：notify 含「窗口」时闪动任务栏（'sound' 只响不闪，由渲染进程播提示音）
        if (!meta?.stopped && win && !win.isDestroyed()
          && config.notify !== 'sound' && config.notify !== 'none') {
          win.flashFrame(true);
        }
        activeRequest = null;
        streamedText = '';
      },
      onError: (err) => {
        if (win && !win.isDestroyed()) win.webContents.send('generate:error', err.message);
        activeRequest = null;
        streamedText = '';
        streamedThink = '';
      },
    },
  });

  activeRequest = run;
  return { started: true, guardReport: guard.report(), toolsEnabled: !!canUseTools };
});

/**
 * 工具调用的展示载荷。
 *
 * ⚠ 只给界面**要显示的**内容：工具名 + 一行摘要 + 状态。
 *   参数原样发过去是可以的（模型自己给的，不是秘密），
 *   但结果正文可能上万字 —— 界面上折叠显示，不必每帧都塞一遍。
 */
function toolCard(call, result) {
  const a = call.args || {};
  const brief = a.command || a.query || a.url || '';
  return {
    id: call.id || call.name,
    name: call.name,
    brief: String(brief).slice(0, 200),
    status: result === 'running' ? 'running'
      : (result && result.ok === false ? 'failed' : 'done'),
    output: result === 'running' ? '' : String((result && result.output) || '').slice(0, 4000),
    // ⚠ 危险原因要透出去：用户要靠它判断这条命令该不该放行
    reasons: (result && result.reasons) || [],
  };
}

/**
 * 危险命令的用户审批。
 *
 * ⚠ 逻辑全在 approval.js 里（有 19 条用例钉着），这里只做**接线**：
 *   把「能不能问用户」这件事翻译成 available（没窗口就是 false），
 *   把「问」翻译成往渲染进程发消息。
 *
 * 之所以不把逻辑写在 main.js：这段是「模型能碰你的电脑」的最后一道闸，
 * 而长在 main.js 里就意味着只能靠真点界面来验证。
 */
const approvalGate = createApprovalGate({
  available: !!(win && !win.isDestroyed()),
  send: (payload) => {
    if (!win || win.isDestroyed()) throw new Error('窗口不在了');
    win.webContents.send('tool:approve', payload);
  },
  onLog: (why, info) => log(`[approve:${why}] ${String((info && info.command) || '').slice(0, 120)}`),
});

/** 界面上有没有窗口可用。createWindow 之后要刷新一次。 */
function refreshApprovalAvailability() {
  approvalGate.setAvailable(!!(win && !win.isDestroyed()));
}
const askUserToApprove = (info) => approvalGate.request(info);

/** 界面回传审批结果 */
handle('tool:decide', ({ id, allow } = {}) => {
  // ⚠ 查不到就是查不到，必须返回错误。
  //   静默 resolve 的话，界面上那个按钮会一直转圈等一个不会来的结果。
  if (!approvalGate.decide(id, allow)) {
    return { ok: false, error: '这条审批已经结束了' };
  }
  return { ok: true };
});

/** 搜索服务的 Key。它不是模型密钥，但同样是密钥 —— 一样走 safeStorage */
/**
 * 联网搜索的 Key 走**服务级**存储（service_secrets 表）。
 *
 * ⚠⚠ 原来它用的是 secret.save(key, '__web_search__') ——
 *   而 connection_secrets 的 connection_id 有外键 REFERENCES connections(id)，
 *   `__web_search__` 不在那张表里，于是每次 INSERT 都被数据库拒绝：
 *
 *     加密失败：FOREIGN KEY constraint failed
 *
 *   这个错误被 secret-store 包成了「加密失败」，界面收到 ok:false，
 *   用户看到的就是「填了 Key 但保存不成功」——
 *   而加密明明可用（同一张表里各家的模型 Key 都能存）。
 *
 *   **联网搜索的 Key 不是「某条连接的密钥」**，它属于服务本身。
 *   硬塞 connections 是设计错误，现在改正。
 *
 * ⚠ provider 写死 'serper'：Bing 那个入口已关闭，只留给手上还有旧 Key 的人，
 *   但两家的 Key 不通用，所以将来要换的话得加一列存服务商。
 */
function loadSearchKey() { return secret.loadService('serper') || ''; }
handle('tool:setSearchKey', ({ apiKey } = {}) => {
  const r = secret.saveService(apiKey == null ? '' : String(apiKey), 'serper');
  return { ok: r.ok, encrypted: r.encrypted, error: r.error, has: !!loadSearchKey() };
});
handle('tool:searchKeyStatus', () => ({
  has: !!loadSearchKey(), encrypted: secret.isEncrypted(),
}));

/**
 * 联网「整体能不能用」的判定。
 *
 * ## 为什么要单独一个 IPC（2026-10-14）
 *
 * 羽毛菌反馈「填了 Key，联网功能依然是标红不可用」。查下来发现两件事：
 *   1. Key 能存能读、请求能真发到 serper（拿到 HTTP 403，格式对）
 *   2. 输入框上的「联网」chip 只有三态：放行 / 未放行 / 总开关关 ——
 *      **没有「没配 Key」这一态**。所以没填 Key 时 chip 照样亮着，
 *      看起来"联网已放行"，实际发出去必然失败。
 *
 * 换句话说，chip 亮 ≠ 联网能用。这两件事被界面混成了一件。
 *
 * 所以这里把**四层条件**一次性算清楚给界面，由它决定 chip 显示什么：
 *   总开关开？→ Key 填了？→ 服务商选对？→ 这一轮放行了？
 * 少任何一层都要**指名道姓地说缺哪一层**，不能笼统说"联网不可用" ——
 * 用户改错地方的成本，比我们多写四行判断高得多。
 */
handle('tool:webReady', () => {
  const provider = config.searchProvider === 'bing' ? 'bing' : 'serper';
  const hasKey = !!loadSearchKey();
  const label = provider === 'bing' ? 'Bing' : 'Serper';
  return {
    provider,
    hasKey,
    encrypted: secret.isEncrypted(),
    masterOn: !!config.toolsEnabled,
    /** 缺哪几层，逐条给界面显示（[] = 全齐） */
    missing: [
      config.toolsEnabled ? null : '总开关',
      hasKey ? null : `${label} 的 Key`,
    ].filter(Boolean),
  };
});

/**
 * 把 @ 引用的技能与文件拼成可读文本。
 *
 * 刻意**不放进消息正文**：消息记录存的是用户真正写的话，
 * 回看历史时能看清在聊什么。引用只在生成时临时拼进 prompt。
 */
function buildRefBlock(refs) {
  if (!refs || !refs.length) return '';
  const lines = ['【本次引用的材料】'];

  const skillRefs = refs.filter((r) => r.kind === 'skill');
  if (skillRefs.length) {
    lines.push('', '技能要求：');
    for (const r of skillRefs) {
      const s = store.getSkill(r.id);
      if (s) lines.push(`- 【${s.name}】${s.prompt_content}`);
    }
  }

  const fileRefs = refs.filter((r) => r.kind === 'file');
  if (fileRefs.length) {
    lines.push('', '引用内容：');
    for (const r of fileRefs) {
      if (r.content) {
        lines.push(`- 【${r.name}】${String(r.content).slice(0, 600)}`);
        continue;
      }
      const ch = store.getChapter(r.id);
      if (ch && ch.content) {
        // 章节只给前 800 字：全文拼进去会挤爆上下文，
        // 而对话场景里模型通常只需要开头的人设与场景
        lines.push(`- 【章节：${ch.title}】${ch.content.slice(0, 800)}`);
      } else if (ch) {
        lines.push(`- 【章节：${ch.title}】（暂无正文）`);
      }
    }
  }

  return lines.join('\n');
}

/** 当前角色状态摘要，供生成时对齐人物位置与境界 */
function buildStateBlock(projectId) {
  if (!projectId) return '';
  let states;
  try { states = store.listEntityStates(projectId); } catch (_) { return ''; }
  if (!states || !states.length) return '';
  const bits = states.map((s) => {
    const b = [];
    if (s.state?.location) b.push(`在${s.state.location}`);
    if (s.state?.境界) b.push(s.state.境界);
    return b.length ? `${s.entity_name}：${b.join('，')}` : null;
  }).filter(Boolean);
  if (!bits.length) return '';
  return ['【当前状态】', ...bits.map((x) => `- ${x}`)].join('\n');
}

// ---- 生成（旧接口：保留给「续写一章」，界面改版后主路径是 conv:send）----
/**
 * 开始一次生成。
 *
 * ⚠ 修掉的真 bug（并发污染）：原来直接 `activeRequest = streamGenerate(...)`，
 * **不检查也不销毁已有请求**。渲染进程虽然有 `if (generating) return`，
 * 但 generating 是 React state，闭包捕获的是渲染时的快照——
 * 用户快速双击「续写」时，两次点击都在同一次 re-render 之前，
 * generating 两次都是 false → 两个请求同时在跑。
 *
 * 后果全部落在模块级共享变量上：
 *   - streamedText 被第二次清空，第一次已收到的正文丢失
 *   - activeProfile 被第二次覆盖，第一次的风格基准错乱
 *   - activeRequest 被覆盖，第一次**永远无法被 generate:stop 停掉**
 *   - 旧请求的 onDone 在新请求流式途中迟到触发，清空新请求的 streamedText
 *     → 新请求的风格检测必然失效
 */
handle('generate:start', async (payload) => {
  const { projectId, chapterId, prompt, mode } = payload;

  // 已有请求在跑：直接拒绝，不做任何状态改动。
  // 这里不能「销毁旧的然后开新的」——旧请求的 onDone 回调会把
  // 新请求刚设好的 streamedText/activeProfile 清掉。
  if (activeRequest) {
    return { started: false, reason: '已有生成在进行中' };
  }

  // 必须先清空：上一次残留会污染本次的风格检测
  streamedText = '';
  activeProfile = null;

  // 组装上下文：system + 设定摘要 + 上一章尾部
  const settings = store.loadSettings(projectId);
  const states = store.listEntityStates(projectId);
  const pinned = new Set();
  for (const s of states) {
    pinned.add(s.entity_name);
    if (s.state && s.state.location) pinned.add(s.state.location);
  }
  const bible = summarizeBible(settings, { maxChars: 1200, pinned: [...pinned] });

  const prev = chapterId ? store.getChapter(chapterId) : null;
  const prevTail = prev && prev.content
    ? prev.content.slice(-600)
    : '';

  // 风格画像：从用户自己已保存的章节正文统计得出。
  // 基准完全来自用户文本，不含任何主观词表——换题材也成立。
  const profile = buildStyleProfile(projectId);

  // ⚠ 同上：窗口与预留按当前连接取，不用全局 config.numCtx。
  const cpGen = connParamsOf(config.activeConnectionId);
  const guard = new LoopContextGuard({
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: '' }],
    numCtx: cpGen.numCtx,
    reserve: cpGen.reserve,
  });
  guard.messages[1].content = buildUserPrompt(prompt, bible.text, prevTail, states, profile);
  activeProfile = profile.ok ? profile : null;

  /**
   * 压缩在**请求发出前**跑一次。
   *
   * ⚠ 修掉的真 bug：原来只调 guard.report()，**ensure() 从未被调用**——
   * 整条上下文压缩链在 Electron 应用里是死代码。
   * 后果：
   *   - report() 的 compressions 恒为 0，返回一份「看起来很健康、
   *     实际什么都没做」的报告
   *   - SettingsPanel 里「超出会被上下文治理自动压缩」是**假的**：
   *     numCtx 调小 + 设定库大时请求直接超窗被 Ollama 拒绝，没有任何兜底
   *
   * ensure() 会把压缩结果同步回 messages，必须在取 body.messages 之前调。
   */
  guard.ensure();

  // 同上：body 交给 provider 层构造，这里只给 messages 与临时温度
  const body = {
    model: payload.model || config.model,
    messages: guard.messages,
    temperature: payload.temperature,
  };

  // 把首段的 content 从 '' 换成真实内容
  body.messages = guard.messages;

  activeRequest = streamGenerate(
    body,
    (text) => {
      if (win && !win.isDestroyed()) win.webContents.send('generate:chunk', text);
      streamedText += text;
    },
    (meta) => {
      // 生成结束后做风格检测：**代码强制**，与「校验位代码强制」同一原则。
      // 只报偏离、不改稿、不重试——自动重写会引入丢稿风险（§3.4 实测改稿侧丢稿率 100%）。
      let styleCheck = null;
      if (activeProfile && streamedText.trim().length >= 50) {
        const r = checkStyle(streamedText, activeProfile, { strict: true });
        if (r.ok) {
          styleCheck = {
            deviations: r.deviations,
            skipped: r.skipped,
            tics: r.tics,
            summary: r.summary,
            confidence: r.confidence,
          };
        }
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('generate:done', { ...(meta || {}), styleCheck });
        // 生成完成：notify 含「窗口」时闪动任务栏
        if (!meta?.stopped && (config.notify === 'window' || config.notify === 'both')) {
          win.flashFrame(true);
        }
      }
      activeRequest = null;
      activeProfile = null;
      streamedText = '';
    },
    (err) => {
      if (win && !win.isDestroyed()) win.webContents.send('generate:error', err.message);
      activeRequest = null;
      activeProfile = null;
      streamedText = '';
      streamedThink = '';
    },
    // 思考分片：走独立事件，不进 streamedText
    (thinkText) => {
      streamedThink += thinkText;
      if (win && !win.isDestroyed()) win.webContents.send('generate:think', thinkText);
    }
  );
  return {
    started: true,
    guardReport: guard.report(),
    styleProfile: profile.ok
      ? { sampleCount: profile.sampleCount, confidence: profile.confidence, totalChars: profile.totalChars }
      : { unavailable: true, reason: profile.error },
  };
});

handle('generate:stop', () => {
  // ⚠ 顺序要紧：先置空 activeRequest 再取消。
  //   取消会触发 generate:done（走循环的 onDone），
  //   渲染进程就会先收到 done{stopped} 再收到一个假的 error，
  //   把「已停止」覆盖成错误提示（实测复现）。
  const req = activeRequest;
  activeRequest = null;
  activeProfile = null;
  streamedText = '';
  cancelActiveRun(req);
  if (win && !win.isDestroyed()) win.webContents.send('generate:done', { stopped: true });
  return { stopped: true };
});

/**
 * 取消一次生成。
 *
 * ⚠ activeRequest 有**两种**形状，不能只当一种处理：
 *   conv:send 现在放的是 agentLoop 的运行对象（{cancel}），
 *   generate:start（旧的「续写一章」路径）放的是 http 请求句柄（{destroy}）。
 *   只写 `req && req.destroy()` 的话，点停止会变成
 *   `req.destroy is not a function`——而那正好发生在**模型要跑危险命令、
 *   用户急着点停止**的时刻。
 */
function cancelActiveRun(req) {
  if (!req) return;
  try {
    if (typeof req.cancel === 'function') req.cancel();
    else if (typeof req.destroy === 'function') req.destroy();
  } catch (e) {
    log('取消生成时出错（不影响停止）：', e.message);
  }
}

/**
 * 窗口关闭 / 渲染进程崩溃时的清理。
 *
 * ⚠ 修掉的真 bug：原来没有任何 win.on('closed') 处理，
 * 生成过程中关窗口时 activeRequest 仍指向一个活着的请求，
 * streamedText 继续累加不重置。macOS 上 window-all-closed 不退出 app，
 * 窗口重开后主进程仍带着上一次的状态。
 */
function cleanupActiveGeneration() {
  const req = activeRequest;
  activeRequest = null;
  activeProfile = null;
  streamedText = '';
  cancelActiveRun(req);
  // ⚠ 所有还在等着的审批全部按拒绝处理。
  //   窗口都关了还挂着审批 Promise，模型会一直等下去——
  //   而审批超时是 120 秒，用户关窗后得多等两分钟才停。
  approvalGate.cancelAll();
  approvalGate.setAvailable(false);
}

// ---- 风格 ----
/**
 * 从项目已保存的章节正文构建风格画像。
 *
 * 取最近 12 章（更多收益递减且吃 IO）。**必须用 listRecentChapterContents**，
 * 不能用 listChapters —— 后者刻意不返回 content（侧栏列表不该拉全文），
 * 早期版本误用它，导致拿到 undefined、风格面板永远显示「不可用」。
 */
function buildStyleProfile(projectId) {
  try {
    const texts = store
      .listRecentChapterContents(projectId, 12)
      .filter((c) => c && c.replace(/\s/g, '').length >= 50);
    if (!texts.length) return { ok: false, error: '还没有已保存的章节，风格基准只能来自你自己的历史正文' };
    return buildProfile(texts);
  } catch (e) {
    return { ok: false, error: `风格画像构建失败：${e.message}` };
  }
}

handle('style:profile', ({ projectId }) => {
  const p = buildStyleProfile(projectId);
  if (!p.ok) return { available: false, reason: p.error };
  return {
    available: true,
    sampleCount: p.sampleCount,
    totalChars: p.totalChars,
    confidence: p.confidence,
    metrics: {
      dialogueRatio: p.dialogueRatio,
      concreteDensity: p.concreteDensity,
      simileDensity: p.simileDensity,
      psychDensity: p.psychDensity,
      idiom4Density: p.idiom4Density,
      sentenceLenCv: p.sentenceLenCv,
      shortParaRatio: p.shortParaRatio,
    },
    directive: styleDirective(p),
  };
});

/** 对任意文本跑一次风格检测（用户在编辑器里手动触发，或对已有章节体检） */
handle('style:check', ({ projectId, text }) => {
  const p = buildStyleProfile(projectId);
  if (!p.ok) return { ok: false, error: p.error };
  const r = checkStyle(text, p, { strict: true });
  return r;
});

/**
 * 系统提示词。
 *
 * ⚠ 修掉的真 bug：原来这里写着
 *   「你必须使用工具完成……1. query_world_bible 2. write_segment 3. commit_chapter」
 * 但请求体里**根本没有 tools 字段**，也没有任何工具执行循环
 * ——streamGenerate 只读 message.content，tool_calls 完全不处理。
 *
 * 后果是模型被要求调三个不存在的工具，实际行为不可预测：
 * 要么输出「我将调用 query_world_bible」这类文字（直接混进正文），
 * 要么干脆不生成内容。
 *
 * 现在的形态：**单次直写**。设定、上一章、状态、风格要求都已在
 * buildUserPrompt 里组装好，模型只需照着写。
 * 工具化 Agent 循环（run-verify.js 里那套已验证的编排逻辑）留到有真实需求时再接。
 */
const SYSTEM_PROMPT = [
  '你是长篇小说的写作助手，直接输出正文。',
  '',
  '硬性规则：',
  '- 只输出正文本身，不要输出标题、说明、分点或任何元信息。',
  '- 不得使用「设定集」与「当前状态」中没有的人名、地名、功法名。',
  '- 遇到设定里没有的实体，就用已有的那批，不要自造。',
  '- 对话用「」，不写旁白解释。',
].join('\n');

function buildUserPrompt(userPrompt, bibleText, prevTail, states, profile) {
  const lines = [];
  if (prevTail) {
    lines.push('【上一章结尾】');
    lines.push(prevTail);
    lines.push('');
  }
  if (states.length) {
    lines.push('【当前状态】');
    for (const s of states) {
      const st = s.state || {};
      const bits = [];
      if (st.location) bits.push(`在${st.location}`);
      if (st.境界) bits.push(st.境界);
      if (bits.length) lines.push(`· ${s.entity_name}：${bits.join('，')}`);
    }
    lines.push('');
  }
  lines.push('【设定集】');
  lines.push(bibleText);
  lines.push('');
  // 风格指令：只给自然语言特征，不给数字（8B 对百分比无概念，
  // 且数字会把模型注意力从写正文上引开）。无画像时整段略过。
  if (profile && profile.ok) {
    const d = styleDirective(profile);
    if (d) { lines.push(d); lines.push(''); }
  }
  lines.push('【本章任务】');
  lines.push(userPrompt || '续写下一段');
  return lines.join('\n');
}

// ---- 诊断 ----
// ---------------------------------------------------------------
// 项目文件夹与文件树（第 4 栏）
//
// ⚠ 路径越界防护全在 ProjectFs.resolveIn 里，这里只做参数转发。
//   不要在这里自己拼路径——每多一处拼法就多一个漏网的地方。
// ---------------------------------------------------------------
handle('fs:tree', ({ projectId, maxDepth, sort }) => pfs.tree(projectId, { maxDepth, sort }));

handle('fs:read', ({ projectId, path: rel }) => {
  const r = pfs.read(projectId, rel);
  // 渲染节点在主进程算好再传给渲染进程：
  // 渲染器在 electron/ 目录，渲染进程打包后跑在 asar 里，
  // 让渲染进程 require 它需要额外配别名 + 让解析器进 bundle。
  // 节点树很小（几十 KB），传输成本可以忽略。
  return { ...r, blocks: mdParse(r.content), stat: mdStat(r.content) };
});

handle('fs:write', ({ projectId, path: rel, content }) => pfs.write(projectId, rel, content));

handle('fs:create', ({ projectId, path: rel, dir, content }) => pfs.create(projectId, rel, { dir, content }));

handle('fs:rename', ({ projectId, from, to }) => pfs.rename(projectId, from, to));

handle('fs:remove', ({ projectId, path: rel, recursive }) => pfs.remove(projectId, rel, { recursive }));

handle('fs:validateName', ({ name }) => pfs.validateName(name));

/**
 * 拖拽落点：跨目录移动 / 同目录重排。
 *
 * 走 pfs.move 而不是在渲染进程里拼 fs 调用——所有路径校验
 * （越界、成环、同名）都在那边，写在这里就等于绕过它。
 */
handle('fs:move', ({ projectId, from, toDir, anchor, place }) =>
  pfs.move(projectId, from, toDir, { anchor, place }));

/** 在系统文件管理器里打开项目文件夹 */
handle('fs:reveal', ({ projectId }) => {
  const dir = pfs.projectDir(projectId);
  if (!fs.existsSync(dir)) return { ok: false, error: '文件夹不存在' };
  shell.openPath(dir);
  return { ok: true, dir };
});

// ---------------------------------------------------------------
// 更新检查
// ---------------------------------------------------------------

/**
 * 读 package.json 拿版本与发布源。
 *
 * ⚠ 打包后 package.json 在 asar 里，`require` 读得到（Electron 把 asar
 *   接进了 fs），所以这里可以直接 require；但**开发态的路径不同**，
 *   所以不写死路径，而是按两种位置依次尝试。
 *   读不到就返回 null，由 versionInfo 用默认值兜底——
 *   不能因为一个附加功能让整个主进程 require 链挂掉。
 */
function readAppPackage() {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) { /* 试下一个 */ }
  }
  return null;
}

let appPkgCache = null;
function appPackage() {
  if (!appPkgCache) appPkgCache = readAppPackage();
  return appPkgCache;
}

handle('app:version', () => versionInfo(appPackage(), app.getVersion(), config));

/**
 * 校验并保存发布页地址。
 * 不合格直接抛错（settings 层会把错误显示出来），合格则持久化。
 */
handle('app:setDownloadUrl', ({ url }) => {
  const r = validateDownloadUrl(url);
  if (!r.ok) return { ok: false, error: r.error };
  saveConfig({ downloadUrl: r.url || '' });
  return { ok: true, downloadUrl: config.downloadUrl || '' };
});

/** 打开下载页 / 安装包直链 */
handle('app:openExternal', async ({ url }) => {
  const u = String(url || '');
  // 只允许 http/https。file: 会打开本地可执行文件、javascript: 会执行代码，
  // 而这里的 url 来自配置或网络响应——不校验就等于把打开任意协议的能力给了外网。
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只允许打开 http/https 链接' };
  await shell.openExternal(u);
  return { ok: true };
});

// ---------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------
handle('trash:list', ({ projectId }) => ({
  items: trash.list(projectId),
  stats: trash.stats(projectId),
}));

handle('trash:add', ({ projectId, path: rel }) => {
  const entry = trash.add(projectId, rel);
  return { ok: true, entry };
});

handle('trash:restore', ({ projectId, id, toPath }) =>
  trash.restore(projectId, id, { toPath }));

handle('trash:purge', ({ projectId, id }) => trash.purge(projectId, id));

handle('trash:empty', ({ projectId }) => trash.empty(projectId));

// ---------------------------------------------------------------
// 数据：备份与恢复
// ---------------------------------------------------------------

/** 备份 = 复制整个项目文件夹。不压缩成 zip——用户要的是"能直接打开的副本"。 */
handle('data:backup', async ({ projectId, destDir }) => {
  const src = pfs.projectDir(projectId);
  if (!fs.existsSync(src)) return { ok: false, error: '项目文件夹不存在' };
  let target = destDir;
  if (!target) {
    const r = await dialog.showOpenDialog(win, {
      title: '选择备份保存位置',
      defaultPath: path.join(USER_DIR, 'backups'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    target = r.filePaths[0];
  }
  fs.mkdirSync(target, { recursive: true });
  // 文件夹名加时间戳，避免覆盖上一次的备份
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${projectId}-${stamp}`;
  const dest = path.join(target, name);
  fs.cpSync(src, dest, { recursive: true });
  return { ok: true, path: dest, name };
});

/** 统计备份里的内容，供界面确认 */
handle('data:inspectBackup', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择一个备份文件夹',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  const dir = r.filePaths[0];
  let files = 0;
  let bytes = 0;
  const walk = (d, depth) => {
    if (depth > 8) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p, depth + 1);
      else if (it.isFile()) { files++; try { bytes += fs.statSync(p).size; } catch (_) {} }
    }
  };
  walk(dir, 0);
  return { ok: true, dir, name: path.basename(dir), files, bytes };
});

// ---- 字体（开源字体按需下载）----
/**
 * 所有字体文件落在 userData/fonts。这里每次现算路径，
 * 因为 fontsDir 是在 whenReady 里创建的（handler 注册在模块顶层，拿不到那个 const）。
 */
const fontDir = () => path.join(app.getPath('userData'), FONT_DIR);

handle('font:presets', () =>
  FONTS.map((f) => ({
    id: f.id, label: f.label, family: f.family, file: f.file,
    sizeMB: f.sizeMB, desc: f.desc,
  }))
);

handle('font:installed', () => {
  const dir = fontDir();
  const ids = [];
  for (const f of FONTS) {
    if (fs.existsSync(path.join(dir, f.file))) ids.push(f.id);
  }
  return ids;
});

handle('font:install', async ({ id }) => {
  const f = fontById(id);
  if (!f) throw new Error('未知字体：' + id);
  const dir = fontDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, f.file);
  await downloadFile(f.url, dest, (loaded, total) => {
    if (win && !win.isDestroyed()) win.webContents.send('font:progress', { id, loaded, total });
  });
  return { id, file: f.file, size: fs.statSync(dest).size };
});

handle('font:uninstall', ({ id }) => {
  const f = fontById(id);
  if (!f) throw new Error('未知字体：' + id);
  const dest = path.join(fontDir(), f.file);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  return { id };
});

/** 生成完成时闪动任务栏窗口（notify 含「窗口」时由渲染进程调用） */
handle('app:flashFrame', () => {
  if (win && !win.isDestroyed()) win.flashFrame(true);
  return true;
});

handle('app:info', () => ({
  version: app.getVersion(),
  userDir: USER_DIR,
  dbPath: DB_PATH,
  node: process.versions.node,
  electron: process.versions.electron,
}));