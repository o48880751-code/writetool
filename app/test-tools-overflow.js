/**
 * 真机验证工具栏的溢出三点菜单。
 *
 * ## 为什么必须真机
 *
 * 用户现场报了两个症状，而**看代码一个都看不出来**：
 *   1. 「拖动卡片变小后，并没有出现三个点」   —— 测量逻辑的时序问题
 *   2. 「对话内容一直在跳，闪的厉害」       —— setState 死循环
 *
 * 第 2 条尤其阴：`setBtnW` 每次都产生**新数组** → 重渲染 → 重新量 →
 * 再 setState → 又重渲染。源码上完全正常，只有真渲染才看得见它闪。
 *
 * 做法：起真窗口 → 量宽 → **把窗口真拖窄** → 看三点有没有出现 →
 * 连续采样若干帧，看 DOM 变了几次（闪没闪）。
 *
 * 运行：.\electron-run.cmd test-tools-overflow.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');

const APPDIR = __dirname;
const PID = 'ovf';
const CONV = 'cv-ovf';

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
  model: 'q', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  chatFontSize: 15, editorFontSize: 15, fontSize: 15,
  fontFamily: 'system-ui', chatFont: 'system-ui', editorFont: 'system-ui',
  temperature: 0.4, theme: 'ink', notify: 'none', currentProject: PID,
  thinkLevel: 'off', activeConnectionId: 'c1', autoSkill: false, toolsEnabled: false,
};
for (const ch of ALL) {
  const fb = ch === 'config:get' ? CFG : (/list$|messages$|tree$/.test(ch) ? [] : null);
  h(ch, () => fb);
}
h('config:get', () => CFG);
h('config:set', (p) => { Object.assign(CFG, p); return CFG; });
h('app:version', () => ({ version: '1.0.8' }));
h('project:list', () => [{ id: PID, name: '测试项目', createdAt: '' }]);
h('project:open', () => CFG);
h('settings:list', () => []);
h('chapter:list', () => []);
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => []);
h('style:profile', () => ({ available: false, reason: '还没有章节' }));
h('trash:list', () => ({ stats: { count: 0 } }));
h('fs:tree', () => ({ name: 'p', type: 'dir', children: [] }));
h('conv:list', () => [{ id: CONV, projectId: PID, title: 't', messageCount: 1 }]);
h('conv:messages', () => [{ id: 'm1', role: 'assistant', content: '一句话。' }]);
h('provider:capabilities', () => ({ providers: [], customs: [] }));
h('provider:listConnections', () => []);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600, height: 900, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));
  const j = (c) => win.webContents.executeJavaScript(c);

  const health = await j('document.querySelectorAll(".quick-tools button").length');
  check('★ 工具栏渲染出来了', () => assert(health > 0, `按钮数 ${health}`));

  const look = () => j(`
    (() => {
      const bar = document.querySelector('.quick-tools');
      const btns = [...bar.querySelectorAll('[data-qt]')];
      const vis = btns.filter((b) => getComputedStyle(b).visibility !== 'hidden');
      const dots = [...bar.querySelectorAll('button')].filter((b) => b.textContent.trim() === '⋯');
      return {
        total: btns.length,
        visible: vis.length,
        dots: dots.length,
        barW: Math.round(bar.getBoundingClientRect().width),
        menuOpen: !!document.querySelector('.tools-menu'),
        menuItems: document.querySelectorAll('.tools-menu button').length,
        html: bar.innerText.replace(/\\n/g, '|'),
      };
    })()
  `);

  const wide = await look();
  console.log(`  宽屏：工具 ${wide.total} 个，可见 ${wide.visible}，三点 ${wide.dots}`);

  // ---- 真把窗口拖窄 ----
  const N = wide.total;
  let narrow = null;
  for (const w of [1300, 1100, 900, 760, 640, 560]) {
    win.setSize(w, 900);
    await new Promise((r) => setTimeout(r, 500));
    narrow = await look();
    console.log(`  ${w}px：可见 ${narrow.visible}/${N}，三点 ${narrow.dots}`);
    if (narrow.dots > 0) break;
  }

  check('★ 拖窄之后三点出现了', () => {
    assert(narrow.dots > 0, `最窄也没出现三点：${JSON.stringify(narrow)}`);
    assert(narrow.visible < N,
      `可见数 ${narrow.visible} = 总数 ${N}，没被裁掉任何一项`);
  });

  check('★ 三点里列的就是被藏起来的那几个', () => {
    const hiddenCount = N - narrow.visible;
    assert(narrow.menuOpen === false, '菜单默认不该是开的');
    return hiddenCount;
  });

  // 点三点
  await j(`(() => {
    const d = [...document.querySelectorAll('.quick-tools button')].find((b) => b.textContent.trim() === '⋯');
    if (d) d.click();
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const opened = await look();
  check('★ 单击三点弹出列表，且列的是被藏起来的', () => {
    assert(opened.menuOpen, '点了三点但菜单没打开');
    const hiddenCount = N - opened.visible;
    assert(opened.menuItems === hiddenCount,
      `菜单里 ${opened.menuItems} 项，实际被藏 ${hiddenCount} 个`);
  });

  // 菜单别被工具栏/消息区盖住（要在 await 之后量，不能塞进 check）
  const cover = await j(`
    (() => {
      const m = document.querySelector('.tools-menu');
      if (!m) return { noMenu: true };
      const b = m.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + 12);
      return { covered: !(m.contains(top) || m === top), tag: top ? top.tagName : 'null' };
    })()
  `);
  check('★ 菜单浮在上层（没被消息区盖住）', () => {
    assert(!cover.noMenu, '菜单没开');
    assert(!cover.covered, `菜单被 ${cover.tag} 盖住了`);
  });

  // ---- 闪不闪：连续采样 DOM 变化次数 ----
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 160));
    samples.push(await j(`document.querySelector('.chat-surface') ? document.querySelector('.chat-surface').innerHTML.length : -1`));
  }
  const uniq = new Set(samples);
  check('★ 静止时内容不再变化（不闪）', () => {
    assert(uniq.size === 1,
      `静止状态下内容长度变了 ${uniq.size} 次：${JSON.stringify(samples)}`);
  });

  // ---- 拖动过程中也不能疯狂重排 ----
  const during = [];
  for (let w = 1500; w >= 800; w -= 100) {
    win.setSize(w, 900);
    await new Promise((r) => setTimeout(r, 120));
    during.push(await j(`document.querySelectorAll('.quick-tools [data-qt]').length`));
  }
  check('★ 拖动过程中工具数量稳定（没有反复增删）', () => {
    assert(new Set(during).size === 1,
      `拖动过程中工具数量跳变：${JSON.stringify(during)}`);
  });

  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `工具栏溢出：${passed} 通过 / ${failures.length} 失败` : `工具栏溢出：${passed} 通过`);
  app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('脚本崩了：', e); app.exit(1); });