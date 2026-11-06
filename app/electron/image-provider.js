/**
 * 生图适配器：把「一次生图」翻译成各家不同的请求体。
 *
 * ## 只有两种形状，不是四家公司
 *
 * - `dashscope`：百炼。prompt 包在 `input.messages[].content[].text` 里，
 *   尺寸用 `*` 分隔，结果在 `output.choices[].message.content[].image`。
 * - `openai`：方舟 / 商汤 / 千帆 / 任何 OpenAI 兼容站。`{model, prompt, size, n}`，
 *   结果在 `data[].url` 或 `data[].b64_json`。
 *
 * 判 `protocol` 不判公司名 —— 同一家换个套餐可能换形状，
 * 而形状才是决定请求怎么拼的东西。
 *
 * ## 为什么不复用 `provider.js`
 *
 * 那个文件服务的是**流式对话**（SSE、工具调用、思考档位、上下文计量）。
 * 生图是一发一收的短请求，共用只会让两边都变难改，
 * 也会把生图的依赖拖进对话的启动路径。
 *
 * ## ⚠ 超时必须自己设
 *
 * Electron 主进程给 socket 设了 5000ms 的默认超时（裸 Node 是 0）。
 * 生图动辄 20–60 秒，不显式设长会稳定失败在"服务端还没画完"。
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

/** 生图比对话慢得多，给足；但也不能无限等 */
const DEFAULT_TIMEOUT_MS = 180000;

/** 调用方没给反向词时的兜底（只保证"别写字"这条底线） */
const DEFAULT_NEG = '文字, 汉字, 字母, 数字, 标点, 标题, 副标题, 字幕, 水印, 签名, logo, '
  + '艺术字, 排版, 版式, 封面, 书封, 海报, 边框, 印章, 落款';

/**
 * 统一尺寸写法 → 各家写法。
 *
 * ⚠⚠ 界面上永远只显示 `宽x高`。写进配置的也是这个。
 *   百炼要 `*`，写 `x` 会直接 400 —— 但那是**我们的**转换责任，
 *   不该让用户记两套。这里做单向转换，读时不转（配置里只有一种）。
 */
function sizeFor(style, size) {
  const s = String(size || '').trim();
  if (!s) return '';
  if (style === 'star') return s.replace(/[x×*]/gi, '*');
  return s.replace(/[×*]/g, 'x');
}

/** 尺寸是不是 `宽x高` 两个正整数 */
function isValidSize(size) {
  return /^\d{2,5}\s*[x×*]\s*\d{2,5}$/i.test(String(size || '').trim());
}

/**
 * 千帆有个例外：ernie-image-turbo 走专属路径，通用 `/images/generations` 不认它。
 * 其余家都是同一个 `/images/generations`。
 */
/**
 * 用户填的是不是「OpenAI 兼容入口」。
 *
 * ⚠⚠ 实测：把百炼的 `.../compatible-mode/v1` 填进「接口地址」，
 *   程序还按**原生 DashScope** 的路径再拼一次 `/api/v1/services/aigc/...`，
 *   实际打到 `.../compatible-mode/v1/api/v1/services/...` → 404。
 *
 * 百炼同时提供两套协议（官方文档原文：supports both the OpenAI-compatible
 * and DashScope protocols），`compatible-mode` 这个段名就是切换开关：
 * 看到它就用 `/images/generations` + OpenAI 形状的请求体。
 */
function isCompatibleMode(base) {
  return /compatible-mode/i.test(cleanBase(base));
}

function pathFor(preset, model, base) {
  if (preset.key === 'qianfan' && /^ernie-image/i.test(model || '')) {
    return '/ernie-image/images/generations';
  }
  if (preset.protocol === 'dashscope') {
    // ⚠ 兼容模式下走 OpenAI 形状的端点，不是原生 multimodal-generation
    return isCompatibleMode(base)
      ? '/images/generations'
      : '/api/v1/services/aigc/multimodal-generation/generation';
  }
  return '/images/generations';
}

/**
 * 这个模型要求的最小总像素。
 *
 * ⚠⚠ 现场：火山方舟 Seedream 5.0 要求 **≥ 3,686,400 像素**（约 1920×1920），
 *   而封面默认的 1024×1536 只有 157 万 —— 必然被拒。
 *   用户看到的是 `400 InvalidParameter`，根本想不到是"图太大了/太小了"。
 *
 * 参考：方舟文档 "单张图片像素范围 [512x512, 2048x2048]" 是 3.x/4.x 的口径，
 *      5.0 系列另有下限；社区实测 1152×864 会被 400 拒掉。
 */
function minPixelsFor(presetKey, model) {
  if (presetKey === 'ark' && /seedream-5/i.test(model || '')) return 3686400;
  return 0;
}

/**
 * 尺寸不够就等比放大到够为止（保持宽高比，边长对齐 64）。
 *
 * ⚠ 为什么自动改而不是让用户自己试：报错是 `400 InvalidParameter`，
 *   不会告诉你"像素不够"。与其让他反复试，不如放大并**明确告知**
 *   （返回值里带 `sizeChanged`，界面把那句话显示出来）。
 */
function ensureMinPixels(size, minPixels) {
  const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(String(size || '').trim());
  if (!m || !minPixels) return { size, changed: false };
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w * h >= minPixels) return { size, changed: false };

  const k = Math.sqrt(minPixels / (w * h)) * 1.02;   // 留 2% 余量，免得四舍五入又差一点
  const nw = Math.ceil((w * k) / 64) * 64;
  const nh = Math.ceil((h * k) / 64) * 64;
  return { size: `${nw}x${nh}`, changed: true, from: `${w}x${h}` };
}

/**
 * 清掉用户从文档/curl 里复制来的"噪音"。
 *
 * ⚠⚠ 实测：用户把整条命令里的地址粘进「接口地址」——
 *   `https://ark.cn-beijing.volces.com/api/v3/images/generations \`
 *   末尾那个 `\` 是 curl 的续行符，中间还带着引号。
 *   不清掉的话请求发到一个根本不存在的路径。
 */
function cleanBase(base) {
  return String(base == null ? '' : base)
    .trim()
    .replace(/\s+/g, '')          // 中间的空格
    .replace(/\\+$/, '')          // curl 的续行符
    .replace(/^["'`]+|["'`]+$/g, '') // 包裹的引号
    .trim();
}

/**
 * 根地址 + 端点，**不会重复拼**。
 *
 * ⚠⚠ 这是那个 500 的根因：用户填的已经是完整端点
 *   `.../api/v3/images/generations`，代码又追加了一次
 *   `/images/generations` → 实际打到 `.../images/generations/images/generations`，
 *   方舟回的是一句看不出所以然的 `500 InternalServiceError`。
 *
 * 原则：**用户已经写到端点就别再追加**。宁可接受他填的完整地址，
 * 也不要把两个路径叠起来。
 */
function joinEndpoint(base, path) {
  const b = cleanBase(base).replace(/\/+$/, '');
  if (!b) return path;
  if (b.toLowerCase().endsWith(path.toLowerCase())) return b;
  // 已经带了某个 images/generations 端点（比如千帆的 ernie 专属路径）就不再动
  if (/\/images\/generations$/i.test(b) && /\/images\/generations$/i.test(path)) return b;
  return b + path;
}

/** 拼一次请求需要的东西（纯函数，好测） */
function buildRequest(preset, { base, model, prompt, size, negative }) {
  const url = joinEndpoint(base || preset.base, pathFor(preset, model, base));

  /**
   * ⚠ 形状（protocol）不只看预置表，还要看**地址**：
   *   百炼的 compatible-mode 是 OpenAI 形状，原生 dashscope 是嵌 messages 的形状。
   *   同一家两种形状，判错的后果是 400/404 —— 而预置表里只有一条 'dashscope'。
   */
  const proto = (preset.protocol === 'dashscope' && isCompatibleMode(base))
    ? 'openai' : preset.protocol;

  /**
   * ⚠ 尺寸分隔符也跟**形状**走，不跟公司走：
   *   百炼原生要 `1024*1536`，但它的 compatible-mode 是 OpenAI 形状，要 `1024x1536`。
   *   混着用的话，服务端只会回一句参数错误。
   */
  const sz = sizeFor(proto === 'openai' ? 'x' : preset.sizeStyle, size);

  let body;
  if (proto === 'dashscope') {
    body = {
      model,
      input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
      parameters: {
        size: sz,
        n: 1,
        // ⚠ 关掉提示词扩写：扩写会自作主张加细节，
        //   而封面要的是"按我说的构图"，不是"更丰富"。
        prompt_extend: false,
        watermark: false,
        /**
         * 百炼支持 negative_prompt，用它再压一次"别写字"。
         * ⚠ 只有 dashscope 有这个字段；OpenAI 形状（方舟/商汤/千帆）
         *   没有统一的反向提示词，硬塞会被拒或忽略 —— 所以不在这边加。
         */
        /**
         * ⚠ 反向词能列的全列上。Qwen-Image 的卖点就是"会渲染中文"，
         *   所以它特别容易在画面里加标题；正向提示词里禁一遍，这里再反着压一遍。
         *   实测仍不能保证 —— 它只是把概率压下去，不是开关。
         */
        /**
         * ⚠ 反向词由**调用方给全**（主进程按 A/B 模式拼好）。
         *   这里不再自己拼一套：A 模式要压掉"文字"，B 模式恰恰**不能**压文字，
         *   两套逻辑放在一处才不会打架（见 cover-prompt.js 的 defaultNegative）。
         */
        negative_prompt: String(negative || '').trim() || DEFAULT_NEG,
      },
    };
  } else {
    body = {
      model,
      prompt,
      n: 1,
      size: sz,
      response_format: 'url',
      watermark: false,
    };
  }

  return {
    url,
    body,
    // ⚠ Authorization 这里**不放**：密钥不进 buildRequest 的返回值，
    //   免得哪天有人把 built 打进日志或回给渲染层。统一在 generate 里拼。
    headers: { 'Content-Type': 'application/json' },
  };
}

/** 只算"最终会请求哪个地址"，给界面做展示用（不含密钥、不发请求） */
function previewUrl(preset, { base, model }) {
  return joinEndpoint(base || preset.base, pathFor(preset, model, base));
}

/**
 * 从各家返回里挖出图片。
 *
 * ⚠ 这里**故意多收几种路径**：同样是 OpenAI 形状，有的站回 `url`、
 *   有的回 `b64_json`、个别回 `image_url`。少收一种，用户看到的就是
 *   "生成成功但没图"。宁可多认几个键。
 */
function pickImage(json) {
  if (!json || typeof json !== 'object') return null;

  // 百炼
  const choices = json.output && json.output.choices;
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const content = c && c.message && c.message.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part.image === 'string' && part.image) {
          return { kind: 'url', value: part.image };
        }
      }
    }
  }

  // OpenAI 形状
  const data = json.data;
  if (Array.isArray(data) && data.length) {
    const d = data[0] || {};
    if (typeof d.url === 'string' && d.url) return { kind: 'url', value: d.url };
    if (typeof d.b64_json === 'string' && d.b64_json) return { kind: 'b64', value: d.b64_json };
    if (typeof d.image_url === 'string' && d.image_url) return { kind: 'url', value: d.image_url };
  }

  // 个别站直接回图片地址
  if (typeof json.url === 'string' && json.url) return { kind: 'url', value: json.url };
  return null;
}

/** 把各家的报错翻成一句人话 */
function pickError(status, json, rawText) {
  /**
   * ⚠ 404 是最没信息量的一个码，而它恰好对应两种最常见的配置错误。
   *   直接把它翻译成人话，比让用户去猜"404 是什么意思"有用得多。
   */
  const hint404 = status === 404
    ? '（地址可能拼错了——看设置页「实际请求」那一行；也可能这个模型/接口在你的账号下还没开通）'
    : '';
  if (json) {
    const err = json.error && typeof json.error === 'object' ? json.error : null;
    /**
     * ⚠⚠ `code` 不能丢。百炼返回的是
     *   `{code:'InvalidParameter', message:'size is invalid'}`，
     *   只留 message 的话用户搜不到原因；而 code 才是能拿去查文档的标识。
     *   OpenAI 形状则把 code 放在 `error.code` 里，两者都要收。
     */
    const code = json.code || (err && err.code) || '';
    const msg = json.message || (err && err.message) || '';
    if (code || msg) {
      return `${status} ${code ? code + ' ' : ''}${msg}${hint404}`.trim();
    }
  }
  const t = String(rawText || '').trim();
  return `${status}${t ? ' ' + t.slice(0, 300) : ''}${hint404}`;
}

function requestRaw(urlStr, { method = 'POST', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error(`地址不合法：${urlStr}`)); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(
      typeof body === 'string' ? body : JSON.stringify(body), 'utf8'
    );

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* 可能真是二进制（图片直出） */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json, buf });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没画完。`
        + '生图本来就慢；如果每次都卡到超时，多半是模型名或尺寸那家不认。'));
    });
    req.on('error', (e) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 下载图片到内存（⚠ 链接 24 小时就失效，必须立刻落盘） */
async function download(urlStr, timeoutMs = 120000) {
  const r = await requestRaw(urlStr, { method: 'GET', timeoutMs });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`下载图片失败：HTTP ${r.status}`);
  }
  const ct = String((r.headers && r.headers['content-type']) || '').toLowerCase();
  const mime = ct.startsWith('image/') ? ct.split(';')[0] : 'image/png';
  return { buffer: r.buf, mime };
}

/**
 * 生成一张图。
 *
 * @param {object} preset  `image-presets.js` 里的一条
 * @param {{base:string, model:string, key:string, timeoutMs?:number}} cfg
 * @param {string} prompt
 * @param {string} size     `宽x高`
 * @returns {Promise<{ok:true, image:{buffer:Buffer,mime:string}, model:string}
 *                  | {ok:false, error:string}>}
 */
async function generate(preset, cfg, prompt, size) {
  const model = String((cfg && cfg.model) || '').trim() || preset.defaultModel;
  if (!model) return { ok: false, error: '还没选模型' };
  if (!String(prompt || '').trim()) return { ok: false, error: '提示词是空的' };

  const built = buildRequest(preset, {
    base: cfg && cfg.base,
    model,
    prompt: String(prompt).trim(),
    size,
    // 用户提示词里可能有「负面提示词：…」那一段（见 cover-prompt.splitPrompt）
    negative: cfg && cfg.negative,
  });
  const key = String((cfg && cfg.key) || '').trim();

  const timeoutMs = Number(cfg && cfg.timeoutMs) || DEFAULT_TIMEOUT_MS;
  let r;
  try {
    r = await requestRaw(built.url, {
      headers: { ...built.headers, Authorization: `Bearer ${key}` },
      body: built.body,
      timeoutMs,
    });
  } catch (e) {
    return { ok: false, error: `连不上：${e.message}` };
  }

  if (r.status < 200 || r.status >= 300) {
    return { ok: false, error: pickError(r.status, r.json, r.text) };
  }
  /**
   * ⚠ 有的站回了 200 但 body 是二进制图片（`response_format` 被忽略时的兜底）。
   *   这种情况下 `json` 是 null，但 `content-type` 是 image/*，直接用。
   */
  const ct = String((r.headers && r.headers['content-type']) || '').toLowerCase();
  if (!r.json && ct.startsWith('image/')) {
    return { ok: true, image: { buffer: r.buf, mime: ct.split(';')[0] }, model };
  }
  if (!r.json) {
    return { ok: false, error: `返回的不是 JSON：${String(r.text || '').slice(0, 200)}` };
  }

  const hit = pickImage(r.json);
  if (!hit) {
    return { ok: false, error: `没在返回里找到图片：${JSON.stringify(r.json).slice(0, 300)}` };
  }

  if (hit.kind === 'b64') {
    const b64 = hit.value.replace(/^data:image\/\w+;base64,/, '');
    return { ok: true, image: { buffer: Buffer.from(b64, 'base64'), mime: 'image/png' }, model };
  }

  try {
    const img = await download(hit.value);
    return { ok: true, image: img, model };
  } catch (e) {
    return { ok: false, error: `图生成了但下载失败：${e.message}（链接 24 小时失效，请重试一次）` };
  }
}

/** 探测图片真实格式（没有扩展名时靠它） */
function sniffExt(buf) {
  if (!buf || buf.length < 4) return 'png';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') return 'webp';
  return 'png';
}

module.exports = {
  generate,
  buildRequest,
  previewUrl,
  joinEndpoint,
  cleanBase,
  isCompatibleMode,
  minPixelsFor,
  ensureMinPixels,
  pickImage,
  pickError,
  sizeFor,
  isValidSize,
  pathFor,
  download,
  sniffExt,
  DEFAULT_TIMEOUT_MS,
};
