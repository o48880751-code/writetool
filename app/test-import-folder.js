/**
 * 导入已有小说文件夹的端到端验证。
 *
 * 用**真实**的《墨染仙途》目录跑，而不是临时造的假目录 ——
 * 假目录一定漂亮：没有 .bak、没有中文名、没有空目录、没有超长路径。
 * 真目录才有那些东西，而它们恰恰是导入最容易翻车的地方。
 *
 * ⚠ 全程**只读**：绝不能往用户的原稿目录里写一个字节。
 *   每一步前后都比对文件清单，任何写入了都直接判失败。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ProjectFs } = require(path.join(__dirname, 'electron', 'project-fs.js'));

const REAL = process.argv[2] || 'C:\\Users\\26775\\AI写小说\\墨染仙途';

let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); pass++; }
  else { console.log(`  ✗ ${name}\n    ${detail || ''}`); fail++; }
}

/** 目录指纹：路径 + 大小 + mtime，用于证明"一个字节都没动" */
function fingerprint(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) walk(path.join(d, it.name), r);
      else {
        const st = fs.statSync(path.join(d, it.name));
        out.push(`${r}|${st.size}|${st.mtimeMs}`);
      }
    }
  };
  walk(dir, '');
  return out.sort().join('\n');
}

console.log('\n导入已有小说文件夹 —— 端到端验证');
console.log(`真实目录：${REAL}\n`);

if (!fs.existsSync(REAL)) {
  console.log('  ! 目录不存在，跳过（环境不满足）');
  process.exit(2);
}

const BEFORE = fingerprint(REAL);
const beforeCount = BEFORE.split('\n').length;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-import-'));
const pfs = new ProjectFs(tmpRoot);
const PID = 'pj-importtest';

console.log('---- 绑定前 ----');
t('绑定前 _dir 指向默认位置', pfs.projectDir(PID) === path.resolve(tmpRoot, PID),
  pfs.projectDir(PID));
t('绑定前 isExternal 为 false', pfs.isExternal(PID) === false);
t('绑定前 resolveIn 能解析到默认位置',
  pfs.resolveIn(PID, 'a.md') === path.join(path.resolve(tmpRoot, PID), 'a.md'));

pfs.bindExternal(PID, REAL);

console.log('\n---- 绑定后 ----');
t('_dir 指向真实外部目录', pfs.projectDir(PID) === path.resolve(REAL),
  pfs.projectDir(PID));
t('isExternal 为 true', pfs.isExternal(PID) === true);

const tree = pfs.tree(PID);
const stats = pfs.countTree(PID);
console.log(`  （扫到 ${stats.fileCount} 文件 / ${stats.dirCount} 目录 / ${stats.charCount} 字）\n`);

t('能扫到外部目录里的文件', stats.fileCount > 0, `${stats.fileCount} 个`);
t('能扫到「第一章.md」', JSON.stringify(tree).includes('第一章.md'));
t('能扫到「小说资料」目录', JSON.stringify(tree).includes('小说资料'));
t('字数统计不为 0', stats.charCount > 0, `${stats.charCount} 字`);

// ---- 越界防护必须仍然以**该项目的实际目录**为界 ----
console.log('\n---- 越界防护 ----');
let threw = false;
try { pfs.resolveIn(PID, '../../../Windows'); } catch (e) { threw = true; }
t('绑定外部目录后仍拦得住 ../../../越界', threw);

threw = false;
try { pfs.resolveIn(PID, 'C:\\Windows\\System32'); } catch (e) { threw = true; }
t('绑定外部目录后仍拦得住绝对路径', threw);

threw = false;
try { pfs.resolveIn(PID, '/etc/passwd'); } catch (e) { threw = true; }
t('绑定外部目录后仍拦得住 /绝对路径', threw);

// 同级目录不该能访问
const sibling = path.join(path.dirname(path.resolve(REAL)), '不存在的兄弟目录');
threw = false;
try {
  pfs.resolveIn(PID, path.relative(path.resolve(REAL), sibling).replace(/\\/g, '/') + '/x.md');
} catch (e) { threw = true; }
t('绑定外部目录后仍访问不到目录之外', threw);

// ---- 最要紧的一条：绝不能删用户的原稿 ----
console.log('\n---- 不许删原稿 ----');
threw = false;
let msg = '';
try { pfs.remove(PID, '', { rootDelete: true }); } catch (e) { threw = true; msg = e.message; }
t('rootDelete 对外部目录被拒绝', threw, msg.slice(0, 40));
t('拒绝时给的是能看懂的理由（不是「路径越界」）',
  threw && /不会被删除|外部/.test(msg), msg.slice(0, 60));
t('拒绝之后文件夹还在', fs.existsSync(REAL));

// ---- 不许写模板 ----
console.log('\n---- 不许塞模板 ----');
threw = false;
try { pfs.ensureProject(PID); } catch (e) { threw = true; msg = e.message; }
t('ensureProject 对存在的外部目录不写入也不抛', !threw, msg.slice(0, 40));
t('没有凭空多出「设定/世界观.md」',
  !fs.existsSync(path.join(REAL, '设定', '世界观.md')));

// 目录被挪走后必须报错，而不是在别处造个空项目
const goneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gone-'));
const pfs2 = new ProjectFs(goneRoot);
pfs2.bindExternal('pj-gone', path.join(goneRoot, '已被删除的目录'));
threw = false; msg = '';
try { pfs2.ensureProject('pj-gone'); } catch (e) { threw = true; msg = e.message; }
t('外部目录消失后 ensureProject 报错（不静默造空项目）', threw, msg.slice(0, 46));
t('报错后没有在别处建出空文件夹',
  !fs.existsSync(path.join(goneRoot, '已被删除的目录')));

// ---- 全程只读 ----
console.log('\n---- 全程没碰用户的原稿 ----');
const AFTER = fingerprint(REAL);
t('文件清单、大小、修改时间全部未变', AFTER === BEFORE,
  AFTER === BEFORE ? `${beforeCount} 个文件` : '⚠ 目录被改动了');

// ---- 读内容确实读得到（端到端真的能用） ----
console.log('\n---- 真的读得到内容 ----');
const first = pfs.read(PID, '章节内容/第一章.md');
t('能读到第一章.md 的内容', typeof first.content === 'string' && first.content.length > 500,
  `${first.content.length} 字符`);
t('读到的内容是真正的正文', first.content.includes('夜枫'));

fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.rmSync(goneRoot, { recursive: true, force: true });

console.log('\n==================================================');
console.log(fail === 0
  ? `通过 ${pass} / ${pass}  全部通过`
  : `通过 ${pass} / ${pass + fail}  ✗ 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);