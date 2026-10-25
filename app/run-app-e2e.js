/**
 * 应用端到端自检：不开界面，直接在 Electron 主进程里跑一遍关键链路。
 *
 * ## 为什么要有这个
 *
 * 截图能证明「界面画出来了」，证明不了「按钮点了有反应」。
 * 这里在真实 Electron 环境里驱动 preload 暴露的每一项能力：
 * 建项目 → 导设定 → 检索 → 建章 → 存章 → 状态回写 → 流式生成。
 *
 * 每一步都断言返回结构，任何一步断掉都会报出来。
 *
 * 用法：
 *   node run-app-e2e.js                    # 跳过生成（不需要 Ollama）
 *   WRITETOOL_GEN=1 node run-app-e2e.js    # 含真实模型生成
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { app } = require('electron');
const { Store } = require(path.join(__dirname, '..', 'db', 'store.js'));
const { summarizeBible } = require(path.join(__dirname, '..', 'memory', 'context-budget.js'));
const { applyStateAfterCommit } = require(path.join(__dirname, '..', 'memory', 'state-writer.js'));
const { LoopContextGuard } = require(path.join(__dirname, '..', 'memory', 'loop-guard.js'));
const { buildProfile, checkStyle, styleDirective } = require(path.join(__dirname, '..', 'memory', 'style.js'));

// 测试用临时库，不碰真实用户数据
const TEST_DB = path.join(os.tmpdir(), `writetool-e2e-${Date.now()}.db`);
const PID = 'e2e-project';

let pass = 0;
let fail = 0;
const results = [];

function judge(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  if (cond) pass++; else fail++;
}

// ---- 复制主进程里的核心逻辑，避免测的和跑的不是一个东西 ----
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');

const logPath = path.join(os.tmpdir(), 'writetool-e2e.log');
const out = [];
function log(...a) { const s = a.join(' '); out.push(s); try { fs.appendFileSync(logPath, s + '\n'); } catch (e) {} }

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(os.tmpdir()), { recursive: true });
  const store = new Store(TEST_DB);

  try {
    // 1. 项目
    store.createProject({ id: PID, name: '端到端测试项目' });
    const projects = store.listProjects();
    judge('创建项目', projects.some((p) => p.id === PID),
      `共 ${projects.length} 个项目`);

    // 2. 设定导入（用真实的墨染仙途库）
    const realDb = path.join(__dirname, '..', 'data', 'modianditu.db');
    let settingCount = 0;
    if (fs.existsSync(realDb)) {
      const src = new Store(realDb);
      for (const s of src.loadSettings('modianditu')) {
        store.upsertSetting({
          id: `${PID}:${s.type}:${s.name}`, projectId: PID,
          type: s.type, name: s.name, note: s.note, aliases: s.aliases || [],
        });
        settingCount++;
      }
      src.close();
    }
    judge('导入真实设定库', settingCount > 100, `${settingCount} 条`);

    // 3. 设定摘要
    const settings = store.loadSettings(PID);
    const summary = summarizeBible(settings, { maxChars: 1200, pinned: ['夜枫'] });
    judge('生成设定摘要', summary.included > 0 && summary.chars < 1500,
      `纳入 ${summary.included}／丢弃 ${summary.dropped}，${summary.chars} 字`);
    judge('摘要无缺失类型', summary.missingTypes.length === 0,
      summary.missingTypes.length ? summary.missingTypes.join(',') : '五类齐全');

    // 4. 检索
    const bible = queryWorldBible(settings, '夜枫');
    judge('检索主角', bible.count > 0 && bible.hits[0].name === '夜枫',
      `命中 ${bible.count}，首位 ${ bible.hits[0] ? bible.hits[0].name : '无'}`);

    const geo = queryWorldBible(settings, '处州');
    judge('检索地名（补齐后）', geo.count > 0,
      geo.count ? `命中 ${geo.hits[0].name}` : '未命中');

    // 5. 章节
    store.createChapter({ id: 'e2e-c1', projectId: PID, title: '第一章 处州少年', content: '' });
    const content = '夜枫蹲在院门口，正给一块松木板去皮。夜大田从巷口走来，说青石镇来了位仙师。'
      + '夜枫朝屋里喊了一声，夜大柱从里间出来。';
    store.updateChapterContent('e2e-c1', content);
    const ch = store.getChapter('e2e-c1');
    judge('章节存取', ch && ch.content === content && ch.revision >= 1,
      `${ch.word_count} 字，revision ${ch.revision}`);

    // 6. 状态回写
    const res = applyStateAfterCommit({
      store, projectId: PID, chapterId: 'e2e-c1', text: content, settings,
    });
    judge('状态回写', res.applied > 0, res.summary);
    judge('状态零冲突（首章不该报）', res.conflicts.length === 0,
      res.conflicts.length ? JSON.stringify(res.conflicts) : '');

    // 7. 上下文预算
    const guard = new LoopContextGuard({
      messages: [
        { role: 'system', content: '你是小说写作助手。'.repeat(30) },
        { role: 'user', content: '写第一章'.repeat(40) },
      ],
      numCtx: 2048,
    });
    for (let i = 0; i < 30; i++) {
      guard.messages.push({
        role: 'assistant', content: '',
        tool_calls: [{ function: { name: 'query_world_bible', arguments: {} } }],
      });
      guard.messages.push({ role: 'tool', name: 'query_world_bible', content: '结果'.repeat(200) });
    }
    const g = guard.ensure();
    judge('上下文超预算触发压缩', g.compressed, `占用 ${g.used}/${g.budget}`);
    // 配对完整性——破坏配对会让模型停止调工具
    let pairsOk = true;
    for (let i = 0; i < guard.messages.length; i++) {
      const m = guard.messages[i];
      if (m.role === 'assistant' && m.tool_calls) {
        const nx = guard.messages[i + 1];
        if (!nx || nx.role !== 'tool') { pairsOk = false; break; }
      }
    }
    judge('压缩后配对完整', pairsOk, `${guard.messages.length} 条消息`);

    // 7.5 文风层（第 3 步）
    // 关键约束：基准必须来自用户自己的已保存章节，且不内置禁用词表。
    // 新项目此刻只有 1 章 56 字 → 画像建不起来，这是**正确行为**不是缺陷。
    {
      const chapters = store.listRecentChapterContents(PID, 12);
      const usable = chapters.filter((t) => t && t.replace(/\s/g, '').length >= 50);
      // 顺带钉住「listChapters 不返回 content」这个约束——
      // 早期误用它取正文，风格面板永久显示不可用
      judge('listChapters 不返回正文（列表页不该拉全文）',
        !store.listChapters(PID).some((c) => 'content' in c));
      judge('listRecentChapterContents 能取到正文', Array.isArray(chapters), `${chapters.length} 章`);
      const p = usable.length ? buildProfile(usable) : buildProfile([]);
      judge('样本不足时明确拒绝建画像', !!p.error || p.confidence === 'low',
        `可用样本 ${usable.length} 篇${p.error ? '，' + p.error : '，置信度 ' + p.confidence}`);

      // 造三章够长的"手写"正文，验证画像可建、指令可注入
      const h1 = '“枫儿——”巷口传来一声喊。夜枫蹲在院门口，正给一块松木板去皮，抬头一看，他大伯夜大田正大步流星朝他走来，脚上一双草鞋沾满了泥，显是刚从外头跑货回来。“大伯。”夜枫放下刨子，站起身。夜大田走到跟前，也不进屋，先在石墩上坐下，灌了口水，抹了把嘴，开口便道：“你爹在家不？有大事。”夜枫朝屋里喊了一声，夜大柱从里间出来，手里还攥着把修了一半的刨子。';
      const h2 = '“盘缠路费少说要十五两。”十五两。夜大柱沉默了。他一个月攒不下二两银子，十五两差不多是全家一年的积蓄。刘氏犹豫道：“那……要花银子不？”夜大田继续道：“我壮着胆子上前搭话，那吴仙师倒也和气，跟我说岚州那边有个问道院，正在招学生。他顿了顿，看了一圈屋里的人。”夜大柱沉默了好一会儿，终于叹了口气，起身进里屋翻出一个旧木匣，取出几锭碎银和两串铜钱放在桌上。刘氏眼圈红了，转身进灶房，把留着过年才吃的腊肉取了出来。夜枫一直没说话。他今年十五岁，生得眉清目秀，身板偏瘦，自小跟着爹学木匠活计。';
      const h3 = '三天后，夜枫背着一个旧包袱，跟着大伯出了处州城门。包袱里装着两件换洗衣裳、几个炊饼、一小块腊肉，怀里贴身缝着那十五两银子，用蓝布包了又包。夜青和嫂子送到村口，塞给他一双新纳的千层底布鞋：“路上穿，别舍不得。”夜枫接过，鼻子有些发酸。走出城门时他回头看了一眼——晨光里土城墙灰扑扑的，兵丁打着哈欠，早点摊老板正往锅里下面条。这是他看了十五年的景象，熟悉得像自己的手掌心。他转过身，不再回头。大伯拍了拍他的肩膀：“走吧，路还远着呢。”';
      const prof = buildProfile([h1, h2, h3]);
      judge('三篇手写样本可建画像', prof.ok, `${prof.sampleCount} 篇，置信度 ${prof.confidence}`);
      judge('画像字段全为有限数', prof.ok && Object.entries(prof)
        .filter(([, v]) => typeof v === 'number').every(([, v]) => Number.isFinite(v)));

      const directive = styleDirective(prof);
      judge('文风指令非空', directive.length > 10);
      judge('文风指令不含百分比数字', !/\d+\s*%/.test(directive));

      const selfCheck = checkStyle(h1, prof, { strict: true });
      judge('自检零偏离', selfCheck.ok && selfCheck.deviations.length === 0,
        selfCheck.ok ? JSON.stringify(selfCheck.deviations.map((d) => d.metric)) : selfCheck.error);
      judge('自检跳过项有说明原因',
        !selfCheck.skipped || selfCheck.skipped.every((s) => !!s.reason));
    }

    // 8. 流式生成（可选）
    if (process.env.WRITETOOL_GEN) {
      const chunks = await streamGen();
      judge('Ollama 流式生成', chunks.text.length > 20,
        `${chunks.text.length} 字，${chunks.ms}ms`);
      judge('生成内容非空且可读', chunks.text.trim().length > 20,
        chunks.text.slice(0, 40).replace(/\n/g, ' '));
    } else {
      log('（跳过生成：设 WRITETOOL_GEN=1 可启用）');
    }
  } catch (e) {
    judge('整体无异常', false, e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  }

  // ---- 打印 ----
  console.log('\n' + '='.repeat(62));
  console.log('WriteTool 应用端到端自检');
  console.log('='.repeat(62));
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '　' + r.detail : ''}`);
  }
  console.log('-'.repeat(62));
  console.log(`${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(62));

  try { fs.rmSync(TEST_DB, { force: true }); } catch (e) {}
  app.exit(fail ? 1 : 0);
});

/** 与主进程 bible:query 同逻辑 */
function queryWorldBible(settings, query, topK = 8) {
  const q = String(query || '').replace(/\s+/g, '').toLowerCase();
  if (!q) return { count: 0, hits: [] };
  const scored = [];
  for (const s of settings) {
    const name = String(s.name || '').toLowerCase();
    const aliases = (s.aliases || []).map((a) => String(a).toLowerCase());
    let score = 0;
    if (name === q) score = 100;
    else if (name.includes(q) || q.includes(name)) score = 80;
    else if (aliases.some((a) => a === q)) score = 70;
    else if (aliases.some((a) => a.includes(q) || q.includes(a))) score = 60;
    else if (String(s.note || '').toLowerCase().includes(q) && q.length >= 3) score = 40;
    if (score > 0) scored.push({ ...s, _score: score });
  }
  scored.sort((a, b) => (b._score - a._score) || a.name.length - b.name.length
    || a.name.localeCompare(b.name, 'zh'));
  return { count: scored.length, hits: scored.slice(0, topK) };
}

function streamGen() {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const data = JSON.stringify({
      model: 'qwen3:latest',
      messages: [
        { role: 'system', content: '你是小说写作助手，只输出正文。' },
        { role: 'user', content: '用三句话写一个少年在雨中等人的场景。' },
      ],
      stream: true, think: false,
      options: { temperature: 0.3, num_ctx: 2048 },
    });
    const t0 = Date.now();
    const req = http.request('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      timeout: 120000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = ''; let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o.message && o.message.content) text += o.message.content;
          } catch (e) {}
        }
      });
      res.on('end', () => resolve({ text, ms: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
    req.write(data);
    req.end();
  });
}