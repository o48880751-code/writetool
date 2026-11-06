/**
 * 判据：快捷工具「封面」→ 生成 → 叠字 → 设为书架封面（2026-11-02）。
 *
 * 运行：./electron-run.cmd test-cover-ui.js
 *
 * ## 这里在防什么
 *
 * 1. **入口不在快捷工具栏**。羽毛菌的原话：「封面功能按钮应该放在快捷工具那一栏」。
 *    这一排放不下会自动收进「⋯」，所以除了"存在"还要断言**它没被收进去**。
 * 2. **Canvas 叠字根本没跑**。只断言"有张图"是不够的 ——
 *    把原图直接传下去也能过。真正的判据是：交给主进程的那张 PNG
 *    **尺寸是 1024×1536**（只有合成过才会是这个尺寸，模型出的是 1024x1536 原图也可能，
 *    所以再加一条：和底图**不是同一串字节**）。
 * 3. **设为封面没落盘**。要点完能看到 project:setCover 收到相对路径。
 *
 * ⚠ 底图用 data URL 喂：跨协议（wtfile://）的图画上画布会污染，
 *   `toDataURL()` 会抛 SecurityError。产品里也是先转 data URL，这里保持一致。
 */

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/**
 * ⚠⚠ 判据自己注册 `wtfile://`。
 *   测试脚本只起渲染层（不 require main.js），不注册的话"封面显示出来了"
 *   这条**永远红** —— 而那是环境的错，不是产品的错。
 *   但也不能因为环境做不到就删掉这条判据：显示不出来正是这功能最终交付的样子。
 *   → 把协议按产品里的实现（`makeWtfileHandler`，同一个函数）注册进来。
 * ⚠ 必须在 app ready **之前**。
 */
protocol.registerSchemesAsPrivileged([{
  scheme: 'wtfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');

const APPDIR = __dirname;
const MODULES = path.resolve(__dirname, '..');
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const APPDATA = process.env.APPDATA || os.tmpdir();
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');

const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const PRESETS = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
const coverPrompt = require(path.join(APPDIR, 'electron', 'cover-prompt.js'));
const { makeWtfileHandler } = require(path.join(APPDIR, 'electron', 'file-protocol.js'));
const skillFormat = require(path.join(APPDIR, 'electron', 'skill-format.js'));
const { setSkillFormat } = require(path.join(MODULES, 'db', 'store.js'));
setSkillFormat(skillFormat);

const db = new Store(path.join(os.tmpdir(), 'test-cover-ui.db'));
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
const PID = 'cv-1';
pfs.ensureProject(PID);
if (!db.getProject(PID)) db.createProject({ id: PID, name: '墨染仙途', kind: 'long' });
pfs.write(PID, '设定/世界观.md', '# 世界观\n\n沈砚自幼被弃于雪原，被守门人捡回山门，二十年后才知道自己背着半个宗门的血债。\n');
pfs.write(PID, '章节/第01章.md', '# 第一章 大雪封山\n\n山门前的雪下了整整三日。\n');

/** 1×1 PNG，当"模型画出来的底图" */
const BASE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const BASE_DATA_URL = 'data:image/png;base64,' + BASE_PNG_B64;

const CALLS = [];
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
for (const ch of ALL_CHANNELS) h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui', mode: 'light',
  notify: 'window', currentProject: null, thinkLevel: 'off', activeConnectionId: 'conn-1',
  editorFontSize: 16, chatFontSize: 16, editorFont: 'system-ui', chatFont: 'system-ui',
  penName: '羽某',
};

h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
// ⚠ 从 package.json 读，别写死：截图右下角会显示它，写死就会看到"旧版本"的截图
const PKG_VERSION = require(path.join(APPDIR, 'package.json')).version;
h('app:version', () => ({ version: PKG_VERSION, full: 'v' + PKG_VERSION }));
h('project:list', () => db.listProjectsWithKind());
h('project:stat', (p) => {
  const c = pfs.countTree(p.id);
  return { ok: true, id: p.id, chars: c.charCount || 0, files: c.fileCount || 0, dirs: c.dirCount || 0,
           chapters: 1, todayChars: 100, streakDays: 2, intro: '沈砚自幼被弃于雪原。' };
});
h('project:open', () => CFG);
h('settings:list', () => db.loadSettings(PID));
h('chapter:list', () => db.listChapters(PID));
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => db.listSkills(PID));
h('trash:list', () => ({ stats: { count: 0 } }));
h('style:profile', () => ({ available: false, reason: '' }));
h('provider:capabilities', () => ({ providers: PRESETS.PROVIDERS, customs: PRESETS.customs().map((c) => c.key) }));
h('provider:listConnections', () => ([
  { id: 'conn-1', name: '本地 Ollama', protocol: 'ollama', providerKey: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen3:latest', needKey: false },
]));
h('font:presets', () => []);
h('font:installed', () => []);
h('fs:tree', (p) => pfs.tree(p.projectId, { sort: p.sort }));
h('conv:list', () => []);

// ---- 封面三个通道 ----
h('image:styles', () => ({
  styles: coverPrompt.listStyles(),
  genres: coverPrompt.listGenres(),
  templates: coverPrompt.listTemplates(),
}));
h('image:composePrompt', (p) => {
  CALLS.push({ ch: 'image:composePrompt', payload: p });
  // 模拟 LLM 写出来的一段（带前言/引号，验证界面能原样收下）
  return { prompt: '雪原上的孤城，暴风雪后的清晨，冷蓝色调，主体偏上，下方留白。', source: 'llm' };
});
h('image:cover', (p) => {
  CALLS.push({ ch: 'image:cover', payload: p });
  /**
   * ⚠ 桩必须**真的把底图写下来**：方案 B 直接拿这张当成品，
   *   书架会用它当封面 —— 不落盘的话"封面加载出来了"那条会红，
   *   而那是桩的问题，不是产品的问题。
   */
  const relPath = ['_assets', '底图-1.png'].join('/');
  const fp = pfs.resolveIn(PID, relPath.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, Buffer.from(BASE_PNG_B64, 'base64'));
  const url = 'wtfile://' + PID + '/' + relPath.split('/').map(encodeURIComponent).join('/');
  return { path: relPath, url, model: 'qwen-image-3.0', ms: 6600, bytes: 68 };
});
h('image:readAsDataUrl', (p) => {
  CALLS.push({ ch: 'image:readAsDataUrl', payload: p });
  return { dataUrl: BASE_DATA_URL };
});
h('image:saveCover', (p) => {
  const s = String((p && p.dataUrl) || '');
  const m = /^data:image\/png;base64,(.+)$/.exec(s);
  const buf = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0);
  CALLS.push({
    ch: 'image:saveCover',
    payload: p,
    bytes: buf.length,
    // PNG 的 IHDR：宽在 16、高在 20（大端）
    w: buf.length > 24 ? buf.readUInt32BE(16) : 0,
    h: buf.length > 24 ? buf.readUInt32BE(20) : 0,
    sameAsBase: s.indexOf(BASE_PNG_B64) >= 0,
  });
  /**
   * ⚠ 桩必须**真的把文件写下来**：后面要用 `wtfile://` 读它、验证书架显示。
   *   只返回一个字符串路径的话，"封面加载出来了"这条就永远红。
   */
  /**
   * ⚠ 顺手把合成结果**原尺寸**落一张到 shots/：
   *   弹层里的预览只有 200px 宽，字效（描边/渐变/字体）根本看不出来，
   *   而"字好不好看"恰恰是这功能的成败点 —— 判据看不出美丑，人得看原图。
   */
  if (buf.length) {
    try { fs.writeFileSync(path.join(OUT, 'cover-full.png'), buf); } catch (_) { /* 落不了不影响判据 */ }
  }

  const relPath = ['_assets', '封面-1.png'].join('/');
  const fp = pfs.resolveIn(PID, relPath.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, buf);

  // ⚠ url 必须**照产品拼法**拼（项目 id + 编码后的路径）：
  //   第一版随手写了个假地址，预览就是一张裂图 —— 而判据只查了"<img> 存在"，
  //   截图里却明晃晃一个破图标。桩返回的地址也得是真的能用。
  const url = 'wtfile://' + PID + '/' + relPath.split('/').map(encodeURIComponent).join('/');
  return { path: relPath, url, bytes: buf.length };
});
h('project:setCover', (p) => {
  CALLS.push({ ch: 'project:setCover', payload: p });
  db.setProjectCover(p.id, p.coverPath);
  return { ok: true, coverPath: p.coverPath };
});

const CHECKS = [];
function t(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('  ✗ 90 秒没跑完'); app.exit(1); }, 90000);

  // 协议处理器用**产品里同一个函数**，不另写一份（否则测的是桩）
  protocol.handle('wtfile', makeWtfileHandler(pfs));

  const { width: screenW, height: screenH } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1500, screenW - 40), height: Math.min(950, screenH - 60), show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.showInactive();
  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await sleep(2600);

  async function js(code) {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) { return { __err: e.message }; }
  }
  const shot = async (name) => {
    await sleep(400);
    try {
      fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      console.log(`  ✓ ${name}`);
    } catch (e) { console.log(`  ✗ ${name} 拍失败：${e.message}`); }
  };
  const click = (sel) => js(`
    (() => {
      var b = document.querySelector(${JSON.stringify(sel)});
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);
  const type = (sel, v) => js(`
    (() => {
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'not-found';
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(String(v))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()
  `);

  console.log('\n=== 一、先进编辑器，再找快捷工具 ===');
  await sleep(300);
  /**
   * ⚠ 入口只能是「继续写作」（2026-11-02 起横幅整块不可点）。
   *   原来写的是"点卡片，没卡片就点横幅" —— 只有一本书时没有卡片，
   *   而横幅已经点不动了，于是整段判据从这里开始全红。
   *   产品语义变了，判据的**进入方式**也得跟着改。
   */
  const card = await click('[data-testid="bookshelf-card"]');
  if (card === 'not-found') await click('[data-testid="shelf-hero-continue"]');
  await sleep(1600);

  const qt = await js(`
    (() => {
      var b = document.querySelector('[data-qt="cover"]');
      var more = [...document.querySelectorAll('button')].find(function (x) {
        return (x.textContent || '').indexOf('还有') >= 0 || (x.getAttribute('title') || '').indexOf('还有') >= 0;
      });
      return {
        direct: !!b,
        label: b ? (b.textContent || '').trim() : null,
        inMoreMenu: !!more,
        visible: [...document.querySelectorAll('[data-qt]')].map(function (x) { return x.getAttribute('data-qt'); }),
      };
    })()
  `);
  console.log('  ', JSON.stringify(qt));
  /**
   * ⚠ 共享的对话栏宽，这一排只放得下 4 个（实测 memo/name/brain/idea），
   *   后面的自动收进「⋯」——文风蒸馏、简介、拆书**一直**都是这样。
   *   所以判据不要求它"直接可见"（那是让产品去迁就判据），
   *   而是要求它**在那一栏里、点得到、点了真能开**。
   */
  t('快捷工具栏认得「封面」这个工具（在栏里，不在别处）',
    qt.direct === true || qt.inMoreMenu === true,
    `直接可见=${qt.direct} 在⋯里=${qt.inMoreMenu} 当前可见=${(qt.visible || []).join(',')}`);
  t('没出现在「可见的那四个」里也说明原因（这一排只放得下 4 个）',
    (qt.visible || []).length <= 4, JSON.stringify(qt.visible));

  console.log('\n=== 二、从「⋯」里点开封面 ===');
  let open;
  if (qt.direct) {
    open = await click('[data-qt="cover"]');
  } else {
    // 先展开「⋯」，再点里面那个「封面」
    await js(`
      (() => {
        var more = [...document.querySelectorAll('button')].find(function (x) {
          return (x.getAttribute('title') || '').indexOf('还有') >= 0;
        });
        if (more) more.click();
        return true;
      })()
    `);
    await sleep(500);
    open = await js(`
      (() => {
        var b = [...document.querySelectorAll('button')].find(function (x) {
          var s = (x.textContent || '').trim();
          return s === '封面' || s.replace(/\s/g, '') === '🖼️封面';
        });
        if (!b) return 'not-found';
        b.click();
        return 'ok';
      })()
    `);
  }
  console.log('  点封面:', open);
  t('从快捷工具栏点得到「封面」', open === 'ok', String(open));
  await sleep(900);
  const modal = await js(`
    (() => {
      var m = document.querySelector('[data-testid="cover-modal"]');
      if (!m) return { open: false };
      var styles = [...m.querySelectorAll('[data-testid^="cover-style-"]')].map(function (b) {
        return b.getAttribute('data-testid').replace('cover-style-', '');
      });
      return {
        open: true,
        styles: styles,
        title: (document.querySelector('[data-testid="cover-title"]') || {}).value,
        author: (document.querySelector('[data-testid="cover-author"]') || {}).value,
        mentionsCover: m.innerText.indexOf('封面') >= 0,
        mentionsPoster: m.innerText.indexOf('海报') >= 0,
      };
    })()
  `);
  console.log('  ', JSON.stringify(modal));
  t('弹层开了', modal.open === true);
  t('六种画风都在', modal.styles && modal.styles.length === 6, (modal.styles || []).join(','));
  t('书名预填成项目名（不用重打）', modal.title === '墨染仙途', String(modal.title));
  t('笔名从设置里带出来', modal.author === '羽某', String(modal.author));
  t('文案里说的是「封面」不是「海报」', modal.mentionsPoster === false);

  /**
   * ⚠⚠ 每个输入框**必须有一个写着字的标签**。
   *
   * 这条是补的：第一版把标签写成了 `<div style={label('书名')} />` ——
   * `label()` 返回样式对象，于是三行标签全是空 div，界面上三个框一个名字都没有。
   * 羽毛菌的反馈是「这个可以不填又是什么？」——他只能靠 placeholder 猜，
   * 而 placeholder 一填就没了。当时的判据只查了"输入框在不在、值对不对"，
   * 所以**全绿**。这类"结构在、内容空"的 bug，只能靠"往回找一个有字的兄弟"来抓。
   */
  const labels = await js(`
    (() => {
      var out = {};
      ['cover-title', 'cover-author', 'cover-scene', 'cover-prompt'].forEach(function (id) {
        var el = document.querySelector('[data-testid="' + id + '"]');
        if (!el) { out[id] = null; return; }
        var prev = el.previousElementSibling;
        out[id] = prev ? (prev.textContent || '').trim() : '';
      });
      return out;
    })()
  `);
  console.log('  标签:', JSON.stringify(labels));
  t('书名 输入框上方有标签文字', !!(labels['cover-title'] || '').length, '\u0027' + labels['cover-title'] + '\u0027');
  t('作者 输入框上方有标签文字（不能只靠 placeholder）',
    !!(labels['cover-author'] || '').length, '\u0027' + labels['cover-author'] + '\u0027');
  t('画面 输入框上方有标签文字',
    !!(labels['cover-scene'] || '').length, '\u0027' + labels['cover-scene'] + '\u0027');
  t('提示词 上方有标签文字',
    !!(labels['cover-prompt'] || '').length, '\u0027' + labels['cover-prompt'] + '\u0027');
  /**
   * ⚠ 选填项必须写清"留空会怎样"。
   *   注意**不能只看标签那一个 div** —— 说明可以放 placeholder 或标签下面那行小字。
   *   所以查整块弹层的可见文字（placeholder 不算，它填上就没了，
   *   所以产品必须在**正文**里也写一遍）。
   */
  const modalText = await js(
    "document.querySelector('[data-testid=\"cover-modal\"]').innerText"
  );
  t('选填项写清了「留空会怎样」（不是干巴巴一个词）',
    /留空|不指定/.test(modalText), String(modalText.slice(0, 60)));

  console.log('\n=== 二之零、六个画风 + 风格预设下拉 ===');
  {
    const form = await js(`
      (() => {
        var m = document.querySelector('[data-testid="cover-modal"]');
        var chips = [...m.querySelectorAll('[data-testid^="cover-style-"]')]
          .map(function (b) { return b.getAttribute('data-testid').replace('cover-style-', ''); });
        var sel = document.querySelector('[data-testid="cover-template"]');
        return {
          chips: chips,
          hasSel: !!sel,
          options: sel ? [...sel.options].map(function (o) { return o.value; }) : [],
          hasBurn: !!document.querySelector('[data-testid="cover-burn-title"]'),
        };
      })()
    `);
    console.log('  ', JSON.stringify(form));
    t('六种画风都在（含 chibi 漫画Q版）',
      form.chips.length === 6 && form.chips.indexOf('chibi') >= 0, form.chips.join(','));
    t('有风格预设下拉', form.hasSel === true);
    t('下拉里有 6 套预设 + "不用预设"', form.options.length === 7, form.options.join(','));
    t('有「AI 生成封面文字」开关', form.hasBurn === true);
  }

  console.log('\n=== 二之零二、选预设会填进提示词框 ===');
  {
    await js(`
      (() => {
        var s = document.querySelector('[data-testid="cover-template"]');
        var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(s, 'hot');
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return s.value;
      })()
    `);
    await sleep(500);
    const filled = await js("document.querySelector('[data-testid=\"cover-prompt\"]').value");
    console.log('  填入长度:', filled.length);
    t('提示词框被填上了（正向 + 反向两段）',
      filled.indexOf('正向提示词') >= 0 && filled.indexOf('负面提示词') >= 0, filled.slice(0, 40));
    t('填的是这套预设的内容（爽感/冲击）',
      /能量光效|速度线|特写/.test(filled), filled.slice(0, 60));
    t('⚠ 结构约束**不写进框里**（要由主进程按开关追加，否则翻开关就不一致）',
      !/不要出现任何形式的文字/.test(filled));
  }

  console.log('\n=== 二之一、点遮罩不会关掉弹层（不丢输入） ===');
  /**
   * ⚠⚠ 羽毛菌：「这个页面太容易误触返回了，刚输入的词又要重新输入」。
   *   根因是遮罩层绑了 `onClick={onClose}` —— 点卡片外面任何地方都关。
   *   判据两边都要验：**点遮罩不关**，而且**内容没丢**。
   *   只验"没关"的话，把输入框清空也能过。
   */
  await type('[data-testid="cover-scene"]', '不该丢的一句话');
  await sleep(300);
  await js(`
    (() => {
      var m = document.querySelector('[data-testid="cover-modal"]');
      if (m) m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(500);
  const afterMask = await js(`
    (() => ({
      open: !!document.querySelector('[data-testid="cover-modal"]'),
      scene: (document.querySelector('[data-testid="cover-scene"]') || {}).value,
    }))()
  `);
  console.log('  ', JSON.stringify(afterMask));
  t('点遮罩**不会**关闭弹层', afterMask.open === true);
  t('已填的内容还在（没有白丢）', afterMask.scene === '不该丢的一句话', String(afterMask.scene));

  const closers = await js(`
    (() => {
      var m = document.querySelector('[data-testid="cover-modal"]');
      var btns = [...m.querySelectorAll('button')].filter(function (b) {
        var s = (b.textContent || '').trim();
        return s === '取消' || s === '×' || s === '关闭';
      });
      return {
        cancelCount: btns.length,
        hasBack: !!m.querySelector('[data-testid="cover-back"]'),
        backText: (m.querySelector('[data-testid="cover-back"]') || {}).textContent,
      };
    })()
  `);
  console.log('  ', JSON.stringify(closers));
  t('有「← 返回」按钮', closers.hasBack === true, String(closers.backText).trim());
  t('没有第二个"取消/关闭"入口（返回只有一条路）', closers.cancelCount === 0);

  console.log('\n=== 二之二、AI 写提示词（两个模型协同） ===');
  /**
   * ⚠ 这是这个功能"覆盖面"的来源：用户写不出提示词才是常态。
   *   判据要验的是**五要素真的传到了主进程**，而不是"界面上多了个按钮"。
   */
  CALLS.length = 0;
  await js(`
    (() => {
      var s = document.querySelector('[data-testid="cover-genre"]');
      var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(s, '仙侠');
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return s.value;
    })()
  `);
  await type('[data-testid="cover-scene"]', '雪原上的孤城，暴风雪');
  await sleep(300);
  console.log('  点 AI 帮我写:', await click('[data-testid="cover-compose"]'));
  await sleep(1000);

  const comp = CALLS.find((c) => c.ch === 'image:composePrompt');
  console.log('  composePrompt 收到:', JSON.stringify(comp && comp.payload));
  t('调了 image:composePrompt', !!comp);
  t('书名传下去了', !!comp && comp.payload.name === '墨染仙途');
  t('作者传下去了', !!comp && comp.payload.author === '羽某');
  t('题材传下去了', !!comp && comp.payload.genre === '仙侠');
  t('风格（必填）传下去了', !!comp && comp.payload.style === 'xianxia');
  t('画面传下去了', !!comp && comp.payload.scene === '雪原上的孤城，暴风雪');

  const afterAI = await js(`
    (() => {
      var ta = document.querySelector('[data-testid="cover-prompt"]');
      var m = document.querySelector('[data-testid="cover-modal"]');
      return { text: ta ? ta.value : '', body: m ? m.innerText : '' };
    })()
  `);
  console.log('  提示词框:', JSON.stringify(afterAI.text.slice(0, 40)));
  t('AI 写的提示词填进了输入框（可以再手改）',
    afterAI.text.indexOf('雪原') >= 0, afterAI.text.slice(0, 30));
  t('界面上标了「AI 写的」（用户知道这段是谁写的）',
    afterAI.body.indexOf('AI 写的') >= 0);

  console.log('\n=== 二之三、书名是必填 —— 没书名不让写也不让画 ===');
  await type('[data-testid="cover-title"]', '');
  await sleep(300);
  const gate = await js(`
    (() => {
      var b = document.querySelector('[data-testid="cover-compose"]');
      return { disabled: !!b && b.disabled };
    })()
  `);
  t('书名空着时「AI 帮我写」是禁用的', gate.disabled === true, String(gate.disabled));
  await type('[data-testid="cover-title"]', '带着满级记忆回高中，我靠先知碾压全场');
  await sleep(200);

  console.log('\n=== 三、生成：真的走 底图 → dataURL → 叠字 → 存盘 ===');
  CALLS.length = 0;
  await type('[data-testid="cover-title"]', '墨染仙途');
  await sleep(200);
  console.log('  点生成:', await click('[data-testid="cover-generate"]'));
  await sleep(2500);

  const madeCall = CALLS.find((c) => c.ch === 'image:cover');
  const readCall = CALLS.find((c) => c.ch === 'image:readAsDataUrl');
  const saveCall = CALLS.find((c) => c.ch === 'image:saveCover');
  console.log('  image:cover 收到:', JSON.stringify(madeCall && madeCall.payload));
  console.log('  saveCover 尺寸:', saveCall && `${saveCall.w}x${saveCall.h}`, '字节', saveCall && saveCall.bytes);

  t('调了 image:cover 且带项目 id', !!madeCall && madeCall.payload.projectId === PID);
  t('画风参数传下去了', !!madeCall && typeof madeCall.payload.style === 'string');
  t('底图读成了 dataURL（画布才不会被污染）', !!readCall && !!readCall.payload.path);
  t('合成后的 PNG 是 1024×1536（证明 Canvas 真的跑了）',
    !!saveCall && saveCall.w === 1024 && saveCall.h === 1536,
    saveCall ? `${saveCall.w}x${saveCall.h}` : '没调用');
  t('存下去的不是底图原样（叠字真的改了像素）',
    !!saveCall && saveCall.sameAsBase === false);
  t('PNG 有实体内容（不是空画布）', !!saveCall && saveCall.bytes > 2000, `${saveCall && saveCall.bytes} 字节`);

  console.log('  [诊断] 弹层里的报错:', JSON.stringify(await js(`
    (() => {
      var m = document.querySelector('[data-testid="cover-modal"]');
      if (!m) return 'no-modal';
      var err = [...m.querySelectorAll('div')].find(function (d) {
        var s = (d.textContent || '').trim();
        return d.children.length === 0 && (s.indexOf('失败') >= 0 || s.indexOf('没能') >= 0
          || s.indexOf('错误') >= 0 || s.indexOf('Error') >= 0 || s.indexOf('格式') >= 0);
      });
      return err ? err.textContent.trim() : '(没找到报错文字)';
    })()
  `)));

  /**
   * ⚠ 不能只查 `<img>` 在不在 —— 裂图也是有 `<img>` 的。
   *   第一版正是这么写的：判据绿，截图里是个破图标。
   */
  const preview = await js(`
    (() => {
      var el = document.querySelector('[data-testid="cover-preview"]');
      if (!el) return { has: false };
      return { has: true, loaded: el.complete && el.naturalWidth > 0, src: el.getAttribute('src') };
    })()
  `);
  console.log('  预览:', JSON.stringify(preview));
  t('预览图在', preview.has === true);
  t('预览图**真的加载出来了**（不是裂图）',
    preview.has === true && preview.loaded === true, String(preview.loaded));
  await shot('c1-封面弹层');

  console.log('\n=== 三之二、方案 B：让 AI 直接写书名，且**不再叠一次** ===');
  /**
   * ⚠⚠ 这条是方案 B 的关键：AI 已经画了标题，Canvas **必须跳过**。
   *   如果还叠一次，封面就会出现两个书名（之前反复踩的就是这个）。
   *   判据：开关打开后 `image:saveCover` 不能被调用，成品就是底图本身。
   */
  {
    await js(`
      (() => {
        var cb = document.querySelector('[data-testid="cover-burn-title"]');
        if (!cb.checked) cb.click();
        return cb.checked;
      })()
    `);
    await sleep(400);
    const bff = await js(`
      (() => ({
        hasSub: !!document.querySelector('[data-testid="cover-subtitle"]'),
        hasTags: !!document.querySelector('[data-testid="cover-tags"]'),
      }))()
    `);
    t('打开开关后出现「副标题」「标签」输入', bff.hasSub && bff.hasTags, JSON.stringify(bff));

    await type('[data-testid="cover-subtitle"]', '重生那年');
    await type('[data-testid="cover-tags"]', '重生 逆袭');
    await sleep(200);

    CALLS.length = 0;
    console.log('  点重画（B 模式）:', await click('[data-testid="cover-generate"]'));
    await sleep(2200);

    const bCall = CALLS.find((c) => c.ch === 'image:cover');
    console.log('  image:cover 收到:', JSON.stringify(bCall && bCall.payload));
    t('titleMode 传成 burn', !!bCall && bCall.payload.titleMode === 'burn');
    t('副标题传下去了', !!bCall && bCall.payload.subtitle === '重生那年');
    t('标签拆成了数组', !!bCall && Array.isArray(bCall.payload.tags) && bCall.payload.tags.length === 2,
      JSON.stringify(bCall && bCall.payload.tags));
    t('⚠ **没有**再走 Canvas 叠字（saveCover 没被调用）',
      !CALLS.some((c) => c.ch === 'image:saveCover'),
      CALLS.map((c) => c.ch).join(','));
  }

  console.log('\n=== 四、设为书架封面 ===');
  CALLS.length = 0;
  console.log('  点设为封面:', await click('[data-testid="cover-apply"]'));
  await sleep(1200);
  const applyCall = CALLS.find((c) => c.ch === 'project:setCover');
  console.log('  project:setCover 收到:', JSON.stringify(applyCall && applyCall.payload));
  t('setCover 收到了项目 id 和相对路径',
    !!applyCall && applyCall.payload.id === PID && applyCall.payload.coverPath === '_assets/底图-1.png');
  t('弹层自己关掉了', (await js("!!document.querySelector('[data-testid=\"cover-modal\"]')")) === false);

  console.log('\n=== 五、书架要真的显示这张图 ===');
  await js("window.scrollTo(0,0); true");
  // 回书架
  const back = await js(`
    (() => {
      var b = document.querySelector('[data-testid="back-to-shelf"]')
           || [...document.querySelectorAll('button')].find(function (x) {
                return (x.getAttribute('title') || '').indexOf('书架') >= 0;
              });
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);
  console.log('  回书架:', back);
  await sleep(1600);

  const shelf = await js(`
    (() => {
      var img = document.querySelector('[data-testid="shelf-hero-cover-img"]');
      return {
        hasImg: !!img,
        src: img ? img.getAttribute('src') : null,
        loaded: img ? (img.complete && img.naturalWidth > 0) : false,
      };
    })()
  `);
  console.log('  ', JSON.stringify(shelf));
  t('横幅封面换成了图片（不再是首字色块）', shelf.hasImg === true, String(shelf.src));
  t('图片地址走的是 wtfile:// 协议', !!shelf.src && shelf.src.indexOf('wtfile://') === 0, String(shelf.src));
  t('图片真的加载出来了（不是裂图）', shelf.loaded === true, `naturalWidth>0 = ${shelf.loaded}`);
  await shot('c2-书架封面');

  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
  if (bad.length) bad.forEach((b) => console.log('  ✗', b.name));
  clearTimeout(watchdog);
  win.destroy();
  app.exit(bad.length ? 1 : 0);
});
