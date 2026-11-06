/**
 * 判据：设置页「封面生图」配置块 + IPC 透传（2026-11-02）。
 *
 * 运行：./electron-run.cmd test-image-ui.js
 *
 * ## 这里在防什么
 *
 * 1. **preload 丢参数**。这一层已经栽过四次（kind / list / stat / import）。
 *    生图这边字段更多（providerKey / base / model / size），
 *    所以判据不是"界面上填进去了"，而是**主进程 handler 真的收到了每一项**。
 * 2. **换服务商不清旧值**。选了方舟却在打百炼的域名，报错看着像密钥错。
 * 3. **密钥不该进 config**。`image:save` 收到的字段里不能出现 key，
 *    密钥只能走 `image:setKey`（safeStorage）。
 * 4. **「试一下」必须真的发请求**。纯 UI 的"保存成功"不能证明配通了。
 *
 * ⚠ 桩里的合并逻辑直接用产品里那个纯函数（`mergeImagePatch`），
 *   不另写一套 —— 否则测的是桩，不是产品。
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
const OUT = path.join(APPDIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const APPDATA = process.env.APPDATA || os.tmpdir();
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');

const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const PRESETS = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
const imagePresets = require(path.join(APPDIR, 'electron', 'image-presets.js'));
const imageProvider = require(path.join(APPDIR, 'electron', 'image-provider.js'));
const skillFormat = require(path.join(APPDIR, 'electron', 'skill-format.js'));
const { setSkillFormat } = require(path.join(MODULES, 'db', 'store.js'));
setSkillFormat(skillFormat);

const db = new Store(path.join(os.tmpdir(), 'test-image-ui.db'));
const pfs = new ProjectFs(PROJECTS_DIR);
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
const PID = 'iu-1';
pfs.ensureProject(PID);
if (!db.getProject(PID)) db.createProject({ id: PID, name: '生图配置验证', kind: 'long' });
pfs.write(PID, '章节/第01章.md', '# 第一章\n\n风起。\n');

/** 1×1 透明 PNG，给「试一下」当返回值用 */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ---- IPC 桩 ----
const CALLS = [];   // { ch, payload } —— 判据靠它看主进程**收到了什么**
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, p) => {
    try { return { ok: true, data: await fn(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];
for (const ch of ALL_CHANNELS) {
  h(ch, () => (/_list$|_get$/.test(ch) ? [] : null));
}

let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui', mode: 'light',
  notify: 'window', currentProject: null, thinkLevel: 'off', activeConnectionId: 'conn-1',
  editorFontSize: 16, chatFontSize: 16,
  /**
   * ⚠⚠ 故意伪装成"老用户选过一个已经下架的字体"（`'LXGW WenKai'`，2026-11-02 移除）。
   *
   *   必须写在**这里**（窗口 loadFile 之前）。第一版是在进设置页之前才赋值的，
   *   可 App 只在启动时读一次 `config:get`，那次赋值根本没生效 ——
   *   于是"零勾回落"那条判据**永远绿**，做变异测试也没变红，等于没测。
   */
  editorFont: "'LXGW WenKai'", chatFont: 'system-ui',
};
let IMG = {};              // 对应主进程的 config.image
let IMG_KEY = '';          // 对应 safeStorage 里的 image 密钥
/** 字体清单走真表 —— 桩自己捏一份的话，"列表里到底有哪几款"就测不到了 */
const FONT_PRESETS = require(path.join(APPDIR, 'electron', 'font-presets.js')).FONTS;

h('config:get', () => CFG);
/**
 * ⚠ 这个桩必须**照主进程的语义抛错**（2026-11-03 加）。
 *   主进程 config:set 会用 honorific.checkTitle 校验称谓并抛错；
 *   桩要是无脑合并，界面那条"保存失败要显示出来"的判据就永远不会红。
 */
const HONOR = require(path.join(APPDIR, 'electron', 'honorific.js'));
h('config:set', (p) => {
  const patch = { ...p };
  if (patch.userTitle !== undefined) {
    const r = HONOR.checkTitle(patch.userTitle);
    if (!r.ok) throw new Error(`这个称谓不能用：${r.reason}`);
    patch.userTitle = r.title;
  }
  CFG = { ...CFG, ...patch };
  return CFG;
});
h('app:version', () => ({ version: '1.6.3', full: 'v1.6.3' }));
h('project:list', () => db.listProjectsWithKind());
h('project:stat', (p) => {
  const c = pfs.countTree(p.id);
  return { ok: true, id: p.id, chars: c.charCount || 0, files: c.fileCount || 0, dirs: c.dirCount || 0,
           chapters: 1, todayChars: 10, streakDays: 1, intro: '' };
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
h('font:presets', () => FONT_PRESETS.map((f) => ({
  id: f.id, label: f.label, family: f.family, file: f.file, sizeMB: f.sizeMB, desc: f.desc,
})));
h('font:installed', () => FONT_PRESETS.map((f) => f.id));
h('fs:tree', (p) => pfs.tree(p.projectId, { sort: p.sort }));
h('conv:list', () => []);

// ---- 生图四个通道（照主进程的语义实现） ----
h('image:presets', () => imagePresets.list());
h('image:get', () => {
  const cfg = IMG.providerKey ? IMG : { providerKey: 'dashscope', protocol: 'dashscope', base: '', model: '', size: '' };
  const preset = imagePresets.get(cfg.providerKey);
  return {
    providerKey: preset.key,
    protocol: preset.protocol,
    base: cfg.base || '',
    model: cfg.model || '',
    size: cfg.size || '',
    effectiveBase: cfg.base || preset.base,
    effectiveModel: cfg.model || preset.defaultModel,
    effectiveSize: cfg.size || preset.defaultSize,
    // 用产品里同一个纯函数算，别在桩里另写一套
    endpoint: imageProvider.previewUrl(preset, {
      base: cfg.base || preset.base,
      model: cfg.model || preset.defaultModel,
    }),
    hasKey: !!IMG_KEY,
  };
});
h('image:save', (p) => {
  CALLS.push({ ch: 'image:save', payload: p });
  /**
   * ⚠ 尺寸校验照**主进程的真实语义**抛错（用的就是产品里那个 isValidSize）。
   *   第一版桩直接收下一切，判据就变成"桩没校验" → 测了个寂寞。
   *   桩要么照产品实现，要么这条判据别写。
   */
  if (p && p.size !== undefined) {
    const s = String(p.size || '').trim();
    if (s && !imageProvider.isValidSize(s)) {
      throw new Error('尺寸要写成「宽x高」，比如 1024x1536');
    }
  }
  IMG = imagePresets.mergeImagePatch(IMG, p || {});
  return IMG;
});
h('image:setKey', (p) => {
  CALLS.push({ ch: 'image:setKey', payload: p });
  IMG_KEY = String((p && p.key) || '');
  return { hasKey: !!IMG_KEY, encrypted: true };
});
h('image:try', (p) => {
  CALLS.push({ ch: 'image:try', payload: p });
  return { url: TINY_PNG, name: 'img-test.png', model: IMG.model || imagePresets.get(IMG.providerKey || 'dashscope').defaultModel, ms: 1234, bytes: 68 };
});

const CHECKS = [];
function t(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('  ✗ 90 秒没跑完'); app.exit(1); }, 90000);

  const { width: screenW, height: screenH } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1400, screenW - 40), height: Math.min(950, screenH - 60), show: false,
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
    await sleep(350);
    try {
      const buf = (await win.webContents.capturePage()).toPNG();
      fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
      console.log(`  ✓ ${name}`);
    } catch (e) { console.log(`  ✗ ${name} 拍失败：${e.message}`); }
  };

  /** 点一个按钮（按 testid） */
  const click = (id) => js(`
    (() => {
      var b = document.querySelector('[data-testid="${id}"]');
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);

  /** 按文字点设置页左边的类目 */
  const clickCat = (label) => js(`
    (() => {
      // ⚠ 不能用 === 比：类目按钮里还有 emoji 图标（🤖AI 提供商），
      //   精确匹配永远点不中 —— 第一版就是这么全红的。
      var b = [...document.querySelectorAll('button')].find(function (x) {
        var s = (x.textContent || '').trim();
        return s === ${JSON.stringify(label)} || s.indexOf(${JSON.stringify(label)}) >= 0;
      });
      if (!b) return 'not-found';
      b.click();
      return 'ok';
    })()
  `);

  /** React 受控输入：必须走原生 setter + input 事件，否则 state 不更新 */
  const type = (id, v) => js(`
    (() => {
      var el = document.querySelector('[data-testid="${id}"]');
      if (!el) return 'not-found';
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(String(v))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()
  `);

  const state = () => js(`
    (() => {
      var body = document.querySelector('[data-testid="settings-body"]');
      if (!body) return { noSettings: true };
      var chips = [...body.querySelectorAll('[data-testid^="img-preset-"]')].map(function (b) {
        return { key: b.getAttribute('data-testid').replace('img-preset-', ''), on: b.style.background.indexOf('color') < 0 && getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)' };
      });
      var g = function (id) { var el = document.querySelector('[data-testid="' + id + '"]'); return el ? el.value : null; };
      return {
        hasSection: body.innerText.indexOf('封面生图') >= 0,
        hasNoCrossLine: body.innerText.indexOf('不会') >= 0,
        chips: chips,
        base: g('img-base'), model: g('img-model'), size: g('img-size'), key: g('img-key'),
        tried: !!document.querySelector('[data-testid="img-tried"]'),
      };
    })()
  `);

  console.log('\n=== 一、入口在「AI 提供商」页下面 ===');
  console.log('  打开设置:', await click('bookshelf-settings'));
  await sleep(900);
  console.log('  点「AI 提供商」:', await clickCat('AI 提供商'));
  await sleep(900);
  let s = await state();
  if (s.noSettings) {
    console.log('  ✗ 设置页没打开');
    t('设置页能打开', false);
    clearTimeout(watchdog); win.destroy(); app.exit(1);
  }
  t('设置页打开了 AI 提供商', !s.noSettings);
  t('页面里有「封面生图」这一块', s.hasSection === true);
  t('五家服务商都在（百炼/方舟/商汤/千帆/自定义）',
    s.chips.length === 5, s.chips.map((c) => c.key).join(','));
  t('把「只画图、不参与对话」说清楚了', s.hasNoCrossLine === true);

  console.log('\n=== 二、切到方舟：只发 providerKey，别的清理由主进程做 ===');
  s = await state();
  console.log('  默认选中的是:', (s.chips.find((c) => c.on) || {}).key);
  t('默认落在百炼', !!(s.chips.find((c) => c.on) && s.chips.find((c) => c.on).key === 'dashscope'));

  CALLS.length = 0;
  console.log('  点方舟:', await click('img-preset-ark'));
  await sleep(700);
  const pickCall = CALLS.find((c) => c.ch === 'image:save');
  console.log('  主进程收到:', JSON.stringify(pickCall && pickCall.payload));
  t('切换时只发了 providerKey（不带上一家的地址模型）',
    !!pickCall && Object.keys(pickCall.payload).length === 1 && pickCall.payload.providerKey === 'ark',
    JSON.stringify(pickCall && pickCall.payload));

  s = await state();
  console.log('  ', JSON.stringify({ base: s.base, model: s.model, size: s.size }));
  t('切完后地址/模型/尺寸都清空了（界面回到那家的占位）',
    s.base === '' && s.model === '' && s.size === '');
  t('方舟的参数说明出来了（模型名带日期那种坑）',
    (await js("document.querySelector('[data-testid=\"settings-body\"]').innerText")).includes('日期后缀'));

  console.log('\n=== 二之二、界面上要显示"实际请求地址"（重复路径一眼可见） ===');
  /**
   * ⚠ 那次 500 的根因是地址被拼了两遍，而界面上完全看不到最终地址。
   *   这条判据盯的是"看得见"，不是"拼得对"（拼得对由 test-image-provider 管）。
   */
  const ep = await js(`
    (() => {
      var el = document.querySelector('[data-testid="img-endpoint"]');
      return { has: !!el, text: el ? el.textContent : '' };
    })()
  `);
  console.log('  ', JSON.stringify(ep));
  t('接口地址下面显示了「实际请求：…」', ep.has === true, ep.text);
  t('显示出来的地址里 /images/generations 只出现一次',
    ((ep.text || '').match(/\/images\/generations/g) || []).length === 1, ep.text);

  console.log('\n=== 三、填参数 + 密钥，保存（验 preload 不丢字段） ===');
  CALLS.length = 0;
  await type('img-base', 'https://ark.cn-beijing.volces.com/api/v3');
  await type('img-model', 'doubao-seedream-4-0-250828');
  await type('img-size', '1024x1536');
  await type('img-key', 'sk-test-123');
  await sleep(300);
  console.log('  点保存:', await click('img-save'));
  await sleep(900);

  const saveCall = CALLS.find((c) => c.ch === 'image:save');
  console.log('  image:save 收到:', JSON.stringify(saveCall && saveCall.payload));
  t('地址活着到了主进程', !!saveCall && saveCall.payload.base === 'https://ark.cn-beijing.volces.com/api/v3');
  t('模型活着到了主进程', !!saveCall && saveCall.payload.model === 'doubao-seedream-4-0-250828');
  t('尺寸活着到了主进程', !!saveCall && saveCall.payload.size === '1024x1536');

  const keyCall = CALLS.find((c) => c.ch === 'image:setKey');
  t('密钥走的是 image:setKey', !!keyCall && keyCall.payload.key === 'sk-test-123');
  t('密钥**没有**混进 image:save（不该进 config）',
    !!saveCall && saveCall.payload.key === undefined,
    JSON.stringify(saveCall && Object.keys(saveCall.payload)));

  s = await state();
  t('密钥框保存后清空（不回显）', s.key === '', String(s.key));

  console.log('\n=== 四、「试一下」真的发请求并显示图 ===');
  CALLS.length = 0;
  console.log('  点试画:', await click('img-try'));
  await sleep(1200);
  const tryCall = CALLS.find((c) => c.ch === 'image:try');
  t('调了 image:try', !!tryCall);
  s = await state();
  t('图上屏了（<img data-testid="img-tried"> 出现）', s.tried === true);
  await shot('i1-生图配置');

  console.log('\n=== 五、尺寸写错：要报错，而且**不能落盘** ===');
  CALLS.length = 0;
  const beforeSize = IMG.size;
  await type('img-size', '1024x');
  await sleep(200);
  await click('img-save');
  await sleep(900);
  const bodyText = await js("document.querySelector('[data-testid=\"settings-body\"]').innerText");
  t('主进程的报错显示到界面上了（不是静默失败）',
    bodyText.indexOf('尺寸要写成') >= 0,
    bodyText.indexOf('尺寸要写成') >= 0 ? '' : '(界面上没找到这句)');
  t('非法尺寸没有落盘（配置里还是原来的值）',
    IMG.size === beforeSize, `before=${beforeSize} after=${IMG.size}`);
  /**
   * ⚠ 这里**故意**要求输入框保留用户敲的坏值：
   *   保存失败时把输入框冲回旧值，用户就得重新敲一遍「他刚才想改成多少」。
   *   所以正确的语义是：**配置干净，输入框保留**，旁边挂着红字告诉哪错了。
   *   （第一版判据写成了"输入框也得是原值"，那是把 bug 当成 spec。）
   */
  t('输入框保留用户敲的值（方便他改），只有配置是干净的',
    (await js("document.querySelector('[data-testid=\"img-size\"]').value")) === '1024x',
    String(await js("document.querySelector('[data-testid=\"img-size\"]').value")));

  /**
   * ---------------------------------------------------------------
   * 六、字体列表（2026-11-02 移除「霞鹜文楷」）
   * ---------------------------------------------------------------
   */
  console.log('\n=== 六、字体列表：下架的那款不能还在，配置也不能"一个勾都没有" ===');
  console.log('  点「外观」:', await clickCat('外观'));
  await sleep(700);


  const fp = await js(`
    (() => {
      /**
       * ⚠ 页面上有**两个**字体选择器（编辑器字体、聊天字体），
       *   直接扫全页 button 会把两处混在一起 —— 第一版就是这么误判的
       *   （"两处各有一个勾"加起来等于 2，看着像"重复打勾"）。
       *   所以先按区块标题定位，只在「编辑器字体」这一块里数。
       */
      var labelEl = [].slice.call(document.querySelectorAll('div')).find(function (d) {
        return (d.textContent || '').trim() === '编辑器字体';
      });
      if (!labelEl) return { noBlock: true };
      var box = labelEl.parentElement;
      var btns = [].slice.call(box.querySelectorAll('button'));
      // 每行的标题 = 该 button 里第一个 span 的文字（「删除」那种按钮没有 span）
      var titles = btns.map(function (b) {
        var sp = b.querySelector('span');
        return sp ? (sp.textContent || '').trim() : '';
      }).filter(Boolean);
      var marked = btns.filter(function (b) { return (b.textContent || '').indexOf('✓') >= 0; });
      return {
        titles: titles,
        hasPlainLgwk: titles.indexOf('霞鹜文楷') >= 0,
        hasGb: titles.indexOf('霞鹜文楷 GB') >= 0,
        marked: marked.length,
        markedTitle: marked.length ? (marked[0].querySelector('span') || {}).textContent : '',
      };
    })()
  `);
  console.log('   行标题:', JSON.stringify(fp.titles));
  t('「霞鹜文楷」这一行没了', fp.hasPlainLgwk === false);
  t('「霞鹜文楷 GB」还在（只是删了原版那一个）', fp.hasGb === true);
  /**
   * ⚠ 这条才是真判据：`editorFont` 指向已下架的字体族时，
   *   选择器必须**回落到系统默认并显示勾**。否则界面上所有行都没有勾，
   *   用户看到的是"我选的字体凭空丢了"——比回退本身更让人慌。
   */
  t('配置指向已下架字体时，系统默认被标为选中（不是零勾）',
    // ⚠ 系统默认那行的第一个 span 是**外层容器**，文字是「系统默认 + 副标题」拼起来的，
    //   所以只能 startsWith，不能 === （这里也栽过一次）。
    String(fp.markedTitle || '').trim().indexOf('系统默认') === 0,
    JSON.stringify({ marked: fp.marked, markedTitle: fp.markedTitle }));
  t('该块内只有一个选中项（不会多处打勾）', fp.marked === 1, `marked=${fp.marked}`);
  await shot('i2-字体列表');

  // ---------------------------------------------------------------- 七、称呼
  console.log('\n=== 七、拾墨怎么称呼你（称谓校验） ===');
  console.log('  点「作者」:', await clickCat('作者'));
  await sleep(600);
  const hasField = await js(`!!document.querySelector('[data-testid="user-title"]')`);
  t('「称呼」输入框在设置里', hasField === true);

  /**
   * ⚠ 这一节验的不是"规则对不对"（那是 test-honorific.js 的 47 条），
   *   而是**界面有没有把主进程的拒绝说出来**。
   *   原来的 save() 没有 catch：主进程抛错时界面一片安静，
   *   用户以为存上了 —— 这类"静默失败"比校验缺失更伤。
   */
  /**
   * 触发 onBlur。
   *
   * ⚠⚠ 试过两种都不行：
   *   · 直接调元素的 blur 方法 —— 元素本来就没有焦点，**不会派发**事件；
   *   · 先 focus 再 blur —— 窗口是 showInactive，focus 不生效，还是没事件。
   *   React 17+ 的 onBlur 实际是挂在根节点上的 **focusout**，
   *   所以直接派发一个冒泡的 focusout 才是对的。
   */
  const blurTitle = () => js(`(() => {
    var el = document.querySelector('[data-testid="user-title"]');
    if (!el) return 'not-found';
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return 'ok';
  })()`);

  await shot('i3-称呼设置');

  console.log('  填「干爹」:', await type('user-title', '干爹'));
  await blurTitle();
  await sleep(600);
  const errText = await js(
    `(document.querySelector('[data-testid="settings-save-error"]') || {}).textContent || ''`,
  );
  t('非法称谓被拒绝，且原因显示在界面上', /称谓不能用|亲属/.test(errText), errText.trim());
  t('被拒绝时配置没被写脏', CFG.userTitle !== '干爹', String(CFG.userTitle));
  t('输入框保留他打的字（方便改，不是偷偷清空）',
    (await js(`document.querySelector('[data-testid="user-title"]').value`)) === '干爹');

  console.log('  填「卷主」:', await type('user-title', '卷主'));
  await blurTitle();
  await sleep(600);
  t('合法称谓保存成功', CFG.userTitle === '卷主', String(CFG.userTitle));
  t('保存成功后错误提示消失', (await js(
    `!!document.querySelector('[data-testid="settings-save-error"]')`,
  )) === false);

  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
  if (bad.length) bad.forEach((b) => console.log('  ✗', b.name));
  clearTimeout(watchdog);
  win.destroy();
  app.exit(bad.length ? 1 : 0);
});
