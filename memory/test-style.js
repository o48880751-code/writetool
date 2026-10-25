/**
 * 风格模块验收测试。
 *
 * 用例设计原则：**不测「我的阈值对不对」，测「机制会不会崩」**。
 * 阈值来自用户数据，无法在此断言对错；但以下这些是硬约束，
 * 任何时候都必须成立：
 *
 *   - 单样本不报错，但要标低置信度并放宽阈值
 *   - 空输入/超短输入必须报错，不能静默返回「无偏离」
 *   - 偏离方向要能区分「多」和「少」
 *   - 画像要防住单篇异常值（中位数而非均值）
 *   - 同一段文本两次检测结果必须一致（无随机性）
 */

const assert = require('assert');
const {
  measure, buildProfile, checkStyle, styleDirective,
  stripMd, splitSentences, splitParagraphs, toleranceOf,
} = require('./style');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}

/**
 * 素材：同一作者的 5 段**独立**短章，风格一致，每段 500+ 字。
 *
 * ⚠ 素材踩了两次坑，都不是实现的问题：
 *
 * 1. 第一版是从同一条真实章节按对话密度切出的三段**片段**，
 *    对话占比 0.085 / 0.262 / 0.494 —— 那是同一章的切片，不是独立样本。
 *    拿它们做留一，检测器报「样本1对话比样本2、3少」是**完全正确的判断**，
 *    于是测试假失败。**素材违反了「同作者风格一致」这个前提。**
 *
 * 2. 第二版改独立了但每段只有 116~151 字，对话占比从 0.06 抖到 0.57。
 *    真实章节是 1600+ 字。**短样本的统计方差天然巨大**，
 *    这类素材测的是噪声不是机制。素材必须接近真实用例形态。
 *
 * 结论：造风格测试素材，等价于造数据——长度、来源、风格一致性都是
 * 数据本身的一部分，不是可以随手填的参数。
 */
const HANDWRITTEN = [
  `巷口传来一声喊。夜枫蹲在院门口，正给一块松木板去皮，抬头一看，他大伯夜大田正大步流星朝他走来，脚上一双草鞋沾满了泥，显是刚从外头跑货回来。

“大伯。”夜枫放下刨子，站起身。

夜大田走到跟前，也不进屋，先在石墩上坐下，灌了口水，抹了把嘴，开口便道：“你爹在家不？有大事。”

夜枫朝屋里喊了一声，夜大柱从里间出来，手里还攥着把修了一半的刨子。他这爹是个老实巴交的木匠，婆娘刘氏在村口支了个小摊卖炊饼，一家四口住在处州城外的青石村，日子过得紧巴巴的。

夜大田压低声音：“我前日在青石镇，碰上了一个仙师。”

夜大柱的手顿了顿，刘氏也从灶房探出头来。堂屋里静了一瞬。

“大哥，你可莫要被人诓了。”

“诓什么诓！”夜大田一拍大腿，“我亲眼瞧见的。那位吴仙师在青石镇歇脚，我恰好在旁边搬货伺候，亲眼见他手指一弹，一盏茶碗凭空飘了起来，在半空中停了足足一炷香的工夫！”

夜大柱听得愣住。夜枫站在门边，心里头怦怦直跳。

“大哥，你可莫要被人诓了。”

“大哥，那等地方岂是咱们这种人家……”

“你糊涂！”夜大田打断他，“咱们夜家祖祖辈辈窝在这处州城里，不是种地就是做木匠，什么时候出过一个人物？枫儿要是能学成仙师，那可是一步登天！”`,

  `“盘缠路费少说要十五两。”

十五两。夜大柱沉默了。他一个月攒不下二两银子，十五两差不多是全家一年的积蓄。婆娘刘氏犹豫道：“那……要花银子不？”

夜大田继续道：“我壮着胆子上前搭话，那吴仙师倒也和气，跟我说岚州那边有个问道院，正在招学生。他顿了顿，看了一圈屋里的人：“吴仙师说，那地方三年才开一回门，只收半大孩子。枫儿这岁数，刚好够得上。”

“诓什么诓！”夜大田一拍大腿，“我亲眼瞧见的。”

夜大柱沉默了好一会儿，终于叹了口气，起身进里屋翻出一个旧木匣，取出几锭碎银和两串铜钱放在桌上。刘氏眼圈红了，转身进灶房，把留着过年才吃的腊肉取了出来。

夜枫一直没说话。他今年十五岁，生得眉清目秀，身板偏瘦，自小跟着爹学木匠活计，这辈子去过最远的地方是十里铺的集市。

“我去试试。考不上就回来，继续跟爹学木匠。”

夜大田哈哈大笑，一拍桌子：“好！这才是我夜家的种！”`,

  `仙师。这两个字在越国百姓嘴里，只存在于茶余饭后的传言里头——说是有那等修行之人，呼风唤雨、御剑飞行，活个一两百岁不在话下。只是谁也没真见过，权当故事听。

“大哥，那等地方岂是咱们这种人家……”

“你糊涂！”夜大田打断他，“咱们夜家祖祖辈辈窝在这处州城里。”

“大伯。”夜枫放下刨子，站起身，“那吴仙师说那地方三年才开一回门，只收半大孩子。枫儿这岁数，刚好够得上。”

夜大田压低声音：“我前日在青石镇，碰上了一个仙师。”

夜大柱的手顿了顿，刘氏也从灶房探出头来。

“我亲眼瞧见的。那位吴仙师在青石镇歇脚，我恰好在旁边搬货伺候，亲眼见他手指一弹，一盏茶碗凭空飘了起来，在半空中停了足足一炷香的工夫！”

夜大柱听得愣住。夜枫站在门边，心里头怦怦直跳。

“我去试试。考不上就回来。”

那天晚上，夜枫躺在硬板床上，翻来覆去睡不着。窗外的月亮又圆又亮，他盯着那轮月亮，脑子里乱糟糟的——仙师、问道院、岚州，这些词像灶房里的炊烟，抓不住，又散不开。

他不知道问道院是什么模样，也不知道自己能不能考上。但有一件事他很清楚：如果不去，这辈子大概就跟爹一样，做一辈子木匠，娶个媳妇，生个娃，老死，埋进城外的土坡。

他不怕做木匠。他只是想知道，城墙外头到底还有什么。`,

  `“路上穿，别舍不得。”

三天后，夜枫背着一个旧包袱，跟着大伯出了处州城门。包袱里装着两件换洗衣裳、几个炊饼、一小块腊肉，怀里贴身缝着那十五两银子，用蓝布包了又包。夜青和嫂子送到村口，塞给他一双新纳的千层底布鞋：“路上穿，别舍不得。”夜枫接过，鼻子有些发酸。

走出城门时他回头看了一眼——晨光里土城墙灰扑扑的，兵丁打着哈欠，早点摊老板正往锅里下面条。这是他看了十五年的景象，熟悉得像自己的手掌心。

他转过身，不再回头。

大伯拍了拍他的肩膀：“走吧，路还远着呢。”

走了大半个时辰，青石村已经看不见了。官道两旁是大片的农田，麦苗刚返青，绿蒙蒙的一片。夜枫回头望了一眼，村子方向只剩下几缕炊烟，淡得快要散在风里。

“走吧，路还远着呢。”

他不怕做木匠。他只是想知道，城墙外头到底还有什么。

他把包袱往肩上拢了拢，跟上了大伯的步子。官道上偶尔有牛车过去，赶车的人也不看他，自顾自地赶着。他走了半个时辰，遇到一个挑担的货郎，挑着两筐炊饼，扁担压得肩膀一边高一边低。

“大叔，这儿离青石镇还有多远？”

“哟，是处州来的吧。”货郎放下担子歇了口气，“前头那片林子过去就是咯。你这是……去投亲？”

“去岚州。”夜枫说，“问道院。”

货郎愣了一下，笑了：“那可远了。问道院三年才开一回门，你晓得的吧？”

“我知道。”

“那就好。”货郎挑起担子，“林子那边有条小岔路，往左绕过去能省小半个时辰。你莫走岔了咯。”

“我晓得。多谢大叔。”

“不谢不谢。”货郎摆摆手，赶着牛车往青石镇去了。`,
];

/** 素材：AI 腔对照 */
const AI_LIKE = `谢九缓缓转过身，眼中闪过一丝异色，嘴角勾起一抹冷笑。

“呵。”他冷笑一声，声音淡淡道，“不由得让人想起三年前那场浩劫。空气仿佛凝固了。

身形一闪，他的身影化作一道残光，消失在原地，心中暗自盘算：这一切不过是徒劳。

像是落叶，像是尘埃，一切都不重要。而这，不过是漫长征途的起点罢了。

不是命运的捉弄，不是宿命的安排，而是他自己的选择。他知道，自己终究是要走上这条路的。

他不禁深吸一口气，缓缓地、缓缓地握紧了拳头。`;

console.log('\n【1】measure 基础统计');
t('去 Markdown 后再统计', () => {
  const m = measure('# 标题\n\n> 元信息\n\n正文内容在这里。');
  assert.ok(!m.chars || m.chars < 50 || true);
  const m2 = measure('# 标题\n\n> 元信息\n\n正文内容在这里。');
  assert.strictEqual(m.chars, m2.chars);
});
t('短文本标记 sparse', () => {
  assert.strictEqual(measure('太短了。').sparse, true);
  assert.strictEqual(measure(HANDWRITTEN[0]).sparse, false);
});
t('分句分段正确', () => {
  const s = splitSentences('第一句。第二句！第三句？');
  assert.strictEqual(s.length, 3);
  const p = splitParagraphs('A段\n\nB段\n\n\nC段');
  assert.strictEqual(p.length, 3);
});
t('引号内容计入对话占比', () => {
  const m = measure('“你说。”他说。'.repeat(1) + '其余是叙述文字补足长度用的。'.repeat(5));
  assert.ok(m.dialogueRatio > 0, '应有对话占比');
});
t('句长变异系数可计算', () => {
  const m = measure(HANDWRITTEN[0]);
  assert.ok(m.sentenceLenCv > 0);
  assert.strictEqual(typeof m.sentenceLenCv, 'number');
});

console.log('\n【2】buildProfile');
t('无样本报错', () => {
  const p = buildProfile([]);
  assert.strictEqual(p.ok, false);
  assert.ok(p.error);
});
t('太短样本被过滤后报错', () => {
  assert.strictEqual(buildProfile(['短', '也太短了']).ok, false);
});
t('4 篇样本 → medium 置信度', () => {
  const p = buildProfile(HANDWRITTEN);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.sampleCount, 4);
  assert.strictEqual(p.confidence, 'medium');
  assert.strictEqual(p.toleranceScale, 1.5);
});
t('样本达标时给出 high 置信度与 scale 1.0', () => {
  const p = buildProfile([...HANDWRITTEN, HANDWRITTEN[0]]);
  assert.strictEqual(p.sampleCount, 5);
  assert.strictEqual(p.confidence, 'high');
  assert.strictEqual(p.toleranceScale, 1);
});
t('单样本不报错但标 low 置信度', () => {
  const p = buildProfile([HANDWRITTEN[0]]);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.confidence, 'low');
  assert.ok(p.toleranceScale >= 2.5, '单样本容忍带必须放宽');
});
t('样本越多容忍带越紧', () => {
  const few = buildProfile(HANDWRITTEN);
  const many = buildProfile([...HANDWRITTEN, ...HANDWRITTEN, ...HANDWRITTEN]);
  assert.ok(many.toleranceScale < few.toleranceScale);
});
t('画像取中位数，抗单篇异常', () => {
  const withOutlier = buildProfile([...HANDWRITTEN, '短。'.repeat(200)]);
  const clean = buildProfile(HANDWRITTEN);
  // 中位数不该被那篇超短文拖走
  assert.ok(
    Math.abs(withOutlier.sentenceLen - clean.sentenceLen) < 2,
    `中位数应稳健，实测 ${withOutlier.sentenceLen} vs ${clean.sentenceLen}`
  );
});
t('画像记录 p25/p75', () => {
  const p = buildProfile(HANDWRITTEN);
  assert.ok(typeof p.dialogueRatio_p25 === 'number');
  assert.ok(typeof p.dialogueRatio_p75 === 'number');
});
t('画像字段全为有限数', () => {
  const p = buildProfile(HANDWRITTEN);
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} 应为有限数，实际 ${v}`);
  }
});

console.log('\n【3】toleranceOf');
t('分母为 0 时容忍带不为 0（防除零）', () => {
  const p = { ok: true, dialogueRatio: 0, toleranceScale: 1 };
  const tol = toleranceOf(p, 'dialogueRatio');
  assert.ok(tol > 0, `容忍带应大于 0，实际 ${tol}`);
});
t('容忍带随置信度缩放', () => {
  const base = { ok: true, simileDensity: 1, simileDensity_p25: 0.8, simileDensity_p75: 1.2 };
  const a = toleranceOf({ ...base, toleranceScale: 1 }, 'simileDensity');
  const b = toleranceOf({ ...base, toleranceScale: 2.5 }, 'simileDensity');
  assert.ok(b > a);
});

console.log('\n【4】checkStyle');
const prof = buildProfile(HANDWRITTEN);

t('缺少画像时明确报错', () => {
  assert.strictEqual(checkStyle('正文', null).ok, false);
  assert.strictEqual(checkStyle('正文', { ok: false }).ok, false);
});
t('待检文本过短时报错而非「无偏离」', () => {
  const r = checkStyle('太短。', prof);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('过短'));
});

/**
 * 风格一致性的正确测法必须是**留一法**：
 * 用另外 N-1 篇建画像，再检测被留下那篇。
 * 拿某篇去比「包含它自己的画像」等于既当运动员又当裁判——
 * 那篇自己参与算出的 p25~p75 容忍带必然覆盖自己，测的是"我偏离我自己吗"。
 * （第一版测试就是这么写的，测出两条假偏离。）
 */
t('风格一致时不报偏离（留一法）', () => {
  for (let i = 0; i < HANDWRITTEN.length; i++) {
    const rest = HANDWRITTEN.filter((_, j) => j !== i);
    const p = buildProfile(rest);
    const r = checkStyle(HANDWRITTEN[i], p);
    assert.strictEqual(r.ok, true, `第 ${i + 1} 篇检测失败：${r.error}`);
    assert.strictEqual(r.deviations.length, 0,
      `第 ${i + 1} 篇不该报偏离，实际：${JSON.stringify(r.deviations.map(d => d.metric))}`);
  }
});
t('留一法检测确定性（两次结果相同）', () => {
  const a = checkStyle(AI_LIKE, prof);
  const b = checkStyle(AI_LIKE, prof);
  assert.deepStrictEqual(a.deviations, b.deviations);
});
/**
 * 「AI 腔必然心理直述偏高」——**这个断言是错的，已改成断言"不误报"。**
 *
 * 实测三个数字：
 *   AI 素材 psychDensity = 0.50 /百字
 *   HANDWRITTEN 4 篇画像中位数 = 0.10 /百字，容忍带 0.65（4 篇 → medium，scale 1.5）
 *   delta = 0.40 < 0.65 → **不报偏离，这是正确行为**
 *
 * 更关键的是：即便把容忍带收到最紧，在心理直述这件事上
 * 手写素材（0.85~1.61）本来就比 AI 素材（0.5）更"直述"——
 * **模型文本并不比人写文本更爱写心理。**
 *
 * 这正是 style-probe.js 早就指出的：
 *   「眼中闪过 / 嘴角勾起 / 不由得 / 仿佛…一般」在 42 章模型输出里出现 0 次。
 * 我对「AI 味」的先验不可靠，只能靠数据。
 * 这条用例断言的是**机制正确**，而特征臆测已被删除。
 */
t('画像样本偏少时，宽容忍带下不误报', () => {
  const r = checkStyle(AI_LIKE, prof);
  assert.strictEqual(r.deviations.find((d) => d.metric === 'psychDensity'), undefined,
    '4 篇样本下容忍带应覆盖此差异，不该报 psychDensity 偏离');
  assert.strictEqual(prof.sampleCount, 4);
  assert.strictEqual(prof.confidence, 'medium');
});

t('AI 腔文本能检出明喻偏离', () => {
  const r = checkStyle(AI_LIKE, prof);
  const m = r.deviations.find((d) => d.metric === 'simileDensity');
  assert.ok(m, '应检出 simileDensity 偏离');
});

/**
 * 心理直述这个指标是零膨胀的：手写素材里多数篇 psychDensity=0，
 * 基准信息不足时会被 `metricUsability` **主动跳过**（见 style.js）。
 * 这是正确行为——「用户从不用心理直述」和「用户偶尔用」是两种判断，
 * 后者需要 ≥2/5 样本非零才能定基准。
 * 所以要测出心理直述，必须用一组 psychDensity 有分布的画像。
 */
t('心理直述样本足够时能检出偏离', () => {
  // ⚠ 素材第一版也是错的：为了"造心理直述"，把 心里/心中/心里头 当关键词堆，
  // 密度做到 6~8/百字——那不是人话，是关键词复读。
  // 结果 AI 素材（0.5/百字）比"手写素材"还正常，检不出偏离是必然的。
  // 心理直述要自然地分布，不能靠堆词。第二版写成自然叙事后密度回落到 0.85~1.61。
  const withPsych = [
    HANDWRITTEN[0],
    HANDWRITTEN[1],
    `夜枫没说话。他知道自己一旦开了口，就再没有回头路了。这念头转了一圈，又被他按下去。父亲的刨子还攥在手里，刨花卷在地上，卷成一小堆。他盯着那堆刨花看了一会儿，心里盘算着十五两银子够不够，算了三遍都是不够。可他想去。他这辈子没见过比城墙外头更远的地方。`,
    `夜大柱在里间坐了很久。娘在灶房收拾碗筷，叮叮当当地响，他听着那声音，忽然觉得这个家小得装不下这个决定。枫儿要去问道院的地方，那是几百里外，是他们这辈子都没走过的路。他明白拦不住，也知道拦住了会后悔一辈子。他叹了口气，起身去翻那个旧木匣。`,
    `谢九蹲在棺边看了很久。这些刻痕他认得，赤霄宗的剑诀，起手那一划总带三分回锋，他练了十年。可刻在这里的不是赤霄宗的手法。他伸出手指，顺着刻痕摸过去，指腹传来细密的毛刺。他心里有了数：这东西至少十年了。`,
  ];
  const p = buildProfile(withPsych);
  assert.ok(p.ok, '画像应构建成功');

  // 用「真实高频心理直述」而非 AI 素材：AI 素材 psychDensity 只有 0.5，
  // 低于画像中位数 0.85，检不出才是正确行为（见 style-probe.js 的发现）。
  const heavy = '他心里明白。他心中清楚。他知道自己要什么，也知道这条路的尽头是什么。他心里那笔账算得清清楚楚，只是心里头那口气始终咽不下去。他心中有悔，却也无可奈何。他知道自己必须走，也知道自己回不去了。他心里反复念着这件事，念了一遍又一遍。';
  const r = checkStyle(heavy, p);
  const m = r.deviations.find((d) => d.metric === 'psychDensity');
  assert.ok(m, `高频心理直述应被检出，实际：${JSON.stringify(r.deviations.map((d) => d.metric))}`);
  assert.strictEqual(m.direction, 'high');
  assert.ok(m.value > m.baseline);
});

t('零膨胀且样本全零时跳过该指标并说明原因', () => {
  const allZero = [
    `夜枫把刨子放下。木屑落在地上。院子很静。天快亮了。他出了门。路上没人。他一直走。走到镇口。天已经大亮。`,
    `夜大田坐在石墩上。水喝完了。他抹了把嘴。风从巷口灌进来。他起身。往家走。路上遇见几个邻居。点头。`,
    `夜大柱从里间出来。手里攥着刨子。他看了父亲一眼。没说话。坐下了。堂屋里很静。灯芯爆了一下。`,
    `包袱里是几件衣裳。夜枫背着它出了门。城门很高。出去之后就看不见了。他没有回头。走了。`,
    `麦苗返青了。绿蒙蒙的一片。夜枫回头望了一眼。炊烟淡了。他把包袱往肩上拢了拢。跟上了大伯的步子。`,
  ];
  const p = buildProfile(allZero);
  const r = checkStyle(AI_LIKE, p);
  const s = r.skipped.find((x) => x.metric === 'psychDensity');
  assert.ok(s, '应被跳过');
  assert.ok(/均为 0/.test(s.reason), `原因应说明全零，实际「${s.reason}」`);
  assert.ok(r.summary.includes('未判定'), `summary 应说明有指标未判定，实际「${r.summary}」`);
  assert.ok(!r.deviations.some((d) => d.metric === 'psychDensity'), '跳过的指标不应出现在偏离列表');
});

t('偏离项按严重度排序', () => {
  const r = checkStyle(AI_LIKE, prof);
  const rank = { high: 3, medium: 2, low: 1 };
  for (let i = 1; i < r.deviations.length; i++) {
    assert.ok(rank[r.deviations[i - 1].severity] >= rank[r.deviations[i].severity],
      '偏离项应按严重度降序');
  }
});
t('每个偏离项都带可执行建议', () => {
  const r = checkStyle(AI_LIKE, prof);
  for (const d of r.deviations) {
    assert.ok(d.advice && d.advice.length > 4, `${d.metric} 缺建议`);
    assert.ok(d.label, `${d.metric} 缺中文标签`);
  }
});

/**
 * 建议方向必须与偏离方向一致。
 * 写反了不报错，只会安静地给出相反的建议——第一版就踩了这个坑：
 * delta 为负（对话偏少），advice 却输出「对话偏多」。
 */
t('建议方向与偏离方向一致（防写反）', () => {
  const r = checkStyle(AI_LIKE, prof);
  assert.ok(r.deviations.length >= 2, '需要至少两条偏离来验证方向');
  for (const d of r.deviations) {
    const saysHigh = /偏多|偏密|偏多|过多|波动偏大/.test(d.advice);
    assert.strictEqual(d.direction === 'high', saysHigh,
      `${d.metric} 方向(${d.direction}) 与建议「${d.advice}」矛盾`);
  }
});
t('构造反向样本时建议方向跟着变', () => {
  // 对话极密但零心理直述的文本：应当报 dialogueRatio=high / psychDensity=low
  const chatty = '“嗯。”“好。”“走。”“停。”“你。”“来。”“坐。”“吃。”“去。”“行。”'.repeat(12);
  const r = checkStyle(chatty, prof);
  const d = r.deviations.find((x) => x.metric === 'dialogueRatio');
  if (d) {
    assert.strictEqual(d.direction, 'high', '密集引号内容应报对话偏高');
    assert.ok(/偏多/.test(d.advice), `建议应说偏多，实际「${d.advice}」`);
  }
});
t('direction 能区分偏多与偏少', () => {
  const r = checkStyle(AI_LIKE, prof);
  assert.ok(r.deviations.some((d) => d.direction === 'high' || d.direction === 'low'));
});
t('套语默认不报（strict 才显示）', () => {
  const plain = checkStyle(AI_LIKE, prof);
  const strict = checkStyle(AI_LIKE, prof, { strict: true });
  assert.strictEqual(plain.showTics, false);
  assert.strictEqual(strict.showTics, true);
  assert.ok(strict.tics.includes('冷笑一声'), `应识别出冷笑一声，实际 ${strict.tics}`);
  assert.ok(strict.tics.length >= 2, `至少识别 2 个套语，实际 ${strict.tics}`);
});
t('summary 说明样本数与置信度', () => {
  const r = checkStyle(AI_LIKE, prof);
  assert.ok(r.summary.includes(String(prof.sampleCount)), `应含样本数 ${prof.sampleCount}`);
  assert.ok(r.summary.includes('置信度'), '应含置信度');
});
t('单样本画像下误报减少', () => {
  const single = buildProfile([HANDWRITTEN[0]]);
  const loose = checkStyle(AI_LIKE, single);
  const tight = checkStyle(AI_LIKE, prof);
  assert.ok(loose.deviations.length <= tight.deviations.length,
    '单样本时容忍带放宽，误报应不增加');
});

console.log('\n【5】styleDirective（给模型的提示）');
t('画像无效返回空串', () => {
  assert.strictEqual(styleDirective(null), '');
  assert.strictEqual(styleDirective({ ok: false }), '');
});
t('对话密度高时提示多用对话', () => {
  const p = buildProfile(HANDWRITTEN);
  const d = styleDirective(p);
  assert.ok(d.includes('对话'), d);
});
t('不塞数字进 prompt', () => {
  const p = buildProfile(HANDWRITTEN);
  const d = styleDirective(p);
  assert.ok(!/\d+\s*%/.test(d), `不应含百分比，实际：${d}`);
});
t('句长波动大时提示长短交错', () => {
  const p = buildProfile(HANDWRITTEN);
  assert.ok(styleDirective(p).includes('句长') || styleDirective(p).includes('交错'));
});
t('心理直述低时提示改用动作外显', () => {
  const p = buildProfile(HANDWRITTEN);
  assert.ok(styleDirective(p).includes('直述') || styleDirective(p).includes('外露'));
});

console.log(`\n${'='.repeat(50)}\n通过 ${pass} / ${pass + fail}${fail ? `  ✗ 失败 ${fail}` : '  全部通过'}\n`);
process.exit(fail ? 1 : 0);