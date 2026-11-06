/**
 * 封面生图服务商预付表。
 *
 * ## 为什么单独一份，不并进 `provider-presets.js`
 *
 * 那张表喂的是**文本模型**：对话的模型下拉、"正在用的模型"、思考档位，
 * 全都从 `connections` 表来。把生图模型塞进去，用户会在对话的模型列表里
 * 看见 `qwen-image` —— 选了就 400，因为它是画图的，不是聊天的。
 * 羽毛菌要的正是「生图和输出正文互不干扰」，所以这里连表都不共用。
 *
 * ## 尺寸为什么按家分开默认
 *
 * ⚠ 这是最容易踩的一脚：**同一串 "1024x1536" 不是每家都认。**
 * - 百炼的分隔符是 `*`，写 `x` 直接报错；
 * - 千帆的 ernie-image-turbo 只认几个固定分辨率，给别的会**静默**变成 1376×768（横图！）；
 * - 商汤要求宽高是 32 的倍数。
 *
 * 所以界面上永远显示 `宽x高` 这一种写法，由 `image-provider.js` 按
 * `sizeStyle` 转换 —— **别让用户在两个格式之间自己记**。
 *
 * @typedef {object} ImagePreset
 * @property {string} key
 * @property {string} name        界面上显示的名字
 * @property {'dashscope'|'openai'} protocol  请求体形状，不是"公司"
 * @property {string} base        到版本段为止的根地址
 * @property {string[]} models
 * @property {string} defaultModel
 * @property {'star'|'x'} sizeStyle
 * @property {string} defaultSize 统一写成 `宽x高`
 * @property {string} keyUrl
 * @property {string} [help]
 */

/** @type {ImagePreset[]} */
const IMAGE_PRESETS = [
  {
    key: 'dashscope',
    name: '阿里云百炼 · Qwen-Image',
    protocol: 'dashscope',
    base: 'https://dashscope.aliyuncs.com',
    models: [
      'qwen-image-2.0-pro',
      'qwen-image-2.0',
      'qwen-image',
      'qwen-image-plus',
      'wan2.7-image',
      'z-image-turbo',
    ],
    defaultModel: 'qwen-image-2.0',
    sizeStyle: 'star',
    defaultSize: '1024x1536',
    keyUrl: 'https://bailian.console.aliyun.com/',
    help: '和文本用的百炼是同一个 Key，可以直接复用。尺寸分隔符是 * 不是 x —— 这个由程序替它转，不用你管。'
      // ⚠ 这条不是废话：Qwen-Image 的官方卖点就是"擅长中文字渲染"，
      //   于是它特别爱在画面里自己加标题。提示词已经禁字、反向词也压了，
      //   但它**只是概率低一些，不是不写**。想少出字就换 Seedream。
      + '注意：Qwen-Image 很擅长渲染中文，因此容易在画面里自己加标题；如果封面老有多余的字，换「火山方舟 · Seedream」通常更干净。',
  },
  {
    key: 'ark',
    name: '火山方舟 · 豆包 Seedream',
    protocol: 'openai',
    base: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      'doubao-seedream-4-0-250828',
      'doubao-seedream-3-0-t2i-250415',
    ],
    defaultModel: 'doubao-seedream-4-0-250828',
    sizeStyle: 'x',
    defaultSize: '1024x1536',
    keyUrl: 'https://console.volcengine.com/ark',
    help: '模型名带日期后缀，一字符都不能少；方舟控制台里"接入点"的 ID 也能直接填在这里。'
      // ⚠ 这条是实测踩出来的：5.0 系列有**总像素下限**，默认的 1024x1536 会被 400 拒掉，
      //   而错误信息里完全不提尺寸。程序会自动放大到合法尺寸并在界面说明。
      + '注意：Seedream 5.0 系列要求总像素不低于约 370 万（≈1920×1920），'
      + '尺寸填小了会被 400 拒绝 —— 程序会自动帮你放大到合法值。'
      + '另外 404 通常是"这个模型在你的账号下还没开通"，去方舟控制台「开通管理」里开一下。',
  },
  {
    key: 'sensenova',
    name: '商汤 · 日日新 SenseNova',
    protocol: 'openai',
    base: 'https://token.sensenova.cn/v1',
    models: ['sensenova-u1.5-lite'],
    defaultModel: 'sensenova-u1.5-lite',
    sizeStyle: 'x',
    defaultSize: '1024x1536',
    keyUrl: 'https://platform.sensenova.cn/',
    help: '宽高必须是 32 的倍数。默认返回的是临时链接，24 小时后失效 —— 生成完要立刻存到本地。',
  },
  {
    key: 'qianfan',
    name: '百度 · 千帆',
    protocol: 'openai',
    base: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-image-turbo', 'qwen-image', 'flux-1-schnell'],
    defaultModel: 'ernie-image-turbo',
    sizeStyle: 'x',
    defaultSize: '896x1200',
    keyUrl: 'https://console.bce.baidu.com/qianfan/',
    help: '⚠ ernie-image-turbo 只认固定分辨率（1024×1024 / 896×1200 / 768×1376 等），填别的会被**静默**改成 1376×768 的横图。',
  },
  {
    key: 'custom',
    name: '自定义（OpenAI 兼容 /images/generations）',
    protocol: 'openai',
    base: '',
    models: [],
    defaultModel: '',
    sizeStyle: 'x',
    defaultSize: '1024x1536',
    keyUrl: '',
    help: '任何实现了 OpenAI 图像接口的服务都能填：硅基流动、各类聚合站、自建的 one-api 等。地址填到版本段（通常是 /v1）。',
  },
];

const BY_KEY = new Map(IMAGE_PRESETS.map((p) => [p.key, p]));

function get(key) {
  return BY_KEY.get(key) || BY_KEY.get('dashscope');
}

/** 前端只认这个（附带 `defaults`，省得它自己再写一遍默认值） */
function list() {
  return IMAGE_PRESETS.map((p) => ({ ...p }));
}

/**
 * 合并一次配置改动。
 *
 * ⚠⚠ **换服务商必须把 base/model/size 清回那家的默认**。
 *   不清的话，上一家的地址和模型名会跟着过去：
 *   用户明明点了"火山方舟"，请求还在打百炼的域名，
 *   回来的 401/404 看着像"密钥不对"，其实是地址没换。
 *
 * 单独抽成纯函数是为了能直接测 —— 这段逻辑埋在 IPC handler 里的话，
 * 判据只能靠桩自证（桩怎么写的就怎么过，等于没测）。
 *
 * @param {object} prev   原配置
 * @param {object} patch  这次要改的字段
 * @returns {object} 新配置（不修改入参）
 */
function mergeImagePatch(prev, patch) {
  const p = patch || {};
  const next = { ...(prev || {}) };

  if (p.providerKey !== undefined) {
    const preset = get(p.providerKey);
    next.providerKey = preset.key;
    next.protocol = preset.protocol;
    next.base = '';
    next.model = '';
    next.size = '';
  }
  for (const k of ['base', 'model', 'size']) {
    if (p[k] !== undefined) next[k] = String(p[k] == null ? '' : p[k]).trim();
  }
  return next;
}

module.exports = { IMAGE_PRESETS, get, list, mergeImagePatch };
