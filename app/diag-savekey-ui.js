/**
 * 诊断：填 Key → 点保存 → 看 toast 有没有弹、状态有没有变。
 *
 * ## 为什么单独一个脚本
 *
 * 羽毛菌装 1.0.2 后反馈：**填了 Key、点了保存，没有弹窗提示，
 * 「联网搜索」那一栏还是「还没填搜索 Key」**。
 *
 * 两种可能，必须分开验：
 *   A. saveKey 根本没走到（按钮 disabled / 点击没生效 / 事件丢了）
 *   B. saveKey 走了，但 save 返回 ok:false（加密失败）而界面没显示
 *   C. 存成功了，但 keyState 没更新（状态刷新链路断了）
 *
 * 光看代码分不出来 —— ToolCat.saveKey 的分支看起来是对的。
 *
 * ## 关键：不打桩 setSearchKey
 *
 * 桩会返回写死的成功，于是"保存成功但没提示"这种 bug 永远测不出来。
 * 这里让桩**真调 secret-store**，把主进程那条路走通。
 *
 * 运行：./electron-run.cmd diag-savekey-ui.js
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

const APPDIR = __dirname;
const MODULES = path.resolve(__dirname, '..');
const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const secret = require(path.join(APPDIR, 'electron', 'secret-store.js'));
const { parse: mdParse, stat: mdStat } = require(path.join(APPDIR, 'electron', 'markdown-render.js'));
const { versionInfo } = require(path.join(APPDIR, 'electron', 'version-info.js'));

const APPDATA = process.env.APPDATA || os.tmpdir();
const DB = path.join(APPDATA, 'writetool', 'writetool.db');
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');
const PID = 'diag-savekey';
const SEARCH_KEY_ID = '__web_search__';
/** 格式合法但无效的 Key。存不进去才说明是保存的问题，与 Key 对错无关。 */
const FAKE_KEY = 'diag_ui_fake_key_00000000000000000000000000000000';

const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const db = new Store(DB);
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!db.getProject(PID)) db.createProject({ id: PID, name: '保存 Key 诊断' });
pfs.ensureProject(PID);

const h = (ch, fn) => {
  if (ipcMain.removeHandler) ipcMain.removeHandler(ch);
  ipcMain.handle(ch, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434',
  numCtx: 8192, maxOutput: 8192,
  temperature: 0.3, fontSize: 16, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: PID, activeConnectionId: 'conn-1',
  toolsEnabled: true, searchProvider: 'serper', thinkLevel: 'off',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('project:list', () => db.listProjects());
h('project:open', () => ({ currentProject: CFG.currentProject }));
h('chapter:list', () => []);
h('chapter:create', () => ({ id: 'c1' }));
h('settings:list', () => []);
h('state:list', () => []);
h('thread:open', () => []);
h('thread:list', () => []);
h('thread:create', () => ({ id: 'th-1' }));
h('thread:resolve', () => ({ ok: true }));
h('bible:query', () => ({ hits: [] }));
h('skill:list', () => []);
h('conv:list', () => ([{ id: 'cv-1', projectId: PID, title: '保存 Key 诊断', updatedAt: Date.now() }]));
h('conv:create', () => ({ id: 'cv-1', projectId: PID, title: '保存 Key 诊断' }));
h('conv:messages', () => []);
h('conv:send', () => ({ started: true }));
h('conv:setThink', () => ({ ok: true }));
h('style:profile', () => ({ available: false }));
h('ollama:check', () => ({ ok: true, version: '0.40.2', models: [] }));
h('fs:tree', (p) => pfs.tree(p.projectId));
h('fs:read', (p) => ({ content: '', blocks: [], stat: null }));
h('fs:write', () => ({ ok: true }));
h('fs:create', () => ({ ok: true }));
h('fs:rename', () => ({ ok: true }));
h('fs:remove', () => ({ ok: true }));
h('fs:reveal', () => ({ ok: true }));
h('tool:decide', () => ({ ok: true }));
h('app:info', () => ({ version: '0.1.0', userDir: APPDATA, dbPath: DB, node: process.versions.node, electron: process.versions.electron }));
h('app:version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APPDIR, 'package.json'), 'utf8'));
  return versionInfo(pkg, '1.0.0', CFG);
});
h('app:openExternal', () => ({ ok: true }));
h('data:backup', () => ({ ok: true }));
h('data:inspectBackup', () => ({ canceled: true }));
h('app:setDownloadUrl', () => ({ ok: true }));
h('trash:list', () => ({ items: [], stats: {} }));
h('trash:add', () => ({ ok: true }));
h('trash:restore', () => ({ ok: true }));
h('trash:purge', () => ({ ok: true }));
h('trash:empty', () => ({ ok: true }));
h('provider:capabilities', () => {
  const presets = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
  return { providers: presets.PROVIDERS, customs: presets.customs().map((c) => c.key) };
});
h('provider:listConnections', () => ([{
  id: 'conn-1', name: '本机 Ollama', protocol: 'ollama',
  providerKey: 'ollama', base: 'http://127.0.0.1:11434',
  model: 'qwen3:latest', needKey: false, isPreset: true, hasKey: false,
}]));
h('provider:connParams', () => ({
  connectionId: 'conn-1', isLocal: true, connName: '本机 Ollama',
  numCtx: 8192, maxOutput: 8192, reserve: 4096,
  usableCtx: 4096,
}));
h('provider:setConnParams', () => ({ ok: true }));

// ---- 三个搜索相关：全部真调 secret-store，桩里不写死成功 ----
secret.init();
secret.bind(
  (id) => db.getConnectionSecret(id),
  (id, enc) => db.setConnectionSecret(id, enc)
);

h('tool:setSearchKey', ({ apiKey } = {}) => {
  const r = secret.save(apiKey == null ? '' : String(apiKey), SEARCH_KEY_ID);
  const has = !!secret.load(SEARCH_KEY_ID);
  console.log('  [桩] setSearchKey →', JSON.stringify({ ...r, has }));
  return { ok: r.ok, encrypted: r.encrypted, error: r.error, has };
});
h('tool:searchKeyStatus', () => {
  const has = !!secret.load(SEARCH_KEY_ID);
  console.log('  [桩] searchKeyStatus → has =', has);
  return { has, encrypted: secret.isEncrypted() };
});
h('tool:webReady', () => {
  const hasKey = !!secret.load(SEARCH_KEY_ID);
  return {
    provider: 'serper', hasKey, encrypted: secret.isEncrypted(),
    masterOn: true, missing: hasKey ? [] : ['Serper 的 Key'],
  };
});

const fails = [];
const expect = (label, cond, why) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fails.push(label + ' —— ' + (why || ''));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { screen } = require('electron');
  const size = screen.getPrimaryDisplay().workAreaSize;
  const W = Math.min(1440, size.width);
  const H = Math.min(900, size.height);

  const win = new BrowserWindow({
    width: W, height: H, show: false,
    webPreferences: { preload: path.join(APPDIR, 'electron', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await wait(1500);

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (e) { fails.push('渲染执行失败：' + e.message.split('\n')[0]); return null; }
  };

  // 先清干净
  secret.save('', SEARCH_KEY_ID);

  const probeBefore = await js(`(() => Array.from(document.querySelectorAll('button'))
    .map((b) => b.textContent.trim().slice(0, 12)).filter(Boolean).slice(0, 20))()`);
  console.log('  页面上有哪些按钮:', JSON.stringify(probeBefore));

  console.log('\n=== 1. 打开设置页，停到「工具」类目 ===');
  const opened = await js(`(() => {
    // 设置页入口按钮
    const btns = Array.from(document.querySelectorAll('button'));
    /**
     * ⚠ 设置按钮的文字是「⚙设置v1.0.2」—— **设置与版本号在同一个按钮里**，
     *   所以拿 trim() 跟 '设置' 比是匹配不到的。
     *   第一版用正则含「设置」二字去匹配，又抓错了别的按钮
     *   （页面上有「保存 Key 诊断」这种含「设」字的）。
     *   改用锚点字符 ⚙ —— 整个页面只有它带这个前缀。
     *
     * ⚠⚠ 这段注释在 js(...) 的模板字符串里，**不能出现反引号**。
     *   我第一版在这儿写了带反引号的代码片段，整个文件直接 SyntaxError。
     *   今天第四回犯这个错。
     */
    const gear = btns.find((b) => b.textContent.trim().charAt(0) === '⚙');
    if (!gear) return { ok: false, why: '找不到以 ⚙ 开头的按钮' };
    gear.click();
    return { ok: true, text: gear.textContent.trim() };
  })()`);
  console.log('  ', JSON.stringify(opened));
  await wait(1200);
  const after2 = await js(`(() => {
    const r = document.getElementById('root');
    return { childCount: r ? r.children.length : -1,
             html: r ? r.innerHTML.length : 0,
             hasBackBtn: !!Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('返回')),
             btnCount: document.querySelectorAll('button').length };
  })()`);
  console.log('  点击 1.2 秒后:', JSON.stringify(after2));
  await wait(1200);
  await js(`(() => {
    const b = Array.from(document.querySelectorAll('button'))
      // ⚠ 类目按钮文字是「⌘工具」—— 图标在同一按钮里，
      //   所以 trim() === '工具' 匹配不到。
      .find((x) => x.textContent.trim().endsWith('功能'));
    if (b) b.click();
    return true;
  })()`);
  await wait(1200);

  const dump = await js(`(() => {
    return {
      hasSettingsTitle: /设置/.test(document.body.innerText),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim().slice(0, 10)).slice(0, 24),
      bodyLen: document.body.innerText.length,
      tail: document.body.innerText.replace(/\s+/g, ' ').slice(-160),
    };
  })()`);
  console.log('  渲染实况:', JSON.stringify(dump, null, 1));

  const page = await js(`(() => {
    const t = document.body.innerText;
    const inp = document.querySelector('[data-testid=tool-search-key]');
    const save = inp ? Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === '保存') : null;
    return {
      onToolsPage: /功能/.test(t) && /联网搜索/.test(t),
      blockedLabel: /还没填搜索 Key/.test(t) ? '还没填搜索 Key' : '(没有这个标签)',
      hasInput: !!inp,
      inputType: inp ? inp.getAttribute('type') : '(无)',
      hasSaveBtn: !!save,
      saveDisabled: save ? save.disabled : null,
    };
  })()`);
  console.log('  工具页状态:', JSON.stringify(page));
  expect('设置页停在「功能」类目', page.onToolsPage, '没找到「联网搜索」字样');
  expect('有 Key 输入框', page.hasInput, '找不到 [data-testid=tool-search-key]');
  expect('有「保存」按钮', page.hasSaveBtn, '找不到保存按钮');

  console.log('\n=== 2. 往输入框里填 Key（走 React 的原生 setter）===');
  const typed = await js(`(() => {
    const inp = document.querySelector('[data-testid=tool-search-key]');
    if (!inp) return null;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(FAKE_KEY)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return { valueLen: inp.value.length, value: inp.value.slice(0, 10) };
  })()`);
  await wait(400);
  console.log('  填完:', JSON.stringify(typed));
  expect('输入框里有字', typed && typed.valueLen > 0, '字没填进去');

  const afterType = await js(`(() => {
    const inp = document.querySelector('[data-testid=tool-search-key]');
    const save = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === '保存');
    return { saveDisabled: save ? save.disabled : null, saveText: save ? save.textContent.trim() : '(无)' };
  })()`);
  console.log('  保存按钮状态:', JSON.stringify(afterType));
  expect('填了字之后「保存」可点', afterType.saveDisabled === false,
    '保存按钮仍是 disabled —— 用户点了没反应，这就是"没反应"的直接原因');

  console.log('\n=== 3. 点保存，看 toast 有没有弹出来 ===');
  const clicked = await js(`(() => {
    const save = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === '保存');
    if (!save) return false;
    save.click();
    return true;
  })()`);
  expect('点得到「保存」按钮', clicked, '按钮没找到');
  // toast 一般 3.2 秒后消失，200ms 内必须抓到
  await wait(260);

  const toast = await js(`(() => {
    const t = document.body.innerText;
    // toast 常是 fixed 定位的一小块，抓「已保存 / 失败 / 重填 / 加密」等字样
    const m = t.match(/(搜索 Key[^\\n]{0,40}|保存失败[^\\n]{0,40}|已保存[^\\n]{0,40}|只保存在本次运行[^\\n]{0,40})/);
    const fixed = Array.from(document.querySelectorAll('div'))
      .filter((d) => {
        const st = getComputedStyle(d);
        return st.position === 'fixed' && d.innerText && d.innerText.trim().length < 80;
      })
      .map((d) => d.innerText.trim());
    return { matched: m ? m[0] : null, fixedTexts: fixed };
  })()`);
  console.log('  toast 探测:', JSON.stringify(toast));
  expect('保存后弹出了提示（页面上能找到 toast 文字）',
    !!(toast && (toast.matched || (toast.fixedTexts || []).length)),
    '找不到任何 toast —— 这就是羽毛菌说的"没有弹窗说明成功"');

  console.log('\n=== 4. 状态有没有更新 ===');
  await wait(1200);
  const after = await js(`(() => {
    const t = document.body.innerText;
    const inp = document.querySelector('[data-testid=tool-search-key]');
    return {
      stillBlocked: /还没填搜索 Key/.test(t),
      nowAvailable: /\\b可用\\b/.test(t),
      inputValue: inp ? inp.value : '(没了)',
      inputPlaceholder: inp ? inp.placeholder : '(没了)',
      page: t.replace(/\\s+/g, ' ').slice(0, 60),
    };
  })()`);
  const badges = await js(`(() => {
    const b = document.querySelector('[data-testid=search-key-saved-badge]');
    const w = document.querySelector('[data-testid=search-key-nowrap-warning]');
    return {
      badge: b ? b.textContent.trim() : null,
      badgeColor: b ? getComputedStyle(b).color : null,
      warn: w ? w.textContent.replace(/\s+/g, ' ').trim().slice(0, 70) : null,
      warnBorder: w ? getComputedStyle(w).borderTopColor : null,
    };
  })()`);
  console.log('  常驻标记:', JSON.stringify(badges));
  expect('有常驻的「已保存」标记（不能只靠会消失的 toast）',
    !!(badges && badges.badge),
    '找不到 [data-testid=search-key-saved-badge] —— toast 一消失用户就不知道存没存上');
  expect('常驻标记说清了「本次运行有效，重启后需重填」',
    !!(badges && badges.badge && /重启/.test(badges.badge)),
    '标记文字是「' + (badges && badges.badge) + '」—— 没说明重启会失效');
  expect('加密不可用时是独立的醒目警告块（不是藏在小字里）',
    !!(badges && badges.warn),
    '找不到 [data-testid=search-key-nowrap-warning] —— 这条警告原来藏在 Hint 第二行，用户根本注意不到');

  console.log('  保存后状态:', JSON.stringify(after));
  expect('「还没填搜索 Key」标签消失了', after.stillBlocked === false,
    '标签还在 —— 状态没刷新，用户以为没保存成功');
  expect('输入框被清空了（setKey(\'\') 生效）', after.inputValue === '',
    '输入框没清空');
  expect('占位符改成了「已保存」', /已保存/.test(after.inputPlaceholder || ''),
    '占位符还是「' + after.inputPlaceholder + '」');

  console.log('\n=== 5. 主进程侧：Key 到底存进去没有 ===');
  const stored = secret.load(SEARCH_KEY_ID);
  console.log('  secret.load 长度 =', String(stored).length);
  expect('Key 真的落库了（能读回来）', stored === FAKE_KEY,
    '读回来是 ' + JSON.stringify(String(stored).slice(0, 12)));

  win.showInactive();
  await wait(500);
  try {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, 'h-savekey-result.png'), img.toPNG());
    console.log('  截图 → h-savekey-result.png');
  } catch (e) {
    console.log('  截图失败：' + e.message);
  }

  // 清理：别把诊断 Key 留在用户库里
  secret.save('', SEARCH_KEY_ID);
  console.log('  已清空诊断 Key');

  win.destroy();
  if (fails.length) {
    console.log(`\n✗ ${fails.length} 条没过：`);
    for (const f of fails) console.log('  - ' + f);
    app.exit(1);
  }
  console.log('\n✓ 保存链路全通');
  app.exit(0);
});
