/**
 * 判据 + 截图：聊天区的底色、头像、消息操作条。
 *
 * ## 需求出处（2026-10-15 羽毛菌）
 *
 *   「这个对话底色不应该是深色，文字白色。应该和 workbuddy 一样，
 *     灰色底色，黑色文字。而且对话下面也要有一个复制 撤回，删除的功能。
 *     模型也要有个头像，和 workbuddy 一样的」
 *
 * ## 为什么用真渲染
 *
 * 三条里有两条是**看得见**的（底色、头像），一条是**摸得到**的（操作条）。
 * 扫源码只能验"写法在"，验不出"底色到底是灰的还是深蓝的"——
 * 而 `ink` 主题原来就是深蓝底白字，代码里写的是 `var(--bubble-user)`，
 * 单看代码完全正常。
 *
 * ⚠ 反向用例：断言"有头像"很容易把整个消息列表删掉也算过，
 *   所以每条都加上"消息还在"这个前提。
 *
 * 运行：.\electron-run.cmd shoot-chat-look.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');
app.disableBackgroundThrottling = true;

const APPDIR = __dirname;
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const PID = 'shot-look';
const CONV = 'cv-look';

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
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];

const DELETED = [];
let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui',
  // ⚠ 特意用 ink：它原来把用户气泡定成深蓝白字，正是这次要修的现场
  theme: 'ink', notify: 'none', currentProject: PID, thinkLevel: 'off',
  activeConnectionId: 'conn-1', autoSkill: false, toolsEnabled: false,
};

const MSGS = [
  { id: 'm1', role: 'user', content: '把上面的设定整理进 设定/世界观.md' },
  { id: 'm2', role: 'assistant', content: '已整理成三条：\n一、时代背景\n二、江湖与庙堂\n三、天工院与武库' },
  { id: 'm3', role: 'user', content: '再补一段人物设定' },
  { id: 'm4', role: 'assistant', content: '李长乐，字无忧，江南沈家出身。' },
];

function fallbackFor(ch) {
  if (ch === 'config:get') return CFG;
  if (/_list$|_get$|messages$/.test(ch)) return [];
  return null;
}
for (const ch of ALL_CHANNELS) { const fb = fallbackFor(ch); h(ch, () => fb); }

h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: '1.0.8', full: 'v1.0.8' }));
h('project:list', () => [{ id: PID, name: '墨染仙途', createdAt: '' }]);
h('project:open', () => CFG);
h('settings:list', () => []);
h('chapter:list', () => []);
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => []);
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('trash:list', () => ({ stats: { count: 0 } }));
h('fs:tree', () => ({ name: '墨染仙途', type: 'dir', children: [] }));
h('conv:list', () => [{ id: CONV, projectId: PID, title: '整理设定', messageCount: MSGS.length }]);
h('conv:messages', () => MSGS.filter((m) => !DELETED.includes(m.id)));
h('conv:setThink', () => ({}));
h('provider:capabilities', () => ({ providers: [], customs: [] }));
h('provider:listConnections', () => []);
// 消息操作通道：记录被调了没，好验界面上真的点了能通
h('msg:delete', (p) => { DELETED.push(p.id); return { deleted: 1, id: p.id }; });
h('msg:deleteFrom', (p) => { DELETED.push(p.id); return { deleted: 4, id: p.id }; });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 820, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,   // ⚠ capturePage 会返回旧帧，见 shoot-chat-empty.js
    },
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log('  [!!] did-fail-load', code, desc, url);
  });
  win.webContents.on('console-message', (...a) => {
    const d = a[1]; const m = d && typeof d === 'object' ? d.message : a[2];
    const lv = d && typeof d === 'object' ? d.level : a[1];
    if (!m || /gpu|GPU|Autofill|devtools|deprecated/i.test(m)) return;
    console.log('  [renderer' + (lv === 'error' || lv === 3 ? ' ✗' : '') + ']', m);
  });
  console.log('  [1]开始载入');
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  console.log("  [2]loadFile 回来了");

  console.log("  [3]did-finish-load");
  await new Promise((r) => setTimeout(r, 1600));
  console.log("  [4]等待结束");

  const j = (code) => win.webContents.executeJavaScript(code);
  const health = await j(`
    (() => {
      const root = document.getElementById('root');
      return { kids: root ? root.children.length : 0, ta: !!document.querySelector('textarea') };
    })()
  `);
  if (!health.kids || !health.ta) { console.error('❌ 界面没渲染出来'); app.exit(1); return; }

  /** 把一条消息的实际配色取出来 —— 这才是"底色对不对"的答案 */
  const look = () => j(`
    (() => {
      const surf = document.querySelector('.chat-surface');
      const us = document.querySelector('.msg-user');
      const ai = document.querySelector('.msg-ai');
      const px = (el) => (el ? getComputedStyle(el) : null);
      const rgb = (s) => (s || '').match(/\\d+/g)?.slice(0, 3).map(Number) ?? [];
      const lum = (c) => { const [r,g,b] = c; return (0.2126*r + 0.7152*g + 0.0722*b) / 255; };
      const su = px(us), sa = px(ai), ss = px(surf);
      const bgU = rgb(su && su.backgroundColor), bgA = rgb(sa && sa.backgroundColor);
      return {
        hasSurface: !!surf,
        rows: document.querySelectorAll('.msg-row').length,
        avatars: document.querySelectorAll('.msg-avatar').length,
        avatarAi: document.querySelectorAll('.msg-avatar.ai').length,
        actBars: document.querySelectorAll('.msg-acts').length,
        btns: [...document.querySelectorAll('.msg-acts button')].map((b) => b.dataset.label || ''),
        // ⚠ 按钮是**纯图标**（羽毛菌要的），所以只能按 data-label 与图标路径来认
        svgCount: document.querySelectorAll('.msg-acts button svg').length,
        btnSize: (() => { const b = document.querySelector('.msg-acts button'); const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
        // 按钮里不该再有可见文字
        btnTexts: [...document.querySelectorAll('.msg-acts button')].map((b) => b.textContent.trim()),
        msgTexts: [...document.querySelectorAll('.msg-user, .msg-ai')].map((x) => x.textContent.slice(0, 10)),
        // 亮度：>0.6 算浅底，<0.4 算深底
        lumUserBg: +lum(bgU).toFixed(3), lumAiBg: +lum(bgA).toFixed(3),
        lumSurf: +lum(rgb(ss && ss.backgroundColor)).toFixed(3),
        inkUser: su ? su.color : '', inkAi: sa ? sa.color : '',
        theme: document.documentElement.getAttribute('data-theme'),
      };
    })()
  `);

  console.log("  [5]开始取样式");
  const s1 = await look();
  console.log("  [6]样式拿到了");
  console.log('  主题=' + s1.theme + ' 行数=' + s1.rows + ' 头像=' + s1.avatars
    + ' 操作条=' + s1.actBars);
  console.log('  亮度：聊天区底 ' + s1.lumSurf + ' / 用户泡 ' + s1.lumUserBg + ' / 模型泡 ' + s1.lumAiBg);
  console.log('  按钮：' + JSON.stringify(s1.btns));

  console.log('\n一、聊天区底色（ink 主题下也必须是浅色）');
  check('★ 聊天区是浅灰底', () => {
    assert(s1.hasSurface, '找不到 .chat-surface —— 固定浅色的容器没渲染');
    assert(s1.lumSurf > 0.6, `聊天区底色亮度只有 ${s1.lumSurf}，那还是深色`);
  });
  check('★ 两种气泡都是浅底', () => {
    assert(s1.lumUserBg > 0.6, `用户气泡亮度 ${s1.lumUserBg} —— 还是深色底`);
    assert(s1.lumAiBg > 0.7, `模型气泡亮度 ${s1.lumAiBg}`);
  });
  check('★ 气泡文字是深色（浅底上必须是深字）', () => {
    // 判据自己的前提：得真的有消息，否则下面全绿
    assert(s1.msgTexts.length >= 2, `消息没渲染出来：${JSON.stringify(s1.msgTexts)}`);
    for (const [name, c] of [['用户', s1.inkUser], ['模型', s1.inkAi]]) {
      const n = (c || '').match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
      const lum = (0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]) / 255;
      assert(lum < 0.4, `${name}气泡文字亮度 ${lum.toFixed(2)} —— 浅底配浅字看不清`);
    }
  });

  console.log('\n二、头像');
  check('★ 每条消息有一个头像，且模型与我的样式不同', () => {
    assert(s1.avatars === s1.rows, `头像 ${s1.avatars} 个 / 消息 ${s1.rows} 行 —— 不是每条都有`);
    assert(s1.avatarAi > 0, '没有模型头像');
  });

  console.log('\n三、消息操作条');
  check('★ 每条消息下面都有复制 / 撤回 / 删除', () => {
    assert(s1.actBars === s1.rows, `操作条 ${s1.actBars} / 消息 ${s1.rows} 行`);
    // ⚠ 按钮是**纯图标**，能认出来的是 data-label（悬停说明），不是文字
    for (const want of ['复制', '删除']) {
      const n = s1.btns.filter((t) => t.includes(want)).length;
      assert(n === s1.rows, `「${want}」出现 ${n} 次，期望 ${s1.rows} 次`);
    }
  });
  check('★ 按钮是**纯图标**（没有可见文字），且带悬停说明', () => {
    assert(s1.svgCount === s1.btns.length,
      `有 ${s1.btns.length} 个按钮但只有 ${s1.svgCount} 个图标`);
    const texts = s1.btnTexts.filter((t) => t.length > 0);
    assert(texts.length === 0, `按钮里还有可见文字：${JSON.stringify(texts)}`);
    for (const b of s1.btns) assert(b && b.length > 0, '有按钮没有悬停说明（data-label）');
    assert(s1.btnSize === '24x22', `按钮尺寸 ${s1.btnSize}，图标按钮不该是文字那么宽`);
  });

  check('★ 撤回只给用户消息（对模型撤回等于删掉整段历史）', () => {
    const n = s1.btns.filter((t) => t.includes('撤回')).length;
    assert(n === 2, `撤回有 ${n} 个，期望 2（两条用户消息各一个）`);
  });

  console.log('\n四、点一下真的能通到主进程');
  const called = await j(`
    (async () => {
      const b = [...document.querySelectorAll('.msg-acts button')].find((x) => /删除/.test(x.dataset.label));
      if (!b) return 'no-button';
      b.click();                       // 第一次：进入"再点一次确认"
      await new Promise((r) => setTimeout(r, 250));
      // ⚠ 两段式确认：第一点之后文字已变成「再点一次确认」，
      //   所以第二次要点的是**那个**，不是原按钮。
      const again = [...document.querySelectorAll('.msg-acts button')]
        .find((x) => /再点一次/.test(x.dataset.label));
      if (again) again.click();
      await new Promise((r) => setTimeout(r, 400));
      return 'clicked';
    })()
  `);
  check('★ 点「删除」会调到 msg:delete', () => {
    assert(called === 'clicked', `按钮没点上：${called}`);
    assert(DELETED.length === 1, `主进程收到 ${DELETED.length} 次删除`);
  });

  const shot = async (name) => {
    // 顺便验三点菜单的**定位**（羽毛菌：菜单要相对三点本身）
  await j(`(async () => {
    const d = [...document.querySelectorAll('.quick-tools button')].find((b) => b.textContent.trim() === '⋯');
    if (d) d.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  try { win.showInactive(); } catch (_) { /* 沙箱里可能不让显示 */ }
    win.focus();
    await new Promise((r) => setTimeout(r, 900));
    let img = null;
    for (let i = 0; i < 3; i++) {
      try { img = await win.webContents.capturePage(); } catch (_) { await new Promise((r) => setTimeout(r, 400)); continue; }
      if (img && !img.isEmpty()) break;
    }
    if (!img || img.isEmpty()) throw new Error('capturePage 一直拿到空图');
    const f = path.join(OUT, `${name}.png`);
    fs.writeFileSync(f, img.toPNG());
    const st = fs.statSync(f);
    console.log(`  ✓ ${name}.png（${Math.round(st.size / 1024)}KB）`);
    return st.size;
  };
  const size = await shot('chat-look');
  check('截图有内容（白图会小得多）', () => {
    assert(size > 20000, `截图只有 ${size} 字节`);
  });

  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `聊天区外观：${passed} 通过 / ${failures.length} 失败` : `聊天区外观：${passed} 通过`);
  app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('脚本崩了：', e); app.exit(1); });
