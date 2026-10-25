/**
 * IME（中文输入法）与流式写入的冲突验证 —— 真实浏览器（Chromium）。
 *
 * 为什么必须真实浏览器：happy-dom / jsdom 不实现输入法组合流程，
 * compositionstart / compositionupdate / compositionend 的时序无法在 Node 复现。
 * 而这是中文写作工具最常见的体验问题：用户正在打候选词时模型在写，会不会打断。
 *
 * 技术要点（实测踩出来的）：
 *   1. TipTap v3 是**纯 ESM**，且内部用 `@tiptap/pm/transform` 这类**包导入**，
 *      浏览器不认裸模块说明符 → 必须提供 import map把它映射到实际文件。
 *   2. esbuild 装不上（Node 22.22 引擎限制），rollup 太重。
 *      最小可行方案：起本地静态服务器 + import map，直接吃 node_modules 里的 ESM。
 *
 * 运行：node editor/test-ime-browser.js
 * 前置：npx playwright install chromium
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
};

/**
 * 读包的 exports 映射，生成 import map 用的 specifier→路径。
 *
 * 必须覆盖两类（实测踩坑）：
 *   1. `@tiptap/pm/*` —— TipTap 的聚合包，内部按包子路径导出
 *   2. `prosemirror-*` —— core 直接依赖裸包名（prosemirror-transform 等），
 *      不映射会报 "Failed to resolve module specifier"
 *
 * 不用 esbuild/rollup 打包：esbuild 在 Node 22.22 装不上（引擎限制），
 * rollup 太重。import map + 本地静态服务器是最小可行方案。
 */
function buildImportMap() {
  const imports = {};
  const nm = (p) => `/node_modules/${p}`;

  // 1) @tiptap/pm 的子路径导出
  const pmDir = path.join(ROOT, 'node_modules', '@tiptap', 'pm');
  const pkg = JSON.parse(fs.readFileSync(path.join(pmDir, 'package.json'), 'utf8'));
  for (const [sub, def] of Object.entries(pkg.exports || {})) {
    if (sub === './package.json') continue;
    const target = typeof def === 'string' ? def : def.import;
    if (!target) continue;
    imports[`@tiptap/pm/${sub.replace('./', '')}`] = nm('@tiptap/pm/' + target.replace('./dist/', 'dist/'));
  }
  // 自映射：某些工具会import '@tiptap/pm' 本身
  imports['@tiptap/pm'] = nm('@tiptap/pm/dist/index.js');

  // 2) 所有 prosemirror-* 裸包
  //注意：这些包的 exports 是**扁平字典** { import, require }，没有 '.' 键。
  // 若按标准子路径格式取 exports['.'] 会拿到整个对象再取 .import → 得到 undefined。
  for (const dir of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
    if (!dir.startsWith('prosemirror-')) continue;
    const pkgPath = path.join(ROOT, 'node_modules', dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pj = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let entry = pj.module;
    const ex = pj.exports;
    if (ex && typeof ex === 'object') {
      // 扁平：{ import, require }
      if (typeof ex.import === 'string') entry = ex.import;
      else {
        // 子路径：{ '.': {...}, './sub': {...} }
        const root = ex['.'];
        const cand = typeof root === 'string' ? root : root && (root.import || root.default || root.module);
        if (cand) entry = cand;
      }
    }
    if (!entry) entry = 'dist/index.js';
    imports[dir] = nm(dir + '/' + entry.replace(/^\.\//, ''));
  }

  // 3) 兜底：把所有可解析的顶层依赖都映射一遍。
  // 原因：@tiptap/core 的 ESM 产物里除了 prosemirror-* 还引用了 orderedmap /
  // rope-sequence / w3c-keyname 这些小包，逐个补容易漏，索性全量映射。
  for (const dir of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
    if (dir.startsWith('.')) continue;
    if (imports[dir]) continue;
    if (dir.startsWith('@')) {
      // scoped 包：映射其下的每个子包
      const scopeDir = path.join(ROOT, 'node_modules', dir);
      if (!fs.statSync(scopeDir).isDirectory()) continue;
      for (const sub of fs.readdirSync(scopeDir)) {
        const key = `${dir}/${sub}`;
        if (imports[key]) continue;
        const pj = path.join(scopeDir, sub, 'package.json');
        if (!fs.existsSync(pj)) continue;
        const e = resolveEntry(pj);
        if (e) imports[key] = nm(`${dir}/${sub}/${e}`);
      }
      continue;
    }
    const pj = path.join(ROOT, 'node_modules', dir, 'package.json');
    if (!fs.existsSync(pj)) continue;
    const e = resolveEntry(pj);
    if (e) imports[dir] = nm(`${dir}/${e}`);
  }

  // @tiptap/core 自身：页面里从 import map 引，避免硬编码路径与 map 打架
  const corePkgPath = path.join(ROOT, 'node_modules', '@tiptap', 'core', 'package.json');
  const corePkg = JSON.parse(fs.readFileSync(corePkgPath, 'utf8'));
  imports['@tiptap/core'] = nm('@tiptap/core/' + (corePkg.module || 'dist/index.js').replace(/^\.\//, ''));

  // 4) scoped 包的子路径导出（如 @tiptap/core/jsx-runtime）。
  //    逐个补子路径容易漏（实测漏了 jsx-runtime 导致模块解析失败），
  //    这里按各包 exports 里声明的子路径全量生成。
  for (const scope of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
    if (!scope.startsWith('@')) continue;
    const scopeDir = path.join(ROOT, 'node_modules', scope);
    if (!fs.statSync(scopeDir).isDirectory()) continue;
    for (const sub of fs.readdirSync(scopeDir)) {
      const pkgJsonPath = path.join(scopeDir, sub, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) continue;
      const pj = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const ex = pj.exports;
      if (!ex || typeof ex !== 'object' || Array.isArray(ex)) continue;
      for (const [key, def] of Object.entries(ex)) {
        if (key === './package.json') continue;
        if (typeof key !== 'string' || !key.startsWith('.')) continue;
        // 只处理非条件导出（直接是字符串或 {import,default}），
        // 条件导出（含 types/browser/node 嵌套）浏览器用不上，跳过避免误取 .d.ts
        let target = null;
        if (typeof def === 'string') target = def;
        else if (def && typeof def === 'object' && !Array.isArray(def)) {
          if (def.types && Object.keys(def).length === 1) continue; // 只有 types，跳过
          const cond = def.browser || def.import || def.default || def.module;
          if (typeof cond === 'string') target = cond;
        }
        if (!target) continue;
        const spec = `${scope}/${sub}${key.slice(1)}`;
        imports[spec] = nm(`${scope}/${sub}/${target.replace(/^\.\//, '')}`);
      }
    }
  }

  return imports;
}

/**
 * 解析一个包的浏览器 ESM 入口。
 * 注意两种 exports 形态都要处理：
 *   扁平 { import, require }  ← prosemirror-* 用这种
 *   子路径 { '.': {...} }      ← 标准形态
 */
function resolveEntry(pkgPath) {
  const pj = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const ex = pj.exports;
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    if (typeof ex.import === 'string') return ex.import.replace(/^\.\//, '');
    const root = ex['.'] ?? ex;
    const cand = typeof root === 'string' ? root : root && (root.import || root.default || root.module);
    if (cand) return cand.replace(/^\.\//, '');
  }
  if (pj.module) return String(pj.module).replace(/^\.\//, '');
  // 有些包只有 main且本身就是 ESM
  if (pj.main && /\.js$/.test(pj.main) && !pj.main.endsWith('.cjs')) {
    return String(pj.main).replace(/^\.\//, '');
  }
  return null;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, d) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(d);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '\n         · ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '\n         · ' + detail : ''}`); }
}

const HTML = (importMap) => `<!doctype html>
<html><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: importMap })}</script>
</head><body>
<div id="editor"></div>
<script type="module">
import { Editor } from '@tiptap/core';

// TipTap 的 schema 由扩展体系构建：必须用 Node/Extension 声明节点，
// 直接传Schema 给Editor 不会被采纳（会报 "Schema is missing its top node type"）。
import { Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const editor = new Editor({
  element: document.getElementById('editor'),
  content: '<p></p>',
  extensions: [StarterKit],
});
window.__editor = editor;
window.__ready = true;
</script>
</body></html>`;

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail) => {
    if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '\n         · ' + detail : ''}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail ? '\n         · ' + detail : ''}`); }
  };

  console.log('\nIME 与流式写入冲突验证（Chromium 真实浏览器）\n');

  const importMap = buildImportMap();
  const { server, port } = await startServer();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  const notFound = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('[console] ' + m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400) notFound.push(`${r.status()} ${r.url().slice(-60)}`); });

  const tmpHtml = path.join(ROOT, '__ime_test__.html');
  fs.writeFileSync(tmpHtml, HTML(importMap), 'utf8');
  await page.goto(`http://127.0.0.1:${port}/__ime_test__.html`);

  let ready = false;
  try {
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });
    ready = true;
  } catch (e) {
    console.log('  页面初始化失败：');
    if (notFound.length) { console.log('    404：'); notFound.forEach((x) => console.log('     ', x)); }
    pageErrors.forEach((x) => console.log('     ', x));
  }
  if (!ready) {
    await browser.close(); server.close(); fs.unlinkSync(tmpHtml);
    process.exitCode = 1;
    return;
  }
  console.log('  TipTap 实例已在真实浏览器中创建\n');

  // ------------------------------------------------------------
  console.log('一、核实 1：用户真实输入的事务带哪些 meta key');

  await page.evaluate(() => {
    const editor = window.__editor;
    window.__tx = [];
    editor.on('transaction', ({ transaction }) => {
      window.__tx.push({
        docChanged: transaction.docChanged,
        uiEvent: transaction.getMeta('uiEvent') ?? null,
        uiType: transaction.getMeta('uiEvent')?.type ?? null,
        uiInputType: transaction.getMeta('uiEvent')?.inputType ?? null,
      });
    });
    editor.view.dom.focus();
  });
  // 真实键盘，不用派发 InputEvent——实测两者的 meta 完全不同
  await page.keyboard.type('秋雨');
  await page.waitForTimeout(200);

  const metaProbe = await page.evaluate(() => ({
    seen: window.__tx,
    text: window.__editor.state.doc.textBetween(0, window.__editor.state.doc.content.size, '\n'),
  }));

  check('真实键盘输入确实进入文档', metaProbe.text.includes('秋雨'),
    `内容=${JSON.stringify(metaProbe.text)}，事务数=${metaProbe.seen.length}`);

  const withUi = metaProbe.seen.filter((t) => t.uiEvent !== null && t.uiEvent !== undefined);
  // 实测结论（2026-10-11，Chromium 156 + TipTap 3.31.4）：
  // 真实键盘输入产生的全部事务，meta **都是空的**——ProseMirror 的输入管线
  // 不给事务打 uiEvent 标记。因此原方案里
  //   transaction.getMeta('uiEvent') 判定用户编辑
  // 是错的，永远返回 undefined。
  // 这条断言记录事实而非期望：若将来某个版本开始提供 uiEvent，这里会失败并提示更新方案。
  check(
    '实测：真实输入事务不带 uiEvent meta（推翻原接入方案的假设）',
    withUi.length === 0,
    `带 uiEvent 的事务 ${withUi.length}/${metaProbe.seen.length}｜` +
    `type=${[...new Set(metaProbe.seen.map((t) => t.uiType).filter(Boolean))].join(',') || '无'}｜` +
    `inputType=${[...new Set(metaProbe.seen.map((t) => t.uiInputType).filter(Boolean))].join(',') || '无'}`
  );

  // ------------------------------------------------------------
  console.log('\n二、核实 2：程序写入是否产生 transaction');

  const programProbe = await page.evaluate(() => {
    const editor = window.__editor;
    let tx = 0;
    editor.on('transaction', () => { tx++; });
    editor.view.updateState(editor.state.apply(editor.state.tr.insertText('程序写入', 1)));
    return { txCount: tx, text: editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n') };
  });

  check('view.updateState 不产生 transaction（程序写入不会被误判为用户编辑）',
    programProbe.txCount === 0,
    `事务数=${programProbe.txCount}，内容=${JSON.stringify(programProbe.text)}`);

  // ------------------------------------------------------------
  console.log('\n三、核实 3：IME 组合输入期间插入模型文本');

  const ime = await page.evaluate(() => {
    const editor = window.__editor;
    editor.commands.setContent('<p></p>');
    const el = editor.view.dom;
    el.focus();
    const appendToEnd = (text) => {
      const pos = editor.state.doc.content.size - 1;
      editor.view.updateState(editor.state.apply(editor.state.tr.insertText(text, pos)));
    };

    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true, cancelable: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: 'ni', bubbles: true, cancelable: true }));

    appendToEnd('【模型】');
    const afterModel = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');

    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: '你好', bubbles: true, cancelable: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true, cancelable: true }));

    return { afterModel, final: editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n') };
  });

  check('组合输入进行中插入模型文本，模型文本保留',
    ime.afterModel.includes('【模型】'),
    `模型写入后：${JSON.stringify(ime.afterModel)}`);

  // ------------------------------------------------------------
  console.log('\n四、核实 4：真实流式节奏（模型追加 + 用户真实按键共存）');

  await page.evaluate(() => {
    const editor = window.__editor;
    editor.commands.setContent('<p></p>');
    editor.view.dom.focus();
    window.__appendToEnd = (text) => {
      const pos = editor.state.doc.content.size - 1;
      editor.view.updateState(editor.state.apply(editor.state.tr.insertText(text, pos)));
    };
  });

  await page.evaluate(() => window.__appendToEnd('模型第一段。'));
  await page.keyboard.type('【用户插队】');
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__appendToEnd('模型第二段。'));
  await page.waitForTimeout(150);

  const coexist = await page.evaluate(() => ({
    text: window.__editor.state.doc.textBetween(0, window.__editor.state.doc.content.size, '\n'),
  }));

  check('模型两段 + 用户真实按键全部保留',
    coexist.text.includes('模型第一段。') && coexist.text.includes('模型第二段。') && coexist.text.includes('【用户插队】'),
    `最终内容：${JSON.stringify(coexist.text)}`);

  const order = ['模型第一段。', '【用户插队】', '模型第二段。'];
  check('顺序为「模型一段 → 用户插队 → 模型二段」（追加语义正确）',
    order.every((s) => coexist.text.includes(s))
      && coexist.text.indexOf(order[0]) < coexist.text.indexOf(order[1])
      && coexist.text.indexOf(order[1]) < coexist.text.indexOf(order[2]),
    `实际：${JSON.stringify(coexist.text)}`);

  await browser.close();
  server.close();
  try { fs.unlinkSync(tmpHtml); } catch (e) { /* 清理失败不影响结论 */ }

  console.log(`\n${'-'.repeat(52)}`);
  console.log(`用例 ${passed + failed}　通过 ${passed}　失败 ${failed}`);
  if (failed === 0) {
    console.log('IME 与流式写入无致命冲突，可进入 UI 集成。');
  } else {
    console.log('存在失败项——UI 集成前必须先解决。');
    process.exitCode = 1;
  }
  console.log('\n边界说明：IME 部分用 CompositionEvent 模拟组合流程，未覆盖真实拼音候选窗');
  console.log('（候选窗遮挡、词频、软键盘布局）的行为差异。真机仍需人工过一遍。');
}

main().catch((e) => {
  console.error('测试异常终止：', e);
  process.exitCode = 1;
});
