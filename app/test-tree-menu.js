/**
 * 文件树：折叠 / 新建入口 / 菜单（2026-10-16 羽毛菌报的三条）。
 *
 *   ① 「章节文件夹左键单击后无法合并，但是设定文件夹却可以」
 *   ② 「新建文件只会添加在章节文件夹下面，所以底下那个新建按钮取消掉」
 *   ③ 「改成右键单击文件夹后弹出菜单新建文件」「单击目录卡片里剩余空白的地方则弹出这个菜单」
 *
 * ⚠ 为什么必须真点：
 *   ① 的根因是「树每次刷新就把展开状态整个覆盖」——
 *      源码看着完全正常（`toggle` 就是翻转一个 Set），
 *      只有**点一下、再触发一次刷新**才看得见它被推翻。
 *      所以判据里必须**手动触发一次刷新**再断言，不然复现不了。
 *
 * 运行：.\electron-run.cmd test-tree-menu.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tree-'));
app.setPath('userData', TMP);

require(path.join(__dirname, 'electron', 'main.js'));

let passed = 0; const failures = []; const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n    ' + e.message); }
  })());
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  }
  win.showInactive();
  win.setBackgroundThrottling(false);
  await new Promise((r) => setTimeout(r, 2500));
  const j = (c) => win.webContents.executeJavaScript(c);

  // 建项目 + 选中它 + reload（界面只认 config.currentProject）
  await j(`(async () => {
    const l = await window.api.project.list();
    if (!l || !l.length) await window.api.project.create({ id: 'p-tree', name: '树验证' });
    await window.api.config.set({ currentProject: 'p-tree' });
  })()`).catch(() => {});
  win.webContents.reload();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const ready = await j(`document.querySelectorAll('[data-tree-row]').length > 0`).catch(() => false);
    if (ready) break;
  }
  await new Promise((r) => setTimeout(r, 800));

  /** 界面上现在能看到几行、都有谁 */
  const rows = () => j(`[...document.querySelectorAll('[data-tree-row]')].map((r) => r.textContent.trim())`);
  /** 按名字点一行（左键） */
  const clickRow = (name) => j(`(() => {
    const r = [...document.querySelectorAll('[data-tree-row]')].find((x) => x.textContent.includes(${JSON.stringify(name)}));
    if (!r) return false;
    r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  const menuInfo = () => j(`(() => {
    const m = document.querySelector('[data-testid="tree-menu"]');
    if (!m) return { open: false };
    return { open: true, items: [...m.querySelectorAll('button')].map((b) => b.textContent.trim()) };
  })()`);

  /**
   * 截图（人看的那一份）。
   * ⚠ rect 用 **CSS px**（capturePage 不收 dpr 换算过的坐标）。
   * ⚠ `anchor: 'bottom'` —— 菜单是**跟着点击位置**弹的：
   *   点空白处时菜单在栏的底部，按"从顶部往下 460px"取景会把它整个截在画面外
   *   （第一版就是这样，截图里菜单"不见了"，而 DOM 里明明是开着的）。
   */
  const OUT = path.join(__dirname, 'shots');
  fs.mkdirSync(OUT, { recursive: true });
  async function grab(name, opt = {}) {
    const left = opt.left || 0;
    const width = opt.width || 560;
    const height = opt.height || 460;
    const box = await j(`(() => {
      const pane = document.querySelector('section[data-pane="files"]').getBoundingClientRect();
      const x = Math.max(0, Math.round(pane.x - ${left}));
      const y = ${opt.anchor === 'bottom'
        ? `Math.max(0, Math.round(pane.bottom - ${height} - 8))`
        : `Math.max(0, Math.round(pane.y + ${opt.top || 0}))`};
      return {
        x, y,
        width: Math.min(window.innerWidth - x - 4, ${width}),
        height: Math.min(window.innerHeight - y - 4, ${height}),
      };
    })()`);
    for (let i = 0; i < 3; i++) {
      try {
        /**
         * ⚠⚠ 先抓一帧**丢掉**再抓要的那一帧。
         *   本机实测：菜单刚弹出来 300ms 时直接抓，回来的还是**上一帧**
         *   （截图里菜单根本不在，而 DOM 查出来是开着的）。
         *   `capturePage` 会返回旧帧 —— 这是老毛病了，
         *   多抓一次等于强制合成器出一帧新的。
         */
        await win.webContents.capturePage();
        await new Promise((r) => setTimeout(r, 260));
        const img = await win.webContents.capturePage(box);
        fs.writeFileSync(path.join(OUT, name), img.toPNG());
        console.log('  → shots/' + name);
        return;
      } catch (_) { await new Promise((r) => setTimeout(r, 400)); }
    }
    console.log('  ⚠ 截图失败（UnknownVizError），跳过 shots/' + name);
  }

  /**
   * ⚠ 模板里 `章节/` 和 `卷纲/` **是空目录**（羽毛菌的要求：没写的东西不替他写），
   *   所以"折叠之后里面的文件不见了"根本没东西可看 ——
   *   第一版判据就在这里假红（断言 `第一章.md` 存在，而它压根没建过）。
   *   先往 章节 里放两个文件，折叠/展开才有可观察的差别。
   */
  await j(`(async () => {
    await window.api.fs.write({ projectId: 'p-tree', path: '章节/第一章.md', content: '# 第一章' });
    await window.api.fs.write({ projectId: 'p-tree', path: '章节/第二章.md', content: '# 第二章' });
  })()`).catch((e) => console.log('  造文件失败：' + e.message));
  await j(`document.querySelector('[aria-label="重新扫描文件夹"]').click()`);
  await new Promise((r) => setTimeout(r, 1600));

  console.log('\n一、左键点文件夹能折叠，而且**刷新之后还是收着的**');
  const before = await rows();
  console.log('  初始行：' + JSON.stringify(before));
  check('★ 初始把所有目录展开（看到里面的文件）', () => {
    assert(before.some((t) => t.includes('设定')), '没有 设定');
    assert(before.some((t) => t.includes('章节')), '没有 章节');
    assert(before.some((t) => t.includes('世界观.md')), '设定 没展开');
    assert(before.some((t) => t.includes('第一章.md')), '章节 没展开');
  });

  await clickRow('章节');
  await new Promise((r) => setTimeout(r, 350));
  const afterClick = await rows();
  console.log('  点一下 章节 之后：' + JSON.stringify(afterClick));
  check('★★ 点一下就收起来了（这一条当时是红的）', () => {
    assert(!afterClick.some((t) => t.includes('第一章.md')),
      `点「章节」之后里面的文件还在：${JSON.stringify(afterClick)}`);
    assert(afterClick.some((t) => t.includes('世界观.md')), '别的文件夹不该受影响');
  });

  // ⚠ 关键一步：刷新一次树 —— 旧代码在这里把展开状态整个覆盖回"全展开"
  await j(`document.querySelector('[aria-label="重新扫描文件夹"]').click()`);
  await new Promise((r) => setTimeout(r, 1500));
  const afterRefresh = await rows();
  console.log('  刷新一次之后：' + JSON.stringify(afterRefresh));
  check('★★ 刷新之后仍然是收着的（根因：每次刷新把展开状态覆盖成全展开）', () => {
    assert(!afterRefresh.some((t) => t.includes('第一章.md')),
      `刷新把 章节 又展开了：${JSON.stringify(afterRefresh)}`);
  });

  await clickRow('章节');
  await new Promise((r) => setTimeout(r, 350));
  const reopened = await rows();
  check('★ 再点一下能重新展开', () => {
    assert(reopened.some((t) => t.includes('第一章.md')), `没展开：${JSON.stringify(reopened)}`);
  });

  await grab('tree-collapsed.png', { left: 210, width: 560, height: 420 });

  console.log('\n二、底下那个「＋ 新建」按钮没了');
  const footer = await j(`(() => {
    const pane = document.querySelector('section[data-pane="files"]');
    return {
      hasNewBtn: [...pane.querySelectorAll('button')].some((b) => /新建/.test(b.textContent || '')),
      text: (pane.innerText.match(/\\d+ 个文件/) || [''])[0],
    };
  })()`);
  console.log('  ' + JSON.stringify(footer));
  check('★ 树里再没有「新建」按钮（新建入口只留在菜单里）', () => {
    assert(!footer.hasNewBtn, '还有按钮写着「新建」');
    assert(footer.text, '顺带把"N 个文件"也删了 —— 那是要留的');
  });

  console.log('\n三、右键文件夹 → 菜单（新建文件 / 新建文件夹 / 重命名 / 移至回收站）');
  await j(`(() => {
    const r = [...document.querySelectorAll('[data-tree-row]')].find((x) => x.textContent.includes('设定'));
    const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.x + 40, clientY: b.y + 8 }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const folderMenu = await menuInfo();
  console.log('  ' + JSON.stringify(folderMenu));
  check('★★ 右键文件夹弹出的菜单里第一项就是「新建文件」', () => {
    assert(folderMenu.open, '菜单没弹出来');
    assert(folderMenu.items[0] === '新建文件', `第一项是「${folderMenu.items[0]}」`);
    assert(folderMenu.items.includes('新建文件夹'), `没有「新建文件夹」：${JSON.stringify(folderMenu.items)}`);
    assert(folderMenu.items.includes('重命名') && folderMenu.items.includes('移至回收站'),
      `文件夹该有改名和回收站：${JSON.stringify(folderMenu.items)}`);
  });

  await grab('tree-menu-folder.png', { left: 210, width: 560, height: 420 });

  console.log('\n四、**右键**点空白 → 同一个菜单（但不能改名/删根）');
  // ⚠ 关菜单要发 pointerdown —— 产品监听的是 pointerdown（见 FileTree「点菜单外关闭」）。
  //   发 mousedown 关不掉，后面那条"左键不该弹菜单"会读到上一个残留菜单而假红。
  await j(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));

  /**
   * ⚠⚠ 反向用例先做：**左键点空白不该弹菜单**。
   *
   * 2026-10-16 我第一版接的是 `onClick`，羽毛菌当场纠正：
   *   「不是左键单击，是右键，我左键单击就弹出了，右键没反应」。
   *   ⚠ 只验"右键能弹"是不够的 —— 那样把左键也接上照样全绿，
   *     而这正是他明确否掉的东西。
   */
  const blankPoint = await j(`(() => {
    const box = document.querySelector('[data-testid="tree-scroll"]');
    const b = box.getBoundingClientRect();
    return { x: Math.round(b.x + 60), y: Math.round(b.bottom - 6) };
  })()`);
  console.log('  左键前菜单：' + JSON.stringify(await menuInfo()));
  await j(`(() => {
    const box = document.querySelector('[data-testid="tree-scroll"]');
    box.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${blankPoint.x}, clientY: ${blankPoint.y} }));
  })()`);
  console.log('  左键点下去**立刻**：' + JSON.stringify(await menuInfo()));
  await new Promise((r) => setTimeout(r, 300));
  const afterLeft = await menuInfo();
  console.log('  左键 300ms 后：' + JSON.stringify(afterLeft));
  check('★★ 左键点空白**不**弹菜单（菜单归右键）', () => {
    assert(!afterLeft.open, '左键点空白也弹了菜单 —— 羽毛菌明确说不要这样');
  });

  await j(`(() => {
    const box = document.querySelector('[data-testid="tree-scroll"]');
    box.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ${blankPoint.x}, clientY: ${blankPoint.y} }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const blankMenu = await menuInfo();
  console.log('  ' + JSON.stringify(blankMenu));
  check('★★ 右键点空白弹菜单，且只有"新建"两项（根目录不能改名/删除）', () => {
    assert(blankMenu.open, '右键点空白没有弹菜单');
    assert(blankMenu.items[0] === '新建文件' && blankMenu.items.includes('新建文件夹'),
      `菜单项不对：${JSON.stringify(blankMenu.items)}`);
    assert(!blankMenu.items.includes('重命名'), '根目录不该有「重命名」');
    assert(!blankMenu.items.includes('移至回收站'), '根目录不该有「移至回收站」');
  });

  await grab('tree-menu-blank.png', { left: 210, width: 560, height: 320, anchor: 'bottom' });

  console.log('\n四·五、树的顶层不该有散落的文件（"项目根目录"那个标签已经删了）');
  /**
   * ⚠⚠ 2026-10-16 羽毛菌：「这三个文件为什么是项目根目录，这些文件应该是放在
   *   章节文件夹下面的啊……你单独弄个项目根目录什么意思，做出来个半成品」。
   *
   *   我上一轮的处理是**加个"项目根目录"标签**去解释它 —— 方向错了：
   *   他要的是文件待在正确的文件夹里，不是给"文件没地方放"这件事起个名字。
   *   现在的规矩（`project-fs.js`）：**根目录不放任何内容文件**，
   *   `章节摘要.md` 也归到 `章节/` 里。
   *
   *   判据就钉这一条：**树的顶层只许有文件夹**。
   *   （散落的文件 = 又出现"这文件归谁"的歧义，而且它永远排在最后一个文件夹后面。）
   */
  const tops = await j(`(() => {
    const box = document.querySelector('[data-testid="tree-scroll"]');
    return [...box.children].map((w) => {
      const row = w.querySelector('[data-tree-row]');
      if (!row) return null;
      return { kind: row.textContent.includes('📁') ? 'dir' : 'file', text: row.textContent.trim() };
    }).filter(Boolean);
  })()`);
  console.log('  顶层：' + JSON.stringify(tops));
  check('★★ 树的顶层只有文件夹，没有散落的文件', () => {
    const loose = tops.filter((x) => x.kind === 'file');
    assert(loose.length === 0,
      `顶层出现了散落文件：${loose.map((x) => x.text).join('、')}`
      + ' —— 它们会排在最后一个文件夹后面、被当成那个文件夹的孩子');
    assert(tops.some((x) => x.text.includes('设定')), '连文件夹都没了？');
  });
  check('★★ 章节摘要.md 在 章节/ 里（不在根）', async () => {
    const where = await j(`(async () => {
      const t = await window.api.fs.tree({ projectId: 'p-tree' });
      const chap = (t.children || []).find((c) => c.name === '章节');
      return {
        inChap: !!chap && (chap.children || []).some((k) => k.name === '章节摘要.md'),
        atRoot: (t.children || []).some((c) => c.name === '章节摘要.md'),
      };
    })()`);
    assert(where.inChap, '章节/ 里没有章节摘要.md');
    assert(!where.atRoot, '章节摘要.md 又回到根目录了');
  });
  /** 树里所有行 + 「（空）」标记，按 DOM 顺序 —— 用来验"层级说清楚了没有" */
  const order = await j(`(() => {
    const out = [];
    document.querySelectorAll('[data-testid="tree-empty"], [data-tree-row]').forEach((el) => {
      out.push(el.getAttribute('data-testid') === 'tree-empty' ? '（空）' : el.textContent.trim());
    });
    return out;
  })()`);
  console.log('  行顺序：' + JSON.stringify(order));
  check('★ 展开的空文件夹里写着「（空）」（折叠它本来就不会有变化）', () => {
    assert(order.includes('（空）'), `树里没有「（空）」标记：${JSON.stringify(order)}`);
    const at = order.indexOf('（空）');
    assert(/📁/.test(order[at - 1] || ''), `「（空）」前面不是文件夹：${order[at - 1]}`);
  });

  console.log('\n五、从菜单新建文件：落在**点的那一层**');
  // 先用菜单在"设定"里建一个
  // ⚠ 关菜单要发 pointerdown —— 产品监听的是 pointerdown（见 FileTree「点菜单外关闭」）。
  //   发 mousedown 关不掉，后面那条"左键不该弹菜单"会读到上一个残留菜单而假红。
  await j(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  await j(`(() => {
    const r = [...document.querySelectorAll('[data-tree-row]')].find((x) => x.textContent.includes('设定'));
    const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.x + 40, clientY: b.y + 8 }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await j(`(() => {
    const m = document.querySelector('[data-testid="tree-menu"]');
    const b = [...m.querySelectorAll('button')].find((x) => x.textContent.trim() === '新建文件');
    b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const dlg = await j(`(() => {
    const i = document.querySelector('.fixed.inset-0.z-50 input');
    return { open: !!i, placeholder: i ? i.placeholder : '' };
  })()`);
  check('★ 菜单点「新建文件」会弹命名框', () => assert(dlg.open, '没弹输入框'));
  // 输入名字并提交
  await j(`(() => {
    const i = document.querySelector('.fixed.inset-0.z-50 input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(i, '甲测试');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 1800));
  const tree1 = await j(`window.api.fs.tree({ projectId: 'p-tree' })`)
    .then((t) => (t.children || []).map((n) => ({ name: n.name, kids: (n.children || []).map((k) => k.name) })))
    .catch((e) => ({ err: String(e) }));
  console.log('  树：' + JSON.stringify(tree1));
  check('★★ 文件建在**右键点的那个文件夹**里（不是永远丢进 章节）', () => {
    const set = (tree1 || []).find((n) => n.name === '设定');
    assert(set, '没有 设定 目录');
    assert(set.kids.includes('甲测试.md'), `设定 里没有新文件：${JSON.stringify(set.kids)}`);
    const ch = (tree1 || []).find((n) => n.name === '章节');
    assert(!(ch.kids || []).includes('甲测试.md'),
      '文件跑进 章节 去了 —— 那正是羽毛菌报的"只会添加在章节文件夹下面"');
  });

  await Promise.all(pending);
  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `文件树：${passed} 通过 / ${failures.length} 失败` : `文件树：${passed} 通过`);
  setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
}).catch((e) => {
  console.error('脚本崩了：', e && e.message);
  setTimeout(() => app.exit(1), 300);
});
