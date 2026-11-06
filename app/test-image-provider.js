/**
 * 判据：生图适配器 + 配置合并（node 直接跑，不联网、不开窗口）。
 *
 * 运行：node test-image-provider.js
 *
 * ## 判据为什么这么定
 *
 * 这里测的全是**会静默出错**的东西：
 *   - 尺寸分隔符（百炼要 `*`，写 `x` 是 400，而界面上只显示一种写法）
 *   - 千帆 ernie-image 的专属路径（走通用路径是 404）
 *   - 换服务商时清空旧 base/model（不清就是"选了方舟还在打百炼"）
 *   - 解析返回（少认一种键 = "生成成功但没图"）
 * 每一条错了都不会抛异常，只会给一个看不懂的结果 —— 所以必须有判据。
 */

const assert = require('node:assert');
const ip = require('./electron/image-provider');
const presets = require('./electron/image-presets');

const CHECKS = [];
function t(name, fn) {
  try { fn(); CHECKS.push({ name, pass: true }); console.log(`  ✓ ${name}`); }
  catch (e) { CHECKS.push({ name, pass: false }); console.log(`  ✗ ${name}  ${e.message}`); }
}

console.log('\n=== 一、尺寸：界面只写一种，各家自己转 ===');
t('百炼：1024x1536 → 1024*1536（分隔符是 *）',
  () => assert.strictEqual(ip.sizeFor('star', '1024x1536'), '1024*1536'));
t('百炼：用户手写 * 也认（不重复转）',
  () => assert.strictEqual(ip.sizeFor('star', '1024*1536'), '1024*1536'));
t('方舟/商汤/千帆：1024*1536 → 1024x1536',
  () => assert.strictEqual(ip.sizeFor('x', '1024*1536'), '1024x1536'));
t('全角 × 也认（中文输入法下很常见）',
  () => assert.strictEqual(ip.sizeFor('x', '1024×1536'), '1024x1536'));
t('非法尺寸判得出来（"1024x" 不算数）', () => {
  assert.strictEqual(ip.isValidSize('1024x1536'), true);
  assert.strictEqual(ip.isValidSize('1024x'), false);
  assert.strictEqual(ip.isValidSize(''), false);
  assert.strictEqual(ip.isValidSize('大一点'), false);
});

console.log('\n=== 二、路径：千帆 ernie 是例外 ===');
t('百炼走 multimodal-generation，不是 /images/generations',
  () => assert.strictEqual(ip.pathFor(presets.get('dashscope'), 'qwen-image-2.0'),
    '/api/v1/services/aigc/multimodal-generation/generation'));
t('方舟走 /images/generations',
  () => assert.strictEqual(ip.pathFor(presets.get('ark'), 'doubao-seedream-4-0-250828'), '/images/generations'));
t('千帆 ernie-image-turbo 走专属路径（通用路径会 404）',
  () => assert.strictEqual(ip.pathFor(presets.get('qianfan'), 'ernie-image-turbo'),
    '/ernie-image/images/generations'));
t('千帆的非 ernie 模型回到通用路径',
  () => assert.strictEqual(ip.pathFor(presets.get('qianfan'), 'qwen-image'), '/images/generations'));
t('商汤走 /images/generations',
  () => assert.strictEqual(ip.pathFor(presets.get('sensenova'), 'sensenova-u1.5-lite'), '/images/generations'));

console.log('\n=== 三、请求体：两种形状不能混 ===');
t('百炼：prompt 包在 input.messages[].content[].text 里',
  () => {
    const b = ip.buildRequest(presets.get('dashscope'),
      { base: '', model: 'qwen-image-2.0', prompt: '雪山', size: '1024x1536' });
    assert.strictEqual(b.body.input.messages[0].content[0].text, '雪山');
    assert.strictEqual(b.body.prompt, undefined, '百炼不该有顶层 prompt');
    assert.strictEqual(b.body.parameters.size, '1024*1536');
    assert.strictEqual(b.body.parameters.watermark, false);
  });
t('方舟：顶层 prompt + x 分隔',
  () => {
    const b = ip.buildRequest(presets.get('ark'),
      { base: '', model: 'doubao-seedream-4-0-250828', prompt: '雪山', size: '1024x1536' });
    assert.strictEqual(b.body.prompt, '雪山');
    assert.strictEqual(b.body.size, '1024x1536');
    assert.strictEqual(b.body.input, undefined, 'OpenAI 形状不该有 input');
  });
console.log('\n=== 三之二、地址拼接：不能把端点拼两遍（2026-11-02 那个 500） ===');
/**
 * ⚠⚠ 现场：用户把文档里的完整地址粘进「接口地址」——
 *   `https://ark.cn-beijing.volces.com/api/v3/images/generations \`
 *   代码又追加了一次 `/images/generations`，实际打到
 *   `.../api/v3/images/generations/images/generations`，
 *   方舟回了一句 `500 InternalServiceError`，谁都看不出是地址重复。
 *   所以：**用户已经写到端点就不再追加**，并且要能吃下 curl 的续行符和引号。
 */
t('粘了完整端点 + curl 续行符 `\\` 也不会重复拼',
  () => {
    const u = ip.previewUrl(presets.get('ark'), {
      base: 'https://ark.cn-beijing.volces.com/api/v3/images/generations \\',
      model: 'doubao-seedream-4-0-250828',
    });
    assert.strictEqual(u, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  });
t('只给根地址（/api/v3）时才会补上端点',
  () => {
    const u = ip.previewUrl(presets.get('ark'), {
      base: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'm',
    });
    assert.strictEqual(u, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  });
t('外面包了引号也认（从文档复制的常见形态）',
  () => {
    const u = ip.previewUrl(presets.get('ark'), {
      base: '"https://ark.cn-beijing.volces.com/api/v3"',
      model: 'm',
    });
    assert.strictEqual(u, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  });
t('任何情况下 URL 里都不该出现两次 /images/generations',
  () => {
    for (const base of [
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://ark.cn-beijing.volces.com/api/v3/images/generations',
      'https://ark.cn-beijing.volces.com/api/v3/images/generations/',
    ]) {
      const u = ip.previewUrl(presets.get('ark'), { base, model: 'm' });
      const n = (u.match(/\/images\/generations/g) || []).length;
      assert.strictEqual(n, 1, `${base} → ${u}`);
    }
  });
t('千帆 ernie 的专属路径粘完整了也不会叠',
  () => {
    const u = ip.previewUrl(presets.get('qianfan'), {
      base: 'https://qianfan.baidubce.com/v2/ernie-image/images/generations',
      model: 'ernie-image-turbo',
    });
    assert.strictEqual(u, 'https://qianfan.baidubce.com/v2/ernie-image/images/generations');
  });

console.log('\n=== 三之三、百炼 compatible-mode：同一家两种协议 ===');
/**
 * ⚠⚠ 现场：把 `https://dashscope.aliyuncs.com/compatible-mode/v1` 填进「接口地址」，
 *   程序还按**原生 DashScope** 拼 `/api/v1/services/aigc/...`，
 *   实际打到 `.../compatible-mode/v1/api/v1/services/...` → 404（界面上只显示一个 "404"）。
 *
 *   官方文档：qwen-image 系列同时支持 OpenAI-compatible 与 DashScope 两套协议，
 *   `compatible-mode` 这个段名就是切换开关。
 */
const DS = presets.get('dashscope');
t('填 compatible-mode/v1 时走 /images/generations（不是原生路径）', () => {
  const u = ip.previewUrl(DS, { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-image-3.0' });
  assert.strictEqual(u, 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations');
});
t('填原生根地址时仍走 multimodal-generation', () => {
  const u = ip.previewUrl(DS, { base: 'https://dashscope.aliyuncs.com', model: 'qwen-image-2.0' });
  assert.ok(u.endsWith('/api/v1/services/aigc/multimodal-generation/generation'), u);
});
t('兼容模式下请求体换成 OpenAI 形状（顶层 prompt，不是嵌 messages）', () => {
  const b = ip.buildRequest(DS, {
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-image-3.0', prompt: '雪原', size: '1024x1536',
  });
  assert.strictEqual(b.body.prompt, '雪原');
  assert.strictEqual(b.body.input, undefined, '兼容模式不该有 input.messages');
});
t('兼容模式下尺寸用 x 分隔（不是百炼原生的 *）', () => {
  const b = ip.buildRequest(DS, {
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-image-3.0', prompt: 'x', size: '1024x1536',
  });
  assert.strictEqual(b.body.size, '1024x1536');
});
t('原生模式下尺寸仍用 * 分隔', () => {
  const b = ip.buildRequest(DS, { base: 'https://dashscope.aliyuncs.com', model: 'qwen-image-2.0', prompt: 'x', size: '1024x1536' });
  assert.strictEqual(b.body.parameters.size, '1024*1536');
});

console.log('\n=== 三之四、按模型兜住"最小总像素"（Seedream 5.0） ===');
/**
 * ⚠ 方舟 Seedream 5.0 要求总像素 ≥ 3,686,400（≈1920×1920）。
 *   封面默认的 1024×1536 只有 157 万 → 400 InvalidParameter，
 *   而错误信息里**完全不提尺寸**，用户根本猜不到。
 */
t('50 万像素的测试尺寸会被抬到合法范围', () => {
  const r = ip.ensureMinPixels('512x512', ip.minPixelsFor('ark', 'doubao-seedream-5-0-flash-260915'));
  assert.strictEqual(r.changed, true);
  const [w, h] = r.size.split('x').map(Number);
  assert.ok(w * h >= 3686400, `放大后只有 ${w * h}`);
});
t('放大后仍保持 2:3 的比例（不把封面拉成方图）', () => {
  const r = ip.ensureMinPixels('1024x1536', 3686400);
  const [w, h] = r.size.split('x').map(Number);
  assert.ok(Math.abs(h / w - 1.5) < 0.08, `比例 ${(h / w).toFixed(2)}`);
});
t('已经够大的尺寸不动（不能把用户的设置改小）', () => {
  const r = ip.ensureMinPixels('2048x3072', 3686400);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.size, '2048x3072');
});
t('4.0 系列没有这个下限（1024x1536 原样通过）', () => {
  assert.strictEqual(ip.minPixelsFor('ark', 'doubao-seedream-4-0-250828'), 0);
});
t('别的服务商不受影响', () => {
  assert.strictEqual(ip.minPixelsFor('dashscope', 'qwen-image-3.0'), 0);
  assert.strictEqual(ip.minPixelsFor('qianfan', 'ernie-image-turbo'), 0);
});

t('自定义 base 里的多余斜杠会被吃掉（不会出现 //）',
  () => {
    const b = ip.buildRequest(presets.get('custom'),
      { base: 'https://example.com/v1/', model: 'flux', prompt: 'x', size: '1024x1024' });
    assert.ok(!b.url.includes('//images'), b.url);
    assert.strictEqual(b.url, 'https://example.com/v1/images/generations');
  });
t('请求头里**没有**密钥（密钥只在 generate 里拼）',
  () => {
    const b = ip.buildRequest(presets.get('ark'),
      { base: '', model: 'm', prompt: 'x', size: '1024x1024' });
    assert.strictEqual(b.headers.Authorization, undefined);
  });

console.log('\n=== 四、解析返回：两种形状 + 兜底 ===');
t('百炼：output.choices[].message.content[].image',
  () => {
    const r = ip.pickImage({
      output: { choices: [{ message: { content: [{ text: '' }, { image: 'https://a/1.png' }] } }] },
    });
    assert.deepStrictEqual(r, { kind: 'url', value: 'https://a/1.png' });
  });
t('OpenAI：data[0].url',
  () => {
    const r = ip.pickImage({ data: [{ url: 'https://b/2.png' }] });
    assert.deepStrictEqual(r, { kind: 'url', value: 'https://b/2.png' });
  });
t('OpenAI：data[0].b64_json（商汤默认可能回 base64）',
  () => {
    const r = ip.pickImage({ data: [{ b64_json: 'AAAA' }] });
    assert.deepStrictEqual(r, { kind: 'b64', value: 'AAAA' });
  });
t('个别站回 data[0].image_url 也认',
  () => {
    const r = ip.pickImage({ data: [{ image_url: 'https://c/3.png' }] });
    assert.strictEqual(r.value, 'https://c/3.png');
  });
t('什么都没有时返回 null（不能抛，也不能瞎猜）',
  () => assert.strictEqual(ip.pickImage({ data: [] }), null));

console.log('\n=== 五、报错要能读 ===');
t('OpenAI 形状：error.message', () => {
  assert.ok(ip.pickError(401, { error: { message: 'invalid api key' } }, '').includes('invalid api key'));
});
t('百炼形状：code + message', () => {
  const m = ip.pickError(400, { code: 'InvalidParameter', message: 'size is invalid' }, '');
  assert.ok(m.includes('InvalidParameter') && m.includes('size is invalid'), m);
});
t('不是 JSON 时退回原文截断（不吞掉服务端说的话）', () => {
  assert.ok(ip.pickError(502, null, '<html>bad gateway</html>').includes('bad gateway'));
});
/**
 * ⚠ 404 是最没信息量的码，而它恰好对应两种最常见的配置错误
 *   （地址拼错 / 模型没开通）。就那个光秃秃的 "404" 交给用户，等于让他猜。
 */
t('404 要翻成人话（地址拼错 / 模型没开通）', () => {
  const m = ip.pickError(404, null, '');
  assert.ok(m.includes('404'), m);
  assert.ok(/地址|开通/.test(m), m);
});
t('200 以外的普通错误不会被这条提示污染', () => {
  const m = ip.pickError(500, { code: 'X', message: 'boom' }, '');
  assert.ok(!/开通/.test(m), m);
});

console.log('\n=== 六、换服务商必须清掉旧地址/模型/尺寸 ===');
t('从百炼换到方舟：base/model/size 全清空',
  () => {
    const prev = { providerKey: 'dashscope', protocol: 'dashscope', base: 'https://dashscope.aliyuncs.com', model: 'qwen-image-2.0', size: '1024x1536' };
    const next = presets.mergeImagePatch(prev, { providerKey: 'ark' });
    assert.strictEqual(next.providerKey, 'ark');
    assert.strictEqual(next.protocol, 'openai');
    assert.strictEqual(next.base, '', '旧地址没清 → 用户会以为密钥错');
    assert.strictEqual(next.model, '');
    assert.strictEqual(next.size, '');
  });
t('换到自定义时同时带上地址和模型（同一个 patch 里也要对）',
  () => {
    const next = presets.mergeImagePatch({ providerKey: 'ark', base: 'https://ark', model: 'x' },
      { providerKey: 'custom', base: 'https://my/v1', model: 'flux' });
    assert.strictEqual(next.base, 'https://my/v1');
    assert.strictEqual(next.model, 'flux');
  });
t('只改尺寸时不动别的字段', () => {
  const prev = { providerKey: 'ark', base: 'https://ark', model: 'm', size: '1024x1536' };
  const next = presets.mergeImagePatch(prev, { size: '1024x1024' });
  assert.strictEqual(next.size, '1024x1024');
  assert.strictEqual(next.base, 'https://ark');
  assert.strictEqual(next.model, 'm');
});
t('不改入参（纯函数）', () => {
  const prev = { providerKey: 'ark', base: 'https://ark' };
  presets.mergeImagePatch(prev, { providerKey: 'qianfan' });
  assert.strictEqual(prev.providerKey, 'ark');
});
t('非法服务商名退回默认，不会把配置毒成 undefined',
  () => {
    const next = presets.mergeImagePatch({}, { providerKey: '不存在的家' });
    assert.strictEqual(next.providerKey, 'dashscope');
  });

console.log('\n=== 七、预付表自检 ===');
t('五家都在', () => assert.strictEqual(presets.list().length, 5));
t('每家都有 defaultModel / defaultSize / keyUrl（缺了界面就是空的）', () => {
  for (const p of presets.list()) {
    if (p.key === 'custom') continue;
    assert.ok(p.defaultModel, `${p.key} 缺 defaultModel`);
    assert.ok(p.defaultSize, `${p.key} 缺 defaultSize`);
    assert.ok(p.keyUrl, `${p.key} 缺 keyUrl`);
  }
});
t('每家的 defaultSize 都是合法 `宽x高`', () => {
  for (const p of presets.list()) assert.ok(ip.isValidSize(p.defaultSize), `${p.key}: ${p.defaultSize}`);
});
t('千帆的默认尺寸在它支持的那几个里（896x1200，3:4）',
  () => assert.strictEqual(presets.get('qianfan').defaultSize, '896x1200'));
t('商汤默认尺寸宽高都是 32 的倍数',
  () => {
    const [w, h] = presets.get('sensenova').defaultSize.split('x').map(Number);
    assert.strictEqual(w % 32, 0);
    assert.strictEqual(h % 32, 0);
  });

const bad = CHECKS.filter((c) => !c.pass);
console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
process.exit(bad.length ? 1 : 0);
