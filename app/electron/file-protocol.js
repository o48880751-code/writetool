/**
 * 项目内图片协议 `wtfile://<项目id>/<相对路径>`。
 *
 * ## 为什么单独一个文件
 *
 * 一是 main.js 已经 4700 行了；二是这段有**安全边界**（路径穿越），
 * 必须能被判据直接打到 —— 埋在 main.js 里就只能靠"启整个应用"来测，
 * 而那种测试跑起来慢、还容易因为别的原因失败，最后没人愿意跑。
 *
 * ## 只读、只给图片
 *
 * ⚠ 越界保护**不在这里重写**：直接用 `pfs.resolveIn`。
 *   那是全项目唯一一处"把不可信路径关进项目目录"的地方。
 *   在这儿再抄一份判据，早晚会和它长得不一样 ——
 *   而两个判据里只要有一个写漏，就是任意文件读取。
 */

const path = require('node:path');
const fs = require('node:fs');

/** 能认的扩展名（也是白名单：别的后缀一律 403） */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function forbidden() { return new Response('forbidden', { status: 403 }); }

/**
 * @param {{resolveIn:(pid:string, rel:string)=>string}} pfs
 * @returns {(req: Request) => Response}
 */
function makeWtfileHandler(pfs) {
  return function handleWtfile(request) {
    try {
      const u = new URL(request.url);
      // ⚠ 标准 scheme 下 `wtfile://<pid>/a/b.png` 里的 pid 落在 **hostname** 上，
      //   只看 pathname 会把项目 id 丢掉（appbg 也踩过同一个坑）。
      const pid = u.hostname;
      const rel = decodeURIComponent((u.pathname || '').replace(/^\/+/, ''));
      if (!pid || !rel) return forbidden();

      const ext = path.extname(rel).toLowerCase();
      if (!MIME[ext]) return forbidden();

      // resolveIn 会拒绝非法 pid、绝对路径、`..` 越界
      const fp = pfs.resolveIn(pid, rel.split('/').join(path.sep));
      const buf = fs.readFileSync(fp);

      return new Response(buf, {
        headers: {
          'content-type': MIME[ext],
          'access-control-allow-origin': '*',
          // 封面是"换了一张立刻要看到"的东西
          'cache-control': 'no-store, must-revalidate',
        },
      });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  };
}

module.exports = { makeWtfileHandler, WTFILE_MIME: MIME };
