/**
 * AI 服务商量表。
 *
 * ## 为什么单独一个模块
 *
 * 「换个地址就能接」这个想法只对了一半。协议上有三种真实存在的形态
 * （见 provider.js 的 PROTOCOLS），思考参数各家又不一样。
 * 这些差异如果散在界面代码里，每加一家就得改一次 UI，
 * 迟早出现「界面上给了选项但发过去没这个参数」。
 *
 * 所以：**协议差异归 provider.js，服务商信息归这里。**
 * 两边都只认 providerKey，界面不写死任何一家的地址。
 *
 * ## 地址的来源
 *
 * 每一项的 base 都来自查到的服务商文档（不是凭记忆）：
 *   - DeepSeek      api.deepseek.com
 *   - 智谱 GLM       open.bigmodel.cn/api/paas/v4  ← 注意是 v4，不是 /v1
 *   - 硅基流动       api.siliconflow.cn/v1          ← 模型名带斜杠（org/model）
 *   - 阿里云百炼     dashscope.aliyuncs.com/compatible-mode/v1
 *   - 火山方舟       ark.cn-beijing.volces.com/api/v3
 *   - 月之暗面       api.moonshot.cn/v1
 *   - MiniMax       api.minimax.chat/v1
 *   - OpenRouter     openrouter.ai/api/v1
 *   - OpenAI        api.openai.com/v1
 *   - Anthropic     api.anthropic.com
 *
 * ⚠ 模型名会变，用户填的以服务端返回的为准。
 *   这里的 models 只是给个起步值，界面上「获取模型列表」
 *   能拉到真实的，用户也可以手填。
 *
 * ## 思考参数形态
 *
 * 已核实的：
 *   - 阿里云百炼  enable_thinking（布尔，顶层，不能放 extra_body）
 *   - OpenRouter  reasoning: {effort}（档位，顶层）
 *   - DeepSeek    deepseek-reasoner 是独立模型，不靠参数开关
 *   - 智谱 GLM    thinking: {type:'enabled'}（对象型）
 *   - 硅基流动    靠模型名区分（DeepSeek-R1 本身就是推理模型）
 *
 * 拿不准的一律标 support:false，界面上置灰并说明原因，
 * **不硬给四档** —— 那是骗用户。
 */

/**
 * @typedef {object} Provider
 * @property {string}   key           量表标识
 * @property {string}   name          显示名
 * @property {string}   protocol      'ollama' | 'openai' | 'anthropic'
 * @property {string}   base          服务根地址
 * @property {boolean}  needKey       是否需要密钥
 * @property {boolean}  isLocal       本地跑（界面上归到「本地」组）
 * @property {string[]} models        起步模型名（服务端为准）
 * @property {object}   think
 * @property {'boolean'|'levels'|'model-only'|'none'} think.style
 *   界面上给几档。'boolean' = 关闭/开启。
 * @property {string}   [think.thinkStyle] 请求体里长什么样，见 provider.js 的
 *   buildThinkParams。可取值：'dashscope' | 'enable-thinking'（两者字段相同，
 *   都是顶层布尔 enable_thinking）| 'zhipu'（thinking 对象）| 'openrouter'
 *   （reasoning.effort，**也是没填时的默认值**）。
 *   ⚠ 只填了 think.style 而没填这个的聚合站，会退到 openrouter ——
 *     而多数聚合站不认 reasoning.effort，等于"关不掉思考"。
 *     硅基流动就是这么踩的（2026-10-15）。
 * @property {string}   [think.note]  给用户看的说明
 * @property {string}   keyUrl        密钥在哪取
 */

/** @type {Provider[]} */
const PROVIDERS = [
  // ---------------------------------------------------------
  // 本地
  // ---------------------------------------------------------
  {
    key: 'ollama',
    id: 'conn-preset-ollama',
    name: 'Ollama',
    protocol: 'ollama',
    base: 'http://127.0.0.1:11434',
    needKey: false,
    isLocal: true,
    models: ['qwen3:latest', 'gemma3:4b'],
    modelsPath: '/api/tags',
    think: {
      style: 'levels',
      note: '开启后模型先想再写。token 消耗约为关闭时的 4~5 倍。',
    },
    keyUrl: '',
    help: '本机装好 Ollama 并运行 ollama serve 即可，地址一般就是上面这个。',
  },
  {
    key: 'vllm',
    id: 'conn-preset-vllm',
    name: 'vLLM',
    protocol: 'openai',
    base: 'http://127.0.0.1:8000',
    needKey: false,
    isLocal: true,
    models: [],
    modelsPath: '/v1/models',
    think: { style: 'none', note: 'vLLM 通常不暴露思考强度，由模型自身决定。' },
    keyUrl: '',
    help: '本地部署的大模型服务。若启动时加了 --api-key 才需要填密钥。',
  },

  // ---------------------------------------------------------
  // 公有云服务商
  // ---------------------------------------------------------
  {
    key: 'deepseek',
    id: 'conn-preset-deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    base: 'https://api.deepseek.com',
    needKey: true,
    isLocal: false,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    modelsPath: '/models',
    think: {
      // ⚠ DeepSeek 的思考模型是独立模型名（deepseek-reasoner），
      //   不是靠参数开关。所以「思考强度」对它没有意义——
      //   要思考就换模型。这与其他服务商的做法完全不同。
      style: 'model-only',
      note: 'DeepSeek 的思考是独立模型：选 deepseek-reasoner 即开思考，'
        + '选 deepseek-chat 即关闭。没有中间的档位。',
    },
    keyUrl: 'https://platform.deepseek.com',
    help: '国内直连，价格低。地址有时也写作 /v1，两种都对。',
  },
  {
    key: 'zhipu',
    id: 'conn-preset-zhipu',
    name: '智谱 GLM',
    protocol: 'openai',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    needKey: true,
    isLocal: false,
    models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
    modelsPath: '/models',
    think: {
      // ⚠ 原来标的是 'levels'，但下面这句 note 自己就写着"没有档位区分"——
      //   标成 levels 的后果是界面给四个按钮，其中三个发过去一模一样。
      //   界面承诺什么，就该和请求体一致：这家只有开/关。
      style: 'boolean',
      // 请求体形态（provider.js 的 buildThinkParams 按这个分派）。
      // 智谱是 thinking: {type:'enabled'} 对象型，与百炼的布尔字段不同。
      thinkStyle: 'zhipu',
      note: 'GLM 的思考是对象型参数（thinking: {type:"enabled"}），'
        + '没有档位区分，只有开与关。',
    },
    keyUrl: 'https://open.bigmodel.cn',
    help: '⚠ 地址是 /api/paas/v4，不是常见的 /v1 —— 少写一层就 404。',
  },
  {
    key: 'siliconflow',
    id: 'conn-preset-siliconflow',
    name: '硅基流动 SiliconFlow',
    protocol: 'openai',
    base: 'https://api.siliconflow.cn/v1',
    needKey: true,
    isLocal: false,
    // ⚠ 硅基流动是聚合平台，模型名是 org/model 形式，一个字符都不能少
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct', 'THUDM/glm-4-9b-chat'],
    modelsPath: '/models',
    think: {
      /**
       * ⚠⚠ 2026-10-15 从 'model-only' 改成 'boolean' + 'enable-thinking'。
       *
       * 原来写的是"靠模型名区分，没有统一的思考开关"——
       * 那个说法对老模型成立，但**对 Qwen3 是错的**：
       * 硅基流动支持顶层布尔 enable_thinking（与百炼同一个字段）。
       *
       * 错误的代价：档位选「关闭」时，请求里发的是 openrouter 那套
       * reasoning:{effort:'none'}，硅基流动直接忽略 → 思考照旧开。
       * 实测 Qwen/Qwen3-8B 同一条提问：
       *   发 reasoning.effort=none → 14751ms、思考 590 字
       *   发 enable_thinking=false → 1577ms、思考   0 字
       * 用户的体感就是"转半分钟，然后正文一个字都没有"。
       */
      style: 'boolean',
      thinkStyle: 'enable-thinking',
      note: '顶层布尔 enable_thinking（Qwen3 这类模型支持）。'
        + '不支持的模型会忽略它，不会报错。',
    },
    keyUrl: 'https://cloud.siliconflow.cn',
    help: '一个 key 接 200+ 模型。模型名带斜杠（org/model），填的时候别漏。',
  },
  {
    key: 'dashscope',
    id: 'conn-preset-dashscope',
    name: '阿里云百炼 / 通义千问',
    protocol: 'openai',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    needKey: true,
    isLocal: false,
    models: ['qwen-plus', 'qwen-max', 'qwen3-max'],
    modelsPath: '/models',
    think: {
      style: 'boolean',
      // 请求体形态：百炼是顶层布尔 enable_thinking（非 OpenAI 标准参数）
      thinkStyle: 'dashscope',
      // 已核实：enable_thinking 是布尔且必须是**顶层**字段，
      // 不能放 extra_body —— 与 OpenAI SDK 的用法正好相反。
      note: '该服务商的思考开关只有「开 / 关」两种，没有档位。',
    },
    keyUrl: 'https://bailian.console.aliyun.com',
    help: '密钥在百炼控制台获取。地址里的 compatible-mode 不能省。',
  },
  {
    key: 'volcengine',
    id: 'conn-preset-volcengine',
    name: '火山方舟（豆包）',
    protocol: 'openai',
    base: 'https://ark.cn-beijing.volces.com/api/v3',
    needKey: true,
    isLocal: false,
    models: ['doubao-pro-256k'],
    modelsPath: '/models',
    think: { style: 'none', note: '方舟的思考由模型自身决定，没有统一开关。' },
    keyUrl: 'https://console.volcengine.com/ark',
    help: '模型名通常是你在控制台创建的「推理接入点」ID，不一定是 doubao-pro。',
  },
  {
    key: 'moonshot',
    id: 'conn-preset-moonshot',
    name: '月之暗面 Kimi',
    protocol: 'openai',
    base: 'https://api.moonshot.cn/v1',
    needKey: true,
    isLocal: false,
    models: ['moonshot-v1-128k', 'kimi-k2-0711-preview'],
    modelsPath: '/models',
    think: { style: 'none', note: 'Kimi 目前没有统一的思考强度参数。' },
    keyUrl: 'https://platform.moonshot.cn',
    help: '长文本能力强，写长篇时上下文比较从容。',
  },
  {
    key: 'minimax',
    id: 'conn-preset-minimax',
    name: 'MiniMax',
    protocol: 'openai',
    base: 'https://api.minimax.chat/v1',
    needKey: true,
    isLocal: false,
    models: ['MiniMax-M3'],
    modelsPath: '/models',
    think: { style: 'none', note: '未提供统一的思考强度参数。' },
    keyUrl: 'https://platform.minimaxi.com',
    help: '',
  },
  {
    key: 'openrouter',
    id: 'conn-preset-openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    base: 'https://openrouter.ai/api/v1',
    needKey: true,
    isLocal: false,
    models: [],
    modelsPath: '/models',
    think: {
      style: 'levels',
      note: 'OpenRouter 用 reasoning.effort（档位），覆盖它家所有模型。',
    },
    keyUrl: 'https://openrouter.ai/keys',
    help: '聚合入口，一个 key 接 Claude / GPT / Gemini / 开源全家桶。',
  },
  {
    key: 'openai',
    id: 'conn-preset-openai',
    name: 'OpenAI',
    protocol: 'openai',
    base: 'https://api.openai.com/v1',
    needKey: true,
    isLocal: false,
    models: ['gpt-4o', 'gpt-4o-mini', 'o3'],
    modelsPath: '/models',
    think: { style: 'levels', note: '推理模型（o 系列）用 reasoning.effort 控档位。' },
    keyUrl: 'https://platform.openai.com/api-keys',
    help: '国内直连通常需要代理。',
  },
  {
    key: 'anthropic',
    id: 'conn-preset-anthropic',
    name: 'Anthropic Claude',
    // ⚠ 第三种协议。不是 OpenAI 兼容：端点、鉴权头、
    //   system 的位置、流式格式全都不同。见 provider.js。
    protocol: 'anthropic',
    base: 'https://api.anthropic.com',
    needKey: true,
    isLocal: false,
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    modelsPath: '/v1/models',
    think: {
      style: 'boolean',
      note: 'Claude 的 extended thinking 只有开/关，由 budget_tokens 控制长度。',
    },
    keyUrl: 'https://console.anthropic.com',
    help: '写长篇公认的好，但国内直连通常需要代理。',
  },

  // ---------------------------------------------------------
  // 自定义
  // ---------------------------------------------------------
  {
    key: 'custom-openai',
    id: 'conn-preset-custom-openai',
    name: '自定义接入（OpenAI 兼容）',
    protocol: 'openai',
    base: '',
    needKey: true,
    isLocal: false,
    models: [],
    modelsPath: '/models',
    think: { style: 'levels', note: '取决于该服务商是否实现，多数不支持。' },
    keyUrl: '',
    help: '填到 /v1 为止的地址。适用于任何 OpenAI 兼容的接口。',
  },
  {
    key: 'custom-anthropic',
    id: 'conn-preset-custom-anthropic',
    name: '自定义接入（Anthropic 兼容）',
    protocol: 'anthropic',
    base: '',
    needKey: true,
    isLocal: false,
    models: [],
    modelsPath: '/v1/models',
    think: { style: 'boolean', note: '取决于该服务商是否实现。' },
    keyUrl: '',
    help: '填到 /v1 之前的地址。适用于 Claude 官方与各类中转。',
  },
];

/**
 * 每个服务商「对话」端点的完整路径（相对 base）。
 *
 * ⚠⚠ 这一张表是 2026-10-14 修硅基流动「接入不行」时补的，
 * 之前 chat 路径在 provider.js 里被**写死成 `/v1/chat/completions`**，
 * 而硅基流动 / dashscope / moonshot / minimax / openrouter / openai 的
 * base 里**已经带 `/v1`**（`https://api.siliconflow.cn/v1`），
 * 拼出来变成 `/v1/v1/chat/completions` —— 全 404。
 * 智谱(base 带 `/v4`)、火山(base 带 `/v3`)同理被写死路径坑。
 *
 * ⚠ 不能靠「modelsPath 把 /models 换成 /chat/completions」推导：
 *   DeepSeek 的 models 在 `/models` 而 chat 在 `/v1/chat/completions`，
 *   同一家两个端点版本段就不一样，推导会错。所以**显式列出来**。
 *
 * 约定：base 里已经含版本段，这里只写版本段之后的那截。
 *   - 硅基流动 base `.../v1`  → chat `/chat/completions`
 *   - DeepSeek  base `...`(无版本) → chat `/v1/chat/completions`
 *   - 智谱      base `.../v4` → chat `/chat/completions`
 */
const CHAT_PATH = {
  ollama: '/api/chat',
  vllm: '/v1/chat/completions',
  deepseek: '/v1/chat/completions',
  zhipu: '/chat/completions',
  siliconflow: '/chat/completions',
  dashscope: '/chat/completions',
  volcengine: '/chat/completions',
  moonshot: '/chat/completions',
  minimax: '/chat/completions',
  openrouter: '/chat/completions',
  openai: '/chat/completions',
  anthropic: '/v1/messages',
  'custom-openai': '/chat/completions',
  'custom-anthropic': '/v1/messages',
};
/** 给每个预置补上 chatPath（界面与 provider 层都从这里取，不再写死） */
for (const p of PROVIDERS) {
  if (!p.chatPath) p.chatPath = CHAT_PATH[p.key] || '/chat/completions';
}

const BY_KEY = new Map(PROVIDERS.map((p) => [p.key, p]));

/** 取某项；取不到给 custom-openai 而不是 undefined —— 界面不能崩 */
function get(key) {
  return BY_KEY.get(key) || BY_KEY.get('custom-openai');
}

/** 自定义接入那两项（界面上的「＋ 新建」用） */
function customs() {
  return PROVIDERS.filter((p) => p.key.startsWith('custom-'));
}

/**
 * 按 base 反查 providerKey。
 *
 * 用途：从老配置迁移时，只有地址没有 providerKey，要猜它原来选的是哪家。
 * 猜不准就落到 custom-openai —— 地址本身仍然有效，
 * 只是界面上不再显示"这是硅基流动"而已。
 */
function guessByBase(base) {
  const b = String(base || '').replace(/\/+$/, '').toLowerCase();
  if (!b) return '';
  // ⚠ 先认本地：127.0.0.1:11434 是 Ollama 的默认地址，
  //   用户地址填错会正好撞上；而 OpenRouter 之类的云服务根本不会是本地。
  //   之前这里把本地跳过了，导致老配置里的 Ollama 地址被判成 custom-openai，
  //   迁移后协议从 ollama 变成 openai —— 端点从 /api/chat 变成
  //   /v1/chat/completions，请求直接 404。
  for (const p of PROVIDERS) {
    if (!p.isLocal) continue;
    if (b === p.base.toLowerCase()) return p.key;
  }
  for (const p of PROVIDERS) {
    if (p.isLocal) continue;           // 本地地址人人相同，别乱认
    if (b === p.base.toLowerCase()) return p.key;
    // 有些服务商文档给地址带 /v1，有些不带
    if (b === p.base.replace(/\/v\d+$/, '').toLowerCase()) return p.key;
  }
  return 'custom-openai';
}

module.exports = { PROVIDERS, get, customs, guessByBase };
