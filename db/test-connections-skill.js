/**
 * 多连接 + Skill 目录式存储的测试。
 *
 * 2026-10-12 新增。挂在 db/test-db.js 的框架上跑，
 * 但单独成文件——这两块与原有 db 用例是不同主题。
 */

module.exports.run = function run(ctx) {
  const { check, section, store: Store, norm: normalizeSkillPath } = ctx;
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const F = require(path.join(ctx.ROOT, 'app', 'electron', 'skill-format.js'));
  const PRESETS = require(path.join(ctx.ROOT, 'app', 'electron', 'provider-presets.js'));

  const s = new Store(':memory:');

  section('六、多连接：connections');

  check('★ 连接列表里绝不带密钥（这份数据要经 IPC）', () => {
    const c = s.createConnection({
      id: 'c1', name: '硅基流动', protocol: 'openai',
      providerKey: 'siliconflow', base: 'https://api.siliconflow.cn/v1',
    });
    s.setConnectionSecret('c1', 'CIPHERTEXT-SHOULD-NOT-APPEAR');
    const list = s.listConnections();
    const txt = JSON.stringify(list);
    if (txt.includes('CIPHERTEXT')) {
      throw new Error('密钥密文跟着 listConnections 出去了 —— '
        + '拿到密文等于拿到一条"在别的进程里解密"的路');
    }
    assert(list[0].hasKey === true, 'hasKey 应该是 true（有密文）');
    assert(!('keyEnc' in list[0]), '不该把密文字段带出来');
    void c;
  });

  check('★ 密钥密文单独存，且能取回', () => {
    s.setConnectionSecret('c1', 'ABC123');
    assert(s.getConnectionSecret('c1') === 'ABC123', '密文取不回来');
    // 存空 = 清掉
    s.setConnectionSecret('c1', null);
    assert(s.getConnectionSecret('c1') === null, '传 null 应该清掉密文');
  });

  check('★ 删连接会连带删掉密钥（不留孤儿密文）', () => {
    s.createConnection({ id: 'c2', name: '临时', protocol: 'openai' });
    s.setConnectionSecret('c2', 'TEMPKEY');
    s.deleteConnection('c2');
    assert(s.getConnectionSecret('c2') === null,
      '连接删了密钥还在 —— 换回来时你以为还存着，其实密文可能已经失效');
  });

  check('★ 名字为空或协议非法都报错（不静默接受）', () => {
    let threw = false;
    try { s.createConnection({ id: 'cx', name: '   ', protocol: 'openai' }); }
    catch (e) { threw = true; }
    assert(threw, '空名字被接受了 —— 界面上会显示一个没名字的连接');

    threw = false;
    try { s.updateConnection('c1', { protocol: '乱写的' }); }
    catch (e) { threw = true; }
    assert(threw, '非法协议被接受了 —— 它会一路传到 provider 然后崩在那儿');
  });

  check('★ base 的结尾斜杠被去掉（否则拼出来是 //）', () => {
    const c = s.createConnection({
      id: 'c3', name: '斜杠', protocol: 'openai', base: 'https://x.com/v1///',
    });
    assert(c.base === 'https://x.com/v1', `实际是 ${c.base}`);
  });

  check('★ 不再有"把内置量表 seed 成连接"这回事', () => {
    // 反过来的断言。原实现 seedPresetConnections 会把 14 家写进连接表，
    // 用户进设置页看到一屏用不上的东西，而且删掉下次启动又回来。
    // 量表是**模板**，只该出现在「新建连接」那一刻。
    assert(typeof s.seedPresetConnections !== 'function',
      'seedPresetConnections 又回来了 —— 它会让连接列表被 14 家内置服务商塞满，'
      + '并且挡住老配置的迁移（连接表非空 → migrateToConnections 直接跳过）');

    // 谁调用它都不行（防有人把它换个名字加回来再调用）
    const src = fs.readFileSync(path.join(ctx.ROOT, 'app', 'electron', 'main.js'), 'utf8');
    assert(!/seedPreset/i.test(src), 'main.js 里出现了 seedPreset —— 量表不该被写进库');
  });

  check('★ 用量表建的连接，地址照抄量表那一份', () => {
    // 这条原先靠 seed 出来的条目验，seed 删掉后改成直接查量表——
    // 验的东西没变：智谱是 /api/paas/v4，少一层就 404。
    const zhipu = PRESETS.get('zhipu');
    assert(zhipu.base === 'https://open.bigmodel.cn/api/paas/v4',
      `智谱的地址不对：${zhipu.base}`);
    const c = s.createConnection({
      id: 'c4', name: zhipu.name, protocol: zhipu.protocol,
      providerKey: zhipu.key, base: zhipu.base, needKey: zhipu.needKey,
    });
    assert(c.base === zhipu.base, '建出来的连接地址与量表不一致');
    assert(c.protocol === 'openai', `智谱走 OpenAI 兼容，实际 ${c.protocol}`);
  });

  section('七、SKILL.md 格式');

  check('★ 解析 frontmatter 的 name 与 description', () => {
    const r = F.parse('---\nname: novel-writer\ndescription: 写小说用。\n---\n\n# 标题\n\n正文');
    assert(r.name === 'novel-writer', `name 解析成 "${r.name}"`);
    assert(r.description === '写小说用。', `description 解析成 "${r.description}"`);
    assert(r.body.includes('正文'), '正文丢了');
    assert(r.body.includes('# 标题'), '标题丢了');
    assert(!r.body.includes('name:'), 'frontmatter 混进正文了');
  });

  check('★ 缺 description 判定为不可用（等于没装）', () => {
    const v = F.validate('---\nname: x\n---\n\n正文');
    assert(!v.ok, '缺 description 却判成可用 —— 渐进式加载下模型看不到它');
    assert(v.errors.some((e) => /description/.test(e)),
      `报错应提到 description：${v.errors.join('; ')}`);
  });

  check('★ 只有一个 --- 时当成纯正文，不报崩', () => {
    const r = F.parse('name: x\ndescription: y\n\n正文');
    assert(!r.hasFrontmatter, '半个 frontmatter 不该被当成功');
    assert(r.body.includes('正文'), '内容丢了');
  });

  check('CRLF 的 SKILL.md 也能解析（Windows 用户）', () => {
    const r = F.parse('---\r\nname: a\r\ndescription: b\r\n---\r\n\r\n正文');
    assert(r.name === 'a', `CRLF 下 name 解析成 "${r.name}" —— 结束标记匹配不上`);
    assert(r.description === 'b', 'CRLF 下 description 解析失败');
  });

  check('★ description 里的 # 不当注释（有 URL 锚点）', () => {
    const r = F.parse('---\nname: a\ndescription: 见 https://x.com/a#b 章节\n---\n\n正文');
    assert(r.description.includes('#b'),
      `URL 锚点被当注释截断了：${r.description}`);
  });

  check('name 被 # 注释截断是对的（真注释）', () => {
    const r = F.parse('---\nname: a   # 这是备注\ndescription: b\n---\n\n正文');
    assert(r.name === 'a', `name 应为 "a"，实际 "${r.name}"`);
  });

  check('★ 未知 frontmatter 字段保留（不能悄悄丢用户的东西）', () => {
    const r = F.parse('---\nname: a\ndescription: b\nallowed-tools: Read, Write\n---\n\n正文');
    assert(r.extra['allowed-tools'] === 'Read, Write',
      `未知字段丢了：${JSON.stringify(r.extra)}`);
  });

  check('name 归一化：小写英文 + 连字符（它要当目录名用）', () => {
    assert(F.sanitizeName('Novel Writer') === 'novel-writer',
      `"Novel Writer" → "${F.sanitizeName('Novel Writer')}"`);
    // 中文会被清空——命名规范本来就要求英文
    assert(F.sanitizeName('中文名') === 'skill',
      `全中文清空后应兜底成 skill，实际 "${F.sanitizeName('中文名')}"`);
    // ⚠ 兜底不能省：空名会让目录名变成空或 undefined
    assert(F.sanitizeName('!!!') === 'skill',
      `全是符号时应兜底成 skill，实际 "${F.sanitizeName('!!!')}"`);
    assert(F.sanitizeName('') === 'skill', '空字符串也要兜底');
    assert(F.sanitizeName('Novel_Writer 2') === 'novel-writer-2',
      `"Novel_Writer 2" → "${F.sanitizeName('Novel_Writer 2')}"`);
  });

  section('八、Skill 配套文件');

  s.createSkill({ id: 'sk1', name: '测试技能', promptContent: '正文', type: 'custom' });

  check('★ 配套文件路径不许穿越（导入 Skill 是不可信输入）', () => {
    const bad = [
      '../../etc/passwd',
      'references/../../evil.md',
      'C:\\Windows\\System32\\evil.txt',
      '/etc/passwd',
      'a\\..\\..\\b',
    ];
    for (const b of bad) {
      const r = normalizeSkillPath(b);
      assert(!r.ok, `「${b}」被放行了 —— 这等于任意文件读写`);
    }
    const good = ['references/a.md', 'scripts/x.py', 'assets/t.html', 'SKILL.md'];
    for (const g of good) {
      const r = normalizeSkillPath(g);
      assert(r.ok, `「${g}」被误拒了：${r.error}`);
    }
  });

  check('★ 配套文件放错目录会报错（只有三个目录有语义）', () => {
    const r = normalizeSkillPath('随便放个文件.md');
    assert(!r.ok, '根目录下的文件被放行了 —— 它不会出现在配套索引里');
    assert(r.error.includes('references'), `报错该说清楚放哪：${r.error}`);
  });

  check('★ 写配套文件与读回来', () => {
    s.saveSkillFile('sk1', { path: 'references/templates.md', content: '# 模板' });
    const f = s.getSkillFile('sk1', 'references/templates.md');
    assert(f && f.content === '# 模板', '写进去读不回来');
    const list = s.listSkillFiles('sk1');
    assert(list.length === 1, `列表里应有 1 个，实际 ${list.length}`);
    // 列表不该带完整内容（可能很大）
    assert(!('content' in list[0]), '列表把完整内容带出来了');
    assert(list[0].size === 4, `size 字段不对：${list[0].size}`);
  });

  check('同名文件是覆盖不是新增', () => {
    s.saveSkillFile('sk1', { path: 'references/templates.md', content: '# 改过了' });
    assert(s.listSkillFiles('sk1').length === 1,
      '写了两次同一个路径却出现两条 —— UNIQUE 约束没生效');
    assert(s.getSkillFile('sk1', 'references/templates.md').content === '# 改过了',
      '内容没被覆盖');
  });

  check('★ 不许删 SKILL.md（删了技能就废了）', () => {
    let threw = false;
    try { s.deleteSkillFile('sk1', 'SKILL.md'); } catch (e) { threw = true; }
    assert(threw, 'SKILL.md 能被删 —— 那等于把技能正文删了');
  });

  check('scripts/ 默认不可执行（导入别人的脚本不等于让它跑）', () => {
    s.saveSkillFile('sk1', { path: 'scripts/helper.py', content: 'print(1)' });
    const f = s.getSkillFile('sk1', 'scripts/helper.py');
    assert(f.executable === 0,
      '导入的脚本默认就可执行 —— 那是让别人的代码在你的机器上跑');
  });

  check('★ 配套文件随技能一起删（外键级联）', () => {
    s.createSkill({ id: 'sk2', name: '待删', promptContent: 'x', type: 'custom' });
    s.saveSkillFile('sk2', { path: 'references/a.md', content: 'a' });
    s.deleteSkill('sk2');
    assert(s.listSkillFiles('sk2').length === 0,
      '技能删了配套文件还在 —— 变成谁都看不到的孤儿数据');
  });

  check('★ 真读一份用户的 SKILL.md 验证全链路', () => {
    const p = 'C:/Users/26775/Desktop/novel-writer-adapted/SKILL.md';
    if (!fs.existsSync(p)) return;   // 用户还没放到那个位置，跳过
    const raw = fs.readFileSync(p, 'utf8');
    const v = F.validate(raw);
    assert(v.ok, `实际用户的 SKILL.md 校验没过：${v.errors.join('; ')}`);
    const parsed = F.parse(raw);
    assert(parsed.name === 'novel-writer', `name 是 "${parsed.name}"`);
    assert(parsed.description.length > 20, 'description 太短，模型不容易触发');
    assert(parsed.body.length > 500, '正文太短，撑不起一个技能');
    // 文件里提到的 references 必须真的存在
    if (parsed.body.includes('references/templates.md')) {
      const ref = 'C:/Users/26775/Desktop/novel-writer-adapted/references/templates.md';
      assert(fs.existsSync(ref),
        '正文里提到 references/templates.md，但文件不存在 —— '
        + '模型会照着去找然后失败');
    }
  });

  s.close();

  // ----------------------------------------------------------------
  // 断言助手
  // ----------------------------------------------------------------
  function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
  }
};