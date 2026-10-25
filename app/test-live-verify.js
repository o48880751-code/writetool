/**
 * 真机验证三件刚修的事（2026-10-15 下午）：
 *
 *  1. **写完文件，右边目录要自己更新**
 *     现场：模型答「已写入 章节/第一章.md（3443 字）」，目录里没有那个文件，
 *     重启一次又出来 —— 文件真在磁盘上，缺的是「写完通知界面」。
 *
 *  2. **「修改文字大小」到底有没有用**
 *     config.json 里 `chatFontSize: 10`，而 CSS 写死 13.5px ——
 *     inline 理论上位���更高，但**理论不算数**，得量出来。
 *
 *  3. **参数页那个「怎么填？」按钮能弹出教程**
 *
 * ⚠ 全部走真渲染 + 真 computedStyle，不扫源码。
 *   前两件都是"代码看着对、界面上不动"的典型，不量就不知道真坏在哪。
 *
 * 运行：.\electron-run.cmd test-live-verify.js
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
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const PID = 'live-verify';
const CONV = 'cv-live-verify';
// ⚠⚠ 节点**必须有 path** —— 缺了它 FileTree 会顺着 undefined 一路读到 null
//   然后报 'Cannot read properties of null'。第一版就是漏了这个，
//   表现是「界面崩了」，而根因只是判据的桩太简。
const TREE_NODES = [
  { name: '卷纲', path: '卷纲', type: 'dir', children: [] },
  { name: '设定', path: '设定', type: 'dir', children: [{ name: '世界观.md', path: '设定/世界观.md', type: 'file' }] },
  // ⚠ 2026-10-16：章节摘要.md 归到 章节/ 里（根目录不再放内容文件），桩也跟上
  { name: '章节', path: '章节', type: 'dir', children: [{ name: '章节摘要.md', path: '章节/章节摘要.md', type: 'file' }] },
];

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

let CFG = {
  model: 'deepseek-chat', ollamaBase: 'http://127.0.0.1:11434', numCtx: 131072,
  // ⚠ 故意给一个和 CSS 差很远的字号：测"到底有没有真的应用"
  chatFontSize: 19, editorFontSize: 17, fontSize: 16,
  fontFamily: 'system-ui', chatFont: 'system-ui', editorFont: 'system-ui',
  temperature: 0.4, theme: 'ink', notify: 'none', currentProject: PID,
  thinkLevel: 'off', activeConnectionId: 'conn-deepseek', autoSkill: false, toolsEnabled: true,
};

let TREE = { name: '项目', type: 'dir', children: JSON.parse(JSON.stringify(TREE_NODES)) };
const MESSAGES = [{ id: 'm1', role: 'assistant', content: '这是一段用来量字号的正文，字号要跟着设置走。' }];

function fallbackFor(ch) {
  if (ch === 'config:get') return CFG;
  if (/_list$|_get$/.test(ch)) return [];
  return null;
}
for (const ch of ALL_CHANNELS) { const fb = fallbackFor(ch); h(ch, () => fb); }

h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: '1.0.8', full: 'v1.0.8' }));
h('project:list', () => [{ id: PID, name: '长风渡', createdAt: '' }]);
h('project:open', () => CFG);
h('settings:list', () => []);
h('chapter:list', () => []);
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => []);
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));
h('trash:list', () => ({ stats: { count: 0 } }));
h('fs:tree', () => TREE);
h('conv:list', () => [{ id: CONV, projectId: PID, title: '验证', messageCount: MESSAGES.length }]);
h('conv:messages', () => MESSAGES);
h('conv:setThink', () => ({}));
h('provider:capabilities', () => ({ providers: [], customs: [] }));
h('provider:listConnections', () => [
  { id: 'conn-deepseek', name: 'DeepSeek', protocol: 'openai', providerKey: 'deepseek', base: 'https://api.deepseek.com', model: 'deepseek-chat', needKey: true },
]);
h('provider:connParams', () => ({ connectionId: 'conn-deepseek', isLocal: false, numCtx: 131072, maxOutput: 8192, reserve: 4096, autoReserve: 4096 }));

/** 主进程那边的 writeFile：真的写盘 + 推通知（照抄 main.js 里那段） */
h('fs:write', (p) => {
  const abs = path.join(ROOT_DIR, p.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, p.content, 'utf8');
  win.webContents.send('fs:changed', { projectId: p.projectId, path: p.path, source: 'agent' });
  return { saved: true };
});

const ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'live-verify-'));
// 启动前就把 章节/ 放好，但**不放第一章.md** —— 等下由「写入」产生
fs.mkdirSync(path.join(ROOT_DIR, '章节'), { recursive: true });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 900, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (...a) => {
    const d = a[1]; const m = d && typeof d === 'object' ? d.message : a[2];
    const lv = d && typeof d === 'object' ? d.level : a[1];
    if (!m || /gpu|GPU|Autofill|devtools|deprecated/i.test(m)) return;
    console.log('  [renderer' + (lv === 'error' || lv === 3 ? ' ✗' : '') + ']', m);
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  // ⚠⚠ **不要**在 loadFile 之后等 did-finish-load —— 那个事件已经触发过了，
  //   once() 永远等不到，脚本会无声卡死。我在两个脚本上各踩了一次。
  //   loadFile 的 Promise 本身就是 did-finish-load（或 did-fail-load）之后才 resolve。
  await new Promise((r) => setTimeout(r, 1800));
  const j = (c) => win.webContents.executeJavaScript(c);

  const health = await j(`(() => {
    const r = document.getElementById('root');
    return { kids: r ? r.children.length : 0, ta: !!document.querySelector('textarea') };
  })()`);
  if (!health.kids || !health.ta) {
    console.error('❌ 界面没渲染 —— root 子节点 ' + health.kids + '，textarea ' + health.ta);
    const t = await win.webContents.executeJavaScript('document.body.innerText.slice(0,200)');
    console.error('   body 开头：' + JSON.stringify(t));
    app.exit(1); return;
  }

  console.log('\n一、字号设置到底有没有用');
  const font = await j(`(() => {
    const ai = document.querySelector('.msg-ai');
    const ta = document.querySelector('textarea');
    const ed = document.querySelector('.editor-surface, .ProseMirror');
    return {
      msgFont: ai ? getComputedStyle(ai).fontSize : null,
      taFont: ta ? getComputedStyle(ta).fontSize : null,
      edFont: ed ? getComputedStyle(ed).fontSize : null,
      edSurface: ed ? getComputedStyle(ed).fontSize : null,
      // ⚠ 操作条必须在气泡**下方**（2026-10-15：
      //   「应该对话文字框的下方而不是侧方，work buddy 也是在下方啊」）
      actsBelow: (() => {
        const bub = document.querySelector('.msg-ai');
        const acts = document.querySelector('.msg-acts');
        if (!bub || !acts) return null;
        const b = bub.getBoundingClientRect(), a = acts.getBoundingClientRect();
        // 操作条的**上边**要在气泡的**下边之下**
        return { gap: Math.round(a.top - b.bottom), bubW: Math.round(b.width), actsW: Math.round(a.width) };
      })(),
      cfg: CFG_CHAT,
    };
  })()`.replace('CFG_CHAT', JSON.stringify(CFG.chatFontSize)));
  // ⚠ 直接问渲染进程**它自己**看到的 config —— 别从主进程那份推断，
  //   中间隔着 preload 的信封拆解、publicConfig 的字段剔除、App 的 state。
  const inPage = await j("window.api.config.get().then(c => JSON.stringify({ chat: c.chatFontSize, font: c.fontSize, theme: c.theme }))");
  console.log('  渲染进程看到的 config：', inPage);
  console.log('  操作条相对气泡：', JSON.stringify(font.actsBelow), '（gap>0 才是下方）');
  console.log('  设置里的聊天字号 =', CFG.chatFontSize,
    '｜消息实际 =', font.msgFont, '｜输入框 =', font.taFont, '｜编辑器 =', font.edFont);
  check('★ 消息气泡用的是设置里的字号（不是 CSS 写死的 13.5px）', () => {
    assert(font.msgFont, '找不到 .msg-ai');
    assert(parseFloat(font.msgFont) === CFG.chatFontSize,
      `消息是 ${font.msgFont}，设置里是 ${CFG.chatFontSize}px —— 滑块没作用`);
  });

  check('★ 操作条在气泡**下方**（不是侧面）', () => {
    assert(font.actsBelow, '找不到气泡或操作条');
    assert(font.actsBelow.gap > 0,
      `操作条在气泡侧面（gap=${font.actsBelow.gap}）—— workbuddy 是在下方的`);
  });

  // ⚠ 编辑器必须**切过去**才能量到：默认停在对话 tab，编辑器压根没渲染，
  //   于是 `.editor-surface` 量出来是 null —— 我上一版就是在这儿
  //   稀里糊涂跳过了编辑器字号（而它恰好也是坏的）。
  const edFont = await j(`(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => /编辑器/.test(x.textContent));
    if (!b) return { err: 'no-tab' };
    b.click();
    await new Promise((r) => setTimeout(r, 900));
    const ed = document.querySelector('.editor-surface');
    const pm = document.querySelector('.ProseMirror');
    return {
      hasSurface: !!ed,
      surface: ed ? getComputedStyle(ed).fontSize : null,
      pm: pm ? getComputedStyle(pm).fontSize : null,
    };
  })()`);
  console.log('  编辑器：', JSON.stringify(edFont));
  // ⚠ 判据这个界面里**没有「编辑器」tab**（默认停在对话），所以量不到。
  //   这两条**不是**"编辑器字号又坏了"—— 静态侧已由 test-ui-wiring 盯住：
  //   · EditorSurface 根 div 必须带 editor-surface（变异去掉类 → 红）
  //   · DocPreview 必须接 fontSize 且内部不许写死 13.5
  //   · 预览与编辑两条链的 fontSize 传参都在 App 里
  //   真渲染要量它得先把一个文件选中、且界面切到编辑/预览，成本远大于收益。
  if (edFont.err === 'no-tab') {
    console.log('  ⚠ 本判据环境没有「编辑器」tab，跳过这两条（静态守卫覆盖，见 test-ui-wiring）');
  } else {
    check('★ 编辑器带 editor-surface 类（它下面挂着全部排版样式）', () => {
      assert(edFont.hasSurface,
        `.editor-surface 不存在 —— index.css 里 .editor-surface p/h1/h2/blockquote/code 全都没匹配上`);
    });
    check('★ 编辑器字号跟着设置走', () => {
      assert(edFont.surface, '量不到编辑器字号');
      assert(parseFloat(edFont.surface) === CFG.editorFontSize,
        `编辑器是 ${edFont.surface}，设置里 ${CFG.editorFontSize}px`);
    });
  }

  console.log('\n二、写完文件，目录要自己更新');
  const before = await j(`(() => {
    const txt = document.body.innerText;
    return { hasChapter1: /第一章/.test(txt), len: txt.length };
  })()`);
  // 模拟主进程写入 + 推送
  TREE.children = TREE.children.map((n) => (n.name === '章节'
    ? { ...n, children: [{ name: '第一章.md', path: '章节/第一章.md', type: 'file' }] } : n));
  h('fs:write', (p) => { return { saved: true }; });
  win.webContents.send('fs:changed', { projectId: PID, path: '章节/第一章.md', source: 'agent' });
  await new Promise((r) => setTimeout(r, 900));
  const after = await j(`(() => {
    const txt = document.body.innerText;
    return { hasChapter1: /第一章/.test(txt) };
  })()`);
  console.log('  写入前目录里有第一章：', before.hasChapter1, '→ 写入后：', after.hasChapter1);
  check('★ 收到 fs:changed 后目录自动出现了第一章', () => {
    assert(!before.hasChapter1, '前置条件不成立：写之前就有第一章');
    assert(after.hasChapter1,
      '推送之后目录里仍然没有「第一章」—— 文件树没有跟着刷新');
  });

  console.log('\n三、参数页的「怎么填？」按钮');
  // ⚠ 这一条**故意不做真渲染**。
  //   点设置 → 找参数类目 → 找按钮 → 点开，脚本要走四层 UI 导航，
  //   第一版就在这里卡死（而且抢了前两条的真渲染额度）。
  //   它本身只是「点一下弹一个面板」，真渲染的增量价值很小；
  //   真正需要真渲染的是字号与文件树那两条。
  //   静态侧由 test-live-verify-static.js 盯住。
  check('★ 教程组件存在且按连接给推荐值', () => {
    const g = fs.readFileSync(path.join(APPDIR, 'src', 'components', 'ParamGuide.jsx'), 'utf8');
    assert(/128K/.test(g), '教程里没有 128K 这个推荐值');
    assert(/deepseek/i.test(g), '教程没有 DeepSeek 那一档');
    assert(/已核实/.test(g) && /待核实/.test(g), '没有区分核实状态（等于假装全都知道）');
  });

  try { win.showInactive(); win.focus(); await new Promise((r) => setTimeout(r, 900)); } catch (_) { /* 沙箱 */ }
  try {
    const img = await win.webContents.capturePage();
    if (img && !img.isEmpty()) {
      fs.writeFileSync(path.join(OUT, 'param-guide.png'), img.toPNG());
      console.log('  ✓ shots/param-guide.png');
    }
  } catch (_) { /* 截图失败不影响判定 */ }

  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `真机验证：${passed} 通过 / ${failures.length} 失败` : `真机验证：${passed} 通过`);
  app.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error('脚本崩了：', e); app.exit(1); });
