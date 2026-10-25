/**
 * 探针 3：修正模式表。
 *
 * 探针 2 的模式表有三个坏模式，全是**正则写错**导致的误报，不是数据的问题：
 *
 *   1.「三句排比」手写 3/4、模型 100% —— 实际匹配的是普通三项并列（中文正常句法）。
 *      真排比要求**同一句式的重复**，不是三个逗号。
 *   2.「具体亲属称谓」模型 95% —— `爹/娘/师父` 是超高频词，人和模型都在用。
 *      区分度为零的模式不该进表。
 *   3.「顿点独立成段」「省略主语对话」手写 0/4 —— **跨行正则失效**。
 *      窗口按句切开后段落边界已变，`^...$\n` 匹配不到。
 *
 * 本探针的核心约束：
 *   **只保留能被人一眼判读的模式。**
 *   一个需要解释"为什么这算 AI 味"的模式，就是没有区分度的模式，删掉。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { body, sentences, paragraphs } = require('./probe-flavor');

const ROOT = path.resolve(__dirname, '..');
const REAL = path.join(os.homedir(), 'AI写小说', '墨染仙途', '章节内容', '第一章.md');
const GEN_DIR = path.join(ROOT, '结果', 'chapters');

/**
 * 模式表 v3。
 * 每条都标 expected: 'absent-in-human' 手写零命中 | 'present-in-human' 手写应有
 */
const PATTERNS = {
  // ---- AI 腔：手写零命中 ----
  suspect: [
    ['心理直述套语', 'absent-in-human',
      /心中(?:一)?(?:暗|顿)?(?:想|道)|心里(?:头|中|底)?(?:一)?(?:暗|顿)?(?:想|道)|暗自(?:想|道|盘算)|心头(?:一)?(?:震|惊)/],
    ['冷笑一声', 'absent-in-human',
      /(?:冷笑|轻哼|冷哼)(?:一声|道)|(?:冷笑|轻哼|冷哼)了?一声/],
    ['仿佛式比喻', 'absent-in-human',
      /(?:像是|好像|宛如|犹如|好似)(?:一[一-龥]|[一-龥]{2,3})(?:一般|一样)/],
    ['眼中闪过', 'absent-in-human',
      /眼(?:中|底|里|眸(?:中|里))(?:闪过|掠过|浮现|划过|闪)/],
    ['不由得/不禁', 'absent-in-human',
      /不由得|不禁|忍不住地|忍不住又/],
    ['声音平淡类', 'absent-in-human',
      /声音(?:很|极|格外|依旧)?(?:淡|冷|平静|清冷)(?:地)?(?:说|道|响起)|语调(?:平淡|平静|冰冷)/],
    ['空气凝固', 'absent-in-human',
      /(?:空气|四周)(?:仿佛)?(?:凝固|凝滞|死寂)(?:了)?(?:一瞬|片刻|下来)?/],
    ['身形一闪', 'absent-in-human',
      /(?:身形|身影)(?:一)?(?:闪|晃|掠|暴退)|化作(?:一道)?(?:残影|流光|清风)/],
    ['总结升华句', 'absent-in-human',
      /(?:而这|这一切|这一切的)[^。！？]{2,14}(?:才是|不过是|终究是|不过只是)/],
    ['否定排比(真)', 'absent-in-human',
      /不是[^。！？]{2,8}[，。]不是[^。！？]{2,8}[，。]而是/],
    ['瞳孔/眼神骤变', 'absent-in-human',
      /瞳孔(?:猛地|骤然)?一(?:缩|紧)|眼神(?:猛地)?(?:一)?(?:凛|变|冷)/],
    ['嘴角勾起', 'absent-in-human',
      /嘴角(?:微微)?(?:勾起|上扬|一?翘)|唇角(?:微)?(?:勾起|上扬)/],
    ['仿佛…一般', 'absent-in-human',
      /仿佛[^，。！？]{1,12}(?:一般|似的)/],
    ['眉头一皱', 'absent-in-human',
      /眉头(?:猛地|微微|轻轻)?一?(?:皱|蹙|挑)|皱(?:了|起)眉头/],
  ],

  // ---- 人写特征：手写应命中 ----
  human: [
    ['方言口语', 'present-in-human',
      /莫要|啥|咋|嘛|咯|喽|怎的|恁|俺|你道|我道|不是(?:啥|啥子)/],
    ['具象日用物', 'present-in-human',
      /刨子|草鞋|包袱|铜钱|碎银|凉茶|腊肉|炊饼|千层底|扁担|锄头|镰刀|柴火|灶房|石墩|凉茶|木匣|银|包/],
    ['具体钱两数', 'present-in-human',
      /(?:[一二三四五六七八九十百千万]+|\d+)\s*两(?!侧|边|旁|个)/],
    ['生活化动词', 'present-in-human',
      /去皮|跑货|搬货|歇脚|支了个小摊|搅(拌)?|刷|砍|劈|挑着|背着|换了/],
    ['独立短段', 'present-in-human',
      /^[“”]?[^。！？，、]{1,8}[。！？][””]?$/gm],
  ],
};

/** 段落级统计（避开跨行正则在窗口里失效的问题） */
function paraStats(texts, fn) {
  let hit = 0, total = 0;
  for (const t of texts) for (const p of paragraphs(t)) { total++; if (fn(p)) hit++; }
  return { hit, total, ratio: total ? +(hit / total).toFixed(3) : 0 };
}

function docStats(texts, re) {
  let n = 0;
  for (const t of texts) {
    // 去空白后统计，避免行尾 \r 影响
    if (re.test(String(t).replace(/[ \t　]+/g, ''))) n++;
  }
  return n;
}

function main() {
  const real = body(fs.readFileSync(REAL, 'utf8'));
  const files = fs.readdirSync(GEN_DIR).filter((f) => f.endsWith('.md'));
  const genTexts = files
    .map((f) => { try { return body(fs.readFileSync(path.join(GEN_DIR, f), 'utf8')); } catch { return ''; } })
    .filter((t) => t.length > 100);

  console.log(`手写 1 章 ${real.length} 字｜模型 ${genTexts.length} 章\n`);
  console.log('=== AI 腔模式（期望：手写零命中）===');
  console.log('模式'.padEnd(16) + '手写'.padStart(8) + '模型出现章数'.padStart(14) + '判定');
  console.log('-'.repeat(62));
  const keep = [], drop = [];
  for (const [name, expect, re] of PATTERNS.suspect) {
    const rn = docStats([real], re);
    const gn = docStats(genTexts, re);
    const ok = rn === 0 && gn > 0;
    const line = name.padEnd(14) + String(rn).padStart(8) +
      `${gn}/${genTexts.length}`.padStart(14) + '  ' +
      (ok ? '✓ 有效' : (gn === 0 ? '✗ 模型也不出现，无用' : '✗ 手写也出现，误报'));
    console.log(line);
    (ok ? keep : drop).push(name);
  }

  console.log('\n=== 人写特征（期望：手写命中、模型少）===');
  console.log('模式'.padEnd(16) + '手写'.padStart(8) + '模型出现章数'.padStart(14) + '判定');
  console.log('-'.repeat(62));
  for (const [name, expect, re] of PATTERNS.human) {
    const rn = docStats([real], re);
    const gn = docStats(genTexts, re);
    const ok = rn > 0 && gn < genTexts.length * 0.3;
    console.log(name.padEnd(14) + String(rn).padStart(8) +
      `${gn}/${genTexts.length}`.padStart(14) + '  ' +
      (ok ? '✓ 有区分度' : (gn >= genTexts.length * 0.5 ? '✗ 模型也高频，无区分度' : '⚠ 手写零命中')));
  }

  // 段落级：独立短段
  const rp = paraStats([real], (p) => /^[“”]?[^。！？，、]{1,8}[。！？][””]?$/.test(p.trim()));
  const gp = paraStats(genTexts, (p) => /^[“”]?[^。！？，、]{1,8}[。！？][””]?$/.test(p.trim()));
  console.log('\n=== 段落级 ===');
  console.log(`独立短段占比  手写 ${rp.ratio} (${rp.hit}/${rp.total})  模型 ${gp.ratio} (${gp.hit}/${gp.total})`);

  console.log(`\n有效 AI 腔模式：${keep.length}/${PATTERNS.suspect.length}`);
  console.log(keep.map((k) => '  ✓ ' + k).join('\n'));
  if (drop.length) console.log(`剔除：${drop.join('、')}`);
}

if (require.main === module) main();
module.exports = { PATTERNS };