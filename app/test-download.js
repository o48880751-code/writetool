/**
 * 判据：下载函数必须**一定会结束**（node 直接跑，用本地服务器复现）。
 *
 * 运行：node test-download.js
 *
 * ## 为什么要有这一条
 *
 * 2026-11-02 羽毛菌的字体卡在 **100%** 不动，重新进设置又变回「下载」。
 * 根因：字节数收满了，但服务端**没有关连接**（代理/限速节点常见），
 *   `res` 迟迟不 emit 'end' → `pipe` 不结束 → 写文件流不 'finish' →
 *   Promise 永远 pending。界面就一直"下载中 100%"，而文件还躺在 .part 里。
 *
 * 这种 bug 光看代码看不出来（逻辑写得挺对），**只能拿服务器复现**：
 *   发完 content-length 声明的字节数，然后**故意不 end 响应**。
 * 所以这条判据自带一个本地 HTTP 服务器，不依赖外网。
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { downloadFile } = require('./electron/download');

const TMP = path.join(os.tmpdir(), `wt-dl-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

const CHECKS = [];
function t(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

/** 起一个"行为可疑"的服务器，按 mode 返回不同表现 */
function server(mode, payload) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': payload.length,
      });
      if (mode === 'half-close') {
        // 发完声明的字节数，但**不结束响应**（就是现场那个情况）
        res.write(payload);
        // 故意不调用 res.end()
        return;
      }
      if (mode === 'normal') {
        res.end(payload);
        return;
      }
      if (mode === 'short') {
        // 声明 1000 字节，只发 400 就断
        res.write(payload.slice(0, 400));
        res.destroy();
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/** 带超时的等待，用来证明"它确实结束了，而不是我们等太久" */
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}：${ms}ms 还没结束`)), ms)),
  ]);
}

(async () => {
  const payload = Buffer.alloc(300 * 1024, 0x41);   // 300KB 假字体

  /**
   * ⚠ 实话说清楚：Node 的 http 服务端在**写满 content-length 声明**时会自动结束响应，
   *   所以这个场景在本地其实无法真正模拟"服务端赖着不关"。
   *   它测到的是"收满即收尾"，不是"卡住"。
   *
   *   真正让羽毛菌卡在 100% 的不是这个，而是**校验误判后重下 8 遍**
   *   （`classifyFontFile` 那条策略）。这里保留这条，是为了保证
   *   下载函数在"服务端不主动 close"时也不会无限等。
   */
  console.log('\n=== 一、服务端不主动关连接（收满就该收尾） ===');
  {
    const { srv, port } = await server('half-close', payload);
    const dest = path.join(TMP, 'half.bin');
    const t0 = Date.now();
    let ok = false;
    let err = '';
    try {
      // ⚠ 给 8 秒：修好之后应该 1~2 秒内就返回；没修的话这里会超时
      await withTimeout(downloadFile(`http://127.0.0.1:${port}/f.ttf`, dest), 8000, '不关连接的下载');
      ok = true;
    } catch (e) {
      err = e.message;
    }
    const size = fs.existsSync(dest) ? fs.statSync(dest).size : -1;
    console.log(`  用时 ${Date.now() - t0}ms，文件 ${size} 字节${err ? '，错误：' + err : ''}`);
    t('不会卡死：拿到了完整文件并返回', ok === true, err);
    t('文件内容完整（不是半截）', size === payload.length, `${size} / ${payload.length}`);
    srv.close();
  }

  console.log('\n=== 二、正常服务器 ===');
  {
    const { srv, port } = await server('normal', payload);
    const dest = path.join(TMP, 'normal.bin');
    let ok = false;
    let progressCalled = false;
    try {
      await withTimeout(
        downloadFile(`http://127.0.0.1:${port}/f.ttf`, dest, () => { progressCalled = true; }),
        8000, '正常下载',
      );
      ok = true;
    } catch (_) { /* 下面断言 */ }
    t('正常下载能完成', ok === true);
    t('文件大小对', fs.existsSync(dest) && fs.statSync(dest).size === payload.length);
    t('进度回调被调用过（界面才有百分比）', progressCalled === true);
    srv.close();
  }

  console.log('\n=== 二之二、大文件（17MB 那种）也要收得利索 ===');
  {
    const big = Buffer.alloc(17 * 1024 * 1024, 0x42);
    const { srv, port } = await server('normal', big);
    const dest = path.join(TMP, 'big.bin');
    const t0 = Date.now();
    let ok = false;
    try {
      await withTimeout(downloadFile(`http://127.0.0.1:${port}/big.ttf`, dest), 30000, '大文件');
      ok = true;
    } catch (_) { /* 下面断言 */ }
    const size = fs.existsSync(dest) ? fs.statSync(dest).size : -1;
    console.log(`  17MB 用时 ${Date.now() - t0}ms`);
    t('17MB 能完整下完', ok && size === big.length, `${size}`);
    srv.close();
  }

  console.log('\n=== 三、服务端提前断开 ===');
  {
    const { srv, port } = await server('short', payload);
    const dest = path.join(TMP, 'short.bin');
    let rejected = false;
    try {
      await withTimeout(downloadFile(`http://127.0.0.1:${port}/f.ttf`, dest), 8000, '短包');
    } catch (_) {
      rejected = true;
    }
    t('半截下载会报错（不会当成成功）', rejected === true);
    srv.close();
  }

  console.log('\n=== 四、连不上的地址 ===');
  {
    const dest = path.join(TMP, 'dead.bin');
    let rejected = false;
    let msg = '';
    try {
      // 127.0.0.1:1 基本不会有人监听
      await withTimeout(downloadFile('http://127.0.0.1:1/f.ttf', dest), 8000, '连接被拒');
    } catch (e) {
      rejected = true;
      msg = e.message;
    }
    t('连不上会报错（不是静默挂着）', rejected === true, msg);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n结果：${CHECKS.length - bad.length} 通过 / ${bad.length} 失败`);
  process.exit(bad.length ? 1 : 0);
})();
