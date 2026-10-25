/**
 * 真机验证上下文用量指示器（CtxMeter）。
 *
 * ## 为什么必须真机
 *
 * 这个组件的问题**全都是只有渲染才看得见的**：
 *   · `ctx:status` 返回 null 时显示什么（判据环境与真实运行不同）
 *   · 圆环画了没有、弧长对不对（`stroke-dasharray` 算错就是一条满环）
 *   · 悬浮气泡是不是**真的**靠 CSS 显隐（`group-hover` 写错就永远不弹）
 *   · 三档颜色（正常 / 将满 / 已满）有没有真的变
 * 源码和单测一个都验不出来。
 *
 * ⚠ 2026-10-16 改版：按钮从「圆点 + 百分比」变成 **WorkBuddy 那种圆环**，
 *   数字搬进了悬浮气泡（`36.4% · 364.1K / 1000.0K 上下文已使用`）。
 *   于是判据不能再从按钮的 textContent 里找百分数 ——
 *   那正是"判据跟着实现走、而不是跟着需求走"的典型，改版当场全红。
 *   现在按**新契约**量：环的弧长 + 气泡文案 + 详情卡（`data-ctx-panel`）。
 *
 * 运行：.\electron-run.cmd test-ctx-meter.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const APPDIR = __dirname;
const PID = 'p1';

let passed = 0; const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n    ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];

const CFG = {
  model: 'q', ollamaBase: 'http://127.0.0.1:11434', numCtx: 131072,
  chatFontSize: 15, editorFontSize: 15, fontSize: 15,
  fontFamily: 'system-ui', chatFont: 'system-ui', editorFont: 'system-ui',
  temperature: 0.4, theme: 'ink', notify: 'none', currentProject: PID,
  thinkLevel: 'off', activeConnectionId: 'c1', autoSkill: false, toolsEnabled: false,
};

/** ⚠ 可变的用量桩 —— 用来把三档都跑一遍 */
let CTX = null;

for (const ch of ALL) {
  h(ch, (p) => {
    if (ch === 'ctx:status') return CTX;
    if (ch === 'config:get') return CFG;
    if (/list$|messages$|tree$/.test(ch)) return [];
    return null;
  });
}
h('app:version', () => ({ version: '1.0.8' }));
h('project:list', () => [{ id: PID, name: '测试项目' }]);
h('conv:list', () => [{ id: 'c1', projectId: PID, title: 't', messageCount: 1 }]);
h('conv:messages', () => [{ id: 'm1', role: 'assistant', content: '一句话。' }]);
h('provider:listConnections', () => []);
h('style:profile', () => ({ available: false, reason: '还没有章节' }));
h('trash:list', () => ({ stats: { count: 0 } }));

const mk = (used, budget, extra = {}) => ({
  enabled: true, messages: 24,
  usedTokens: used, historyBudget: budget,
  usage: `${((used / budget) * 100).toFixed(1)}%`,
  compressions: 2, totalDropped: 13, starvedEvents: 0, log: [], starved: false, ...extra,
});

/** 周长（半径 8）—— 和组件里的常量是同一条公式，判据自己算一遍 */
const C = 2 * Math.PI * 8;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 900, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  /**
   * ⚠⚠ 必须让窗口**真的显示**（showInactive，不抢焦点）才能验悬浮。
   *   原来的 `show: false` 下 `sendInputEvent` 鼠标移动**不会**产生 CSS `:hover`
   *   —— 判据量出来 display 一直是 none，看着像"悬浮气泡写错了"，
   *   其实是"窗口没显示 → 没有鼠标状态"。
   *   ⚠ `:hover` 是浏览器状态，**没法用 JS 事件伪造**，只能发真输入 + 真显示。
   */
  win.showInactive();
  await new Promise((r) => setTimeout(r, 600));
  await new Promise((r) => setTimeout(r, 1800));
  const j = (c) => win.webContents.executeJavaScript(c);

  const read = () => j(`
    (() => {
      // ⚠ 按专属标记找，不按文案（空态显示的是「—」，按内容找会判成"没渲染"）
      const btn = document.querySelector('[data-ctx-meter]');
      if (!btn) return { found: false };
      const rings = btn.querySelectorAll('circle');
      const arc = rings[1] || null;              // rings[0] 是灰色轨道
      const tip = document.querySelector('[data-ctx-tip]');
      return {
        found: true,
        text: btn.textContent.trim(),
        color: getComputedStyle(btn).color,
        ringCount: rings.length,
        dashoffset: arc ? Number(arc.getAttribute('stroke-dashoffset')) : -1,
        aria: btn.getAttribute('aria-label') || '',
        title: btn.getAttribute('title') || '',
        tipText: tip ? tip.textContent.replace(/\\s+/g, ' ').trim() : '',
        tipDisplay: tip ? getComputedStyle(tip).display : '',
      };
    })()
  `);

  /** 把鼠标真的移到按钮上（`:hover` 没法用 JS 事件伪造，只能发真输入） */
  async function hoverButton() {
    const r = await j(`(() => {
      const b = document.querySelector('[data-ctx-meter]');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x - 40, y: r.y - 40 });
    await new Promise((s) => setTimeout(s, 120));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    await new Promise((s) => setTimeout(s, 250));
    return read();
  }
  async function unhover() {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
    await new Promise((s) => setTimeout(s, 250));
    return read();
  }

  // ---- 空态 ----
  CTX = null;
  await new Promise((r) => setTimeout(r, 4600));   // 等它轮询一次
  const empty = await read();
  console.log('  空态：' + JSON.stringify(empty));
  check('★ 没有数据时显示「—」，而且不画弧（空轨道 ≠ 0%）', () => {
    assert(empty.found, '指示器根本没渲染');
    assert(/—/.test(empty.text), `显示的是「${empty.text}」，不是「—」`);
    assert(!/0%/.test(empty.text), '显示 0% 会让人以为"确实没占用"');
    assert(empty.ringCount === 1, `应该只有轨道那一个圆，实际 ${empty.ringCount} 个`);
  });

  // ---- 正常档 ----
  CTX = mk(3000, 20000);
  await new Promise((r) => setTimeout(r, 4600));
  const normal = await read();
  console.log('  正常档：' + JSON.stringify(normal));
  check('★ 正常档：环画出来了，弧长就是 15%', () => {
    assert(normal.found, '没渲染');
    assert(normal.ringCount === 2, `只有 ${normal.ringCount} 个圆 —— 用量弧没画`);
    // 15% → dashoffset = C × 0.85
    const want = C * 0.85;
    assert(Math.abs(normal.dashoffset - want) < 1.5,
      `dashoffset=${normal.dashoffset.toFixed(1)}，15% 应该是 ${want.toFixed(1)}`);
    assert(/15/.test(normal.aria), `aria-label 没说明用量：${normal.aria}`);
  });
  check('★ 按钮上**不写数字**（数字归气泡），也不再挂原生 title', () => {
    assert(!/%/.test(normal.text), `按钮里还留着百分比：${normal.text}`);
    assert(!normal.title, '还挂着 title —— 会和自定义气泡同时弹出来');
  });

  // ---- 悬浮气泡（WorkBuddy 那种）----
  const tipText = normal.tipText;
  check('★ 气泡文案就是 WorkBuddy 那个口径：36.4% · 364.1K / 1000.0K 上下文已使用', () => {
    assert(/15\.0% · 3\.0K \/ 20\.0K 上下文已使用/.test(tipText),
      `气泡是「${tipText}」`);
  });
  check('★ 不悬浮时气泡是 display:none（不是靠透明度藏起来）', () => {
    assert(normal.tipDisplay === 'none', `没悬浮时 display=${normal.tipDisplay}`);
  });
  const hovered = await hoverButton();
  console.log('  悬浮后：tipDisplay=' + hovered.tipDisplay);
  check('★★ 悬浮上去气泡才真的显示出来', () => {
    assert(hovered.tipDisplay === 'block', `悬浮后 display=${hovered.tipDisplay}`);
  });

  // 留一张图给羽毛菌看（悬浮着的样子）
  const OUT = path.join(APPDIR, 'shots');
  fs.mkdirSync(OUT, { recursive: true });
  /**
   * ⚠⚠ `capturePage(rect)` 的 rect 是 **CSS px（DIP）**，返回的图才是设备像素
   *   —— 两件事别混。
   *   我按 devicePixelRatio 把 rect 也乘了一遍，结果 rect 被推到窗口外，
   *   变成 `UnknownVizError`（看着像"截图坏了"，其实是坐标超界）。
   *   ⚠ 真正需要乘 dpr 的是**读 `toBitmap()` 的像素**（那是设备像素网格），
   *     不是 capturePage 的参数。
   */
  const box = await j(`(() => {
    const r = document.querySelector('[data-ctx-meter]').getBoundingClientRect();
    // 气泡是右对齐的，所以要往左多留一点，右边留出按钮 + 三角
    return { x: Math.round(r.x - 270), y: Math.round(r.y - 56), width: 310, height: 98 };
  })()`);
  /**
   * 截图工具。⚠ `capturePage` 会偶发 `UnknownVizError`（合成器抽风，
   *   尤其刚发过鼠标输入之后）——必须 try/catch + 重试，
   *   否则"截图失败"会把整个判据脚本带走。
   *   截图只是留给人看的，**不该判失败**；但也不能静默 —— 失败要打印出来。
   */
  async function grab(box, name) {
    for (let i = 0; i < 3; i++) {
      try {
        const img = await win.webContents.capturePage(box);
        fs.writeFileSync(path.join(OUT, name), img.toPNG());
        console.log('  → shots/' + name);
        return true;
      } catch (_) { await new Promise((r) => setTimeout(r, 400)); }
    }
    console.log('  ⚠ 截图失败（capturePage 抛 UnknownVizError），跳过 shots/' + name);
    return false;
  }

  // 悬浮着的样子留一张（此时鼠标还停在按钮上）
  await grab(box, 'ctx-tip.png');

  const back = await unhover();
  check('★ 鼠标移开就收起来', () => {
    assert(back.tipDisplay === 'none', `移开后 display=${back.tipDisplay}`);
  });

  // ---- 点开详情卡 ----
  await j(`(() => {
    const b = document.querySelector('[data-ctx-meter]');
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const pop = await j(`
    (() => {
      const t = document.querySelector('[data-ctx-panel]');
      return { open: !!t, text: t ? t.textContent.replace(/\\s+/g, ' ').slice(0, 200) : '' };
    })()
  `);
  check('★ 点开有详情：用量 / 条数 / 压缩次数', () => {
    assert(pop.open, '详情卡没打开');
    assert(/已用/.test(pop.text) && /消息条数/.test(pop.text), `详情不全：${pop.text}`);
    assert(/自动压缩/.test(pop.text) && /2/.test(pop.text), `没显示压缩次数：${pop.text}`);
  });
  check('★ 明说「压缩不会删你和助手的对话」', () => {
    assert(/不会删/.test(pop.text), `没这句说明：${pop.text}`);
  });

  const whileOpen = await j(`getComputedStyle(document.querySelector('[data-ctx-tip]')).display`);
  check('★ 详情卡开着时气泡收起', () => {
    assert(whileOpen === 'none', `详情卡开着时气泡 display=${whileOpen}`);
  });
  // 详情卡的样子也留一张
  const panelBox = await j(`(() => {
    const r = document.querySelector('[data-ctx-meter]').getBoundingClientRect();
    return { x: Math.round(Math.max(0, r.x - 290)), y: Math.round(Math.max(0, r.y - 250)), width: 330, height: 290 };
  })()`);
  await grab(panelBox, 'ctx-panel.png');

  // ---- 预警档 ----
  await j(`document.querySelector('[data-ctx-meter]').click()`);
  CTX = mk(16000, 20000);
  await new Promise((r) => setTimeout(r, 4600));
  const warn = await read();
  console.log('  预警档：' + JSON.stringify(warn));
  check('★ 超过 70% 会变色（环的弧跟着变色）', () => {
    assert(/80/.test(warn.aria), `aria 里是「${warn.aria}」`);
    assert(warn.color !== normal.color, '颜色没变');
    assert(warn.ringCount === 2, '弧没了');
  });

  // ---- starved 档 ----
  CTX = mk(19900, 20000, { starved: true, starvedEvents: 3 });
  await new Promise((r) => setTimeout(r, 4600));
  const star = await read();
  check('★ starved 变红并说清出路', () => {
    assert(star.color !== normal.color && star.color !== warn.color, '颜色没区分');
  });
  await j(`document.querySelector('[data-ctx-meter]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const starPop = await j(`
    (() => {
      const t = document.querySelector('[data-ctx-panel]');
      return t ? t.textContent.replace(/\\s+/g, ' ') : '';
    })()
  `);
  check('★ starved 时给出可执行的出路', () => {
    assert(/新建/.test(starPop) && /@/.test(starPop), `没给出路：${starPop}`);
  });

  // ---- 点击外部关闭 ----
  await j(`(() => {
    const b = document.querySelector('[data-ctx-meter]');
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  await j(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.querySelector('.chat-surface').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));`);
  await new Promise((r) => setTimeout(r, 250));
  const closed = await j(`!document.querySelector('[data-ctx-panel]')`);
  check('★ 点外面会关闭详情卡', () => assert(closed, '点了外面还开着'));

  // ---- 不闪 ----
  const samples = [];
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 180));
    samples.push(await j(`document.querySelector('.chat-surface') ? document.querySelector('.chat-surface').innerHTML.length : -1`));
  }
  check('★ 轮询不会让消息区反复重排', () =>
    assert(new Set(samples).size === 1, `内容长度变了 ${new Set(samples).size} 次`));

  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `上下文用量：${passed} 通过 / ${failures.length} 失败` : `上下文用量：${passed} 通过`);
  app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('脚本崩了：', e); app.exit(1); });
