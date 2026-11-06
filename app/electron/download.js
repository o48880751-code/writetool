/**
 * 单文件下载（带进度与重定向跟随）。
 *
 * ## 为什么单独一个文件
 *
 * 2026-11-02 的一次事故：进度条**卡在 100%**，重新进设置又变回「下载」。
 * 原因是字节收满之后服务端不关连接，`res` 迟迟不 emit 'end' →
 * `pipe` 不结束 → 写流不 'finish' → Promise 永远 pending。
 *
 * 这类卡住没法靠看代码发现，只能靠``(发完数据但不关连接)``的本地服务器复现。
 * 所以把函数挪出来，让判据能直接打它（main.js 判据 require 不了）。
 */

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    /**
     * ⚠⚠ 这个函数必须**自己保证一定会 settle**。
     *
     * 现场：进度条卡在 100%，重新进设置又变回「下载」。
     * 原因：字节数已经收满，但服务端**没有关连接**（代理/限速节点常见），
     * `res` 迟迟不 emit 'end' → `pipe` 不结束 → 写文件流不 'finish' →
     * Promise 永远 pending。界面就一直挂在"下载中 100%"，
     * 而文件其实没落地（它还在 .part 里），下次进来当然是"未安装"。
     *
     * 所以：**收满就是收满**，不再等 'end'；另外还有两道兜底
     * （停滞超时、总时长上限）。
     */
    let settled = false;
    let hardTimer = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      fn(v);
    };

    const run = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) return done(reject, new Error('字体下载重定向过多'));
          res.resume();
          return run(new URL(res.headers.location, u).href, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return done(reject, new Error(`字体下载失败 HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let loaded = 0;
        let drained = false;
        const ws = fs.createWriteStream(dest);

        /** 收满之后等 write 流把缓冲区刷完就完事，不等 'end' */
        const finishWhenDrained = () => {
          if (settled) return;
          if (ws.writableFinished) return done(resolve, dest);
          ws.once('finish', () => done(resolve, dest));
          // 流卡住也别赖着
          setTimeout(() => {
            if (!settled) {
              try { ws.end(); } catch (_) { /* 已结束 */ }
              done(reject, new Error('文件写入没有完成'));
            }
          }, 15000);
        };

        res.on('data', (c) => {
          loaded += c.length;
          if (total && onProgress) onProgress(loaded, total);
          // ⚠ 收满即视为完成（服务端不关连接也不会卡死）
          if (total && loaded >= total && !drained) {
            drained = true;
            finishWhenDrained();
          }
        });
        res.pipe(ws);
        ws.on('finish', () => done(resolve, dest));
        ws.on('error', (e) => done(reject, e));
        res.on('error', (e) => done(reject, e));
      });
      req.on('error', (e) => done(reject, e));
      req.setTimeout(60000, () => {
        req.destroy(new Error('字体下载卡住了（60 秒没有任何数据）'));
      });
      // 总时长上限：17MB 在慢网下也就一两分钟，超过 5 分钟一定是出问题了
      hardTimer = setTimeout(() => {
        try { req.destroy(); } catch (_) { /* 已结束 */ }
        done(reject, new Error('字体下载超过 5 分钟，已放弃'));
      }, 300000);
    };
    run(url, 0);
  });
}

module.exports = { downloadFile };
