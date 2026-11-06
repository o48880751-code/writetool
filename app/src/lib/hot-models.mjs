/**
 * 从服务端返回的模型列表里挑出"常见的那批"。
 *
 * ## 为什么要挑
 *
 * 百炼一个接口返回 183 个模型（含语音、OCR、重排、embedding、各种实验版本），
 * 全铺在设置页里就是一屏看不懂的英文——用户根本选不出来。
 * 羽毛菌的原话：「183 个模型太多了……要展示的话，展示主流的二十个就够了」。
 *
 * ## 挑法
 *
 * 1. **先剔除非对话模型**：audio / realtime / tts / asr / embed / rerank /
 *    ocr / video / image / whisper / moderation。这些不能用来聊天，
 *    列出来只会让人点错。
 * 2. **按"耳熟""打分**：命中一条常见家族就 +1，分高的排前面。
 *    不做精确白名单 —— 各家命名规则不同（qwen-max / doubao-seed / glm-4），
 *    白名单一定会漏，漏了就等于"这个模型不存在"。
 * 3. **取前 N 个**，剩下的不显示。用户要别的就直接在输入框里写名字
 *    （输入框本来就在上面）。
 *
 * ⚠ 这一步只是**排序建议**，不是白名单：被排在后面的模型依然可以手填使用。
 *   所以宁可多留几个"看着像聊天模型"的，也不要漏掉真正能用的。
 */

/**
 * 明显不是对话模型的：列出来只会让人点错。
 *
 * ⚠ 这份表是**踩出来的**，别凭印象删：
 *   第一版只写了 audio/embed/ocr 这些英文词，于是百炼的
 *   `wanx2.1-t2i`（文生图）、`paraformer-v2`（语音转文字）、
 *   `cosyvoice-v2`（语音合成）全被当成"可聊天模型"列在前面，
 *   用户点一个报一次错。判据（`test-hot-models.mjs`）现在钉住了这几类。
 */
const NOT_CHAT = /(audio|realtime|tts|asr|speech|embed|rerank|ocr|video|image|whisper|moderation|voice|t2i|i2i|paraformer|cosyvoice|sambert|wanx|flux|stable-?diffusion)/i;

/**
 * 常见家族。命中越多排越前（同时命中多条时靠前）。
 * ⚠ 这些都是"按名字认人"，不保证服务端真的有 —— 真正可用与否由连接测试决定。
 */
const FAMILIAR = [
  // 通义 / 千问
  /qwen3(\.\d+)?-(max|plus|turbo|flash)/i,
  /qwen-(max|plus|turbo|long)/i,
  /qwen3(\.\d+)?-omni/i,
  /qwen-vl/i,
  // DeepSeek
  /deepseek-(v3|r1|chat|v\d)/i,
  // OpenAI / Anthropic / Google
  /gpt-(4o|4\.1|5|oss)/i,
  /claude-(3|4|sonnet|opus|haiku)/i,
  /gemini-(2|3)/i,
  // 国内其它
  /glm-(4|5)/i,
  /kimi|moonshot/i,
  /doubao-(seed|1\.5|pro|lite|vision)/i,
  /hunyuan/i,
  /ernie/i,
  /\b(spark|abab|yi-|minimax|step-)/i,
  // 开源
  /llama-?3/i,
  /mistral|mixtral/i,
];

/**
 * @param {string[]} models 服务端返回的模型名
 * @param {number} limit 最多展示几个
 * @returns {{ hot: string[], total: number, hidden: number }}
 *   hot    要展示的
 *   total  可用总数（剔除不该聊天之后）
 *   hidden 没展示的数量
 */
export function pickHotModels(models, limit = 20) {
  const all = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m) : [];
  const chat = all.filter((m) => !NOT_CHAT.test(m));

  const scored = chat.map((m, idx) => {
    let score = 0;
    for (const re of FAMILIAR) if (re.test(m)) score += 1;
    // idx 参与排序是为了**稳定**：同分的保持服务端原顺序，
    // 否则每次刷新顺序都在跳，用户会以为列表变了。
    return { m, score, idx };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  const hot = scored.slice(0, limit).map((x) => x.m);

  return { hot, total: chat.length, hidden: Math.max(0, chat.length - hot.length) };
}
