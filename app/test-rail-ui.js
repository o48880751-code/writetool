/**
 * 左栏 UI 验收：标题行（对话列表 + ＋）、设置按钮的形状。
 *
 * 2026-10-16 羽毛菌提的三条，都属于"看着对不对"，没有 IPC 通道能验：
 *   ① 「这个新对话功能改成小按钮一个＋号，左边是对话列表四个字」
 *   ② 「设置上边的分割线也去掉，把设置弄成一个带 R 角的矩形按钮，位置不变」
 *
 * ⚠ 所以这一条必须**真点**：造项目 → 点 ＋ → 输入框出现 → 打字 → 回车 →
 *   对话真的建出来了。光"源码里有 onNewProject"不算数。
 *
 * 运行：.\electron-run.cmd test-rail-ui.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rail-'));
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
  const j = (code) => win.webContents.executeJavaScript(code);

  /**
   * ⚠ 这里为什么要**重建窗口**而不是直接建个项目：
   *   `project:create` 只写库，界面的 `projectId` 来自 `config.currentProject`
   *   （启动时读一次）。光建项目，界面上 `hasProject` 还是 false ——
   *   那个 ＋ 会走"先建项目"分支（data-testid 也跟着变），
   *   判据就会去点一个不存在的按钮，还以为是产品坏了。
   *   正解：建项目 + 写 currentProject + reload，让界面真的处在"有项目"的状态。
   */
  await j(`(async () => {
    const l = await window.api.project.list();
    if (!l || !l.length) await window.api.project.create({ id: 'p-rail', name: '界面验证' });
    await window.api.config.set({ currentProject: 'p-rail' });
  })()`).catch((e) => console.log('  准备项目失败：' + e.message));
  win.webContents.reload();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const ready = await j(`!!document.querySelector('[data-testid="btn-new-conv"]')`).catch(() => false);
    if (ready) break;
  }
  await new Promise((r) => setTimeout(r, 600));

  console.log('\n一、标题行：对话列表 + 一个 ＋');
  const head = await j(`(() => {
    const btn = document.querySelector('[data-testid="btn-new-conv"]');
    const aside = document.querySelector('section[data-pane="conversations"]');
    return {
      hasBtn: !!btn,
      btnText: btn ? (btn.textContent || '').trim() : '',
      btnTitle: btn ? btn.title : '',
      headText: aside ? (aside.innerText.split('\\n')[0] || '') : '',
      // ＋ 必须是**小按钮**：不能又变回通栏那条宽按钮
      btnW: btn ? Math.round(btn.getBoundingClientRect().width) : -1,
      railW: aside ? Math.round(aside.getBoundingClientRect().width) : -1,
    };
  })()`);
  console.log('  ' + JSON.stringify(head));

  check('★ 标题行写着「对话列表」', () => {
    assert(/对话列表/.test(head.headText), `第一行是「${head.headText}」`);
  });
  check('★ 新建入口是个**小** ＋，不是通栏大按钮', () => {
    assert(head.hasBtn, '找不到 ＋ 按钮');
    assert(head.btnW > 0 && head.btnW <= 36, `按钮宽 ${head.btnW}px —— 又变回通栏按钮了`);
    assert(head.btnW < head.railW * 0.4, `按钮宽 ${head.btnW} / 栏宽 ${head.railW}，占得太满`);
    assert(/新建对话/.test(head.btnTitle), `title 没说明它是干什么的：${head.btnTitle}`);
  });

  console.log('\n二、点 ＋ → 出现命名输入框 → 回车真的建出对话');
  const created = await j(`(async () => {
    const btn = document.querySelector('[data-testid="btn-new-conv"]');
    if (!btn) return { err: '没有 ＋ 按钮' };
    btn.click();
    await new Promise((r) => setTimeout(r, 350));
    const input = document.querySelector('section[data-pane="conversations"] input');
    if (!input) return { err: '点了 ＋ 没有出现输入框' };
    // ⚠ React 受控组件：必须走原生 setter + input 事件，直接改 value 它收不到
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '验证用对话');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const list = await window.api.conv.list({ projectId: 'p-rail' });
    return { titles: (list || []).map((c) => c.title), railText: document.querySelector('section[data-pane="conversations"]').innerText };
  })()`);
  console.log('  ' + JSON.stringify(created).slice(0, 200));

  check('★★ 回车之后对话真的建出来了，而且列表里看得见', () => {
    assert(!created.err, created.err);
    assert((created.titles || []).includes('验证用对话'),
      `库里没有这条对话：${JSON.stringify(created.titles)}`);
    assert(/验证用对话/.test(created.railText || ''), '库里有了，但列表里没显示出来');
  });

  console.log('\n三、设置按钮：圆角矩形、上面那条分割线没了');
  const set = await j(`(() => {
    const btn = document.querySelector('[data-testid="btn-settings"]');
    if (!btn) return { err: '找不到设置按钮' };
    const cs = getComputedStyle(btn);
    const box = btn.parentElement;
    const bs = getComputedStyle(box);
    const r = btn.getBoundingClientRect();
    return {
      radius: cs.borderRadius,
      bg: cs.backgroundColor,
      border: cs.borderTopWidth + ' ' + cs.borderTopColor,
      boxBorderTop: bs.borderTopWidth,
      boxBg: bs.backgroundColor,
      w: Math.round(r.width),
      parentW: Math.round(box.getBoundingClientRect().width),
    };
  })()`);
  console.log('  ' + JSON.stringify(set));

  check('★★ 设置是个带圆角、有底色的矩形按钮', () => {
    assert(!set.err, set.err);
    const rad = parseFloat(set.radius) || 0;
    assert(rad >= 4, `圆角只有 ${set.radius}（要"带 R 角的矩形"）`);
    // 底色不能是透明的 —— 透明的话它就又变回"一行文字"
    assert(!/rgba\(0, 0, 0, 0\)/.test(set.bg), `按钮没有底色：${set.bg}`);
    assert(parseFloat(set.border) > 0, `按钮没有描边：${set.border}`);
    // 位置不变：还是通栏那么宽
    assert(set.w >= set.parentW - 20, `按钮宽 ${set.w} / 容器 ${set.parentW}，没有保持通栏宽度`);
  });
  check('★★ 设置上方那条分割线没了', () => {
    assert(!set.err, set.err);
    const w = parseFloat(set.boxBorderTop) || 0;
    assert(w === 0, `底座还有 ${set.boxBorderTop} 的上边框 —— 那条线还在`);
    assert(/rgba\(0, 0, 0, 0\)/.test(set.boxBg),
      `底座还刷着底色 ${set.boxBg}（会把按钮淹掉）`);
  });

  await Promise.all(pending);
  console.log('\n----------------------------------------------------');
  console.log(failures.length ? `左栏界面：${passed} 通过 / ${failures.length} 失败` : `左栏界面：${passed} 通过`);
  setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
}).catch((e) => {
  console.error('脚本崩了：', e && e.message);
  setTimeout(() => app.exit(1), 300);
});
