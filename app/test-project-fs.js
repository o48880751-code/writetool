/**
 * 项目文件夹模块的验收测试。
 *
 * ⚠ 这个模块的测试重点不是"能不能读文件"，是**越界防护**。
 * 渲染进程传过来的是纯字符串，任何一个漏网的检查都等于把整盘文件系统
 * 交给模型生成的内容（正文会进入编辑器，恶意正文就可能读走用户文件）。
 *
 * 运行：node app/test-project-fs.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProjectFs, TEMPLATE_FILES, TEMPLATE_DIRS, SORT_BY_NAME } = require('./electron/project-fs.js');

// ---------------------------------------------------------------
// 迷你断言
// ---------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
assert.strictEqual = function (a, b, msg) {
  if (a !== b) throw new Error(msg || `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};
assert.throws = function (fn, mustMatch, msg) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error(msg || '应当抛异常，实际没抛');
  if (mustMatch && !String(threw.message).includes(mustMatch)) {
    throw new Error(`${msg || '异常信息不对'}：期望含「${mustMatch}」，实际「${threw.message}」`);
  }
  return threw;
};

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function section(t) {
  console.log(`\n${t}`);
}

// ---------------------------------------------------------------
// 每例独立目录，避免互相污染
// ---------------------------------------------------------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fs-'));
const pfs = new ProjectFs(path.join(ROOT, 'projects'));

function freshProject(id) {
  pfs.ensureProject(id);
  return id;
}

// ===========================================================
section('一、项目文件夹与初始模板');

check('建项目会创建文件夹', () => {
  pfs.ensureProject('p1');
  assert(fs.existsSync(pfs.projectDir('p1')), '文件夹未创建');
});

check('初始模板文件都在，且只有一个标题（不留空骨架）', () => {
  for (const name of Object.keys(TEMPLATE_FILES)) {
    const p = path.join(pfs.projectDir('p1'), name);
    assert(fs.existsSync(p), `缺少模板：${name}`);
    const txt = fs.readFileSync(p, 'utf8').trim();
    // ⚠ 2026-10-15 羽毛菌：「不要这么多提醒」——
    //   原来是「## 地理 / ## 势力 / …」+ 空 `-` 条目，打开就是一片空标题，
    //   而第 4 栏的「设定」里本来就有世界观条目，两处重复。
    assert(txt.length > 0, `${name} 是空的`);
    assert(/^#\s+\S/.test(txt), `${name} 缺一级标题：${JSON.stringify(txt)}`);
    assert(!/^##\s/m.test(txt),
      `${name} 还有空小节（## 开头）——那些只是提醒，没有内容：${JSON.stringify(txt)}`);
    assert(!/^\s*-\s*$/m.test(txt),
      `${name} 还有空列表项 —— 同样是提醒`);
  }
});

check('★ 设定条目跟着「设定」文件夹走，不散在根目录', () => {
  // 羽毛菌：「新建项目之后，只给三个文件夹，设定，卷纲，章节。
  // 设定文件夹里，初始只有世界观和人物库」。
  // 原来的模板是 世界观.md/人物库.md 平铺在项目根——
  // 从文件树上看，它们和「设定」文件夹里的东西毫无关系。
  const root = pfs.projectDir('p1');
  for (const f of ['世界观.md', '人物库.md']) {
    assert(fs.existsSync(path.join(root, '设定', f)), `设定/${f} 不存在`);
    assert(!fs.existsSync(path.join(root, f)),
      `★ ${f} 还散在项目根 —— 它是设定条目，该在「设定」里`);
  }
});

check('★ 根目录下一个散文件都没有（内容文件全归到三个文件夹里）', () => {
  /**
   * ⚠⚠ 2026-10-16 改：这条原来断言"根目录只留章节摘要.md"，理由是
   *   它跨卷、不属于任何单卷（羽毛菌当时也是这么说的）。
   *   但他真的用起来之后，看到根上那三个文件排在最后一个文件夹后面
   *   —— 看着就像「章节」的孩子，原话：
   *   「这三个文件为什么是项目根目录，这些文件应该是放在章节文件夹下面的啊」。
   *   ⚠ 教训：**根目录出现在树里本身就是歧义**（永远排在最后、紧贴最后一个文件夹）。
   *     所以规矩改成：根目录不放任何内容文件。
   *     ⚠ 别只看"该在的在哪"，要断言"根上什么都没有" —— 后者才挡得住复发。
   */
  const root = pfs.projectDir('p1');
  const loose = fs.readdirSync(root)
    .filter((n) => !n.startsWith('.') && fs.statSync(path.join(root, n)).isFile());
  assert(loose.length === 0, `根目录不该有散文件，实际：${loose.join('、')}`);
  assert(fs.existsSync(path.join(root, '章节', '章节摘要.md')),
    '章节摘要.md 应该在 章节/ 里面');
});

check('★ 灵感碎片不再由模板创建（它是「脑洞」工具的文件）', () => {
  // 两个入口做同一件事：文件树里一份空文件、工具栏里一个能写的。
  assert(!('灵感碎片.md' in TEMPLATE_FILES),
    '模板还在建灵感碎片.md —— 它和「脑洞」工具重复了');
  const root = pfs.projectDir('p1');
  assert(!fs.existsSync(path.join(root, '灵感碎片.md')),
    '★ 项目根出现了灵感碎片.md，应该由第一次用「脑洞」工具时创建');
  // 但工具仍然指向它
  const tools = fs.readFileSync(path.join(__dirname, 'src', 'components', 'ToolsPanel.jsx'), 'utf8');
  assert(tools.includes("file: '灵感碎片.md'"),
    '「脑洞」工具不写灵感碎片.md 了 —— 那羽毛菌记的东西没地方落');
});

check('初始模板目录存在（卷纲/章节刻意是空的）', () => {
  for (const d of TEMPLATE_DIRS) {
    const p = path.join(pfs.projectDir('p1'), d);
    assert(fs.existsSync(p), `缺少目录：${d}`);
    assert(fs.statSync(p).isDirectory(), `${d} 不是目录`);
  }
});

check('★ 卷纲是空的、章节里只有章节摘要（不放占位的「说明.md」）', () => {
  // 原来每个空目录里躺一个"说明.md"，理由是"空目录在 Windows 上不显眼"——
  // 但文件树会显示空目录，占位文件反而让首屏多出三个说不清的文件。
  // 「设定」有内容，所以另外断言它不是空的。
  //
  // ⚠ 2026-10-16：章节摘要.md 从根挪进了 章节/（见 project-fs.js 的注释），
  //   所以「章节」不再是空的 —— 但**不许出现「说明.md」这类占位**，
  //   这条判据真正要守的是"别塞占位文件"，不是"必须一个文件都没有"。
  const root = pfs.projectDir('p1');
  assert(fs.readdirSync(path.join(root, '卷纲')).length === 0, '卷纲应该真的是空的');
  const chap = fs.readdirSync(path.join(root, '章节'));
  assert(!chap.some((n) => /说明/.test(n)), `章节里不该有说明书式的占位文件：${chap.join('、')}`);
  assert(chap.length === 1 && chap[0] === '章节摘要.md',
    `章节里只该有章节摘要，实际：${chap.join('、')}`);
  assert(fs.readdirSync(path.join(root, '设定')).length > 0, '设定里应该有世界观与人物库');
});

check('重复 ensure 不覆盖用户改过的内容', () => {
  const p = path.join(pfs.projectDir('p1'), '设定', '世界观.md');
  fs.writeFileSync(p, '# 我改过的世界观\n', 'utf8');
  const r = pfs.ensureProject('p1');
  assert.strictEqual(r.created, false, '重复调用应报告已存在');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '# 我改过的世界观\n', '★ 模板被覆盖了，用户会丢资料');
});

// ===========================================================
section('二、路径越界防护（安全底线）');

check('拒绝绝对路径', () => {
  assert.throws(() => pfs.resolveIn('p1', 'C:/Windows/System32/config'), '不允许绝对路径');
  assert.throws(() => pfs.resolveIn('p1', 'D:\\secret.md'), '不允许绝对路径');
});

check('拒绝 UNC 路径', () => {
  assert.throws(() => pfs.resolveIn('p1', '\\\\server\\share\\x.md'), '不允许绝对路径');
});

check('拒绝 ../ 逃逸', () => {
  assert.throws(() => pfs.resolveIn('p1', '../p2/世界观.md'), '路径越界');
  assert.throws(() => pfs.resolveIn('p1', '../../../../Windows/win.ini'), '路径越界');
});

check('拒绝多层嵌套的 ../', () => {
  assert.throws(() => pfs.resolveIn('p1', '卷纲/../../p2/人物库.md'), '路径越界');
});

check('拒绝前导斜杠伪装成绝对路径', () => {
  assert.throws(() => pfs.resolveIn('p1', '/etc/passwd'), '不允许绝对路径');
});

check('拒绝空 projectId', () => {
  assert.throws(() => pfs.resolveIn('', 'x.md'), '非法项目 ID');
  assert.throws(() => pfs.resolveIn(null, 'x.md'), '非法项目 ID');
});

check('拒绝 projectId 里的路径分隔符（防止项目间穿越）', () => {
  assert.throws(() => pfs.resolveIn('p1/p2', '世界观.md'), '非法项目 ID');
  assert.throws(() => pfs.resolveIn('..', 'x.md'), '非法项目 ID');
});

check('正常相对路径通过', () => {
  const abs = pfs.resolveIn('p1', '卷纲/第一卷.md');
  assert(abs.startsWith(fs.realpathSync(pfs.projectDir('p1'))), `解析结果不在项目内：${abs}`);
});

check('反斜杠分隔符按 posix 语义处理（Windows 上用户会这么输入）', () => {
  const abs = pfs.resolveIn('p1', '卷纲\\第一卷.md');
  assert(abs.endsWith(path.join('卷纲', '第一卷.md')), `解析错误：${abs}`);
});

check('符号链接指向项目外时被挡下', () => {
  // Windows 上创建符号链接需要管理员权限，失败就跳过——不能因为环境限制就假装测过
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), '机密', 'utf8');
  const link = path.join(pfs.projectDir('p1'), 'link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (e) {
    console.log('      （跳过：当前环境无创建符号链接权限）');
    return;
  }
  assert.throws(() => pfs.read('p1', 'link/secret.md'), '路径越界');
  fs.unlinkSync(link);
});

// ===========================================================
section('三、读 / 写');

check('写入后能读回，内容一致（含中文与 emoji）', () => {
  const text = '# 世界观\n\n越国，昭华十七年冬。\n\n🌙 夜雪。\n';
  pfs.write('p1', '卷纲/第一卷.md', text);
  const r = pfs.read('p1', '卷纲/第一卷.md');
  assert.strictEqual(r.content, text, '读回内容不一致');
  assert.strictEqual(r.size, Buffer.byteLength(text, 'utf8'), 'size 应是字节数不是字符数');
});

check('写入会自动建父目录', () => {
  pfs.write('p1', '新目录/深层/笔记.md', '内容');
  assert(fs.existsSync(path.join(pfs.projectDir('p1'), '新目录/深层/笔记.md')), '父目录未创建');
});

check('读不存在的文件抛错而不是返回空串', () => {
  // 返回空串会让界面显示"空文档"，用户以为内容被清空了
  assert.throws(() => pfs.read('p1', '不存在.md'), '不存在');
});

check('读目录抛错（不返回乱码）', () => {
  assert.throws(() => pfs.read('p1', '卷纲'), '不是文件');
});

check('写入空内容是合法操作（用户清空文件）', () => {
  pfs.write('p1', '空文件.md', '');
  assert.strictEqual(pfs.read('p1', '空文件.md').content, '');
});

// ===========================================================
section('四、文件树');

check('树递归包含子目录', () => {
  const t = pfs.tree('p1');
  const names = t.children.map((c) => c.name);
  const chap = t.children.find((c) => c.name === '章节');
  assert(chap && (chap.children || []).some((k) => k.name === '章节摘要.md'),
    '章节/ 里的 md 没进树');
  assert(names.includes('卷纲'), '子目录没进树');
  const vol = t.children.find((c) => c.name === '卷纲');
  assert(vol.type === 'dir', '卷纲 应标记为目录');
  // 卷纲现在是真的空的（2026-10-13 改的模板），"空目录也在树里"才是要验的：
  // 目录节点必须存在、children 是数组（不能是 undefined）。
  assert(Array.isArray(vol.children), '空目录的 children 应是数组');
  // 设定里有内容，用它验递归
  const st = t.children.find((c) => c.name === '设定');
  assert(st.children.length > 0, '设定/ 下的文件没进树');
  assert(st.children.some((c) => c.name === '世界观.md'), '设定/世界观.md 没进树');
});

check('目录排在文件前面', () => {
  const t = pfs.tree('p1');
  const firstFile = t.children.findIndex((c) => c.type === 'file');
  const lastDir = t.children.map((c) => c.type).lastIndexOf('dir');
  assert(firstFile > lastDir, '目录应全部排在文件前，否则文件树看起来乱');
});

check('忽略非 md/txt 文件（db-wal、exe 等不进树）', () => {
  pfs.write('p1', '杂项.bin', 'x');
  fs.writeFileSync(path.join(pfs.projectDir('p1'), '数据库.db'), 'x', 'utf8');
  const names = pfs.tree('p1').children.map((c) => c.name);
  assert(!names.includes('杂项.bin'), 'bin 不该出现在树里');
  assert(!names.includes('数据库.db'), 'db 不该出现在树里');
});

check('忽略隐藏文件与 .git', () => {
  fs.writeFileSync(path.join(pfs.projectDir('p1'), '.隐藏.md'), 'x', 'utf8');
  const names = pfs.tree('p1').children.map((c) => c.name);
  assert(!names.includes('.隐藏.md'), '隐藏文件不该出现');
});

check('项目不存在时返回空树而不是抛错', () => {
  const t = pfs.tree('p-not-exist');
  assert(Array.isArray(t.children), 'children 必须是数组');
  assert.strictEqual(t.children.length, 0, '应为空');
});

check('maxDepth 生效（防止软链成环无限递归）', () => {
  pfs.write('p1', 'a/b/c/深层.md', 'x');
  // maxDepth 语义：根目录下的目录处于 depth 0，maxDepth=1 意味着
  // 「展开一层」——a 要显示，被截断的是 a/b。写清楚这点免得下次又怀疑实现。
  const t = pfs.tree('p1', { maxDepth: 1 });
  const a = t.children.find((c) => c.name === 'a');
  assert.strictEqual(a.truncated, undefined, 'depth 0 的目录不该被截断');
  const b = a.children.find((c) => c.name === 'b');
  assert(b && b.truncated === true, 'depth 1 的目录应标记 truncated');
  assert.strictEqual(b.children.length, 0, '截断节点不应带 children');
});

check('默认 maxDepth 下深层目录能正常读到', () => {
  const t = pfs.tree('p1');
  const a = t.children.find((c) => c.name === 'a');
  const b = a.children.find((c) => c.name === 'b');
  const c = b.children.find((c2) => c2.name === 'c');
  assert(c && c.children.some((f) => f.name === '深层.md'), '深层文件应能被读到');
});

check('文件节点带 size 与 mtime（界面要显示字数/时间）', () => {
  const t = pfs.tree('p1');
  // 世界观.md 在 设定/ 下（2026-10-13 的模板改动），从那儿取
  const st = t.children.find((c) => c.name === '设定');
  const f = st.children.find((c) => c.name === '世界观.md');
  assert(typeof f.size === 'number', '缺 size');
  assert(typeof f.mtime === 'string', '缺 mtime');
});

// ===========================================================
section('五、新建 / 重命名 / 删除');

check('新建文件带默认骨架', () => {
  pfs.create('p1', '新章节.md');
  const c = pfs.read('p1', '新章节.md').content;
  assert(c.includes('# 新章节'), `默认骨架不对：${JSON.stringify(c)}`);
});

check('新建文件夹', () => {
  pfs.create('p1', '资料', { dir: true });
  assert(fs.statSync(path.join(pfs.projectDir('p1'), '资料')).isDirectory(), '没建成目录');
});

check('同名新建直接报错，不静默覆盖', () => {
  // 覆盖用户的资料不可逆
  pfs.write('p1', '重要.md', '我的正文');
  assert.throws(() => pfs.create('p1', '重要.md'), '已存在');
  assert.strictEqual(pfs.read('p1', '重要.md').content, '我的正文', '★ 现有文件被覆盖');
});

check('拒绝新建非 md 文件（挡住 exe/bat）', () => {
  assert.throws(() => pfs.create('p1', '病毒.exe'), '只允许');
  assert.throws(() => pfs.create('p1', '启动.bat'), '只允许');
});

check('重命名成功且内容保留', () => {
  pfs.write('p1', '临时名.md', '正文内容');
  pfs.rename('p1', '临时名.md', '正式名.md');
  assert(!fs.existsSync(path.join(pfs.projectDir('p1'), '临时名.md')), '旧名还在');
  assert.strictEqual(pfs.read('p1', '正式名.md').content, '正文内容', '重命名丢了内容');
});

check('重命名到已存在的名字报错（不覆盖）', () => {
  pfs.write('p1', '目标.md', '目标内容');
  pfs.write('p1', '源.md', '源内容');
  assert.throws(() => pfs.rename('p1', '源.md', '目标.md'), '目标已存在');
  assert.strictEqual(pfs.read('p1', '目标.md').content, '目标内容', '★ 目标被覆盖');
});

check('删除文件', () => {
  pfs.write('p1', '待删.md', 'x');
  pfs.remove('p1', '待删.md');
  assert(!fs.existsSync(path.join(pfs.projectDir('p1'), '待删.md')), '文件还在');
});

check('删非空目录必须显式 recursive', () => {
  pfs.write('p1', '满的/a.md', 'x');
  assert.throws(() => pfs.remove('p1', '满的'), '目录非空');
  pfs.remove('p1', '满的', { recursive: true });
  assert(!fs.existsSync(path.join(pfs.projectDir('p1'), '满的')), '目录还在');
});

check('删除不存在的路径报错', () => {
  assert.throws(() => pfs.remove('p1', '从来没有这个.md'), '不存在');
});

// ===========================================================
section('五点五、排序');

check('按名称排序可用', () => {
  pfs.ensureProject('so1');
  pfs.write('so1', 'zebra.md', 'x');
  pfs.write('so1', 'alpha.md', 'x');
  const t = pfs.tree('so1', { sort: 'name' });
  const files = t.children.filter((c) => c.type === 'file').map((c) => c.name);
  assert(files.length >= 2, `文件数不对：${files.length}`);
});

check('★ 不管按什么排，目录永远在文件前面', () => {
  pfs.ensureProject('so2');
  pfs.write('so2', '大文件.md', 'x'.repeat(5000));
  pfs.write('so2', 'aaa.md', 'x');
  for (const by of ['name', 'modified', 'size']) {
    const t = pfs.tree('so2', { sort: by });
    const kinds = t.children.map((c) => c.type);
    const lastDir = kinds.lastIndexOf('dir');
    const firstFile = kinds.indexOf('file');
    if (firstFile >= 0) {
      assert(lastDir < firstFile, `按 ${by} 排时目录没全在前面：${kinds.join(',')}`);
    }
  }
});

check('按大小排序：大文件在前', () => {
  pfs.ensureProject('so3');
  pfs.write('so3', '小.md', 'x');
  pfs.write('so3', '大.md', 'x'.repeat(5000));
  const t = pfs.tree('so3', { sort: 'size' });
  const files = t.children.filter((c) => c.type === 'file');
  assert(files[0].name === '大.md', `实际第一是「${files[0].name}」`);
});

check('按修改时间排序：新的在前', () => {
  pfs.ensureProject('so4');
  pfs.write('so4', '旧.md', 'x');
  const past = new Date(Date.now() - 86400000);
  const abs = pfs.resolveIn('so4', '旧.md');
  fs.utimesSync(abs, past, past);
  pfs.write('so4', '新.md', 'x');

  const t = pfs.tree('so4', { sort: 'modified' });
  const files = t.children.filter((c) => c.type === 'file');
  assert(files[0].name === '新.md', `实际第一是「${files[0].name}」`);
});

check('★ 排序稳定：同一批文件反复读，次序不变', () => {
  // mtime 相同的文件如果每次刷新都在跳，用户会以为界面抽风
  const same = new Date(1700000000000);
  for (const n of ['b.md', 'a.md', 'c.md']) {
    const abs = pfs.resolveIn('so3', n);
    fs.writeFileSync(abs, 'x', 'utf8');
    fs.utimesSync(abs, same, same);
  }
  const first = pfs.tree('so3', { sort: 'modified' }).children.map((c) => c.name).join(',');
  for (let i = 0; i < 3; i++) {
    const again = pfs.tree('so3', { sort: 'modified' }).children.map((c) => c.name).join(',');
    assert(again === first, `第 ${i + 1} 次读出来次序变了`);
  }
});

check('未知排序方式退回按名称（不崩）', () => {
  const t = pfs.tree('so3', { sort: '不存在的排法' });
  assert(Array.isArray(t.children), 'children 必须是数组');
});

check('子目录也按同一规则排', () => {
  pfs.ensureProject('so5');
  pfs.write('so5', 'x/小.md', 'x');
  pfs.write('so5', 'x/大.md', 'y'.repeat(3000));
  const t = pfs.tree('so5', { sort: 'size' });
  const x = t.children.find((c) => c.name === 'x');
  assert(x.children[0].name === '大.md', `子目录未按大小排：${x.children.map(c=>c.name)}`);
});

// ===========================================================
section('五点六、排序 vs 拖拽顺序（.order.json）');

// 背景：这个模块最容易被做错的地方。
// 界面上的排序控件给了四档（手动/名称/时间/大小），后端 sortNodes 只管三种，
// 而用户拖拽出来的顺序存在 .order.json 里，优先级曾经是**永远更高**。
// 那样一来：用户拖过某个文件夹，然后点了「按时间」→ 那一层顺序没变
// → 第一反应是「这控件坏了」。
// 现在规则是：'manual' 档听 .order.json，其余三档压过它。

/** 在项目里拖出一个与名字/大小/时间都不同的顺序 */
function seedDragged(p) {
  pfs.ensureProject(p);
  pfs.write(p, 'aaa.md', 'x'.repeat(100));            // 最小、最新
  pfs.write(p, 'bbb.md', 'y'.repeat(3000));           // 中
  pfs.write(p, 'zzz.md', 'x'.repeat(9000));           // 最大
  // ⚠ mtime 要拉开**分钟级**再设，别只差几毫秒。
  //   NTFS 的时间戳精度足够高，三个文件几毫秒内的差别完全可能反过来，
  //   那样断言就成了"看谁写得快"——偶然红一次的测试比没测试更糟。
  const ago = (min) => new Date(Date.now() - min * 60000);
  fs.utimesSync(pfs.resolveIn(p, 'aaa.md'), ago(120), ago(120));   // 最旧
  fs.utimesSync(pfs.resolveIn(p, 'bbb.md'), ago(60), ago(60));
  // zzz 保持最新（刚写的）
  // ⚠ move 的第 4 个参数是 **opts 对象**，不是 (anchor, place)。
  //   按位置传的话 opts.anchor 是 undefined，_recordSiblingOrder 拿不到锚点，
  //   于是把 readdir 的原样顺序原封不动写进 .order.json —— 文件存在、内容却等于没排。
  pfs.move(p, 'zzz.md', '', { anchor: 'aaa.md', place: 'before' });
  const ord = path.join(pfs.projectDir(p), '.order.json');
  assert(fs.existsSync(ord), `拖完没写 .order.json`);
  const names = JSON.parse(fs.readFileSync(ord, 'utf8')).dirs[''];
  // ⚠ 两个坑：
  //   1. 断言 names[0] 是 zzz —— 项目模板自带「卷纲/设定/章节」三个目录，
  //      而「目录恒在文件前」是这个模块的刻意规则，第一个必然是目录。
  //   2. 过滤出所有 .md —— 模板里还有「章节摘要.md」，会混进来。
  // 只看我造的那三个文件的相对次序，这才是拖拽真正影响的东西。
  const mine = names.filter((n) => ['aaa.md', 'bbb.md', 'zzz.md'].includes(n));
  assert.strictEqual(mine.join(','), 'zzz.md,aaa.md,bbb.md', `order.json 没记下拖拽结果：${names}`);
}

/**
 * 取出一层里**我造的那三个文件**的名字。
 *
 * ⚠ 不能直接取全部文件：项目模板自带一个「章节摘要.md」，
 *   而它按设计就排在三个目录之后（"目录恒在文件前"）。
 *   混进来会让「zzz 是否被拖到了 aaa 前面」这种断言读不懂——
 *   第一版就是这么误判成"顺序没生效"的。
 */
const fileNames = (t) => t.children
  .filter((c) => c.type === 'file')
  .map((c) => c.name)
  .filter((n) => ['aaa.md', 'bbb.md', 'zzz.md', 'b.md', 'a.md'].includes(n));

const namesOf = (t) => fileNames(t).join(',');

check('默认（不传 sort）等价于 manual，拖出来的顺序生效', () => {
  seedDragged('so6');
  const manual = namesOf(pfs.tree('so6', { sort: 'manual' }));
  const dflt = namesOf(pfs.tree('so6'));
  assert.strictEqual(dflt, manual, '不传 sort 应当与 manual 一致');
  assert(manual.startsWith('zzz'), `manual 档未用 .order.json，实际「${manual}」`);
});

check('★ 选了排序档就压过拖拽顺序（否则控件会被当成坏的）', () => {
  seedDragged('so7');
  const bySize = pfs.tree('so7', { sort: 'size' }).children.filter((c) => c.type === 'file');
  assert.strictEqual(fileNames({ children: bySize }).join(','), 'zzz.md,bbb.md,aaa.md', `按大小未压过 order`);
  const byName = pfs.tree('so7', { sort: 'name' }).children.filter((c) => c.type === 'file');
  assert.strictEqual(fileNames({ children: byName }).join(','), 'aaa.md,bbb.md,zzz.md', `按名称未压过 order`);
  const byTime = pfs.tree('so7', { sort: 'modified' }).children.filter((c) => c.type === 'file');
  // 期望 zzz,bbb,aaa（最新在前），与拖拽排出的 zzz,aaa,bbb **不同**——
  // 两者的第一项相同，光看第一项区分不出，所以整串比。
  assert.strictEqual(fileNames({ children: byTime }).join(','), 'zzz.md,bbb.md,aaa.md', `按时间未压过 order`);
});

check('切回 manual 后拖拽顺序又回来了（能来回切）', () => {
  seedDragged('so8');
  pfs.tree('so8', { sort: 'size' });                 // 先按大小读一次
  const back = namesOf(pfs.tree('so8', { sort: 'manual' }));
  assert(back.startsWith('zzz'), `切回 manual 后顺序没回来，实际「${back}」`);
});

check('只有拖过的那一层用 order，其余层照排', () => {
  pfs.ensureProject('so9');
  pfs.write('so9', 'b.md', 'x');
  pfs.write('so9', 'a.md', 'x'.repeat(9000));
  pfs.write('so9', '子/b.md', 'x');
  pfs.write('so9', '子/a.md', 'x'.repeat(9000));
  pfs.move('so9', 'b.md', '', { anchor: 'a.md', place: 'before' });  // 只拖了根这一层

  const t = pfs.tree('so9', { sort: 'name' });
  assert.strictEqual(fileNames(t).join(','), 'a.md,b.md', '根层应按名称排');
  const zi = t.children.find((c) => c.name === '子');
  assert.strictEqual(zi.children[0].name, 'a.md', '未拖过的子层也应按名称排');
});

check('未知档位与 undefined 都退回 manual，不崩', () => {
  for (const s of ['不存在的排法', undefined, null, '', 42]) {
    const t = pfs.tree('so6', { sort: s });
    assert(Array.isArray(t.children), `sort=${JSON.stringify(s)} 时 children 不是数组`);
  }
});

check('SORT_BY_NAME 导出且不含 manual', () => {
  // manual 混进去是个隐蔽的坑：它会让 useOrder 判成 false，
  // 而 sortNodes 又不认 'manual'，等于两套规则都不生效、退回 readdir 序。
  assert(Array.isArray(SORT_BY_NAME), 'SORT_BY_NAME 没导出');
  for (const k of ['name', 'modified', 'size']) {
    assert(SORT_BY_NAME.includes(k), `SORT_BY_NAME 少了 ${k}`);
  }
  assert(!SORT_BY_NAME.includes('manual'), 'SORT_BY_NAME 不该含 manual');
});


check('合法名通过', () => {
  for (const n of ['世界观.md', '第一卷', '人物小传 2', 'a-b_c']) {
    const r = pfs.validateName(n);
    assert(r.ok, `${n} 应合法，实际：${r.error}`);
  }
});

check('空名与非法字符被拦', () => {
  assert.strictEqual(pfs.validateName('  ').ok, false);
  assert.strictEqual(pfs.validateName('a/b').ok, false);
  assert.strictEqual(pfs.validateName('a:b').ok, false);
  assert.strictEqual(pfs.validateName('a*b').ok, false);
  assert.strictEqual(pfs.validateName('a?b').ok, false);
  assert.strictEqual(pfs.validateName('..').ok, false);
});

check('超长名被拦（防 Windows MAX_PATH）', () => {
  const r = pfs.validateName('长'.repeat(200));
  assert.strictEqual(r.ok, false);
  assert(r.error.includes('太长'), `错误信息应说明原因：${r.error}`);
});

// ---------------------------------------------------------------
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch (_) { /* 临时目录，清不掉不影响结论 */ }

console.log(`\n${'-'.repeat(52)}`);
console.log(`项目文件夹模块：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);