const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

/**
 * AI 提供商适配层。
 *
 * ## 为什么必须是这一层，而不是"换个地址就行"
 *
 * Ollama 与 OpenAI 兼容协议（vLLM / 阿里云百炼 / OpenRouter / DeepSeek…）
 * 在**五个地方**不同，缺一个就是 400 或静默丢字段：
 *
 * | 维度 | Ollama | OpenAI 兼容 |
 * |---|---|---|
 * | 端点 | `/api/chat` | `/v1/chat/completions` |
 * | 思考参数 | `think: false\|"low"\|"medium"\|"high"` | 见下，`think` 无效 |
 * | 流式格式 | 裸 JSON，每行一个对象 | SSE：`data: {...}`，以 `data: [DONE]` 收尾 |
 * | token 计数 | `prompt_eval_count` / `eval_count` | `usage.prompt_tokens` / `usage.completion_tokens` |
 * | 模型列表 | `/api/tags` → `models[].name` | `/v1/models` → `data[].id` |
 *
 * ## 思考参数：三家三种形态（核实于 2026-10-12）
 *
 * ⚠ 这一段是查过官方文档的，不是凭记忆：
 *
 * - **Ollama**：`think` 字段。`false` 或 `"low"|"medium"|"high"`。
 *   实测 0.40.2 + qwen3 四档都接受，且**不传时默认开启**
 *   （所以"关闭"必须显式传 false，省略字段等于没关）。
 * - **阿里云百炼 / Qwen**：`enable_thinking`，**布尔**，只有开/关，没有档位。
 *   官方文档：https://help.aliyun.com/zh/model-studio/deep-thinking
 *   它不是 OpenAI 标准参数 —— Python SDK 走 `extra_body`，
 *   而**直接发 HTTP 时它是 body 的顶层字段**（与 model 同级）。
 *   ⚠ 文档明确说「须与 model 同级传入，不能放在 extra_body 中」。
 * - **OpenRouter**：`reasoning: { effort: "low"|"medium"|"high"|"max"|"xhigh"|"minimal"|"none" }`，
 *   另有顶层别名 `reasoning_effort`（两者不能同时给且不同值）。
 *   文档：https://openrouter.ai/docs/features/reasoning-tokens
 *
 * 所以"思考强度"这个 UI 概念在不同引擎下**能表达的东西不一样**：
 * 布尔型引擎只能表达"开/关"。硬把它塞进四档就是骗用户——
 * 界面上得按引擎显示对应形态，不支持的置灰。
 *
 * ## 凭据（C6）
 *
 * apiKey 只从内存里的 config 拿，**任何错误信息与日志都不含它**。
 * 这是本文件唯一接触密钥的地方，函数出口一律不回传。
 */

/**
 * 支持的协议。
 *
 * ⚠ 别把它当"地址的三种写法"——是三套真的不一样的协议：
 *   ollama     /api/chat，裸 JSON 每行一个
 *   openai     /v1/chat/completions，SSE `data: {...}` + `data: [DONE]`
 *   anthropic  /v1/messages，SSE `event: xxx` + `data: {...}` 双行，
 *               **没有 [DONE]**，结束是 `event: message_stop`
 *
 * 三处的差异集中在 authHeaders / buildRequestBody / handleLine /
 * probe&listModels 四个函数里，新增协议只改这四处。
 */
const ENGINES = ['ollama', 'openai', 'anthropic'];

/** 归一化：任何拼错的 engine 都落到 openai，不让 undefined 漏下去 */
function protoOf(cfg) {
  const e = cfg && cfg.engine;
  return ENGINES.includes(e) ? e : 'openai';
}

/** 思考参数形态 */
const THINK_FORMATS = {
  /** 布尔开/关（阿里云百炼等） */
  boolean: 'boolean',
  /** 档位字符串（Ollama、OpenRouter） */
  levels: 'levels',
  /** 不支持思考 */
  none: 'none',
};

/**
 * 各引擎的思考参数定义。
 *
 * 字段名与形态来自官方文档，见文件头注释。
 * 新增服务商时改这一处，不要在别处 if/else。
 */
const THINK_SPEC = {
  ollama: {
    format: THINK_FORMATS.levels,
    /** Ollama 的 think 直接接受这些值 */
    levels: { off: false, low: 'low', medium: 'medium', high: 'high' },
    /** 响应里思考内容的字段名 */
    replyField: 'thinking',
  },
  'openai-compatible': {
    format: THINK_FORMATS.levels,
    /**
     * OpenRouter 的字段是对象 {effort}，且有顶层别名。
     * 阿里云百炼是布尔、字段名不同、且必须是顶层。
     * 两者不能共用一套参数，所以这里只放"通用默认"，
     * 具体服务商由 config.thinkStyle 决定（见 buildThinkParams）。
     *
     * ⚠ 'on' 这一档是为百炼的界面准备的：
     *   布尔型引擎没有 low/medium/high 的区分，界面上给它
     *   「关闭 / 开启」两个按钮，值分别是 off / on。
     *   第一版这里只映射了 off/low/medium/high，于是用户点「开启」
     *   拿到 {ok:false}、请求体里没有思考字段 ——
     *   表现为"开关点了没反应"��而且不报错。
     */
    levels: {
      off: 'none', on: 'high', low: 'low', medium: 'medium', high: 'max',
    },
    replyField: 'reasoning_content',
  },
};

/**
 * 思考参数形态的中文说明，界面上直接用。
 * 避免界面里写死一套文案、与这里的实际能力脱节。
 */
const THINK_LABEL = {
  boolean: '开 / 关（该服务商只支持这两种）',
  levels: '关闭 / 低 / 中 / 高',
  none: '该引擎不支持思考',
};

/**
 * 把设置里的 thinkLevel 翻译成某个引擎的实际请求字段。
 *
 * @param {string} engine  'ollama' | 'openai-compatible'
 * @param {string} level   'off' | 'low' | 'medium' | 'high' | 'default'
 * @param {object} [opt]
 * @param {string} [opt.thinkStyle] 服务商风格，默认 'openrouter'
 *   'dashscope' → enable_thinking（布尔，顶层）
 *   'openrouter' → reasoning.effort（档位，顶层）
 * @returns {{ok:boolean, fields?:object, note?:string, error?:string}}
 */
function buildThinkParams(engine, level, opt = {}) {
  const spec = THINK_SPEC[engine];
  if (!spec) return { ok: false, error: `未知引擎：${engine}` };

  const lv = String(level == null ? 'off' : level).toLowerCase();

  /**
   * ⚠⚠ 'default' 不是档位，是"不下发"（2026-10-14）。
   *   用户点「默认」的意思是"按服务商自己那套来，别替我决定"，
   *   所以这里必须返回**空 fields** —— 不能落到下面的
   *   `hasOwnProperty` 判断里报「未知的思考强度」，
   *   更不能因为报错而被上层当异常处理、连带整次生成失败。
   *
   *   fields: {} 而非 undefined：上层是 Object.assign({}, ...fields)，
   *   undefined 会抛 Object.assign 收到 undefined。
   */
  if (lv === 'default') {
    return { ok: true, fields: {}, note: 'default（不下发思考字段）' };
  }

  if (!Object.prototype.hasOwnProperty.call(spec.levels, lv)) {
    return { ok: false, error: `未知的思考强度：${level}` };
  }
  const value = spec.levels[lv];

  if (engine === 'ollama') {
    // ⚠ 不能省略 false —— 实测不传 think 时 Ollama 默认开着思考。
    return { ok: true, fields: { think: value }, note: `think=${JSON.stringify(value)}` };
  }

  // OpenAI 兼容系：两种服务商形态
  const style = opt.thinkStyle || 'openrouter';
  /**
   * 顶层布尔 `enable_thinking` 这一形态。
   *
   * ⚠⚠ 2026-10-15 加的 'enable-thinking' 这个名字，起因是一个真故障：
   *   羽毛菌在**硅基流动**上用 Qwen/Qwen3-8B，档位选「关闭」，
   *   而请求里发的是 openrouter 那套 `reasoning:{effort:'none'}` ——
   *   硅基流动不认这个字段，**思考根本没关**。
   *   实测同一条提问，四种发法的耗时与思考量：
   *     reasoning.effort=none（旧行为）  14751ms  思考 590 字
   *     enable_thinking=false            1577ms  思考   0 字   ← 只有这个真关住了
   *     chat_template_kwargs…            12965ms  思考 581 字
   *     什么都不发                        12829ms  思考 561 字
   *   也就是**快了 9 倍**，而且正文才是模型真正要给的东西。
   *
   * ⚠ 顺带核过：这个字段给不支持思考的模型（Qwen2.5-7B-Instruct）
   *   也不会 400 —— 服务端直接忽略。所以按服务商整家下发是安全的，
   *   不必再按模型名猜。
   *
   * 'dashscope' 保留原名（百炼早就用它，改了会牵动一堆用例），
   * 两者**字段完全一样**，只是名字分别对上各自的文档叫法。
   */
  if (style === 'dashscope' || style === 'enable-thinking') {
    // 布尔型，档位压成开/关（medium 与 high 都算"开"）
    const on = value !== 'none';
    return {
      ok: true,
      fields: { enable_thinking: on },
      note: on
        ? `enable_thinking=true（该服务商只有开/关，${lv} 与高都是"开"）`
        : 'enable_thinking=false',
    };
  }
  // 智谱：对象型 thinking: {type:'enabled'|'disabled'}
  //
  // ⚠ 别把它并进 dashscope：那是顶层布尔 enable_thinking，
  //   字段名与形态都不同，发过去服务端不认。
  //   来源：智谱开放平台文档（GLM 的 thinking 对象）。
  if (style === 'zhipu') {
    const on = value !== 'none';
    return {
      ok: true,
      fields: { thinking: { type: on ? 'enabled' : 'disabled' } },
      note: on ? 'thinking.type=enabled（对象型）' : 'thinking.type=disabled',
    };
  }
  // openrouter：顶层 reasoning 对象
  return {
    ok: true,
    fields: { reasoning: { effort: String(value) } },
    note: `reasoning.effort=${value}`,
  };
}

/** 把 base + path 拼成完整 URL，并去掉结尾多余的斜杠 */
function joinUrl(base, p) {
  return String(base || '').replace(/\/+$/, '') + p;
}

/** 从 base 里抠出协议，缺省按 http（vLLM 默认不带 TLS） */
function parseBase(base) {
  let u;
  try {
    u = new URL(String(base || ''));
  } catch (_) {
    throw new Error(`地址不合法：${base || '(空)'}`);
  }
  if (!/^https?:$/.test(u.protocol)) {
    throw new Error(`只支持 http / https，收到 ${u.protocol.replace(':', '')}`);
  }
  return u;
}

/**
 * 模型列表路径兜底（当 cfg 没带 modelsPath 时，例如单测直传的精简 cfg）。
 *
 * ⚠⚠ 2026-10-14 修：之前 listModels / probe 把模型路径**写死 `/v1/models`**，
 *   而硅基流动这类 base 已带 `/v1` 的服务商拼出 `/v1/v1/models` 直接 404。
 *   现在优先用 cfg.modelsPath（来自预置表，已包含正确版本段），
 *   这里只在缺省时按引擎给一个合理默认。
 */
function defaultModelsPath(engine) {
  if (engine === 'ollama') return '/api/tags';
  if (engine === 'anthropic') return '/v1/models';
  return '/models';
}

/**
 * 对话路径（相对 base）。
 *
 * ⚠ 优先用 cfg.chatPath（来自预置表，已含正确版本段）；
 *   兜底按引擎给默认。之前写死 `/v1/chat/completions` 会把
 *   base 已带 `/v1` 的服务商拼成双 `/v1` 而 404。
 */
function chatPathFor(cfg) {
  if (cfg && cfg.chatPath) return cfg.chatPath;
  const engine = protoOf(cfg);
  if (engine === 'ollama') return '/api/chat';
  if (engine === 'anthropic') return '/v1/messages';
  return '/v1/chat/completions';
}

/**
 * 发一个 HTTP 请求，返回 Buffer。
 *
 * ⚠ 超时是**墙钟超时**：从建立连接到收到第一个字节算起。
 *   生成正文可能要几分钟，所以这个值由调用方按场景传，
 *   探测类请求传 3~5 秒，生成请求传分钟级。
 */
function httpRequest(url, opt = {}) {
  const {
    method = 'GET', headers = {}, body = null,
    timeout = 30000,
  } = opt;

  return new Promise((resolve, reject) => {
    let u;
    try { u = parseBase(url); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;

    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          accept: payload ? 'application/json' : '*/*',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      }
    );
    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy(new Error(`响应超时（${Math.round(timeout / 1000)} 秒没有数据）`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 鉴权头。
 *
 * ⚠ Ollama 本地通常不需要 key，给了也无害（服务端忽略未知头）。
 *   vLLM 若启用了 --api-key 则必须要。
 */
function authHeaders(cfg) {
  const key = cfg.apiKey ? String(cfg.apiKey) : '';
  const engine = protoOf(cfg);
  if (engine === 'anthropic') {
    // ⚠ Anthropic 的鉴权与 OpenAI 有两处不同（已查官方文档核实）：
    //   1. 头是 `x-api-key`，**不是** Authorization: Bearer
    //   2. `anthropic-version` 是**必填**，缺了整个请求 400
    //   只给 x-api-key 而漏了 version，是这一族最常见的 400。
    // ⚠ 没有 key 时也要给 version（值随便填）：不少本地中转不校验
    //   key，但没有 version 头它会直接拒。宁可给个假值也别让请求早失败。
    return {
      'x-api-key': key || 'not-set',
      'anthropic-version': '2023-06-01',
    };
  }
  if (!key) return {};
  return { authorization: `Bearer ${key}` };
}

/**
 * 探测：能不能连上、有哪些模型。
 *
 * 错误信息里**不带 apiKey**——哪怕它出现在地址里也不例外。
 *
 * ⚠⚠ 2026-10-14 修「接入不行」：
 *   原来先发一个写死的 `/v1/models` 探版本号，再发 `/v1/models` 列模型。
 *   对 base 已经带 `/v1` 的服务商（硅基流动等）这一步直接 404，
 *   于是「测试连接」永远失败、却没有任何有用提示。
 *   改法：OpenAI 兼容 / Anthropic 不单独探版本，**直接用模型列表接口**
 *   同时验证「能连上 + key 有效」；只有 Ollama 才先探 `/api/version`
 *   （它的版本端点是独立的健康探测）。路径全部走 cfg.modelsPath
 *   （来自预置表，含正确版本段），不再写死 `/v1`。
 *
 * @returns {Promise<{ok:boolean, engine:string, base?:string, version?:string, models?:string[], error?:string}>}
 */
async function probe(cfg) {
  const engine = protoOf(cfg);
  const modelsPath = cfg.modelsPath || defaultModelsPath(engine);

  let base;
  try { base = joinUrl(cfg.base, ''); } catch (e) {
    return { ok: false, engine, error: e.message };
  }

  /**
   * Ollama 的特殊处理：先探 `/api/version`（独立健康端点）。
   * 拿不到版本号说明服务没正常起来，比直接列模型更早给出信号。
   * 其余引擎没有「版本」这个概念，跳过，直接去列模型。
   */
  let version;
  if (engine === 'ollama') {
    try {
      version = await safeVersion(cfg);
    } catch (e) {
      return { ok: false, engine, base, error: friendlyError(e, engine, base, cfg.apiKey) };
    }
    if (version === undefined) {
      return {
        ok: false, engine, base,
        error: '连上了但拿不到版本号（Ollama 服务可能没正常响应）。',
      };
    }
  }

  // 连通性 + 鉴权：拉模型列表。200 = 通且 key 有效；
  // 401/403 = key 问题；连不上 = 网络/地址问题。这一发同时验证两件事。
  let modelsHttp;
  try {
    modelsHttp = await httpRequest(joinUrl(base, modelsPath), {
      headers: authHeaders(cfg),
      timeout: 5000,          // 探测不能等太久，用户会以为界面卡了
    });
  } catch (e) {
    return { ok: false, engine, base, error: friendlyError(e, engine, base, cfg.apiKey) };
  }
  if (modelsHttp.status >= 400) {
    return {
      ok: false, engine, base, models: [],
      error: describeHttp(modelsHttp.status, modelsHttp.text, engine, cfg.apiKey),
    };
  }

  const models = await listModels(cfg, modelsHttp.text);
  return { ok: true, engine, base, version, models };
}

async function safeVersion(cfg) {
  try {
    const res = await httpRequest(joinUrl(joinUrl(cfg.base, ''), '/api/version'), {
      headers: authHeaders(cfg), timeout: 3000,
    });
    if (res.status >= 400) return undefined;
    return (JSON.parse(res.text) || {}).version;
  } catch (_) {
    return undefined;   // 版本号拿不到不是致命问题，不该让整个探测失败
  }
}

/**
 * 列模型。
 *
 * @param {object} cfg
 * @param {string} [prefetched] 探测时已经拿到的模型列表正文，避免重复请求。
 *   不传就自己发一次。失败返回空数组——探测已经确认过能连上了，这里不必再抛。
 */
async function listModels(cfg, prefetched) {
  const engine = protoOf(cfg);
  const p = cfg.modelsPath || defaultModelsPath(engine);
  let j;
  if (prefetched != null) {
    try { j = JSON.parse(prefetched); } catch (_) { return []; }
  } else {
    try {
      const res = await httpRequest(joinUrl(joinUrl(cfg.base, ''), p), {
        headers: authHeaders(cfg), timeout: 5000,
      });
      if (res.status >= 400) return [];
      j = JSON.parse(res.text);
    } catch (_) {
      return [];
    }
  }
  if (engine === 'ollama') {
    return (j.models || []).map((m) => m.name).filter(Boolean);
  }
  // ⚠ OpenAI 兼容是 data[].id，Anthropic 是 data[].id 但常被中转
  //   改成 data[].name。两种都收，否则部分中转会一个模型都列不出来。
  return (j.data || [])
    .map((m) => m.id || m.name)
    .filter(Boolean);
}

/**
 * 把 HTTP 错误码翻译成用户能看懂的话。
 *
 * 401/403 是最高频的一类（key 填错、没填、vLLM 开了鉴权），
 * 而服务端返回的原文往往是英文或一段 JSON。
 */
function describeHttp(status, text, engine, secret) {
  const t = redactKey(String(text || '').slice(0, 400), secret);
  if (status === 401 || status === 403) {
    return `鉴权失败（${status}）。检查 API 密钥是否填对、有没有过期。`
      + (engine === 'ollama'
        ? '（本地 Ollama 默认不需要密钥；如果设了反向代理才需要）'
        : '');
  }
  if (status === 404) {
    return `接口不存在（404）。地址可能写错了——`
      + (engine === 'ollama'
        ? 'Ollama 应该是 /api 之前的服务根地址，例如 http://127.0.0.1:11434'
        : 'OpenAI 兼容应该是到 /v1 之前，例如 https://xxx.com/v1');
  }
  if (status === 429) return '请求太频繁或额度用尽（429）。稍后再试。';
  if (status >= 500) return `服务端出错（${status}）。${t}`;
  return `请求失败（${status}）。${t}`;
}

/**
 * 把密钥从任意文本里抹掉。
 *
 * ⚠ 这不是洁癖：服务端报错时**经常把请求头回显在错误正文里**
 *   （尤其是 401 与网关层的错误），用户截图发到论坛就等于公开了密钥。
 *   实测路径：`describeHttp(500, 'stack with sk-xxx')` 直接把原文拼了出去。
 *
 * 只在**日志与错误信息**里调用；发请求时用原始密钥。
 */
function redactKey(text, secret) {
  const s = String(text == null ? '' : text);
  const k = secret ? String(secret) : '';
  if (!k) return s;
  // 顺带抹掉常见的 sk- 前缀形式，即便传进来的 secret 不完整
  let out = s.split(k).join('（密钥已隐藏）');
  if (k.length >= 8) {
    const tail = k.slice(-4);
    const head = k.slice(0, Math.min(6, k.length - 4));
    out = out.split(head + tail).join('（密钥已隐藏）');
  }
  return out;
}

/** 网络层错误翻译。ECONNREFUSED 是"服务没启动"的最常见信号。 */
function friendlyError(e, engine, base, secret) {
  const code = e && e.code;
  const host = (() => { try { return new URL(base).host; } catch (_) { return base; } })();
  if (code === 'ECONNREFUSED') {
    return `连不上 ${host}（端口没开）。`
      + (engine === 'ollama'
        ? '请确认已运行 ollama serve。'
        : '请确认服务已启动、地址与端口对。');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `域名解析失败：${redactKey(host, secret)}。检查地址有没有拼错。`;
  }
  if (code === 'ETIMEDOUT' || /超时/.test(String(e && e.message))) {
    return `连接 ${host} 超时。可能是网络不通，或者该服务需要代理。`;
  }
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || /self.signed|unable to verify/i.test(String(e && e.message))) {
    return '证书校验失败（自签名）。企业内网的 HTTPS 常这样——请改用 http，或换成受信任的证书。';
  }
  return `连接失败：${redactKey(e && e.message ? e.message : String(e), secret)}`;
}

/**
 * 建请求体。
 *
 * ⚠ num_predict / max_tokens 的换算是**实测定的**，不是拍的：
 *   Ollama 侧实测（0.40.2 + qwen3 8B）num_predict=500 时
 *   thinking 吃掉 477 字、content 一片都没有；给到 3000 才正常出正文。
 *   所以开思考时必须给足，否则用户看到的是"转圈但一个字都没有"。
 */
function buildRequestBody(cfg, messages, opt = {}) {
  const engine = protoOf(cfg);
  const temperature = opt.temperature ?? cfg.temperature ?? 0.3;
  const numCtx = Number(cfg.numCtx) || 8192;
  /**
   * 要不要开思考（2026-10-14 改）。
   *
   * ⚠⚠ 'default'（"按服务商默认"）必须和 'off' 一样**不下发任何思考字段**。
   *   原来只有 `!== 'off'` 一个条件，于是 'default' 落进"要思考"那一侧，
   *   给 Ollama 发了 think:true、给云端发了 reasoning.effort ——
   *   而用户点「默认」的意图恰恰是"别替服务商做决定"。
   *
   *   判据：只有用户**明确挑了某个具体档位**才下发。
   *   空、default、off 三种都不下发，区别只在界面显示，不在请求体。
   */
  const lv = String(cfg.thinkLevel == null ? '' : cfg.thinkLevel).toLowerCase();
  const explicit = !!lv && lv !== 'off' && lv !== 'default';
  const wantThink = explicit;

  /**
   * 输出上限。
   *
   * ⚠⚠ 必须从 numCtx 里**独立出来**（2026-10-13 修）：
   *   原来三家都用 numCtx 推算，系数 0.5/0.75。云端模型
   *   窗口动辄 128K，却因为本地那个"省显存"的 8192 只能输出
   *   4096 token ≈ 3000 字中文 —— 写一章正文被拦腰截断而不报错。
   *   这两件事本来就没关系：numCtx 管的是**能装多少前文**（受显存约束），
   *   maxOutput 管的是**一次能写多长**（受服务端限制）。
   *
   * 兜底**按引擎分开算**（老配置里没有 maxOutput）：
   *   本地仍取 numCtx 的 75% —— Ollama 的 num_predict 确实不该超过窗口太多
   *   （超过会挤掉前文，写长篇时会"忘记"开头的设定）。
   *   云端取固定 8192 —— ⚠ 云端的 numCtx 只是从本地配置沿袭下来的一个数，
   *   跟它的输出能力毫无关系。用它推算（8192*0.75=6144）等于
   *   让云端继续跟着本地的显存参数走，正是这次要修的那个 bug。
   */
  const maxOut = Number(opt.maxTokens) || Number(cfg.maxOutput) || 0;
  const outLimit = maxOut > 0
    ? maxOut
    : (engine === 'ollama' ? Math.max(1024, Math.round(numCtx * 0.75)) : 8192);

  /**
   * ⚠ 本地还有一条物理约束：num_predict 吃的是窗口里的份额。
   *   窗口 8192 却要输出 32768，多出来的部分会把前文挤掉 ——
   *   写长篇时表现为"写着写着忘了开头的设定"，而用户只会觉得模型笨。
   *   所以本地按窗口的 75% 封顶（留 25% 给前文与设定）。
   *
   *   云端不做这个封顶：它的窗口本来就大得多，截断该由服务端管。
   */
  const outCap = Math.max(1024, Math.round(numCtx * 0.75));
  const wantOut = engine === 'ollama'
    ? Math.min(outLimit, outCap)     // 本地：输出吃的是窗口里的份额，必须封顶
    : Math.max(1024, outLimit);      // 云端：窗口大得多，按用户设的来

  if (engine === 'ollama') {
    const t = buildThinkParams('ollama', cfg.thinkLevel);
    // ⚠⚠ 档位不认识时必须拒绝：
    //   原来 t.error 从没人看过，而 ...undefined 是合法展开 ——
    //   思考参数会静默消失，界面照样亮着，用户以为在用高档位。
    if (!t.ok) return { ok: false, error: t.error };
    const body = {
      model: cfg.model,
      messages,
      stream: true,
      ...t.fields,
      options: {
        temperature,
        top_p: 0.9,
        num_ctx: numCtx,
        num_predict: wantOut,
      },
      keep_alive: '15m',
    };
    // ⚠ Ollama 的 tools 是**顶层字段**，而且格式与 OpenAI 相同
    //   （type:'function' + function:{name,description,parameters}）。
    //   但只发非空数组：给一个 tools: [] 有些版本会报 400。
    if (opt.tools && opt.tools.length) body.tools = opt.tools;
    return { ok: t.ok, error: t.error, note: t.note, body };
  }

  // ---- Anthropic Messages ----
  //
  // 与 OpenAI 的四处硬差异（已查官方文档核实，不是猜的）：
  //  1. system 是**顶层字段**，不是 messages 里的 role:'system'。
  //     把它塞进 messages 会被拒或被当成一条奇怪的用户消息。
  //  2. max_tokens **必填**，没有默认值。OpenAI 那边可以不发。
  //  3. 思考是 thinking: {type:'enabled', budget_tokens:N}，对象型。
  //  4. assistant 消息的内容是数组 [{type:'text',text:...}] 而非字符串。
  if (engine === 'anthropic') {
    const sys = [];
    const rest = [];
    for (const m of messages) {
      if (m.role === 'system') {
        // 多条 system 拼起来。Anthropic 只接受一个顶层 system。
        sys.push(String(m.content == null ? '' : m.content));
      } else {
        rest.push(m);
      }
    }
    /**
     * ⚠⚠ Anthropic 的 max_tokens 是**总输出预算**，thinking token 也吃它。
     *   而用户设的 maxOutput 说的是"正文要多少"。
     *   所以开思考时必须把思考预算**加在上面**，不是取 max ——
     *   原来的 `Math.max(4096, wantOut)` 在 wantOut=8192 时仍然是 8192，
     *   thinking 吃掉一半，正文只剩 4096：用户看到的是"转了半天圈没字"。
     *
     *   opt.maxTokens 是调用方显式指定的总预算（比如某次重写写死），
     *   那种情况不再往上加 —— 调用方自己知道它要什么。
     */
    const textOut = opt.maxTokens || wantOut;
    const thinkBudget = wantThink ? Math.max(1024, Math.round(textOut * 0.5)) : 0;
    const maxTok = opt.maxTokens ? textOut : textOut + thinkBudget;

    const body = {
      model: cfg.model,
      // ⚠ 必须保证第一条是 user。Anthropic 不接受开头是 assistant，
      //   而我们的历史里第一条可能是 system（已被剥掉）或 user。
      messages: rest.length && rest[0].role !== 'user'
        ? [{ role: 'user', content: '(继续)' }, ...rest]
        : rest,
      // ⚠ 必填，没有默认值。
      // ⚠ 不再从 numCtx 推算：那会让云端跟着本地的显存参数走（见 wantOut 注释）。
      max_tokens: maxTok,
      stream: true,
    };
    if (sys.length) body.system = sys.join('\n\n');
    // ⚠ Anthropic 的 tools 里**不能有 type:'function'**，
    //   它只有 {name, description, input_schema}。
    //   照抄 OpenAI 那份会直接 400（invalid_request_error）。
    if (opt.tools && opt.tools.length) {
      body.tools = opt.tools.map((t) => {
        const f = t.function || t;
        return {
          name: f.name,
          description: f.description || '',
          input_schema: f.parameters || { type: 'object', properties: {} },
        };
      });
    }
    if (wantThink) {
      body.thinking = {
        type: 'enabled',
        // ⚠ budget_tokens 必须 < max_tokens，否则服务端 400。
        //   用上面那个同一个 thinkBudget，别再从 max_tokens 反推 ——
        //   max_tokens 已经含了它，反推会算出另一个数，两个值对不上。
        budget_tokens: thinkBudget,
      };
      // ⚠ 开 extended thinking 时 temperature 只能为 1，
      //   给别的值 Anthropic 会直接报错。
      body.temperature = 1;
    } else {
      body.temperature = temperature;
    }
    return { ok: true, note: wantThink ? 'thinking enabled' : undefined, body };
  }

  // ---- OpenAI 兼容 ----
  const t = buildThinkParams('openai-compatible', cfg.thinkLevel, {
    thinkStyle: cfg.thinkStyle || 'openrouter',
  });
  // ⚠⚠ 同 ollama 分支：error 必须查。
  //   这里写的是 `...(t.fields || {})` —— 显式吞掉了 undefined，
  //   于是「档位不认识」彻底静默：思考参数不见了，界面上那档还亮着。
  if (!t.ok) return { ok: false, error: t.error };
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    temperature,
    ...(t.fields || {}),
  };
  // ⚠ OpenAI 兼容：tools 与 messages 同级，格式就是标准 OpenAI 那份。
  //   空数组不发 —— 部分中转会因为"有 tools 但 messages 里没有
  //   tool 消息"而报 400，宁可不发让它走纯对话。
  if (opt.tools && opt.tools.length) body.tools = opt.tools;
  // ⚠ OpenAI 兼容服务对未知字段常直接 400，所以只在开思考时才发
  //   max_completion_tokens（有的服务不认这个、不认 max_tokens）。
  // ⚠ 同上：不再从 numCtx 推算。云端模型窗口 128K 起，
  //   输出上限不该被一个"省本地显存"的 8192 压成 4096。
  if (wantThink) {
    body.max_tokens = opt.maxTokens || Math.max(2048, wantOut);
  } else {
    body.max_tokens = opt.maxTokens || wantOut;
  }
  if (cfg.thinkStyle === 'dashscope' && cfg.includeUsage) {
    body.stream_options = { include_usage: true };
  }
  return { ok: t.ok, error: t.error, note: t.note, body };
}

/**
 * 流式生成。
 *
 * @param {object} cfg  {engine, base, apiKey, model, numCtx, temperature, thinkLevel, thinkStyle}
 * @param {Array} messages
 * @param {object} handlers
 * @param {function(string)} handlers.onChunk   正文分片
 * @param {function(string)} [handlers.onThink]  思考分片
 * @param {function(object)} [handlers.onDone]   {ms, tokensIn, tokensOut, hadThinking}
 * @param {function(Error)} handlers.onError
 * @param {AbortSignal} [handlers.signal]
 * @returns {function():void} 取消函数
 */
/**
 * 流式聊天。
 *
 * @param {object} cfg
 * @param {Array} messages
 * @param {object} handlers
 * @param {Array} [handlers.tools] 要下发给模型的工具定义（不给就纯对话）
 * @param {Array} [handlers.onToolCalls] 收到 (calls) 时回调：
 *        calls = [{id, name, arguments}]。args 已 JSON.parse。
 * @param {Function} handlers.onChunk
 * @param {Function} handlers.onDone
 * @param {Function} handlers.onError
 */
function chatStream(cfg, messages, handlers = {}) {
  const engine = protoOf(cfg);
  // ⚠ 路径走 chatPathFor：优先用 cfg.chatPath（来自预置表，含正确版本段），
  //   不再写死 `/v1/chat/completions`——否则 base 已带 `/v1` 的服务商
  //   会拼成双 `/v1` 而 404（2026-10-14 修）。
  const path = chatPathFor(cfg);
  const built = buildRequestBody(cfg, messages, {
    tools: handlers.tools,
  });
  if (!built.ok) {
    setTimeout(() => handlers.onError && handlers.onError(new Error(built.error)), 0);
    return () => {};
  }

  const url = joinUrl(joinUrl(cfg.base, ''), path);
  let u;
  try { u = parseBase(url); } catch (e) {
    setTimeout(() => handlers.onError && handlers.onError(e), 0);
    return () => {};
  }
  const lib = u.protocol === 'https:' ? https : http;
  const payload = Buffer.from(JSON.stringify(built.body), 'utf8');
  const t0 = Date.now();
  /**
   * 每一轮都留一行"发出去了什么"，含**工具数与请求体字节数**。
   *
   * ⚠ 字节数比 message 条数有用得多：带了三份设定文件时，
   *   条数可能只有 2 条，正文却有几十万 token ——
   *   而"模型跑了很久一个字不出"最常见的原因就在这里。
   */
  emitLog(`[chat] 发出 ${engine} ${u.hostname}${u.pathname}`
    + ` model=${cfg.model} 工具=${(handlers.tools || []).length}`
    + ` 消息=${messages.length} 正文=${payload.length}字节`
    + ` 思考=${cfg.thinkLevel || 'off'} 窗口=${Number(cfg.numCtx) || 8192}`);

  /**
   * ⚠ 消息**结构**摘要（2026-10-19 加）。
   *
   * 空响应连续两次都发生在"带多组 tool_calls 的第 4 轮"，
   * 而日志里只有条数（`消息=13`）—— 这 13 条长什么样完全看不出来：
   * 有几组 assistant+tool 配对、assistant 的 content 是不是空串，全都不知道，
   * 只能靠猜。
   *
   * 记号：s=system u=user a=assistant t=tool，后缀 `!` 表示这条带 tool_calls。
   * 例：`s u a! t a! t a! t t` = 三轮工具调用。
   */
  emitLog('[chat] 结构 ' + messages.map((m) => {
    const r = String((m && m.role) || '?')[0];
    const hasCalls = Array.isArray(m && m.tool_calls) && m.tool_calls.length > 0;
    return hasCalls ? `${r}!` : r;
  }).join(' '));

  // 开思考时墙钟超时要给得长很多：实测 thinking 字数 949~1347，
  // 加上正文，整轮可能好几分钟。
  const thinking = cfg.thinkLevel && cfg.thinkLevel !== 'off';
  const timeout = Number(cfg.wallClockMs) || (thinking ? 10 * 60 * 1000 : 5 * 60 * 1000);

  let buf = '';
  let thinkSeen = false;
  let done = false;
  let finish = null;
  let gotText = 0;          // 只为日志：正文累计字数

  /**
   * 工具调用的**累加器**。
   *
   * ⚠⚠ 不能每帧直接回调 —— 流式协议会把一次工具调用拆成很多帧：
   *   OpenAI 先来一帧 {id, name}，再逐帧来 arguments 的片段
   *   ("{"、'"comm'、"and"'…)，最后一帧才补完 index。
   *   边收边回调的话，上层会拿到十几个半截的参数，
   *   而 JSON.parse 在半截上必然抛。
   *
   *   所以：按 id/index 累积，done 时统一解析并回调一次。
   */
  const toolAcc = new Map();
  const onToolFrame = (frag) => {
    if (!frag) return;
    const key = frag.index != null ? `i${frag.index}` : (frag.id || frag.name || 'x');
    const prev = toolAcc.get(key) || { id: frag.id, name: '', args: '' };
    if (frag.id) prev.id = frag.id;
    // ⚠ name 只在**第一帧**有。若跟着每帧都拼，会变成
    //   "web_searchweb_searchweb_search" —— 上层拿到一个不存在的工具名，
    //   于是回一句"不认识的工具"，而模型会一直重试同一个调用。
    //   （OpenAI 那边有些中转确实分片发 name，所以这里也不能简单忽略。）
    //   折中：同名就不重复加，不同名才拼。
    if (frag.name && frag.name !== prev.name) prev.name = (prev.name || '') + frag.name;
    if (typeof frag.arguments === 'string') prev.args += frag.arguments;
    else if (frag.arguments) {
      // Ollama 有时直接给完整对象而不是字符串片段
      try { prev.args = JSON.stringify(frag.arguments); } catch (_) { /* 忽略 */ }
    }
    toolAcc.set(key, prev);
  };
  const flushTools = () => {
    if (!handlers.onToolCalls || !toolAcc.size) return;
    const calls = [];
    for (const c of toolAcc.values()) {
      let args = {};
      if (c.args && c.args.trim()) {
        try { args = JSON.parse(c.args); }
        catch (_) {
          // ⚠ 解析不了就明说，不能给一个空对象 —— 那会让上层
          //   拿着 {} 去执行一条"没有命令"的终端调用。
          calls.push({ id: c.id, name: c.name, args: {},
                        parseError: `参数不是合法 JSON：${c.args.slice(0, 120)}` });
          continue;
        }
      }
      calls.push({ id: c.id, name: c.name, args });
    }
    toolAcc.clear();
    if (calls.length) handlers.onToolCalls(calls);
  };

  const finishOnce = (meta) => {
    if (done) return;
    /**
     * ⚠⚠⚠ 空响应必须当失败（2026-10-19 羽毛菌现场，两次）。
     *
     * 第一次：DeepSeek 返回 200，56 秒后给空流，正文 0 字。
     * 第二次：同样是 200 + 50 秒，日志里 `正文=0字`，**但 thinkSeen 为真** ——
     *   服务端推了思考内容、正文一个字没有。
     *
     * 而上一版的判定是 `gotText===0 && toolAcc.size===0 && !thinkSeen`，
     * 那个 `!thinkSeen` 把第二种形态放了过去 —— 于是：
     *   · 走的是正常 onDone
     *   · `out` 是空 → `if (out.trim())` 不成立 → **助手消息根本不落库**
     *   · 界面上一条 AI 回复都没有，也没有任何错误
     *   · 用户看到的就是"点了发送，什么都没发生"
     *
     * ## 判定改成只看"用户能不能看到东西"
     *
     * 有思考没正文，用户**依然什么都看不到**（思考是折叠的、也不会落库）。
     * 所以不看 thinkSeen —— 只要正文和工具都没有，就是失败。
     * 思考量只用来**区分文案**（"思考了很久但没写出来"比"返回空内容"更有用）。
     */
    if (gotText === 0 && toolAcc.size === 0) {
      emitLog(`[chat] 空响应 ${Date.now() - t0}ms —— 正文 0 字、无工具`
        + `${thinkSeen ? '、但有思考内容' : ''}`);
      const err = new Error(
        (thinkSeen
          ? '模型思考了很久，但正文一个字都没写出来（服务端返回了空内容）。'
          : '模型这次没有返回任何内容。')
        + '已自动重试，仍失败。常见原因：① 服务端超时/过载，'
        + '② 设定里的内容触发了平台审核。前者隔几分钟再试，后者把措辞调整一下。'
      );
      err.code = 'EMPTY_RESPONSE';
      err.hadThinking = !!thinkSeen;
      failOnce(err);
      return;
    }
    done = true;
    if (finish) clearTimeout(finish);
    emitLog(`[chat] 结束 ${Date.now() - t0}ms`
      // ⚠ 写「工具定义」而不是「工具」：这个数是**下发的工具个数**，
      //   不是调用次数。写成「工具=6」会让人误以为调了 6 次（2026-10-19 踩过）。
      + ` 正文=${gotText}字 工具定义=${(handlers.tools || []).length}`);
    // 顺序要紧：**先**把攒下的工具调用发出去，**再**发 done。
    //   反过来的话主循环会在 done 里先把 activeRequest 清掉、
    //   落库结束，工具调用就没人接了。
    flushTools();
    handlers.onDone && handlers.onDone({
      ms: Date.now() - t0,
      ...meta,
    });
  };
  const failOnce = (e) => {
    if (done) return;
    done = true;
    if (finish) clearTimeout(finish);
    handlers.onError && handlers.onError(e);
  };

  /**
   * ⚠⚠⚠ socket 超时**必须显式设**，而且不能是 5 秒（2026-10-15 修）。
   *
   * 现场：羽毛菌发一条 78463 字节的真实请求，日志是
   *   [chat] TCP 已连接 api.siliconflow.cn:443
   *   [chat] socket 超时 api.siliconflow.cn（已 5081ms 没收到任何字节）
   *   [chat] 失败 … msg=连接超时
   *
   * 5081 ≈ 5000 —— 而 `http.request` 的 options 里**根本没有 timeout**，
   * 裸 Node 默认也不超时（0）。是 **Electron 主进程给 socket 设了 5 秒默认**，
   * 实测（diag-bigpayload.js）打印出来就是 `socket.timeout=5000`。
   *
   * 后果：**任何首字节超过 5 秒的请求都会被掐掉**，而界面上只显示
   * 「连接 xxx 超时」—— 那是个彻头彻尾的**假象**：连接是通的（TCP 已连接），
   * 掐掉它的是我们自己。
   *
   * 为什么要给这么长：生成类请求的首字节本来就可能几十秒
   *（本地模型冷启动要几分钟，8B 模型开思考更久）。5 秒是"探测"的值，
   * 不是"生成"的值 —— 探测走的是 `httpRequest`（那里 3~5 秒是对的）。
   *
   * ⚠ 流式过程中不会误伤：socket 超时是**空闲**计时，每收到一块数据就重置；
   *   而整体还有墙钟 `wall` 与空闲 `finish` 两道兜底。
   */
  const socketTimeout = Number(cfg.socketTimeoutMs) || 180000;

  const req = lib.request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      timeout: socketTimeout,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        accept: 'text/event-stream',
        ...authHeaders(cfg),
      },
    },
    (res) => {
      emitLog(`[chat] 收到响应 ${res.statusCode}（${Date.now() - t0}ms）${engine} ${u.hostname}${u.pathname}`);
      if (res.statusCode >= 400) {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => failOnce(
          new Error(describeHttp(res.statusCode, b, engine, cfg.apiKey))));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        // SSE 按空行分帧；Ollama 是每行一个 JSON。都靠"行"来切，
        // 只是行的前缀不一样。
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const raw of lines) handleLine(raw, cfg, engine, {
          onText: (t) => { gotText += t.length; handlers.onChunk && handlers.onChunk(t); },
          onThink: (t) => { thinkSeen = true; handlers.onThink && handlers.onThink(t); },
          onTool: onToolFrame,
        });
        if (!done) {
          finish = setTimeout(() => finishOnce({ tokensOut: 0, hadThinking: thinkSeen }),
            Math.min(timeout, 60000));
        }
      });
      res.on('end', () => {
        if (buf.trim()) handleLine(buf, cfg, engine, {
          onText: (t) => handlers.onChunk && handlers.onChunk(t),
          onThink: (t) => { thinkSeen = true; handlers.onThink && handlers.onThink(t); },
          onTool: onToolFrame,
        });
        finishOnce({ hadThinking: thinkSeen });
      });
      res.on('error', (e) => failOnce(e));
    }
  );

  // 墙钟超时：这是 C5 要求的硬上限。不设的话，
  // 服务端挂住但连接不断，界面会一直转圈。
  const wall = setTimeout(() => {
    try { req.destroy(); } catch (_) {}
    failOnce(new Error(`生成超时（${Math.round(timeout / 60000)} 分钟未完成）。`
      + '模型可能太大或上下文设得过长，可以调小「上下文」后重试。'));
  }, timeout);

  req.on('error', (e) => {
    clearTimeout(wall);
    if (done) return;
    emitLog(`[chat] 失败 ${engine} ${u.hostname}${u.pathname}`
      + ` code=${(e && e.code) || '(无)'} msg=${(e && e.message) || e}`
      + ` 已耗时=${Date.now() - t0}ms`);
    failOnce(new Error(friendlyError(e, engine, cfg.base, cfg.apiKey)));
  });
  /**
   * ⚠ socket 的四段事件是网络问题的**唯一**诊断依据。
   *   少任何一段，最后都只呈现为"超时"两个字。
   *   - lookup  : DNS 解析到了哪个 IP（没有 → 域名/hosts 问题）
   *   - connect : TCP 连上没有（没有 → 防火墙/服务没起/需要代理）
   *   - timeout : socket 超时（Node 默认不设 socket 超时，触发即异常）
   */
  req.on('socket', (s) => {
    const host = u.hostname;
    s.on('lookup', (err, ip) => {
      emitLog(`[chat] DNS ${host} → ${err ? ('失败 ' + err.message) : ip}`);
    });
    s.on('connect', () => {
      emitLog(`[chat] TCP 已连接 ${host}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`);
    });
    s.on('timeout', () => {
      emitLog(`[chat] socket 超时 ${host}（已 ${Date.now() - t0}ms 没收到任何字节）`);
    });
  });
  req.on('timeout', () => req.destroy(new Error(
    `等了 ${Math.round(socketTimeout / 1000)} 秒，服务端一个字节都没回`
    + `（连接本身是通的，通常是请求体太大、服务端还在预处理）。`
    + '如果是云端模型，试试少挂几个文件引用；如果是本地模型，第一次请求'
    + '可能要等模型冷启动。')));
  req.write(payload);
  req.end();

  if (handlers.signal) {
    if (handlers.signal.aborted) req.destroy();
    handlers.signal.addEventListener('abort', () => req.destroy(), { once: true });
  }

  return () => {
    try { req.destroy(); } catch (_) {}
    clearTimeout(wall);
    if (!done) { done = true; finishOnce({ aborted: true, hadThinking: thinkSeen }); }
  };
}

/**
 * 整帧解不出来时只警告一次的标志。
 *
 * ⚠ 必须是模块级而不是 handleLine 内部局部变量：
 *   每次调用都重新置位的话，一个坏地址会刷出上千条警告，
 *   真正的错误反而被日志淹了。
 */
let warnedBadFrame = false;

/** 测试用：重置「只警告一次」的标志 */
function _resetWarn() { warnedBadFrame = false; }

/**
 * 日志出口。由 main.js 注入（provider 不该反向依赖 main）。
 *
 * ## 为什么需要它
 *
 * 2026-10-15：羽毛菌报「连接 127.0.0.1:11434 超时」「连接 api.siliconflow.cn 超时」，
 * 而**日志里一个字都没有** —— `conv:send` 的网络失败路径不留任何痕迹。
 * 于是只能靠回忆和猜，而网络层最值钱的信息恰恰是：
 *   DNS 解析到了哪个 IP → TCP 连上没有 → HTTP 状态是多少 → socket 的错误码是什么。
 *
 * 这四件事任何一件都能一眼定性（DNS 失败 / 被防火墙拦 / 服务端 4xx / 读到一半断了），
 * 缺了就全都变成「超时」两个字。
 */
let logSink = null;
function setLog(fn) { logSink = typeof fn === 'function' ? fn : null; }
function emitLog(...args) {
  if (!logSink) return;
  try { logSink(...args); } catch (_) { /* 日志失败绝不能影响请求 */ }
}

/**
 * 处理一行流数据。抽出来是为了能单独测——
 * SSE 与裸 JSON 的差异全在这 40 行里，
 * 混在流式回调里就只能靠真跑一遍才能验证。
 *
 * @returns {{done?:boolean, tokensIn?:number, tokensOut?:number, ms?:number}}
 */
function handleLine(raw, cfg, engine, out) {
  const line = String(raw).replace(/\r$/, '').trim();
  if (!line) return {};

  // ---- Anthropic：SSE，event: 与 data: **两行一组** ----
  //
  // ⚠ 三处与 OpenAI 的差别，缺一处就静默丢内容：
  //  1. 有 `event: xxx` 行。多数事件它只是名字，但 `message_stop`
  //     **只出现在 event 行、没有对应的 data** —— 按 OpenAI 那套
  //     「只认 data:」会漏掉结束信号，靠 res.on('end') 兜底，
  //     token 统计就丢了。
  //  2. 结束不是 `data: [DONE]`。
  //  3. 正文在 delta.text_delta.thinking，思考在 delta.thinking_delta。
  if (engine === 'anthropic') {
    if (line.startsWith(':')) return {};                    // 心跳注释
    if (line.startsWith('event:')) {
      const ev = line.slice(6).trim();
      if (ev === 'message_stop' || ev === 'error') return { done: true };
      return {};
    }
    if (!line.startsWith('data:')) return {};
    const payload = line.slice(5).trim();
    // 有些中转会在 data 里塞 [DONE]，一并认了
    if (payload === '[DONE]') return { done: true };

    let o;
    try { o = JSON.parse(payload); } catch (_) {
      if (!warnedBadFrame) {
        warnedBadFrame = true;
        console.warn('[provider] 有 data 帧不是 JSON，已跳过。'
          + `开头是：${payload.slice(0, 120).replace(/\s+/g, ' ')}`);
      }
      return {};
    }
    // 流内错误（overloaded_error 之类）
    if (o.type === 'error' || o.error) {
      const e = o.error || {};
      const r = e.message || JSON.stringify(e).slice(0, 200);
      throw new Error(`服务端返回错误：${redactKey(r, cfg && cfg.apiKey)}`);
    }
    const d = o.delta || {};
    // ⚠ 两个字段都在 delta 里，但**类型不同**，不能混读：
    //   text_delta     → 正文
    //   thinking_delta → 思考
    //   signature_delta → 思考块的签名，不是正文也不是思考，不输出
    if (d.type === 'text_delta' && d.text) out.onText(d.text);
    if (d.type === 'thinking_delta' && d.thinking) out.onThink(d.thinking);

    // ---- Anthropic 的工具调用 ----
    //
    // ⚠⚠ 四种事件，四种字段名，而且**位置不一样**，这是最容易写错的地方：
    //
    //   content_block_start  → **o.type**（顶层！）+ o.content_block{id,name,index}
    //   input_json_delta     → **o.delta.type** + o.delta.partial_json
    //
    // 我第一版把 content_block_start 也写成读 `d.type`，
    // 而那一帧的 delta 是**空对象**（参数在后续 input_json_delta 里），
    // 于是条件永远不成立 —— 一次工具调用只剩参数、没有名字和 id，
    // 上层执行时拿到一个 undefined 的工具名。
    // 而且它**不报错**，只是"调用少了个名字"，最难发现。
    if (o.type === 'content_block_start' && (o.content_block || {}).type === 'tool_use') {
      const b = o.content_block;
      // ⚠⚠ index 在**顶层 o.index**，不在 o.content_block.index
      //   （content_block 里只有 id/name/input）。
      //   读错的后果很隐蔽：这里拿到 undefined → 累加器改用 id 当键，
      //   而后续 input_json_delta 用 o.index=0 当键 →
      //   **同一次调用被拆成两条记录**：一条只有名字没有参数，
      //   一条只有参数没有名字。执行时一条报"没有命令"，另一条报"不认识"。
      //   而不报错、不中断，只是多了一次失败的工具调用。
      out.onTool && out.onTool({
        index: o.index != null ? o.index : b.index,
        id: b.id, name: b.name, arguments: '',
      });
    }
    if (d.type === 'input_json_delta') {
      out.onTool && out.onTool({ index: o.index != null ? o.index : undefined,
        arguments: d.partial_json || '' });
    }

    // ⚠ usage 的位置**有两处**，这是官方格式里最容易漏的：
    //   message_start 里是 o.message.usage（首帧，输入 token 在这）
    //   message_delta 里是 o.usage（末帧，累计输出 token 在这）
    // 只读后者的话，prompt tokens 会一直是 0。
    // 且两处都是**累计值**（不是增量），直接覆盖而非累加。
    const u = o.usage || (o.message && o.message.usage);
    if (u) {
      return {
        tokensIn: u.input_tokens || 0,
        tokensOut: u.output_tokens || 0,
      };
    }
    return {};
  }

  // ---- OpenAI 兼容：SSE ----
  if (engine === 'openai') {
    // SSE 心跳/注释行
    if (line.startsWith(':')) return {};
    if (!line.startsWith('data:')) return {};
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return { done: true };

    let o;
    try { o = JSON.parse(payload); } catch (_) {
      // 静默跳过是对的（分片边界可能落在 JSON 中间），
      // 但**整帧都解不出来**说明服务端发了非 SSE 内容——
      // 典型是 base_url 写错��指到一个返回 HTML 的网页。
      // 那时用户看到的是"一直转圈"，所以记一笔。
      if (!warnedBadFrame) {
        warnedBadFrame = true;
        const snippet = payload.slice(0, 120).replace(/\s+/g, ' ');
        console.warn(`[provider] 有 ${payload.length} 字节的 data 帧不是 JSON，已跳过。`
          + `开头是：${snippet} —— 常见原因是地址填到了网页而不是 API 接口。`);
      }
      return {};
    }
    // 服务端报错时 choices 为空、error 有值
    if (o.error) {
      const raw = o.error.message || JSON.stringify(o.error).slice(0, 200);
      throw new Error(`服务端返回错误：${redactKey(raw, cfg && cfg.apiKey)}`);
    }

    const delta = (o.choices && o.choices[0] && o.choices[0].delta) || {};
    // 思考内容：各家字段名不同。reasoning_content 是最常见的
    // （百炼、OpenRouter 经网关归一后的标准字段）。
    const think = delta.reasoning_content || delta.reasoning || '';
    if (think) out.onThink(think);
    if (delta.content) out.onText(delta.content);

    // ---- OpenAI 的工具调用 ----
    // ⚠ 一条调用被拆成很多帧：
    //   第一帧 {index:0, id:'call_x', function:{name:'terminal', arguments:''}}
    //   之后若干帧 {index:0, function:{arguments:'{"comm'}}, ...}
    //   只有第一帧有 id/name，之后**都没有** —— 所以必须按 index 累积，
    //   靠 id 累积会得到一堆空名字的记录。
    // ⚠ 有些中转会分片发 function.name（同名多帧），
    //   所以 name 是**拼接**而不是覆盖（累加器那边已经这么处理了）。
    if (delta.tool_calls && delta.tool_calls.length) {
      for (const tc of delta.tool_calls) {
        const fn = tc.function || {};
        out.onTool && out.onTool({
          index: tc.index,
          id: tc.id,
          name: fn.name,
          arguments: fn.arguments,
        });
      }
    }

    // token 计数：只有开了 stream_options.include_usage 才会在最后一帧给
    let tokensIn = 0; let tokensOut = 0;
    if (o.usage) {
      tokensIn = o.usage.prompt_tokens || 0;
      tokensOut = o.usage.completion_tokens || 0;
    }
    return tokensIn || tokensOut ? { tokensIn, tokensOut } : {};
  }

  // ---- Ollama：裸 JSON 行 ----
  let o;
  try { o = JSON.parse(line); } catch (_) { return {}; }
  if (o.error) {
    const raw = typeof o.error === 'string' ? o.error : JSON.stringify(o.error);
    throw new Error(`Ollama 返回错误：${redactKey(raw, cfg && cfg.apiKey)}`);
  }

  const msg = o.message || {};
  // ⚠ 实测：开 think 后流式响应里 297 个分片全是 thinking，
  //   content 一片都没有。两者必须分开读，且都不许漏。
  if (msg.thinking) out.onThink(msg.thinking);
  if (msg.content) out.onText(msg.content);

  // ---- Ollama 的工具调用 ----
  // ⚠ Ollama 的 arguments 给的是**完整对象**，不是字符串分片。
  //   而且一帧里可能有**多条** tool_calls（并行工具调用）。
  // ⚠ 但也有版本会把 arguments 做成字符串分片 ——
  //   累加器里两种都处理了，这里照原样传下去即可。
  if (msg.tool_calls && msg.tool_calls.length) {
    msg.tool_calls.forEach((tc, i) => {
      out.onTool && out.onTool({
        index: tc.index != null ? tc.index : i,
        id: tc.id || tc.function?.name,
        name: (tc.function && tc.function.name) || tc.name,
        arguments: tc.function ? tc.function.arguments : tc.arguments,
      });
    });
  }

  const meta = {};
  if (o.prompt_eval_count) meta.tokensIn = o.prompt_eval_count;
  if (o.eval_count) meta.tokensOut = o.eval_count;
  if (o.done && o.total_duration) meta.ms = Math.round(o.total_duration / 1e6);
  return meta;
}

/**
 * OpenAI 兼容要的 arguments：**JSON 字符串**。
 *
 * ⚠ 优先原样回传模型给的字符串（见 appendToolTurn 的注释）。
 */
function openaiToolArgs(c) {
  if (typeof c.argsRaw === 'string' && c.argsRaw) return c.argsRaw;
  return JSON.stringify(c.args || {});
}

/**
 * Ollama 要的 arguments：**对象**。
 *
 * ## ⚠⚠ 这是 2026-10-15 线上故障的直接原因，别再改回去
 *
 * 症状：本地模型（Ollama）第一轮正常调工具，第二轮必报
 *   请求失败（400）。{"error":"Value looks like object, but can't find closing '}' symbol"}
 *
 * 这个报错看着像 JSON 坏了，其实**不是**。它说的是
 * 「这个位置我期待一个对象，却收到一个字符串」——
 * Ollama 原生 `/api/chat` 的 `tool_calls[].function.arguments`
 * 是 Go 的 map，要的是对象；而 OpenAI 那套要的是字符串。
 *
 * 实测（Ollama 0.40.4 + qwen3:latest，两条请求只差 arguments 的类型）：
 *   "arguments": "{\"command\":\"Get-ChildItem\"}"  → 400 上面那句
 *   "arguments":  {"command":"Get-ChildItem"}      → 200
 *
 * ⚠ 反过来在 Ollama 的 **OpenAI 兼容层**（/v1/chat/completions）
 *   是字符串对、对象错。所以这里判的是 engine，不是"填了哪个 base"。
 *
 * 拿不到合法对象时**给空对象**，不要退化成字符串：
 * 空对象最坏是模型抱怨"没给参数"，字符串则整轮请求直接 400，
 * 用户连错误都看不懂。
 */
function ollamaToolArgs(c) {
  const a = c && c.args;
  if (a && typeof a === 'object' && !Array.isArray(a)) return a;
  if (typeof c.argsRaw === 'string' && c.argsRaw.trim()) {
    try {
      const o = JSON.parse(c.argsRaw);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (_) { /* 落到空对象 */ }
  }
  return {};
}

/**
 * 开了思考又带工具时，assistant 消息里放推理内容的字段名。
 *
 * ## 为什么必须回传
 *
 * DeepSeek 的推理模型在**下一轮**会校验：上一轮 assistant 用过思考，
 * 就必须把 `reasoning_content` 一起带回来。不带直接 400：
 *   "The `reasoning_content` in the thinking mode must be passed back
 *    to the API."
 * 实测 2026-10-15，同一个请求加上这个字段就通了。
 *
 * ⚠ 只在**真的收到过推理内容**时才塞这个字段。
 *   无脑塞给不支持它的模型（甚至同家的非推理模型）会换来另一个 400。
 *
 * @returns {string|null} 字段名；这家不需要就当 null
 */
function reasoningFieldFor(engine) {
  return engine === 'openai' ? 'reasoning_content' : null;
}

/**
 * 把一次「模型要工具 → 执行完」的结果接回消息历史。
 *
 * ## 这是整个工具链路最容易出错的地方
 *
 * 三家协议在这里**完全不同**，而且都必须原样回传模型给的东西：
 *
 *   OpenAI / Ollama：
 *     assistant { tool_calls:[{id, type:'function', function:{name, arguments}}] }
 *     然后逐条 { role:'tool', tool_call_id:<同一个 id>, content:<结果> }
 *     ⚠ tool_call_id 必须**精确对上**。对不上报 400，
 *       而模型看到报错只会重试，于是无限循环。
 *
 *   Anthropic：
 *     assistant { content:[{type:'tool_use', id, name, input}] }
 *     然后 user { content:[{type:'tool_result', tool_use_id:<同一个 id>, content}] }
 *     ⚠ 这里 assistant 的 content 是**数组**，而且必须是 user 角色来放结果
 *       ——放成 assistant 会直接被拒。
 *
 *   ⚠⚠ 参数必须**原样字符串**回传，不能 parse 完再 stringify：
 *     模型发的是 `{"a": 1, "b":2}`（带空格），你 stringify 出来是
 *     `{"a":1,"b":2}`，内容虽等价但**不保证**被所有中转接受。
 *     最稳的是把原始字符串留着，一路带回来。
 *
 *     **但这只对 OpenAI 成立。** Ollama 反过来——它要对象。
 *     详见 ollamaToolArgs。
 *
 * @param {string} engine
 * @param {Array} messages 现有历史（会被复制，不改原数组）
 * @param {Array} calls [{id, name, args, argsRaw}]
 * @param {Array} results [{output}]
 * @param {object} [opt]
 * @param {string} [opt.think] 这一轮模型的推理原文。开了思考又带工具时
 *   必须原样回传，见 reasoningFieldFor。
 * @returns {Array} 新历史
 */
function appendToolTurn(engine, messages, calls, results, opt = {}) {
  const hist = [...messages];

  if (engine === 'anthropic') {
    // ⚠ Anthropic 一条 assistant 只能对应一次工具调用，
    //   多个并行调用要拆成多条 assistant/user 交替消息。
    for (let i = 0; i < calls.length; i++) {
      hist.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: calls[i].id || `toolu_${i}`, name: calls[i].name,
                    input: calls[i].args || {} }],
      });
      hist.push({ role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: calls[i].id || `toolu_${i}`,
        content: String((results[i] && results[i].output) || ''),
      }] });
    }
    return hist;
  }

  // ---- OpenAI / Ollama 共用一套骨架 ----
  const isOllama = engine === 'ollama';
  const lastAssistant = {
    role: 'assistant',
    content: '',
  };
  // ⚠ 没有正文时给个空串：有些中转会拒绝 content 为 null 的 assistant
  lastAssistant.tool_calls = calls.map((c, i) => ({
    // ⚠ Ollama 不要求 id，给一个稳定的兜底值，省得它对不上
    id: c.id || `call_${i}`,
    type: 'function',
    function: {
      name: c.name,
      // ⚠⚠ arguments 的**类型**两家相反，这里不能共用一行（2026-10-15 修）。
      //   见下方 ollamaToolArgs 的注释。
      arguments: isOllama ? ollamaToolArgs(c) : openaiToolArgs(c),
    },
  }));
  // ⚠ 带工具的那一轮如果模型开了思考，assistant 必须把推理内容一起回传。
  //   见 reasoningFieldFor 的注释。
  const rk = reasoningFieldFor(engine);
  if (rk && typeof opt.think === 'string' && opt.think) {
    lastAssistant[rk] = opt.think;
  }
  hist.push(lastAssistant);

  for (let i = 0; i < calls.length; i++) {
    hist.push({
      role: 'tool',
      // ⚠ 必须和上面 assistant 里的 id 一模一样
      tool_call_id: calls[i].id || `call_${i}`,
      content: String((results[i] && results[i].output) || ''),
    });
  }
  return hist;
}

module.exports = {
  ENGINES,
  protoOf,
  THINK_FORMATS,
  THINK_SPEC,
  THINK_LABEL,
  buildThinkParams,
  buildRequestBody,
  appendToolTurn,
  ollamaToolArgs,
  openaiToolArgs,
  reasoningFieldFor,
  handleLine,
  chatStream,
  listModels,
  probe,
  describeHttp,
  friendlyError,
  redactKey,
  _resetWarn,
  setLog,
  joinUrl,
  parseBase,
  httpRequest,
  defaultModelsPath,
  chatPathFor,
};
