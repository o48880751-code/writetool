/**
 * 第 3 步端到端：真实模型 + 真实手写样本。
 *
 * 验的不是「模型写得好不好」，而是**风格链路是否真的接上了**：
 *   1. 用《墨染仙途》真实手写章建画像 → 必须成功
 *   2. 画像转成 prompt 指令 → 必须非空、且不塞数字
 *   3. write_segment 返回的 style_check → 必须挂得上
 *   4. 同一段文本重复检测 → 必须一致（链路无随机性）
 *
 * ⚠ 不做「A/B 对比有无风格指令哪个更好」——
 *    那需要多轮生成，而羽毛菌已明确要求不再反复跑模型。
 *    风格层的价值靠离线用例（37 项）保证，这里只验证接线。
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildProfile, checkStyle, styleDirective, measure } = require('./style');
const { makeToolImpl, loadWorld } = require('../run-verify.js');

const REAL_CHAPTER = path.join(os.homedir(), 'AI写小说', '墨染仙途', '章节内容', '第一章.md');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}\n    ${detail || ''}`); fail++; }
}

async function chatProbe() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    return { ok: true, models: (j.models || []).map((m) => m.name) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  console.log('\n【1】用真实手写章建画像');
  if (!fs.existsSync(REAL_CHAPTER)) {
    console.log(`  ✗ 找不到 ${REAL_CHAPTER}`);
    process.exit(1);
  }
  const realText = fs.readFileSync(REAL_CHAPTER, 'utf8');
  const profile = buildProfile([realText]);
  t('画像构建成功', profile.ok, profile.error);
  if (!profile.ok) { process.exit(1); }

  t('样本数为 1', profile.sampleCount === 1, `实际 ${profile.sampleCount}`);
  t('置信度标记为 low（单样本）', profile.confidence === 'low', `实际 ${profile.confidence}`);
  t('单样本容忍带被放宽（scale 2.5）', profile.toleranceScale === 2.5, `实际 ${profile.toleranceScale}`);
  console.log(`  · 总字符 ${profile.totalChars}`);
  for (const k of ['dialogueRatio', 'concreteDensity', 'simileDensity', 'psychDensity', 'shortParaRatio']) {
    console.log(`    ${k} = ${profile[k]}`);
  }

  console.log('\n【2】画像转 prompt 指令');
  const directive = styleDirective(profile);
  t('生成了非空指令', directive.length > 0);
  t('指令不含百分比数字', !/\d+\s*%/.test(directive), `实际：${directive.slice(0, 80)}`);
  t('单样本下指令仍然产出（不空手而归）', directive.includes('文风要求'));
  console.log('  · 实际注入内容：');
  directive.split('\n').forEach((l) => console.log(`    ${l}`));

  console.log('\n【3】自检检测链路');
  const selfCheck = checkStyle(realText, profile, { strict: true });
  t('自检不报错', selfCheck.ok, selfCheck.error);
  t('自检零偏离（自己检自己）', selfCheck.deviations.length === 0,
    `实际偏离：${JSON.stringify(selfCheck.deviations.map((d) => d.metric))}`);
  const again = checkStyle(realText, profile, { strict: true });
  t('重复检测结果一致', JSON.stringify(selfCheck.deviations) === JSON.stringify(again.deviations));

  console.log('\n【4】Ollama 连通性');
  const probe = await chatProbe();
  if (!probe.ok) {
    console.log(`  ⚠ Ollama 未就绪（${probe.error}），跳过真实模型环节`);
    console.log('    启动方式：ollama serve');
  } else {
    t('Ollama 可达', true);
    console.log(`  · 已加载模型：${probe.models.join(', ')}`);
    const model = probe.models.find((m) => /qwen3:latest/.test(m)) || probe.models[0];
    if (!model) {
      console.log('  ⚠ 没有可用模型，跳过生成环节');
    } else {
      console.log(`\n【5】真实模型生成 + 风格检测（${model}）`);
      const world = loadWorld();
      // makeToolImpl(world, store) —— store 会被 writeSegment 写入 segments，不能传 null
      const store = { chapters: [], segments: [] };
      const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wt-style-'));
      const tools = makeToolImpl(world, store);
      const ctx = {
        model,
        facts: [{ name: '夜枫', type: 'character', note: '处州青石村少年，十五岁，木匠之子' }],
        styleProfile: profile,
        keepAlive: '5m',
        outDir: tmpDir,
        via: 'agent',
        chat: async (payload) => {
          const r = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(180000),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
      };
      const t0 = Date.now();
      const seg = await tools.write_segment(
        { scene: '夜枫第一次离开青石村，走在去青石镇的官道上，见到沿途的田野与行人', tone: '朴素克制', max_length: 500 },
        ctx
      );
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      t('write_segment 成功', seg.ok === true, seg.error);
      if (seg.ok) {
        console.log(`  · 生成 ${seg.chars} 字 / ${dt} 秒`);
        console.log(`  · 正文：${seg.text.slice(0, 120)}…`);
        t('style_check 已挂上（代码强制）', !!seg.style_check);
        if (seg.style_check) {
          console.log(`  · 检测结论：${seg.style_check.summary}`);
          if (seg.style_check.tics.length) console.log(`  · 套语提示：${seg.style_check.tics.join('、')}`);
          if (seg.style_check.skipped.length) {
            console.log(`  · 未判定指标：${seg.style_check.skipped.map((s) => `${s.label}(${s.reason})`).join('、')}`);
          }
          for (const d of seg.style_check.deviations) {
            console.log(`    · ${d.label} ${d.direction === 'high' ? '偏高' : '偏低'}：实测 ${d.value} / 基准 ${d.baseline} —— ${d.advice}`);
          }
          const m = measure(seg.text);
          console.log(`  · 画像对比：对话占比 ${m.dialogueRatio}（基准 ${profile.dialogueRatio}）、具象密度 ${m.concreteDensity}（基准 ${profile.concreteDensity}）`);
        }
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log(`\n${'='.repeat(56)}\n通过 ${pass} / ${pass + fail}${fail ? `  ✗ 失败 ${fail}` : '  全部通过'}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });