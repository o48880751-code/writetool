#!/usr/bin/env node
'use strict';

/**
 * verify.js —— 判据批量运行器
 *
 * 仓库里有 70 个判据文件，写法统一：node <file>，断言失败则以非零码退出。
 * 其中一部分需要 Electron / TipTap / Playwright 等 npm 依赖，没装就跑不起来。
 * 本脚本静态扫描每个判据的 require，自动跳过依赖外部包的，只跑纯 Node 内置模块的。
 *
 * 用法：
 *   node verify.js            跑全部零依赖判据，打印逐项结果与汇总
 *   node verify.js --list     只列清单，标注哪些需要 npm
 *   node verify.js --ci       只跑核心集（CI 用），有任何失败即非零退出
 *   node verify.js --quiet     只打印失败项与汇总
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const BUILTIN = new Set(require('node:module').builtinModules);

/* CI 跑的核心集：覆盖工具协议、审批流、上下文守卫、数据迁移、检索、流式客户端。
 * 挑选标准是「纯内置模块 + 不依赖图形环境 + 跨平台无副作用」。 */
const CORE = [
  'test-mock.js',
  'db/test-db.js',
  'db/test-connections-skill.js',
  'editor/test-stream-client.js',
  'memory/test-drift.js',
  'memory/test-import.js',
  'memory/test-loop-guard.js',
  'memory/test-memory.js',
  'memory/test-style.js',
  'app/test-tool-protocol.js',
  'app/test-approval.js',
  'app/test-agent-loop.js',
  'app/test-scope-guard.js',
  'app/test-schema-migration.js',
  'app/test-markdown.js',
  'app/test-ctx-contract.js',
  'app/test-skill-router.js',
];

/* 需要 5 秒以上的判据单独放宽超时（默认 45 秒） */
const TIMEOUT_MS = 45000;

function discover(dir = ROOT, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === '.tmp-shot') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) discover(abs, out);
    else if (ent.name === 'test-mock.js' || /^test-.*\.js$/.test(ent.name)) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

/* 静态扫描 require：返回该判据用到的、非 Node 内置的包名 */
function externalDeps(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const deps = new Set();
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const id = m[1];
    if (id.startsWith('.') || id.startsWith('/')) continue;
    if (id.startsWith('node:')) continue;
    const bare = id.split('/')[0];
    if (BUILTIN.has(bare)) continue;
    deps.add(id);
  }
  return [...deps];
}

function run(rel) {
  const started = Date.now();
  try {
    execFileSync(process.execPath, [rel], {
      cwd: ROOT,
      timeout: TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, CI: process.env.CI || '' },
    });
    return { rel, ok: true, ms: Date.now() - started };
  } catch (err) {
    const raw = String(err.stderr || err.stdout || err.message || '');
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    return { rel, ok: false, ms: Date.now() - started, detail: lines.slice(-2).join(' / ').slice(0, 200) };
  }
}

function main() {
  const argv = new Set(process.argv.slice(2));
  const list = discover();
  const runnable = [];
  const needNpm = new Map();

  for (const rel of list) {
    const deps = externalDeps(rel);
    if (deps.length === 0) runnable.push(rel);
    else needNpm.set(rel, deps);
  }

  if (argv.has('--list')) {
    console.log(`判据文件 ${list.length} 个：零依赖 ${runnable.length}，需要 npm ${needNpm.size}\n`);
    console.log('零依赖（node verify.js 会跑）：');
    runnable.forEach((r) => console.log('  ' + r));
    console.log('\n需要 npm（先 npm --prefix app install）：');
    for (const [rel, deps] of needNpm) console.log(`  ${rel}  ← ${deps.join(', ')}`);
    return 0;
  }

  const target = argv.has('--ci') ? CORE.filter((r) => runnable.includes(r)) : runnable;
  const quiet = argv.has('--quiet');
  const label = argv.has('--ci') ? '核心集' : '零依赖判据';

  console.log(`跑${label} ${target.length} 个（共 ${list.length} 个判据文件，${needNpm.size} 个需要 npm 已跳过）\n`);

  const results = [];
  for (const rel of target) {
    const r = run(rel);
    results.push(r);
    if (!r.ok) console.log(`✗ ${rel}  (${r.ms}ms)\n    ${r.detail}`);
    else if (!quiet) console.log(`✓ ${rel}  (${r.ms}ms)`);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n' + '-'.repeat(56));
  console.log(`通过 ${passed} / 失败 ${failed}（${label}）`);
  if (failed) {
    console.log('失败项：');
    results.filter((r) => !r.ok).forEach((r) => console.log('  ' + r.rel));
  }
  return failed === 0 ? 0 : 1;
}

process.exit(main());
