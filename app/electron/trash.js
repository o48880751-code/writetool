/**
 * 回收站。
 *
 * ## 为什么不用操作系统的回收站
 *
 * 1. 系统回收站走的是 Explorer 的 shell API，**跨不了非注册目录**——
 *    而项目文件夹在 AppData 下，是用户的资料目录，
 *    用 shell 会绕过 `resolveIn` 的全部越界检查。
 * 2. 系统回收站不记录**原路径**。用户要还原时不知道该还原到哪，
 *    而"还原到哪"恰恰是删除操作里最容易出错的一步。
 * 3. 用户可能把项目文件夹整个拷到 U 盘、网盘，那些地方没有系统回收站。
 *
 * 所以自己实现，放在项目下的 `.trash/`。
 *
 * ## 数据结构
 *
 *   projects/<id>/.trash/
 *     index.json          ← 全部元信息（原路径、删除时间、类型）
 *     items/<唯一id>/      ← 被删的文件或文件夹本体
 *
 * 为什么本体要各自开一个目录而不是平铺：
 * 平铺的话两个同名文件（`卷纲/第一卷.md` 与 `设定/第一卷.md`）
 * 放进回收站会撞名。平铺 + 改名会把原路径信息搅在一起。
 *
 * ## 为什么 index.json 是「唯一真相源」而不是扫目录
 *
 * 元信息必须含**原路径**与**删除时间**，这两样在文件系统里取不到。
 * 所以必须有一份索引。而索引需要处理"条目被手工删了"的情况——
 * 读的时候要过滤掉实际不存在的项，不能因为索引陈旧就报错。
 */

const fs = require('node:fs');
const path = require('node:path');

const TRASH_DIR = '.trash';
const ITEMS_DIR = 'items';
const INDEX_FILE = 'index.json';

/** 唯一 id：时间戳 + 随机尾。排序后天然按时间递增 */
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class Trash {
  /**
   * @param {import('./project-fs.js').ProjectFs} pfs
   */
  constructor(pfs) {
    this.pfs = pfs;
  }

  /** 回收站根目录的绝对路径 */
  trashRoot(projectId) {
    return this.pfs.resolveIn(projectId, TRASH_DIR);
  }

  /**
   * 读**未过滤**的索引。
   *
   * readIndex 会剔除内容已丢失的条目（正常路径要这样），
   * 但错误提示需要区分「条目不存在」与「条目在、内容没了」——
   * 前者是 id 写错，后者是用户在文件管理器里手工清过。
   */
  _rawIndex(projectId) {
    const f = path.join(this.trashRoot(projectId), INDEX_FILE);
    if (!fs.existsSync(f)) return [];
    try {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  /** 读索引。文件不存在或损坏都返回空数组——不能因为索引坏了就进不去回收站 */
  readIndex(projectId) {
    const p = this.trashRoot(projectId);
    const f = path.join(p, INDEX_FILE);
    if (!fs.existsSync(f)) return [];
    try {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!Array.isArray(arr)) return [];
      // 过滤掉实际已被删掉的条目：用户可能直接在文件管理器里清了 items/
      // ⚠ 要查 items/<id>/<name>（本体是目录里的原名文件），
      //   查 items/<id> 本身会把「目录还在但内容被清」当成有效条目。
      return arr.filter((it) => {
        if (!it || !it.id || !it.origPath || !it.name) return false;
        try {
          return fs.existsSync(path.join(p, ITEMS_DIR, it.id, it.name));
        } catch (_) {
          return false;
        }
      });
    } catch (_) {
      // JSON 损坏：备份一份再当空的，否则用户既进不去也删不掉
      try { fs.renameSync(f, f + '.corrupt-' + Date.now()); } catch (_) {}
      return [];
    }
  }

  writeIndex(projectId, list) {
    const root = this.trashRoot(projectId);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, INDEX_FILE), JSON.stringify(list, null, 2), 'utf8');
  }

  /**
   * 放入回收站。
   *
   * @param {string} projectId
   * @param {string} relPath 项目内的相对路径
   * @returns {{id, name, origPath, type, deletedAt}}
   */
  add(projectId, relPath) {
    const src = this.pfs.resolveIn(projectId, relPath);
    if (!fs.existsSync(src)) throw new Error(`不存在：${relPath}`);

    // 不允许把回收站自己放进去 —— 否则会递归套娃
    const norm = String(relPath).replace(/\\/g, '/');
    if (norm === TRASH_DIR || norm.startsWith(TRASH_DIR + '/')) {
      throw new Error('回收站自己不能放进回收站');
    }

    const root = this.trashRoot(projectId);
    const id = makeId();
    const baseName = path.basename(src);
    const isDir = fs.statSync(src).isDirectory();

    /**
     * 本体的落点：`items/<id>/` 目录里放**原名**，也就是
     * `items/<id>/甲.md`。
     *
     * ⚠ 第一版直接 `fs.renameSync(src, path.join(root,'items',id))`，
     *   把文件重命名成了 `<id>` —— 于是 items 下全是 `mv4jler2-xxxx`，
     *   既看不出原名，还原时也找不到文件（目录也成了 ENOTDIR）。
     *   所以必须先建 `<id>` 目录、再把内容**移进去**。
     */
    const holder = path.join(root, ITEMS_DIR, id);
    fs.mkdirSync(holder, { recursive: true });
    const dest = path.join(holder, baseName);
    if (isDir) {
      // 目录整体移进去
      fs.renameSync(src, dest);
    } else {
      fs.renameSync(src, dest);
    }

    const stat = fs.statSync(dest);
    const entry = {
      id,
      name: baseName,
      origPath: norm,                          // 还原时要回的位置
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : stat.size,
      deletedAt: new Date().toISOString(),
    };
    const list = this.readIndex(projectId);
    list.push(entry);
    this.writeIndex(projectId, list);
    return entry;
  }

  /** 本体在 items 下的绝对路径 */
  itemPath(projectId, entry) {
    return path.join(this.trashRoot(projectId), ITEMS_DIR, entry.id, entry.name);
  }

  /** 列出回收站条目，按删除时间倒序（最近删的在前） */
  list(projectId) {
    const root = this.trashRoot(projectId);
    const out = this.readIndex(projectId).map((it) => {
      // 实时读一次大小：用户可能在别处改了 items/ 下的内容
      try {
        const st = fs.statSync(this.itemPath(projectId, it));
        return { ...it, size: it.type === 'dir' ? 0 : st.size, exists: true };
      } catch (_) {
        return { ...it, exists: false };
      }
    });
    out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    return out;
  }

  /**
   * 还原。
   *
   * ⚠ 原路径被占用时**绝不覆盖**，抛错让调用方决定。
   *   静默覆盖是数据丢失，而且用户不会知道自己刚丢了什么。
   *
   * @param {object} opts
   * @param {string} [opts.toPath] 改路径还原；不给则回原路径
   */
  restore(projectId, id, opts = {}) {
    const list = this.readIndex(projectId);
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) {
      /**
       * 区分两种「找不到」：
       *   - 索引里压根没有 → id 不对
       *   - 索引里有但内容被手工删了 → 用户能看懂发生了什么
       *
       * readIndex 已经把内容丢失的条目过滤掉了，所以这里要读原始索引
       * 才能判断。否则用户会看到「回收站里没有这一项」，
       * 而他明明刚删过——像是软件不认账。
       */
      let rawExists = false;
      try {
        const raw = this._rawIndex(projectId);
        rawExists = raw.some((x) => x && x.id === id);
      } catch (_) { /* 读不到就当没有 */ }
      throw new Error(rawExists
        ? '内容已被删除，无法还原'
        : '回收站里没有这一项');
    }
    const entry = list[idx];

    const src = this.itemPath(projectId, entry);
    if (!fs.existsSync(src)) throw new Error('内容已丢失，无法还原');

    const toRel = (opts.toPath || entry.origPath).replace(/\\/g, '/');
    // 还原目标同样要过越界检查：toPath 来自界面，不能信任
    const dest = this.pfs.resolveIn(projectId, toRel);
    if (fs.existsSync(dest)) {
      throw new Error(`原位置已有同名文件「${entry.name}」，请换个位置还原`);
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);

    list.splice(idx, 1);
    this.writeIndex(projectId, list);
    return { ok: true, restoredTo: toRel, name: entry.name };
  }

  /** 粉碎一个（永久删除，不进系统回收站——用户点的是"粉碎"） */
  purge(projectId, id) {
    const list = this.readIndex(projectId);
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: true, purged: 0 };
    const entry = list[idx];
    // 删整个 items/<id>/ 目录（本体是它里面的原名文件）
    const p = path.join(this.trashRoot(projectId), ITEMS_DIR, id);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    list.splice(idx, 1);
    this.writeIndex(projectId, list);
    return { ok: true, purged: 1, name: entry.name };
  }

  /** 清空回收站 */
  empty(projectId) {
    const list = this.readIndex(projectId);
    const itemsDir = path.join(this.trashRoot(projectId), ITEMS_DIR);
    if (fs.existsSync(itemsDir)) {
      fs.rmSync(itemsDir, { recursive: true, force: true });
    }
    this.writeIndex(projectId, []);
    return { ok: true, purged: list.length };
  }

  /** 统计 */
  stats(projectId) {
    const list = this.readIndex(projectId);
    return {
      count: list.length,
      bytes: list.reduce((s, x) => s + (x.size || 0), 0),
    };
  }
}

module.exports = { Trash, TRASH_DIR, ITEMS_DIR, INDEX_FILE };