/**
 * 全新机器首次启动验证（2026-10-16 羽毛菌）：
 * 「轻薄本没用本地大模型，第一次点开软件也会显示已连接 Ollama 吗？」
 *
 * ⚠⚠ 必须实测，不能空口保证 —— main.js 里 providerConfig 的**兜底默认值**
 *   就是 Ollama 127.0.0.1:11434（兼容旧版用），如果"在用"状态默认指向它，
 *   全新机器首启就会显示"已连接 Ollama"——那正是用户说的低级错误。
 *
 * 判据（全新 userData 下）：
 * ① 连接列表为空（没有任何预置连接）
 * ② 没有"正在使用"的连接（activeId 为空）
 * ③ 界面上出现「现在没有在用任何连接」的引导文案，而不是「已连接」
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

// ⚠⚠ 关键：全新 userData —— 模拟轻薄本第一次装
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fresh-'));
app.setPath('userData', TMP);
console.log('全新 userData:', TMP);

// ⚠⚠ OLD_USER=1 时预写一份 config.json，模拟「1.0.x 老用户升级」——
//   修复不能只顾新用户：老用户升级后**必须**还能迁移出原来的连接，
//   否则他升级完发现连接凭空消失，比多一条默认连接严重得多。
if (process.env.OLD_USER === '1') {
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    engine: 'ollama',
    ollamaBase: 'http://127.0.0.1:11434',
    model: 'qwen3:latest',
  }), 'utf8');
  console.log('已预写老用户 config.json（模拟 1.0.x 升级）');
}

require(path.join(__dirname, 'electron', 'main.js'));

let passed = 0;
const failed = [];
function check(name, ok, extra) {
  if (typeof ok === 'function') {
    try { const r = ok(); ok = (r === undefined) ? true : !!r; }
    catch (e) { ok = false; extra = String((e && e.message) || e); }
  }
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80 && !win; i++) {
    await new Promise((r) => setTimeout(r, 250));
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  }
  if (!win) { console.log('没有窗口'); app.exit(1); return; }
  win.showInactive();
  await new Promise((r) => setTimeout(r, 3500));
  const j = (c) => win.webContents.executeJavaScript(c);

  // ① 数据层：连接列表与"在用"状态
  // ⚠⚠ 探针第一版调了不存在的 window.api.provider.list()/config()，
  //   得到 undefined 就判"列表有 undefined 条" —— 那是**探针的错**，不是产品的错。
  //   正确的通道是 provider.listConnections()；"在用"的 id 从界面状态拿不到
  //   就从 listConnections 的 inUse/active 字段拿（照 preload 抄形状，别猜）。
  const data = await j(`(async () => {
    const list = await window.api.provider.listConnections();
    const arr = Array.isArray(list) ? list : (list && list.connections) || [];
    const inUse = arr.find((c) => c.inUse || c.active || c.isCurrent);
    return { rawType: Array.isArray(list) ? 'array' : typeof list,
             count: arr.length, inUseId: inUse ? inUse.id : null,
             first: arr[0] ? JSON.stringify(arr[0]).slice(0, 160) : null };
  })()`).catch((e) => ({ err: String(e && e.message) }));
  console.log('  数据层：' + JSON.stringify(data));

  check('① 连接列表符合预期', () => {
    if (process.env.OLD_USER === '1') {
      // 老用户升级：迁移**必须**发生，原来的连接不能凭空消失
      assert(data && data.count === 1,
        '老用户配置应该迁出 1 条连接，实际 ' + (data && data.count) + ' 条：'
        + JSON.stringify(data && data.first));
      assert(data && data.first && data.first.indexOf('conn-migrated') >= 0,
        '迁移出来的不是 conn-migrated：' + JSON.stringify(data && data.first));
      return;
    }
    assert(data && data.count === 0,
      '连接列表有 ' + (data && data.count) + ' 条：'
      + JSON.stringify(data && data.first) + ' —— 首启不该预置任何连接');
  });
  check('② 没有"正在使用"的连接', () => {
    assert(data && !data.inUseId,
      '有在用连接：' + JSON.stringify(data && data.inUseId) + '，首启不该有');
  });

  // ② 界面层：可靠地打开设置页并切到「AI 提供商」
  // ⚠ 第一版用 textContent 猜按钮 —— 没点中，界面根本没离开聊天区，
  //   然后把主界面上别的"已连接"字样当成了证据。**导航失败 = 后面全白量。**
  await j(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /设置/.test(x.textContent || ''));
    if (b) b.click();
    return true;
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  await j(`(() => {
    // 设置页左侧类目：按 label 精确匹配「AI 提供商」
    const b = [...document.querySelectorAll('button')]
      .find((x) => (x.textContent || '').trim().endsWith('AI 提供商'));
    if (b) b.click();
    return true;
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1300));

  const ui = await j(`(() => {
    // ⚠ 只在设置页正文里找，别拿整个 body —— 主界面的状态文字会串进来
    const scope = document.querySelector('[data-testid="settings-body"]');
    const t = ((scope ? scope.innerText : '') || '');
    const onProvider = t.indexOf('AI 提供商') >= 0 || t.indexOf('新建连接') >= 0;
    return {
      reached: onProvider,
      hasEmptyGuide: t.indexOf('没有在用任何连接') >= 0,
      hasConnectedBadge: /已连接\\s*·/.test(t),
      head: t.slice(0, 150).replace(/\\s+/g, ' '),
    };
  })()`).catch((e) => ({ err: String(e && e.message) }));
  console.log('  界面层：' + JSON.stringify(ui));

  check('③ 探针真的到了「AI 提供商」页（导航失败则后面全不作数）', () => {
    assert(ui && ui.reached, '没进到 AI 提供商页：' + JSON.stringify(ui && ui.head));
  });
  // ⚠⚠ ④⑤ 按场景断言：两个场景的"正确界面"正好相反。
  //   全新安装 → 空状态引导（选连接方式）；老用户升级 → 迁移出的连接卡片。
  //   上一版把场景A的断言原样套在场景B上，老用户界面正确却报红。
  if (process.env.OLD_USER === '1') {
    check('④ 老用户升级：界面显示迁移出的连接（不是空状态）', () => {
      assert(ui && !ui.hasEmptyGuide && /Ollama/.test(ui.head || ''),
        '老用户升级后没看到迁移出的连接：' + JSON.stringify(ui && ui.head));
    });
    check('⑤ 老用户升级：探测徽章如实显示（本机 Ollama 在跑则为已连接）', () => {
      assert(ui && ui.hasConnectedBadge === true,
        '连接卡片在但探测徽章没显示：' + JSON.stringify(ui && ui.head));
    });
  } else {
    check('④ 首启界面显示空状态引导（选连接方式）', () => {
      // ⚠ 断言空态要看**实际文案**：「还没有连接。点下面「新建连接」加一条」。
      //   我第一版找的是「没有在用任何连接」——那是切连接列表的空态文案，
      //   不是这一处的，于是产品明明对了判据还红。
      //   （"别断言字面文案"的坑换了个形式又踩一次：这次是找错了句子。）
      assert(ui && (ui.hasEmptyGuide || /还没有连接/.test(ui.head || '')),
        'AI 提供商页没有空状态引导 —— 实际显示：' + JSON.stringify(ui && ui.head));
    });
    check('⑤ 首启界面没有「已连接 ·」徽章', () => {
      assert(ui && ui.hasConnectedBadge === false,
        '首启就显示「已连接」—— 这正是用户担心的低级错误');
    });
  }

  console.log(`\n全新首启验证：${passed} 通过${failed.length ? ' / ' + failed.length + ' 失败' : ''}`);
  for (const f of failed) console.log('  失败：' + f);
  setTimeout(() => app.exit(failed.length ? 1 : 0), 300);
}).catch((e) => { console.error('崩了：', e && e.message); app.exit(1); });