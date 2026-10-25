/**
 * 记忆层端到端验证：真实模型生成一章 → 落库 → 状态回写。
 *
 * 这是第 2 步真正的验收：不是「模块能跑」，而是「模型写出来的真实文本，
 * 状态回写能从中提取出结构化状态」。
 *
 * 运行：node memory/verify-e2e.js
 * 前置：Ollama 在 127.0.0.1:11434 在线
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../db/store.js');
const { ContextBudget, summarizeBible } = require('./context-budget.js');
const { applyStateAfterCommit } = require('./state-writer.js');
const V = require('../run-verify.js');

const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'qwen3:latest';

async function main() {
  console.log(`\n记忆层端到端验证　模型：${MODEL}\n`);

  try {
    const r = await fetch(`${V.BASE_URL}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const names = (r.json ? [] : []);
    void names;
  } catch (e) {
    console.log(`Ollama 未启动（${V.BASE_URL}）：${e.message}`);
    console.log('请先启动 Ollama 再运行本脚本。');
    process.exitCode = 1;
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-e2e-'));
  const store = new Store(path.join(tmp, 'e2e.db'));
  store.importWorldBible(V.resolveWorldPath(), (pid) => {
    store.createProject({ id: pid, name: `项目 ${pid}` });
  });
  const settings = store.loadSettings('novel-demo-01');
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n         · ' + detail : ''}`);
  };

  // ------------------------------------------------------------
  console.log('【一】上下文预算在真实设定库上的表现');

  const bibleSummary = summarizeBible(settings, { maxChars: 600 });
  console.log(`  设定摘要：${bibleSummary.included} 条纳入，${bibleSummary.dropped} 条未纳入，${bibleSummary.chars} 字符`);
  check('设定摘要在预算内', bibleSummary.chars <= 700, `${bibleSummary.chars} 字符`);

  const budget = new ContextBudget({ numCtx: 8192, reserve: 2048, keepRecentRounds: 3 });
  budget.push({ role: 'system', content: '你是执笔者，只输出正文。' + bibleSummary.text, pinned: true });
  check('固定区（system + 设定摘要）不超预算', budget.usedTokens() <= budget.historyBudget,
    `${budget.usedTokens()}/${budget.historyBudget}（${budget.report().usage}）`);

  // 模拟 10 轮长对话，看压缩是否生效
  for (let i = 1; i <= 10; i++) {
    budget.push({ role: i % 2 ? 'assistant' : 'user', content: `第${i}轮对话内容`.repeat(400) });
    budget.push({ role: 'tool', content: `第${i}轮检索结果`.repeat(200) }, { used: i % 2 === 0 });
  }
  const before = budget.usedTokens();
  const dropped = budget.compress();
  check('10 轮长对话被压缩进预算', budget.usedTokens() <= budget.historyBudget,
    `${before} → ${budget.usedTokens()}/${budget.historyBudget}，丢弃 ${dropped.length} 条` +
    `，剩余 ${JSON.stringify(budget.report().byRole)}`);
  check('压缩未标记 starved（有可丢的条目）', budget.starved === false);

  // ------------------------------------------------------------
  console.log('\n【二】真实模型生成 → 状态回写');

  const orch = V.createOrchestrator({
    chat: V.ollamaChat,
    model: MODEL,
    world: settings,
    outDir: path.join(tmp, 'out'),
    deterministic: false,
  });

  const chapters = [];
  for (let i = 1; i <= 2; i++) {
    const rec = await orch.runAgentSample(i, 'known');
    const tag = rec.legal ? '合法' : rec.fallback ? '降级' : '失败';
    console.log(`  第${i}章：${tag}　重试 ${rec.retries}　${(rec.ms / 1000).toFixed(1)}s`);
    if (rec.error) console.log(`         错误：${rec.error}`);
    if (rec.chapter && fs.existsSync(rec.chapter)) {
      const body = fs.readFileSync(rec.chapter, 'utf8');
      const cid = `e2e-c${i}`;
      store.createChapter({
        id: cid, projectId: 'novel-demo-01',
        title: `第${i}章`, content: body, origin: 'agent',
      });
      chapters.push({ cid, body, rec });
    }
  }

  check('真实模型产出至少一章', chapters.length > 0, `产出 ${chapters.length} 章`);

  // ------------------------------------------------------------
  console.log('\n【三】状态回写（编排层强制触发）');

  let allEntities = new Map();
  let totalApplied = 0;
  let totalConflicts = 0;
  for (const c of chapters) {
    const res = applyStateAfterCommit({
      store, projectId: 'novel-demo-01', chapterId: c.cid,
      text: c.body, settings,
    });
    totalApplied += res.applied;
    totalConflicts += res.conflicts.length;
    res.entities.forEach((e) => allEntities.set(e.name, (allEntities.get(e.name) || 0) + e.count));
    console.log(`  ${c.cid}：${res.summary}`);
    console.log(`         提及：${res.entities.map((e) => `${e.name}(${e.count})`).join('、') || '无'}`);
    if (res.conflicts.length) {
      res.conflicts.forEach((cf) => console.log(`         ⚠️ 冲突：${cf.hint}`));
    }
  }

  const states = store.listEntityStates('novel-demo-01');
  console.log('');
  console.log(`  状态表落库 ${states.length} 条：`);
  for (const s of states) {
    console.log(`    ${s.entity_name}：${JSON.stringify(s.state)}（记于 ${s.updated_in_chapter}）`);
  }

  check('状态回写有实际产出', totalApplied > 0,
    `更新 ${totalApplied} 条，提及实体 ${allEntities.size} 个：${[...allEntities.keys()].join('、')}`);
  check('状态可从 SQLite 读回', states.length > 0, `${states.length} 条`);

  // ------------------------------------------------------------
  console.log('\n【四】伏笔挂载与状态一致性');

  const threadsBefore = store.listThreads('novel-demo-01').length;
  store.createThread({
    id: 'e2e-thread', projectId: 'novel-demo-01',
    name: '铁棺北侧第三根棺钉刻着「归」字',
    summary: '暗示铁棺来历', plantedIn: chapters[0] ? chapters[0].cid : null, importance: 5,
  });
  const threads = store.listOpenThreads('novel-demo-01');
  check('伏笔可挂载且按重要度排序', threads.length === threadsBefore + 1 && threads[0].importance === 5,
    `未回收伏笔 ${threads.length} 条：${threads.map((t) => `${t.name}(重要性${t.importance})`).join('、')}`);

  // 状态漂移检查：连续两章是否出现矛盾
  check('连续两章未产生未预期的状态冲突', totalConflicts === 0,
    totalConflicts === 0 ? '无冲突' : `${totalConflicts} 处冲突（已阻断写入，待人工裁决）`);

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  // ---- 汇总 ----
  console.log(`\n${'-'.repeat(52)}`);
  const ok = results.filter((r) => r.ok).length;
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  }
  console.log(`${'-'.repeat(52)}`);
  const pct = Math.round((ok / results.length) * 100);
  console.log(`端到端 ${pct}% 通过（${ok}/${results.length}）`);
  if (pct < 100) {
    console.log('\n有失败项，第 2 步不能算完成。');
    process.exitCode = 1;
  } else {
    console.log('\n第 2 步验收通过：记忆与状态层可用。');
  }
}

main().catch((e) => {
  console.error('验证异常终止：', e);
  process.exitCode = 1;
});
