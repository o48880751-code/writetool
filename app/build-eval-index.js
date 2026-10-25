/**
 * 从磁盘上的真实 SKILL.md 生成评测用的索引集。
 *
 * ## 为什么要这一步
 *
 * 上一轮评测（2026-10-16 早）用的是**手抄在脚本里**的 description，
 * 而磁盘上的正文已经按六项约束改过了。手抄 = 会漂移 =
 * 测出来的数字不能代表真实技能。
 *
 * 所以这个脚本从 `app/builtin-skills` 各技能的 SKILL.md 现读 frontmatter，
 * 用 skill-format 模块的 parse（不是自己写正则），
 * 生成 `eval-index.json` 给评测脚本吃。
 *
 * ⚠ 用 skill-format 是因为 main.js 的 skill:index 也用它 ——
 *   解析规则不一致的话，测出来的资格判断和真机不是一回事。
 */

const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname);
const { BUILTIN } = require(path.join(APP, '..', 'db', 'builtin-skills.js'));
const skillFmt = require(path.join(APP, 'electron', 'skill-format.js'));

const out = [];
for (const s of BUILTIN) {
  const p = path.join(APP, 'builtin-skills', s.id, 'SKILL.md');
  if (!fs.existsSync(p)) {
    console.error(`❌ ${s.id} 的 SKILL.md 不存在：${p}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(p, 'utf8');
  const meta = skillFmt.parse(raw);
  if (!meta.description) {
    console.error(`❌ ${s.id} 没有 description —— 它进不了 skill:index，等于没装`);
    process.exit(1);
  }
  const files = fs.existsSync(path.join(APP, 'builtin-skills', s.id, 'references'))
    ? fs.readdirSync(path.join(APP, 'builtin-skills', s.id, 'references'))
    : [];
  out.push({
    id: s.id,
    name: s.name,
    description: meta.description,
    bodyChars: meta.body.length,
    files: files.map((f) => 'references/' + f),
  });
}

const dest = path.join(APP, 'shots-verify', 'eval-index.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2));

console.log(`从磁盘生成 ${out.length} 条索引 → ${dest}\n`);
for (const s of out) {
  console.log(`${s.id}`);
  console.log(`  显示名   ${s.name}`);
  console.log(`  描述     ${s.description.length} 字`);
  console.log(`  正文     ${s.bodyChars} 字`);
  console.log(`  配套文件 ${s.files.length ? s.files.join(', ') : '(无)'}`);
}
