/**
 * 截图：思考强度控件（聊天输入框里）+ 零项目时的头屏。
 *
 * ## 与前几个 shoot 脚本的差别：通道用**自动枚举**
 *
 * shoot-v / shoot-settings 是手工列 `h('xxx:yyy', ...)` 的。
 * 那样每加一个通道就要记得回来补一行，忘了的表现是
 * 界面上某块区域空白或"加载中…"——而截图看着"差不多"，
 * 很容易被当成正常。
 *
 * 这里改成从 preload.js 里把 `call('通道名')` 全抠出来，逐个注册兜底桩：
 * 新加的通道**自动**有桩，不会再漏。
 * 需要真数据的那几个再单独覆盖。
 *
 * 运行：
 *   electron shoot-think.js --mode=chat
 *   electron shoot-think.js --mode=noproj
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

const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=chat').split('=')[1];
const PID = 'shot-think';
const NO_PROJECT = MODE === 'noproj';

const { Store } = require(path.join(MODULES, 'db', 'store.js'));
const { ProjectFs } = require(path.join(APPDIR, 'electron', 'project-fs.js'));
const PRESETS = require(path.join(APPDIR, 'electron', 'provider-presets.js'));
const skillFormat = require(path.join(APPDIR, 'electron', 'skill-format.js'));

const APPDATA = process.env.APPDATA || os.tmpdir();
const PROJECTS_DIR = path.join(APPDATA, 'writetool', 'projects');

const db = new Store(path.join(os.tmpdir(), `shoot-think-${MODE}.db`));
const pfs = new ProjectFs(PROJECTS_DIR);
const { setSkillFormat } = require(path.join(MODULES, 'db', 'store.js'));
setSkillFormat(skillFormat);

if (!NO_PROJECT) {
  if (!db.getProject(PID)) db.createProject({ id: PID, name: '墨染仙途' });
  pfs.ensureProject(PID);
  db.upsertSetting({ id: `${PID}:character:夜枫`, projectId: PID, type: 'character', name: '夜枫', note: '处州青石村少年' });
  db.upsertSetting({ id: `${PID}:location:处州`, projectId: PID, type: 'location', name: '处州', note: '越国境内一州' });
  try { db.seedBuiltinSkills(() => null); } catch (_) { /* 截图不需要真技能 */ }

  // 造一条有内容的对话：截图要看的是"聊到一半时档位在哪"
  const conv = db.createConversation({ projectId: PID, title: '卷一开篇怎么写' });
  db.addMessage({ conversationId: conv.id, role: 'user', content: '夜枫第一次离开青石村，这个开篇怎么写才不落俗套？' });
  db.addMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: '先别急着让他"回头看一眼村子"。\n\n俗套的写法是：他站在村口回头，夕阳把影子拉长，心里默念"我一定会回来的"。\n\n换个切法——把「离开」这件事压到一个具体的、跟修行无关的动作上：\n\n> 他数着母亲塞给他的干粮，一共十一个饼。第十一个已经硬得咬不动了。\n\n读者不需要你告诉他这是离家，他自己会懂。',
  });
}

// ---- IPC 桩 ----
/**
 * ⚠ 注册前先 removeHandler。
 *
 * 下面"自动枚举注册兜底桩"和"真数据覆盖"会把同一个通道注册两次，
 * 而 Electron 对同一通道二次注册**直接抛错**：
 *   Attempted to register a second handler for 'config:get'
 * 症状是脚本在加载期就挂掉，什么截图都没有、也不会有别的提示。
 * （跟这一轮主进程里那个重复注册的 bug 是同一个坑。）
 */
const h = (ch, fn) => {
  ipcMain.removeHandler(ch);
  return ipcMain.handle(ch, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
};

/** 从 preload 里抠出全部通道名，先统统注册一个兜底桩 */
const preloadSrc = fs.readFileSync(path.join(APPDIR, 'electron', 'preload.js'), 'utf8');
const ALL_CHANNELS = [...new Set([...preloadSrc.matchAll(/call\('([^']+)'/g)].map((m) => m[1]))];

/** 兜底返回值：按通道名前缀给个合理形状，避免渲染期读到 undefined 崩掉 */
function fallbackFor(ch) {
  if (/_list$|_get$/.test(ch)) return [];
  if (ch === 'config:get') {
    return {
      model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
      temperature: 0.3, fontSize: 15, fontFamily: 'system-ui', theme: 'gold',
      notify: 'window', currentProject: null, thinkLevel: 'off',
      activeConnectionId: 'conn-1',
    };
  }
  return null;
}
for (const ch of ALL_CHANNELS) {
  const fb = fallbackFor(ch);
  h(ch, () => (typeof fb === 'function' ? fb() : fb));
}

// ---- 真数据覆盖 ----
let CFG = {
  model: 'qwen3:latest', ollamaBase: 'http://127.0.0.1:11434', numCtx: 8192,
  temperature: 0.3, fontSize: 15, fontFamily: 'system-ui', theme: 'gold',
  notify: 'window', currentProject: NO_PROJECT ? null : PID, thinkLevel: 'off',
  activeConnectionId: 'conn-1',
};
h('config:get', () => CFG);
h('config:set', (p) => { CFG = { ...CFG, ...p }; return CFG; });
h('app:version', () => ({ version: '1.0.0', full: 'v1.0.0' }));
h('project:list', () => (NO_PROJECT ? [] : db.listProjects()));
h('project:open', () => CFG);
h('project:create', (p) => { db.createProject(p); return { projects: db.listProjects(), createdFolder: true, dir: '' }; });
h('settings:list', () => (NO_PROJECT ? [] : db.loadSettings(PID)));
h('chapter:list', () => (NO_PROJECT ? [] : db.listChapters(PID)));
h('state:list', () => []);
h('thread:open', () => []);
h('skill:list', () => (NO_PROJECT ? [] : db.listSkills(PID)));
h('conv:list', () => (NO_PROJECT ? [] : db.listConversations(PID).map((c) => ({ ...c, messageCount: db.countMessages(c.id) }))));
h('conv:messages', (p) => (NO_PROJECT ? [] : db.listMessages(p.conversationId)));
h('conv:setThink', (p) => db.setConversationThinkLevel(p.conversationId, p.level));
h('fs:tree', (p) => (NO_PROJECT ? { name: '', type: 'dir', children: [] } : pfs.tree(p.projectId)));
h('trash:list', () => ({ stats: { count: 0 } }));
h('style:profile', () => ({ available: false, reason: '还没有已保存的章节' }));

/**
 * 服务商量表与连接。
 *
 * ⚠ 这两条就是这一轮 UI 改动的关键输入：
 *   caps.providers 决定档位有几档（Ollama 四档 / 百炼只有开关），
 *   connections 决定"当前是哪一条"。
 *   缺任何一条，输入框旁边的控件都不会渲染。
 */
h('provider:capabilities', () => ({ providers: PRESETS.PROVIDERS, customs: PRESETS.customs().map((c) => c.key) }));
h('provider:listConnections', () => [
  { id: 'conn-1', name: '本地 Ollama', protocol: 'ollama', providerKey: 'ollama', base: 'http://127.0.0.1:11434', model: 'qwen3:latest', needKey: false },
  { id: 'conn-2', name: '硅基流动', protocol: 'openai', providerKey: 'siliconflow', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B', needKey: true },
]);

console.log(`通道桩：${ALL_CHANNELS.length} 个（从 preload 自动枚举）｜模式：${MODE}`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1680, height: 1000, show: false,
    webPreferences: {
      preload: path.join(APPDIR, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  /** 渲染进程的报错要收集起来——它们就是"界面为什么是白的"的答案 */
  const rendererErrors = [];
  win.webContents.on('console-message', (...args) => {
    // Electron 44 的签名是 (event, MessageDetails)，旧版是分离参数，两种都兜
    const d = args[1];
    const m = d && typeof d === 'object' ? d.message : args[2];
    const lv = d && typeof d === 'object' ? d.level : args[1];
    if (!m) return;
    if (/gpu|GPU|Autofill|devtools|Download the React/i.test(m)) return;
    console.log('  [renderer]', m);
    if (lv === 'error' || lv === 3) rendererErrors.push(String(m));
  });

  await win.loadFile(path.join(APPDIR, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1600));

  /**
   * ⚠ 先做一次"活着吗"的检查，再截图。
   *
   * 这几张图的用途是**证明界面能跑**。如果渲染期抛错，
   * capturePage 照样会写出一张 PNG——上面是一片白或一段报错栈，
   * 而脚本以 0 退出、文件名看着一切正常。
   * 2026-10-13 就是这么抓到 App.jsx 里那句 `config.thinkLevel`
   * （首帧 config 还是 null → 整个 React 树挂不上 → 全白）。
   * 所以这里要主动断言，不能让"截到图了"冒充"界面没问题"。
   */
  const health = await win.webContents.executeJavaScript(`
    (() => {
      const root = document.getElementById('root');
      return {
        rootChildren: root ? root.children.length : 0,
        textarea: !!document.querySelector('textarea'),
        head: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
      };
    })()
  `);
  if (!health.rootChildren || !health.textarea) {
    console.log('❌ 聊天界面没渲染出来 —— 这次截图不能当证据');
    console.log('   root 子节点数:', health.rootChildren);
    console.log('   body 开头:', JSON.stringify(health.head));
    if (rendererErrors.length) console.log('   渲染进程报错:\n     ' + rendererErrors.join('\n     '));
    app.exit(1);
    return;
  }
  console.log('  界面已渲染（root 子节点 ' + health.rootChildren + '，输入框在）');
  if (!NO_PROJECT) {
    const md = await win.webContents.executeJavaScript(`
      (() => ({
        bubbles: document.querySelectorAll('.msg-user, .msg-ai').length,
        convTitle: (document.querySelector('.font-semibold') || {}).textContent || '',
        listCount: document.querySelectorAll('[data-testid], aside button').length,
      }))()
    `);
    console.log('  消息气泡数:', md.bubbles, '｜第 1 栏按钮数:', md.listCount);
    console.log('  库里最新对话的消息数:',
      db.countMessages(db.listConversations(PID)[0].id));
  }

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('  ✓', `${name}.png`);
  };
  /** 只截输入区那一块（工具栏在底部，整屏图里太小看不清） */
  const shotComposer = async (name) => {
    const box = await win.webContents.executeJavaScript(`
      (() => {
        const ta = document.querySelector('textarea');
        if (!ta) return null;
        const r = ta.closest('div[style*="border"]') || ta.parentElement;
        const b = r.getBoundingClientRect();
        return { x: Math.round(b.x) - 120, y: Math.round(b.y) - 8,
                 width: Math.round(b.width) + 150, height: Math.round(b.height) + 20 };
      })()
    `);
    const img = box
      ? await win.webContents.capturePage({ x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height })
      : await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('  ✓', `${name}.png`, box ? `（裁剪 ${box.width}×${box.height}）` : '（整屏）');
  };
  /** 点一个按钮（按文字找），返回点了几个 */
  const clickByText = (t) => win.webContents.executeJavaScript(`
    (() => {
      const bs = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === ${JSON.stringify(t)});
      bs.forEach(b => b.click());
      return bs.length;
    })()
  `);

  if (NO_PROJECT) {
    await shot('t1-零项目-头屏');
    const n = await clickByText('＋ 新建项目');
    console.log('  点「＋ 新建项目」命中', n, '个按钮');
    await new Promise((r) => setTimeout(r, 500));
    await shot('t2-零项目-点了新建项目');
    // 断言：弹窗开了，而且新建输入框已经展开
    const st = await win.webContents.executeJavaScript(`
      (() => {
        const dlg = document.querySelector('[role="dialog"][aria-label="切换小说项目"]');
        if (!dlg) return { dialog: false };
        const inp = [...dlg.querySelectorAll('input')].find(i => i.placeholder && i.placeholder.includes('给新小说'));
        return { dialog: true, inputVisible: !!inp, active: document.activeElement === inp };
      })()
    `);
    console.log('  弹窗状态:', JSON.stringify(st));
    console.log(st.dialog && st.inputVisible
      ? '  ✅ 弹窗打开且「新建」输入框直接展开（用户点一下就能打字）'
      : '  ❌ 弹窗没开或输入框没展开');
  } else {
    await shot('t1-聊天-档位默认');
    await shotComposer('t2-聊天-输入区特写');
    const nHigh = await clickByText('高');
    console.log('  点「高」命中', nHigh, '个按钮');
    await new Promise((r) => setTimeout(r, 300));
    await shotComposer('t3-聊天-档位切到高');
    const nOff = await clickByText('关闭');
    console.log('  点「关闭」命中', nOff, '个按钮');
    await new Promise((r) => setTimeout(r, 300));
    await shotComposer('t4-聊天-档位切到关闭');

    // 断言：控件真的在输入区里，且有四档；而且它与「发送」在同一行
    const st = await win.webContents.executeJavaScript(`
      (() => {
        const labels = ['关闭','低','中','高','开启'];
        const all = [...document.querySelectorAll('button')];
        const found = all.filter(b => labels.includes(b.textContent.trim()))
          .map(b => b.textContent.trim());
        const ta = document.querySelector('textarea');
        const sendBtn = all.find(b => b.textContent.trim() === '发送');
        const highBtn = all.find(b => b.textContent.trim() === '高');
        // ⚠ 判"同一行"要比**垂直中心**，不能比 top。
        //   这一行是 items-center，而「发送」比档位按钮高
        //   （py-1.5 vs py-[3px]），居中对齐时高的那个 top 更小 ——
        //   同一行也会量出 7px 的差。第一版就是这么误判的。
        //   （注释里不能出现反引号：整段是模板字符串，会提前结束。）
        const mid = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return Math.round(r.top + r.height / 2);
        };
        return {
          levels: found,
          hasTextarea: !!ta,
          midSend: mid(sendBtn),
          midThink: mid(highBtn),
          midTa: mid(ta),
        };
      })()
    `);
    /**
     * 「发送」与档位必须在同一行。
     *
     * ⚠ 这条是量出来的，不是看出来的。第 2 栏只有 ~350px 宽，
     *   四个档位每边多 2px 就把「发送」挤到第二行 ——
     *   而截图缩略图上那一行 1~2px 的位移根本看不出来。
     *   （px-2 时实测 369 > 可用 359，所以改成了 px-1.5。）
     */
    const sameRow = st.midSend !== null && st.midThink !== null
      && Math.abs(st.midSend - st.midThink) <= 3;
    console.log(`  布局：发送中心 y=${st.midSend}｜档位中心 y=${st.midThink}｜` +
      (sameRow ? '同一行 ✓' : '★ 掉了行 ✗'));
    console.log('  档位按钮:', JSON.stringify(st.levels));
    // 库里那条对话的档位（点「高」之后）
    const row = db.listConversations(PID)[0];
    console.log('  库里对话的 thinkLevel =', row && row.thinkLevel);

    const ok = st.levels.length === 4
      && st.levels.includes('关闭') && st.levels.includes('高')
      && nHigh > 0 && row && row.thinkLevel === 'off'   // 最后点的是「关闭」
      && sameRow;
    console.log(ok
      ? '  ✅ 四档都在输入框里、与发送同一行，点击能改档位并落库'
      : '  ❌ 档位控件不完整 / 点击没生效 / 与发送不在同一行');
    if (!ok) app.exit(1);
  }

  console.log('截图输出：' + OUT);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
