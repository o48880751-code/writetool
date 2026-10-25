/**
 * Ollama 流式客户端。
 *
 * 为什么要单独写：run-verify.js 的 ollamaChat 是 stream:false（一次性拿全文），
 * 编辑器需要真流式才能做打字机效果与用户插队。
 *
 * 格式依据（2026-10-11 实测Ollama 0.40.2 / qwen3:latest，非凭记忆）：
 *   - 响应是 NDJSON：每行一个 JSON 对象，用 \n 分隔
 *   - 中间行：{ model, created_at, message: { role, content }, done: false }
 *   - content 是**逐字**到达的（实测「修」「仙」分开两行）
 *   - 末行：{ ..., done: true, done_reason, total_duration,
 *             prompt_eval_count, eval_count, ... }，message.content 为空
 *   - 顶层字段全集：model, created_at, message, done, done_reason,
 *                   total_duration, load_duration, prompt_eval_count,
 *                   prompt_eval_cached_count, prompt_eval_duration,
 *                   eval_count, eval_duration
 *
 * 两个实测踩过的坑：
 *   1. tool call 在流式下会被拆成多片，arguments 是**字符串碎片**，
 *      必须累积后再 JSON.parse——直接 parse 每片必然失败。
 *      这一点在非流式下不存在（非流式返回完整对象），是流式独有的。
 *   2. 末行的 message.content 是空字符串，若不判断 done 会多写一个空分片。
 */

const BASE_URL = process.env.OLLAMA_HOST
  ? process.env.OLLAMA_HOST.replace(/\/$/, '')
  : 'http://127.0.0.1:11434';

// 超时：8B 正常 10s，30B 慢样本 190s，流式下超时按「首字节」而非整体更合理，
// 但为了简单可靠，这里给整体上限，流式一旦开始有数据就续命。
const FIRST_BYTE_TIMEOUT_MS = Number(process.env.OLLAMA_FIRST_BYTE_TIMEOUT_MS) || 60000;
const IDLE_TIMEOUT_MS = Number(process.env.OLLAMA_IDLE_TIMEOUT_MS) || 60000;

/**
 * 读取 NDJSON 流，逐行回调。
 * @param {Response} res
 * @param {(obj:object)=>void} onLine
 * @param {{signal?:AbortSignal}} [opts]
 */
async function readNdjson(res, onLine, opts = {}) {
  const { signal } = opts;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let firstByte = true;
  // 空闲计时器：流停住不动（网络断/Ollama 卡住）时能退出，不会永久挂死
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      reader.cancel().catch(() => {});
    }, IDLE_TIMEOUT_MS);
  };
  armIdle();

  try {
    while (true) {
      if (signal && signal.aborted) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error('已中止'), { aborted: true });
      }
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buf += decoder.decode(value, { stream: true });
      // NDJSON 以 \n 分行；最后一行可能不完整，留在缓冲区等下一片
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          onLine(JSON.parse(line));
        } catch (e) {
          // 非JSON 行：Ollama 正常不会产生，视为协议异常但不中断——
          // 上层通过 onParseError 感知
          onLine({ __parseError: true, raw: line, message: e.message });
        }
      }
      firstByte = false;
    }
    // 处理末尾残留（无换行结尾的最后一行）
    const tail = buf.trim();
    if (tail) {
      try { onLine(JSON.parse(tail)); } catch (e) { onLine({ __parseError: true, raw: tail, message: e.message }); }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  return { firstByteSeen: !firstByte };
}

/**
 * 流式对话。
 *
 * @param {object} payload /api/chat 请求体（stream 会被强制置true）
 * @param {object} handlers
 * @param {(delta:string)=>void} [handlers.onText]   逐字正文增量
 * @param {(delta:string, state)=>void} [handlers.onToolCallDelta] 工具调用参数增量
 * @param {(toolCall:{name:string, arguments:object})=>void} [handlers.onToolCall] 完整的工具调用（解析成功后）
 * @param {(usage:object)=>void} [handlers.onDone]  末行统计
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text:string, toolCalls:Array, usage:object, aborted:boolean}>}
 */
async function chatStream(payload, handlers = {}, opts = {}) {
  const { onText, onToolCallDelta, onToolCall, onDone } = handlers;
  const body = { ...payload, stream: true };

  // 首字节超时用AbortController 实现；一旦开始收数据就取消首字节计时
  const controller = new AbortController();
  let timedOut = false;
  const firstTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FIRST_BYTE_TIMEOUT_MS);
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(firstTimer);
    if (timedOut) {
      const err = new Error(`首字节超时（>${FIRST_BYTE_TIMEOUT_MS / 1000}s），模型可能未加载或显存不足`);
      err.retryable = true;
      throw err;
    }
    throw e;
  }

  if (!res.ok) {
    clearTimeout(firstTimer);
    const t = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${t.slice(0, 300)}`);
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }

  let text = '';
  let usage = {};
  let parseErrors = [];
  // 流式下 tool_calls 是碎片化的：name 一次性的，arguments 分片到达
  let pendingToolName = null;
  let pendingArgsBuf = '';
  let sawFirstChunk = false;
  const completedToolCalls = [];

  try {
    await readNdjson(
      res,
      (obj) => {
        if (obj.__parseError) {
          parseErrors.push(obj);
          return;
        }
        if (!sawFirstChunk && obj.message) {
          sawFirstChunk = true;
          clearTimeout(firstTimer);
        }
        if (obj.done) {
          usage = {
            total_duration: obj.total_duration,
            load_duration: obj.load_duration,
            prompt_eval_count: obj.prompt_eval_count,
            eval_count: obj.eval_count,
            done_reason: obj.done_reason,
          };
          return;
        }
        const msg = obj.message || {};
        // 正文增量
        if (msg.content) {
          text += msg.content;
          if (onText) onText(msg.content);
        }
        // 工具调用增量（可能出现在多个分片里）
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          for (const tc of msg.tool_calls) {
            const fn = tc.function || {};
            if (fn.name) {
              // 新的调用开始：若上一个还没收完，先结算
              if (pendingToolName) {
                completedToolCalls.push(
                  finalizeTool(pendingToolName, pendingArgsBuf, onToolCall)
                );
              }
              pendingToolName = fn.name;
              pendingArgsBuf = '';
            }
            if (typeof fn.arguments === 'string' && fn.arguments) {
              pendingArgsBuf += fn.arguments;
              if (onToolCallDelta) onToolCallDelta(fn.arguments, { name: pendingToolName });
            } else if (fn.arguments && typeof fn.arguments === 'object') {
              // 少数模型直接给对象（非字符串），序列化后统一走字符串路径
              pendingArgsBuf = JSON.stringify(fn.arguments);
            }
          }
        }
      },
      { signal: opts.signal }
    );
  } catch (e) {
    clearTimeout(firstTimer);
    if (opts.signal && opts.signal.aborted) {
      return { text, toolCalls: completedToolCalls, usage, aborted: true };
    }
    throw e;
  } finally {
    clearTimeout(firstTimer);
  }

  // 结算最后一个工具调用
  if (pendingToolName) {
    completedToolCalls.push(finalizeTool(pendingToolName, pendingArgsBuf, onToolCall));
  }
  if (onDone) onDone(usage);
  return { text, toolCalls: completedToolCalls, usage, aborted: false, parseErrors };
}

/** 结算累积的 arguments 缓冲；解析失败不抛，返回 ok:false 交给清洗层 */
function finalizeTool(name, argsBuf, onToolCall) {
  let parsed = null;
  let ok = true;
  let error = null;
  const raw = (argsBuf || '').trim();
  if (!raw) {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      ok = false;
      error = e.message;
      parsed = { __rawArgs: raw };
    }
  }
  const call = { name, arguments: parsed, rawArgs: raw, ok, error };
  if (onToolCall && ok) onToolCall(call);
  return call;
}

module.exports = { chatStream, readNdjson, BASE_URL, FIRST_BYTE_TIMEOUT_MS, IDLE_TIMEOUT_MS };
