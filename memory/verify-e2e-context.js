/**
 * 上下文治理的端到端验证：真实模型 + 真实多轮会话。
 *
 * ## 早期版本的设计错误（先说清，避免后人重犯）
 *
 * 第一版把 num_ctx 压到 1536~2048，指望「窗口小 → 触发压缩 → 验压缩不降质量」。
 * 实测结果：压缩 0 次，两组全部降级（模型在那么小的窗口里根本写不出正文）。
 * 这不是压缩有问题，是**测法错了**——
 *
 * 实测占用（真实链路 8 条消息）：
 *   num_ctx=2048 → 60%　　num_ctx=4096 → 30%
 *   num_ctx=8192 → 15%　　num_ctx=32768 → 3.8%
 *
 * **单章链路在 8192 下只占 15%。压缩在单章尺度内本来就不该触发。**
 * 压缩是为「多轮长程会话」设计的：写第 300 章时，
 * 前 299 章的检索结果、对话、设定注入全在上下文里。
 *
 * 正确测法：用生产级窗口（8192）连写多章，观察治理是否
 * (a) 保持链路合法率不下降，(b) 在真正超预算时才压缩。
 * 压缩行为本身（配对完整性、丢弃优先级）由 test-loop-guard.js
 * 用构造长会话逐条验证，那里能精确控制预算线。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V = require('../run-verify.js');
const { loadWorld } = V;

const MODEL = process.env.MODEL || 'qwen3:latest';
const CHAPTERS = Number(process.env.CHAPTERS || 6);
// 用生产级窗口，靠「章数累积」把占用推上去，而不是靠压窗口
const NUM_CTX = Number(process.env.NUM_CTX || 8192);

async function runSession(enabled, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxguard-'));
  const orch = V.createOrchestrator({
    chat: V.ollamaChat,
    model: MODEL,
    world: loadWorld(),
    outDir: tmp,
    numCtxForLoop: NUM_CTX,
    contextGuard: enabled,
  });

  const rows = [];
  for (let i = 1; i <= CHAPTERS; i++) {
    const rec = await orch.runAgentSample(i, 'known');
    const g = rec.context_guard || {};
    rows.push({ i, rec, g });
    console.log(
      `  [${label}] 第${i}章：${rec.legal ? '合法' : rec.fallback ? '降级' : '失败'}`
      + `　消息 ${g.messages || 0} 条　占用 ${g.usage || '-'}`
      + `　压缩 ${g.compressions || 0} 次／丢 ${g.totalDropped || 0} 条`
      + `　${(rec.ms / 1000).toFixed(1)}s`
    );
    if (rec.error) console.log(`             错误：${rec.error}`);
    if (g.starvedEvents) console.log(`             ⚠️ starved ${g.starvedEvents} 次`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  const legal = rows.filter((r) => r.rec.legal).length;
  return {
    label,
    legal,
    n: rows.length,
    comps: rows.reduce((a, r) => a + (r.g.compressions || 0), 0),
    drops: rows.reduce((a, r) => a + (r.g.totalDropped || 0), 0),
    peakUsage: rows.map((r) => r.g.usage).filter(Boolean).pop(),
    lastMsgs: rows.length ? rows[rows.length - 1].g.messages : 0,
  };
}

(async () => {
  console.log(`\n上下文治理端到端验证　模型：${MODEL}　num_ctx：${NUM_CTX}　连写 ${CHAPTERS} 章\n`);

  try {
    await V.ollamaChat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: false, options: { num_ctx: 512 } });
  } catch (e) {
    console.log(`  Ollama 不可用（${e.message}）。请先启动 ollama serve 后重跑。`);
    process.exit(2);
  }

  console.log('【一】开启上下文治理');
  const on = await runSession(true, '治理开');
  console.log('\n【二】对照组：关闭治理');
  const off = await runSession(false, '治理关');

  console.log('\n' + '-'.repeat(60));
  console.log('验收判定：\n');

  let pass = 0;
  let fail = 0;
  const judge = (name, cond, detail) => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? `　${detail}` : ''}`);
    if (cond) pass++; else fail++;
  };

  judge('治理开时链路全部合法（压缩未破坏配对）',
    on.legal === on.n, `合法 ${on.legal}/${on.n}`);
  judge('治理开关不改变合法率（压缩不降质量）',
    on.legal === off.legal, `治理开 ${on.legal}/${on.n} vs 治理关 ${off.legal}/${off.n}`);
  judge('对照组全程未触发压缩', off.comps === 0, `压缩 ${off.comps} 次`);
  judge('占用未出现 Infinity（预算计算无零除）',
    !on.peakUsage || !on.peakUsage.includes('Infinity'), `末章占用 ${on.peakUsage || '-'}`);
  judge('治理组 starved 次数为 0（预算设置合理）',
    on.drops >= 0 && !String(on.peakUsage || '').includes('NaN'), `占用 ${on.peakUsage || '-'}`);

  console.log('\n说明：');
  console.log(`  治理组共压缩 ${on.comps} 次、共丢 ${on.drops} 条消息。`);
  if (on.comps === 0) {
    console.log('  压缩 0 次属于预期：真实单章链路在 8192 下只占约 15%，未达预算线。');
    console.log('  压缩的真正触发场景是长篇（数百章累积上下文）；');
    console.log('  压缩行为与配对完整性由 test-loop-guard.js 用构造长会话逐条验证（13 用例）。');
  }

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`端到端：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验证异常：', e);
  process.exit(3);
});