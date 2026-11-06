/**
 * 判据：封面提示词 + 项目图片协议（node 直接跑，不开窗口）。
 *
 * 运行：node test-cover.js
 *
 * ## 这里在防什么
 *
 * 1. **提示词漏了"不要文字"** → 图上自带一堆鬼画符，再叠书名就是双标题。
 *    这条错了不会有任何报错，只会在用户看到封面的那一刻暴露。
 * 2. **提示词漏了"下方留白"** → 书名只能压在主体上，糊成一团。
 * 3. **`wtfile://` 路径穿越** → 一个 `../../config.json` 就能读走用户的密钥。
 *    这是安全边界，必须有判据，而且要比对"确实被拒"。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const coverPrompt = require('./electron/cover-prompt');
const ip = require('./electron/image-provider');
const { makeWtfileHandler } = require('./electron/file-protocol');
const { ProjectFs } = require('./electron/project-fs');

const CHECKS = [];
function t(name, fn) {
  try { fn(); CHECKS.push({ name, pass: true }); console.log(`  ✓ ${name}`); }
  catch (e) { CHECKS.push({ name, pass: false }); console.log(`  ✗ ${name}  ${e.message}`); }
}
function tAsync(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { CHECKS.push({ name, pass: true }); console.log(`  ✓ ${name}`); })
    .catch((e) => { CHECKS.push({ name, pass: false }); console.log(`  ✗ ${name}  ${e.message}`); });
}

console.log('\n=== 一、提示词：三条硬要求 ===');
const P = coverPrompt.buildCoverPrompt({
  name: '墨染仙途',
  intro: '沈砚自幼被弃于雪原，被守门人捡回山门。',
  style: 'xianxia',
  kind: 'long',
});

/**
 * ⚠ 别钉死我写的字面句子 —— 那等于"改个措辞就红"，判据会变成维护负担。
 *   这里只要求**语义要素齐**：禁字的动作词 + 具体要禁的东西。
 */
t('明确禁止出现文字（否则标题会叠在鬼画符上）',
  () => {
    const ban = /(不要|禁止|不得|不能)[^。]{0,8}(生成|出现|包含)[^。]{0,8}文字/.test(P);
    if (!ban) throw new Error('提示词里没有"禁止出现文字"这句话');
    for (const word of ['汉字', '数字', '水印']) {
      if (!P.includes(word)) throw new Error(`禁字清单里缺「${word}」`);
    }
  });
t('禁字要求放在**第一句**（实测只写在中间模型会忽略）',
  () => {
    const first = P.split('\n')[0];
    if (!/文字/.test(first)) throw new Error(`第一句不是禁字：${first}`);
  });
t('结尾再强调一次（前置 + 重复是最低成本的降概率手段）',
  () => {
    const lines = P.split('\n');
    const last = lines[lines.length - 1];
    if (!/文字/.test(last)) throw new Error(`最后一句没再提：${last}`);
  });
/**
 * ⚠ 这条原来要的是「下方留出空白」——**那个措辞本身就是问题**：
 *   "空白/留白"在绘画语境里等于"这里该写点什么"，会引导模型自己补标题。
 *   现在改成描述暗部环境，判据也跟着改：要"下方三分之二是暗部且不放主体"。
 */
t('要求下方三分之一是暗部、不放主体物（而不是"留白"）',
  () => {
    const ok = /下方三分之一/.test(P) && /暗部/.test(P) && /不放主体物/.test(P);
    if (!ok) throw new Error(`没有"下方暗部"的要求：${P}`);
  });
t('主体取自简介（不是"随机画个风景"）',
  () => assert(P.includes('被弃于雪原')));
t('简介末尾的句号不会被叠成「。。」',
  () => {
    if (P.includes('。。')) throw new Error('出现了连续句号');
  });
t('竖版 2:3（封面比例，不是方图）', () => assert(/2:3/.test(P)));
t('每句话都带上了题材', () => {
  for (const s of ['xianxia', 'ink', 'real', 'anime', 'minimal']) {
    const p = coverPrompt.buildCoverPrompt({ name: '书', intro: '简介内容足够长的一句话。', style: s });
    if (!p.includes(coverPrompt.getStyle(s).tail)) throw new Error(`${s} 的画风没拼进去`);
  }
});
t('不认识的画风退回默认，不崩', () => {
  const p = coverPrompt.buildCoverPrompt({ name: '书', intro: '', style: '不存在' });
  assert(p.includes(coverPrompt.getStyle('xianxia').tail));
});
/**
 * ⚠ 这条原来断言"没简介就拿书名当主体"——那**正是**模型自己画标题的原因：
 *   Qwen-Image 看到书名就会把它渲染成标题字。所以行为反过来了：
 *   没简介也不能把书名塞进画面，但提示词仍必须够长、能画出东西。
 */
t('没简介也能出提示词（不能空着发给模型），但**不含书名**', () => {
  const p = coverPrompt.buildCoverPrompt({ name: '墨染仙途', intro: '', style: 'ink' });
  assert(!p.includes('墨染仙途'), '书名不该出现在画面描述里');
  assert(p.length > 80, `太短了：${p.length}`);
});
t('六种画风都在（新增「漫画Q版」）', () => {
  const list = coverPrompt.listStyles();
  assert(list.length === 6, `只有 ${list.length} 个`);
  assert(list.some((s) => s.key === 'chibi' && s.label === '漫画Q版'), JSON.stringify(list.map((s) => s.label)));
});

function assert(cond) { if (!cond) throw new Error('断言失败'); }

console.log('\n=== 一之一、风格预设 + A/B 两种模式（2026-11-02 新需求） ===');
/**
 * 需求要点：
 *   · 预设只是**提示词模板**，不锁画风；
 *   · A 模式（默认）：禁字 + 留标题区；B 模式：明确要求它把书名写出来；
 *   · 两种模式的反向词**必须不同** —— 否则 B 模式会被自己的反向词按住。
 */
t('预设模板有 6 套，且每套都带正向 + 反向', () => {
  const list = coverPrompt.listTemplates();
  assert(list.length === 6, `${list.length} 套`);
  for (const t of list) {
    assert(t.positive && t.positive.length > 10, `${t.key} 缺正向`);
    assert(t.negative && t.negative.length > 2, `${t.key} 缺反向`);
  }
});

const A_PROMPT = coverPrompt.buildCoverPrompt({
  name: '书', intro: '一段简介。', style: 'chibi', template: 'hot', titleMode: 'blank',
});
const B_PROMPT = coverPrompt.buildCoverPrompt({
  name: '墨染仙途', intro: '一段简介。', style: 'real', template: 'hot', titleMode: 'burn',
  subtitle: '重生那年', tags: ['重生', '逆袭'],
});

t('预设内容进了提示词（只影响构图氛围）', () => {
  assert(A_PROMPT.includes('标题'), A_PROMPT);
  assert(A_PROMPT.includes('主体'), A_PROMPT);
});
t('预设不锁画风：Q 版 + 爽感 能同时出现', () => {
  assert(A_PROMPT.includes('Q 版'), A_PROMPT);
  assert(A_PROMPT.includes('能量光效') || A_PROMPT.includes('速度线'), A_PROMPT);
});
t('A 模式：明令禁字', () => assert(/不要出现任何形式的文字/.test(A_PROMPT), A_PROMPT));
t('A 模式：给标题留位置（下方暗部不放主体）', () => {
  assert(/下方三分之一/.test(A_PROMPT) && /不放主体物/.test(A_PROMPT), A_PROMPT);
});
t('A 模式：**不出现**书名（否则模型会照着画）', () => {
  const p = coverPrompt.buildCoverPrompt({ name: '墨染仙途', intro: '一段简介。', style: 'ink', titleMode: 'blank' });
  assert(!p.includes('墨染仙途'), p);
});

t('B 模式：明确要求把书名写进画面', () => {
  assert(B_PROMPT.includes('书名为「墨染仙途」'), B_PROMPT);
  assert(/中文标题字/.test(B_PROMPT), B_PROMPT);
});
t('B 模式：副标题和标签也写进去', () => {
  assert(B_PROMPT.includes('重生那年'), B_PROMPT);
  assert(B_PROMPT.includes('逆袭'), B_PROMPT);
});
t('B 模式：仍然要求文字准确（错别字/乱码）', () => {
  assert(/错别字/.test(B_PROMPT) && /乱码/.test(B_PROMPT), B_PROMPT);
});

t('⚠ 反向词：A 模式压"文字"，B 模式**不能**压', () => {
  const a = coverPrompt.defaultNegative('blank');
  const b = coverPrompt.defaultNegative('burn');
  assert(a.includes('文字') && a.includes('标题'), a);
  assert(!/文字|汉字|标题/.test(b), b);
  assert(b.includes('错别字'), '文字模式下仍要防错别字');
});

t('统一约束：外部来的提示词也要追加（A 禁字 / B 排版要求）', () => {
  const a = coverPrompt.constraintFor('blank');
  const b = coverPrompt.constraintFor('burn', { name: '书', subtitle: '副', tags: ['一'] });
  assert(/不要出现任何文字/.test(a), a);
  assert(/书名为「书」/.test(b) && /副标题/.test(b), b);
});

console.log('\n=== 一之二、两个模型协同：给 LLM 的指令 + 输出清洗 ===');
const MSG = coverPrompt.buildEditorMessages({
  name: '墨染仙途',
  author: '羽某',
  genre: '仙侠',
  style: 'ink',
  scene: '雪原上的孤城',
  intro: '沈砚自幼被弃于雪原。',
  kind: 'long',
});
const SYS = MSG[0].content;
const USER = MSG[1].content;

t('给的是 system + user 两条消息（不是一段裸文本）',
  () => {
    assert(MSG.length === 2);
    assert(MSG[0].role === 'system' && MSG[1].role === 'user');
  });
t('system 里要求"只要那段描述"（否则会带着"以下是提示词："进图片）',
  () => assert(/只输出那一段/.test(SYS)));
t('system 里禁止文字（和模板同一条底线）', () => assert(/绝对不能有文字/.test(SYS)));
t('system 里要求下方留白（那是放书名的地方）', () => assert(/下方三分之一/.test(SYS)));
t('system 里禁止复述书名（书名会印上去，画里再来一次就是双标题）',
  () => assert(/不要复述书名/.test(SYS)));
/**
 * ⚠ 「作者」**故意不进来**：它和画面无关，但模型会把它画进图里
 *   （实测封面底部出现「作者：冷雨」，和我叠的那行重成两层字）。
 */
t('该给的要素都进了 user 消息（书名/题材/画风/画面/简介）',
  () => {
    for (const w of ['墨染仙途', '仙侠', '水墨', '雪原上的孤城', '沈砚']) {
      if (!USER.includes(w)) throw new Error(`缺「${w}」`);
    }
  });
t('没填的要素不会留空行/undefined', () => {
  const m = coverPrompt.buildEditorMessages({ name: '书', style: 'real' });
  assert(!/undefined|null/.test(m[1].content), m[1].content);
});

t('清洗：去掉「以下是提示词：」+ 代码围栏 + 引号',
  () => {
    const out = coverPrompt.cleanEditorOutput('以下是提示词：\n```\n"雪原孤城，暴风雪"\n```');
    assert(out === '雪原孤城，暴风雪', JSON.stringify(out));
  });
t('清洗：模型回 JSON 时取出 prompt 字段（别让花括号混进提示词）',
  () => {
    const out = coverPrompt.cleanEditorOutput('```json\n{"prompt":"雪原孤城"}\n```');
    assert(out === '雪原孤城', JSON.stringify(out));
  });
t('清洗：结尾的「希望有帮助」被丢掉', () => {
  const out = coverPrompt.cleanEditorOutput('雪原孤城。\n希望有帮助');
  assert(!out.includes('希望'), out);
});
t('清洗：正常输出原样保留（别把好句子也削了）',
  () => {
    const s = '雪原上的孤城，暴风雪后的清晨，冷蓝色调。';
    assert(coverPrompt.cleanEditorOutput(s) === s);
  });

t('画面 > 简介 > 书名：用户写了画面就优先用它',
  () => {
    const p = coverPrompt.buildCoverPrompt({
      name: '墨染仙途', intro: '简介里的内容。', scene: '用户要的画面。', style: 'ink',
    });
    assert(p.includes('用户要的画面'), p);
    assert(!p.includes('简介里的内容'), '简介不该同时出现');
  });
t('没写画面时退回简介',
  () => {
    const p = coverPrompt.buildCoverPrompt({ name: '书', intro: '简介内容足够长。', style: 'ink' });
    assert(p.includes('简介内容足够长'));
  });
t('题材会拼进模板（不选就不出现"题材："）',
  () => {
    const a = coverPrompt.buildCoverPrompt({ name: '书', intro: '一段简介。', style: 'ink', genre: '仙侠' });
    const b = coverPrompt.buildCoverPrompt({ name: '书', intro: '一段简介。', style: 'ink' });
    assert(a.includes('题材：仙侠'));
    assert(!b.includes('题材：'));
  });
t('题材清单非空（界面的下拉能填满）', () => assert(coverPrompt.listGenres().length >= 5));

console.log('\n=== 一之三、书名不能进画面（否则模型会自己画标题） ===');
t('兜底模板的主体里**不含书名**（写了书名模型就照抄）',
  () => {
    const p = coverPrompt.buildCoverPrompt({ name: '带着满级记忆回高中', style: 'real' });
    assert(!p.includes('带着满级记忆回高中'), p);
  });
t('提示词里明确「书名一个字都不能出现」', () => {
  const sys = coverPrompt.buildEditorMessages({ name: '书', style: 'ink' })[0].content;
  assert(/书名一个字都不能出现/.test(sys), sys.slice(0, 200));
});
t('出口处硬剔书名：《书名》包着的也剔',
  () => {
    const out = coverPrompt.stripBookTitle('《墨染仙途》中，一个少年站在窗前。', '墨染仙途');
    assert(!out.includes('墨染仙途'), out);
    assert(out.includes('一个少年'), out);
  });
t('出口处硬剔书名：裸书名也剔', () => {
  const out = coverPrompt.stripBookTitle('雪原孤城，墨染仙途的故事，冷色调。', '墨染仙途');
  assert(!out.includes('墨染仙途'), out);
});
t('太短的书名不动（避免误伤正文）', () => {
  const s = '雪原孤城，暴风雪。';
  assert(coverPrompt.stripBookTitle(s, '城') === s);
});

console.log('\n=== 一之四、模型回「负面提示词」要判出来 ===');
t('「负面提示词：畸形，扭曲…」判为不合格',
  () => assert(coverPrompt.looksLikeNegative(
    '负面提示词：\n畸形，扭曲，昏暗压抑，恐怖，悲伤，古风，魔幻，怪物，多余人物')));
t('正常的画面描述不会被误判',
  () => assert(!coverPrompt.looksLikeNegative('雪原上的孤城，暴风雪后的清晨，冷蓝色调，主体偏上。')));
console.log('\n=== 一之四之二、结构化提示词（正向+负向）不能误杀 ===');
/**
 * ⚠⚠ 羽毛菌从别处拿到一份完整提示词（正向描述 + 负面提示词 + 尺寸建议），
 *   贴在提示词框里。第一版我一看「负面提示词」就当废稿丢掉 —— **误杀**。
 *   所以要分清两种东西：
 *     「负面提示词：畸形…」（前面啥都没有）        → 废稿
 *     「正向提示词：黄昏教室…\n负面提示词：畸形…」 → 好东西，一个字都别改
 */
const STRUCTURED = [
  '【暗调时光回溯版｜适配 Seedream 5.0】',
  '',
  '正向提示词：',
  '都市重生爽文小说封面，厚涂写实，电影级逆光氛围感，黄昏高中校园，少年男主坐在课桌前，侧脸被落日金边勾勒。',
  '',
  '负面提示词：',
  '畸形人脸，崩坏肢体，水印，文字，杂乱涂鸦，古风，仙侠，怪物，阴暗恐怖，拥挤杂乱，遮挡男主，低质感，模糊，色彩脏污',
  '',
  '配套尺寸建议（满足Seedream5 ≥370 万像素要求）',
  '2048 × 2048',
].join('\n');

t('完整的「正向+负向」提示词**不被**判成废稿', () => {
  assert(!coverPrompt.looksLikeNegative(STRUCTURED));
});
t('纯反向词（前面没有正向内容）才判废稿', () => {
  assert(coverPrompt.looksLikeNegative('负面提示词：\n畸形人脸，崩坏肢体，水印，文字，杂乱涂鸦'));
});

const SP = coverPrompt.splitPrompt(STRUCTURED);
t('拆出正向段，且不含"负面提示词"这几个字', () => {
  assert(SP.structured === true);
  assert(SP.positive.includes('黄昏高中校园'), SP.positive);
  assert(!SP.positive.includes('负面提示词'), SP.positive);
});
t('拆出负向段，且不含"配套尺寸建议"那截', () => {
  assert(SP.negative.includes('畸形人脸'), SP.negative);
  assert(!SP.negative.includes('配套尺寸建议'), SP.negative);
  assert(!SP.negative.includes('2048'), SP.negative);
});
t('没有小标题的普通提示词原样返回（不拆）', () => {
  const s = coverPrompt.splitPrompt('雪原上的孤城，暴风雪。');
  assert(s.structured === false);
  assert(s.positive === '雪原上的孤城，暴风雪。');
});

console.log('\n=== 一之四之三、用户的负向词要进 negative_prompt，不能混进正向 ===');
const DSp = require('./electron/image-presets').get('dashscope');
/**
 * ⚠ 契约变了（2026-11-02 A/B 模式）：反向词由**调用方给全**，适配器不再自己拼。
 *   因为 A 模式要压"文字"，B 模式恰恰不能压 —— 两套逻辑必须在一处决定。
 */
t('调用方给了反向词就原样用（适配器不擅自拼）', () => {
  const b = ip.buildRequest(DSp, {
    base: 'https://dashscope.aliyuncs.com', model: 'qwen-image-2.0', prompt: '黄昏教室', size: '1024x1536',
    negative: '畸形人脸，崩坏肢体',
  });
  assert(b.body.parameters.negative_prompt === '畸形人脸，崩坏肢体', b.body.parameters.negative_prompt);
});
t('调用方没给时退回"别写字"那条底线', () => {
  const b = ip.buildRequest(DSp, {
    base: 'https://dashscope.aliyuncs.com', model: 'qwen-image-2.0', prompt: '黄昏教室', size: '1024x1536',
  });
  assert(b.body.parameters.negative_prompt.includes('文字'), b.body.parameters.negative_prompt);
});
t('百炼：正向段里不再夹着"负面提示词："', () => {
  const b = ip.buildRequest(DSp, {
    base: 'https://dashscope.aliyuncs.com', model: 'qwen-image-2.0', prompt: SP.positive, size: '1024x1536',
  });
  assert(!JSON.stringify(b.body).includes('负面提示词'), JSON.stringify(b.body.parameters));
});
t('OpenAI 形状（方舟）没有 negative_prompt 字段（硬塞会被拒）', () => {
  const ark = require('./electron/image-presets').get('ark');
  const b = ip.buildRequest(ark, {
    base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', prompt: '黄昏教室', size: '1024x1536',
    negative: '畸形人脸',
  });
  assert(b.body.negative_prompt === undefined, JSON.stringify(b.body));
});

t('给 LLM 的指令里写明了「只写正向」',
  () => {
    const sys = coverPrompt.buildEditorMessages({ name: '书', style: 'ink' })[0].content;
    assert(/只写\*\*正向\*\*/.test(sys) || /只写正向/.test(sys), sys.slice(0, 300));
    assert(/不要写"负面提示词"/.test(sys) || /负面提示词/.test(sys));
  });

console.log('\n=== 一之六、"封面"两个字不能进画面提示词（模型会照抄成版式） ===');
/**
 * ⚠⚠ 这是"模型自己画标题"的真正根因：提示词里写着「小说封面插画」，
 *   模型就按**封面版式**画，自己留标题位、自己把标题画上去。
 *   别处再怎么禁字都没用，因为任务本身被描述成了"画一张封面"。
 */
t('兜底模板里不出现「封面」二字', () => {
  const p = coverPrompt.buildCoverPrompt({ name: '墨染仙途', intro: '一段简介。', style: 'real', genre: '都市' });
  assert(!p.includes('封面'), p);
});
t('兜底模板说的是「插画」且声明没有版式/标题区', () => {
  const p = coverPrompt.buildCoverPrompt({ name: '书', intro: '一段简介。', style: 'real' });
  assert(/插画/.test(p), p);
  assert(/没有版式|没有标题区/.test(p), p);
});
t('构图描述里不出现「空白/留白」（会被模型理解成"这里该写字"）', () => {
  const p = coverPrompt.buildCoverPrompt({ name: '书', intro: '一段简介。', style: 'real' });
  assert(!/空白|留白/.test(p), p);
  const sys = coverPrompt.buildEditorMessages({ name: '书', style: 'ink' })[0].content;
  assert(!/留出干净|空白/.test(sys), sys);
});
t('系统提示词里也不出现「封面」二字', () => {
  const sys = coverPrompt.buildEditorMessages({ name: '书', style: 'ink' })[0].content;
  assert(!sys.includes('封面'), sys.slice(0, 120));
});
t('作者名不交给文字模型（会被画进图里）', () => {
  const m = coverPrompt.buildEditorMessages({ name: '书', style: 'ink', author: '冷雨' });
  assert(!m[1].content.includes('冷雨'), m[1].content);
});

console.log('\n=== 一之五、字体下载要有备用节点 ===');
const { mirrorUrls } = require('./electron/font-mirror');
t('jsDelivr 链接会展开成多个节点（一条挂了换下一条）',
  () => {
    const u = 'https://cdn.jsdelivr.net/gh/lxgw/LxgwWenKai@v1.522/fonts/TTF/LXGWWenKai-Regular.ttf';
    const list = mirrorUrls(u);
    assert(list.length >= 3, `只展开了 ${list.length} 条`);
    assert(list[0].includes('cdn.jsdelivr.net'));
    assert(list.some((x) => x.includes('fastly.jsdelivr.net')));
  });
t('换节点时路径不变（只有域名不同）', () => {
  const u = 'https://cdn.jsdelivr.net/gh/a/b@v1/f.ttf';
  for (const x of mirrorUrls(u)) assert(x.endsWith('/gh/a/b@v1/f.ttf'), x);
});
t('query 要保留（版本锁有时在 query 里）', () => {
  const list = mirrorUrls('https://cdn.jsdelivr.net/gh/a/b@v1/f.ttf?x=1');
  for (const x of list) assert(x.includes('?x=1'), x);
});
t('非 jsDelivr 的链接不瞎猜镜像', () => {
  const list = mirrorUrls('https://example.com/a.ttf');
  assert(list.length === 1 && list[0] === 'https://example.com/a.ttf');
});
t('坏地址不抛异常（返回原样，让下游报错）', () => {
  assert(mirrorUrls('not a url').length === 1);
});

console.log('\n=== 一之七、下载回来的必须是字体文件，不是网页 ===');
/**
 * ⚠⚠ 实测报错「下到的文件只有 199 字节」：服务器回了一个错误网页。
 *   老代码只查"大于 1KB"，这种 199 字节的会被当成"小文件"跳过——
 *   但真按 KB 放开就完了：网页被存成 .ttf，界面显示"已安装"，打开却说字体损坏。
 *   所以必须验**文件头魔数**。
 */
const { isFontFile } = require('./electron/font-mirror');

t('真 TTF 认得出来（开头 00 01 00 00）',
  () => assert(isFontFile(Buffer.concat([Buffer.from([0, 0x01, 0, 0]), Buffer.alloc(32)]))));
t('真 OTF 认得出来（开头 OTTO）',
  () => assert(isFontFile(Buffer.concat([Buffer.from('OTTO', 'latin1'), Buffer.alloc(32)]))));
t('字体集 TTC 认得出来（开头 ttcf）',
  () => assert(isFontFile(Buffer.concat([Buffer.from('ttcf', 'latin1'), Buffer.alloc(32)]))));
t('**错误网页**被拒（这就是 199 字节那种）',
  () => assert(!isFontFile(Buffer.from('<!DOCTYPE html><html><body>403 Forbidden</body></html>'))));
t('JSON 报错体被拒（有的 CDN 回 JSON）',
  () => assert(!isFontFile(Buffer.from('{"error":"not found"}'))));
t('空/过短的被拒', () => {
  assert(!isFontFile(Buffer.alloc(0)));
  assert(!isFontFile(Buffer.from([0, 1])));
  assert(!isFontFile(null));
});

console.log('\n=== 一之八、已安装的字体绝不能被"顺手删掉" ===');
/**
 * ⚠⚠ 现场：霞鹜文楷（17MB，能正常用）在装了新版之后**凭空消失**，
 *   列表里又变回「下载」。原因是 `font:installed` —— 一个**只读查询接口**——
 *   判文件头不像字体就 `unlink` 了它。
 *
 *   只读接口有破坏性，是这一整类 bug 的根源。
 */
const { classifyFontFile } = require('./electron/font-mirror');

t('文件头正常 → ok', () => {
  assert(classifyFontFile(17 * 1024 * 1024, true) === 'ok');
});
t('**大文件但文件头不认识 → 保留**（可能只是魔数不在我的清单里）', () => {
  assert(classifyFontFile(17 * 1024 * 1024, false) === 'suspect');
});
t('只有很小且不像字体的才清（当初那个 199 字节的错误页）', () => {
  assert(classifyFontFile(199, false) === 'garbage');
  assert(classifyFontFile(60 * 1024, false) === 'garbage');
});
t('64KB 是分界（边界上不删）', () => {
  assert(classifyFontFile(64 * 1024, false) === 'suspect');
  assert(classifyFontFile(64 * 1024 - 1, false) === 'garbage');
});

console.log('\n=== 二、wtfile:// 只能读项目内的图片 ===');
const ROOT = path.join(os.tmpdir(), 'wtfile-test-projects');
fs.mkdirSync(ROOT, { recursive: true });
const pfs = new ProjectFs(ROOT);
const PID = 'wt-1';
pfs.ensureProject(PID);
const handler = makeWtfileHandler(pfs);

/** 1×1 PNG */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const rel = ['_assets', '封面-1.png'].join('/');
const fp = pfs.resolveIn(PID, rel.split('/').join(path.sep));
fs.mkdirSync(path.dirname(fp), { recursive: true });
fs.writeFileSync(fp, PNG);
// 项目里放一个"非图片"，用来验扩展名白名单
fs.writeFileSync(path.join(ROOT, PID, '设定', '世界观.md'), '# 世界观\n');

/** ⚠ URL 里的中文要编码，否则 fetch/URL 解析会炸 */
const url = (p) => 'wtfile://' + PID + '/' + p.split('/').map(encodeURIComponent).join('/');

(async () => {
  const ok = handler(new Request(url(rel)));
  await tAsync('正常请求：200 且 content-type 是 image/png', async () => {
    assert(ok.status === 200);
    assert(ok.headers.get('content-type') === 'image/png');
    const buf = Buffer.from(await ok.arrayBuffer());
    assert(buf.length === PNG.length, `字节数对不上 ${buf.length}`);
  });

  await tAsync('不缓存的头在（换了封面要立刻看到）', async () => {
    assert(/no-store/.test(ok.headers.get('cache-control') || ''));
  });

  await tAsync('中文文件名能读（生成的封面就是中文名）', async () => {
    const r = handler(new Request(url(['_assets', '封面-2.png'].join('/'))));
    // 这个文件不存在 → 404 是对的；关键是"没有因为中文崩掉"
    assert(r.status === 404, `期望 404，实际 ${r.status}`);
  });

  await tAsync('非图片扩展名一律 403（不能当文件浏览器用）', async () => {
    const r = handler(new Request(url('设定/世界观.md')));
    assert(r.status === 403, `期望 403，实际 ${r.status}`);
  });

  await tAsync('路径穿越 ../ 被拒（这是安全边界）', async () => {
    const r = handler(new Request('wtfile://' + PID + '/%2e%2e%2f%2e%2e%2fconfig.png'));
    assert(r.status !== 200, `居然读到了，状态 ${r.status}`);
    const r2 = handler(new Request('wtfile://' + PID + '/_assets/../../config.png'));
    assert(r2.status !== 200, `居然读到了，状态 ${r2.status}`);
  });

  await tAsync('拿别的项目 id 当路径也越不出去', async () => {
    const r = handler(new Request('wtfile://../' + encodeURIComponent('x.png')));
    assert(r.status !== 200, `状态 ${r.status}`);
  });

  await tAsync('空路径 / 只有项目 id 也是 403', async () => {
    assert(handler(new Request('wtfile://' + PID + '/')).status === 403);
  });

  await tAsync('不存在的文件是 404，不是 500（别把异常抛给渲染层）', async () => {
    assert(handler(new Request(url('_assets/没有这个.png'))).status === 404);
  });

  console.log('\n=== 三、书名排版：一个字都不能丢 ===');
  /**
   * ⚠ 这是"截图看不出来"的一类 bug：图上只是"字有点怪"，
   *   实际是书名被截断了。所以喂一个**假的 ctx**（字符宽度 = 字号 × 0.98）
   *   直接数：排出来的字连起来必须和原文一模一样。
   */
  const { layoutTitle, wrapLines } = await import('./src/title-layout.mjs');

  const fakeCtx = () => ({
    font: '',
    letterSpacing: '',
    measureText(t) {
      const m = /(\d+)px/.exec(this.font);
      const size = m ? Number(m[1]) : 10;
      return { width: [...t].length * size * 0.98 };
    },
  });
  const LONG = '带着满级记忆回高中，我靠先知碾压全场';

  await tAsync('18 字长书名：排出来的字和原文完全一致（不截断、不加省略号）', async () => {
    const ctx = fakeCtx();
    const r = layoutTitle(ctx, LONG, (s) => `700 ${s}px x`, { width: 874 });
    assert(r.lines.join('') === LONG, `丢了字：${JSON.stringify(r.lines)}`);
    assert(!r.lines.join('').includes('…'), '不该出现省略号');
  });

  await tAsync('长书名最多 3 行（不会占到半个封面）', async () => {
    const ctx = fakeCtx();
    const r = layoutTitle(ctx, LONG, (s) => `700 ${s}px x`, { width: 874 });
    assert(r.lines.length <= 3, `排了 ${r.lines.length} 行`);
  });

  await tAsync('每行都不超过可用宽度（不溢出画布）', async () => {
    const ctx = fakeCtx();
    const r = layoutTitle(ctx, LONG, (s) => `700 ${s}px x`, { width: 874 });
    for (const line of r.lines) {
      ctx.font = `700 ${r.size}px x`;
      ctx.letterSpacing = `${Math.round(r.size * 0.03)}px`;
      const w = ctx.measureText(line).width;
      assert(w <= 874, `「${line}」宽 ${Math.round(w)} > 874`);
    }
  });

  await tAsync('短书名用最大字号（不会无故缩小）', async () => {
    const ctx = fakeCtx();
    const r = layoutTitle(ctx, '墨染仙途', (s) => `700 ${s}px x`, { width: 874 });
    assert(r.size === 128, `字号 ${r.size}`);
    assert(r.lines.length === 1);
  });

  await tAsync('极端长文本：宁可多行也不丢字', async () => {
    const ctx = fakeCtx();
    const T = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
    const r = layoutTitle(ctx, T, (s) => `700 ${s}px x`, { width: 874 });
    assert(r.lines.join('') === T, `丢了字：${r.lines.length} 行`);
  });

  await tAsync('放不下时 wrapLines 返回 null（而不是偷偷截断）', async () => {
    const ctx = fakeCtx();
    ctx.font = '700 128px x';
    assert(wrapLines(ctx, LONG, 874, 2) === null);
  });

  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
  try { fs.rmSync(path.join(os.tmpdir(), 'wtfile-test-projects'), { recursive: true, force: true }); } catch (_) {}
  process.exit(bad.length ? 1 : 0);
})();
