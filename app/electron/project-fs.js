/**
 * 项目文件夹：每个小说一个独立目录。
 *
 * ## 为什么单独一个模块
 *
 * 文件读写是**唯一一处**用户数据可能被任意路径触达的地方。
 * 渲染进程（React）传过来的是纯字符串，没有类型、没有范围约束。
 * 所以这里的每一个入口都必须先过 `resolveIn`——把不可信输入
 * 约束到项目目录内，越界直接抛错。
 *
 * ## 目录结构（2026-10-13 起）
 *
 *   %APPDATA%/writetool/projects/<projectId>/
 *     设定/
 *       世界观.md
 *       人物库.md
 *       时空设定.md          ← 用户自己加
 *     卷纲/
 *       第一卷.md
 *     章节/
 *       第一章.md
 *       章节摘要.md          ← 跨卷的主线脉络，放在章节里
 *
 *   一句话：**根目录下不放正文性质的文件**，一切小说内容都归到三个文件夹里。
 *
 *   ⚠⚠ 2026-10-16 改动：`章节摘要.md` 从根挪进 `章节/`。
 *     上一版是"刻意留在根"（理由：它跨卷，塞进某一卷会像只管那一卷），
 *     但羽毛菌看到树上那三个文件排在最后一个文件夹后面、以为它们是章节的孩子，
 *     原话：「这三个文件为什么是项目根目录，这些文件应该是放在章节文件夹下面的啊」。
 *     **根目录出现在树里就是歧义** —— 排在最下面、看着像最后一个文件夹的孩子。
 *     所以不再往根放任何内容文件。
 *
 * ## 为什么不用 chapter 正文
 *
 * 章节正文仍在 SQLite 里（`chapters` 表），文件系统只放**资料**。
 * 理由：正文要参与检索、参与风格画像统计、要跟着项目备份走 SQLite 的事务；
 * 而资料是给人看的文件，用 md 存可以随时用任何编辑器打开。
 * 两套并存但职责不重叠。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 建项目时生成的初始资料。
 *
 * ## 2026-10-13 重做：为什么根目录不再散落一堆 md
 *
 * 羽毛菌的原话：「新建项目之后，只给三个文件夹，设定、卷纲、章节。
 * 卷纲和章节都是空文件夹。设定文件夹里，初始只有世界观和人物库」。
 *
 * 原来的模板是**四个 md 平铺在根 + 三个空文件夹**：
 *
 *     世界观.md  人物库.md  章节摘要.md  灵感碎片.md
 *     卷纲/  章节/  设定/
 *
 * 问题不在"多"，在**看不出这些文件属于哪个文件夹**——
 * 文件夹里各躺一个"说明.md"，根上又散着四个文件，
 * 文件树第一屏就是"设定/章节/卷纲 + 一堆不知哪来的 md"。
 * 而"世界观、人物库"本来就是设定条目，跟「设定」文件夹里的其它资料是一类。
 *
 * 现在的结构：
 *
 *     设定/世界观.md      ← 设定条目归设定
 *     设定/人物库.md
 *     卷纲/               ← 空。用户的大纲还没写，先占个位
 *     章节/章节摘要.md     ← 跨卷的主线脉络（2026-10-16 从根挪进来）
 *
 * ⚠ 章节摘要**不再留在根**：根上放文件，在树上会排到最后一个文件夹后面，
 *   看着就像那个文件夹的孩子（羽毛菌 2026-10-16 的原话：
 *   「这三个文件为什么是项目根目录，这些文件应该是放在章节文件夹下面的啊」）。
 *   宁可它待在"章节"里语义上略糙，也不要让用户每次都在猜"这个文件归谁"。
 *
 * ⚠ 灵感碎片**从模板里去掉了**，因为它已经是「脑洞」工具的文件
 *   （ToolsPanel 的 TOOLS[2].file）。模板里再放一份，等于同一件事有两个入口，
 *   而工具面板那个是带输入框的、能持续追加的。
 *
 * ⚠ 卷纲/章节是**真空目录**，不放"说明.md"占位。
 *   原来的理由是"空目录在 Windows 上不显眼"，但那是指"用户以为是删错了"——
 *   而现在文件树会显示空目录（后面有 (空) 标记），占位文件反而添乱。
 */
/**
 * 新建项目时种下的三个文件。
 *
 * ⚠⚠ **只留标题，正文空的**（2026-10-15 羽毛菌：「这个世界观.md是干什么的，
 *   不要这么多提醒，下面已经有个世界观.md了」）。
 *
 * 原来三个模板都是一堆空小节骨架：
 *   # 世界观 / ## 地理 / ## 势力 / ## 力量体系 / ## 历史 / - （空条目）…
 * 而**第 4 栏的「设定」里本来就有世界观这个条目**，两处重复；
 * 更要紧的是那些 `## 地理` + 空 `-` 看起来像"提醒你该填什么"，
 * 打开就是一片空标题 —— 看着像软件在催他，实际什么也没说。
 *
 * 现在只留 `# 世界观` 一个标题，其余自己写。
 * ⚠ 仍然要留着这三个文件本身：系统提示里点名了 `设定/世界观.md`，
 *   模型的 write_note 得有个落点；文件不存在的话它会先去创建，
 *   多一次写盘、也多一次失败的可能。
 */
const TEMPLATE_FILES = {
  '设定/世界观.md': '# 世界观\n',
  '设定/人物库.md': '# 人物库\n',
  '章节/章节摘要.md': '# 章节摘要\n',
};

/** 建项目时生成的空目录。刻意是空的——用户没写的东西不该替他写。 */
/**
 * 建项目时生成的空目录，**顺序即默认显示顺序**（手动排序档下不重排）。
 *
 * ⚠ 2026-10-15 羽毛菌：「这个目录里的文件夹默认顺序，应该是设定，卷纲，章节」。
 *   原来写的是 卷纲、章节、设定，于是打开就看到 卷纲 在最上面 ——
 *   而「设定」才是写小说时最常看的一栏。
 */
const TEMPLATE_DIRS = ['设定', '卷纲', '章节'];

/** 单个文件名上限，防止 Windows MAX_PATH 260 被打爆 */
const MAX_NAME = 80;

/** 允许的扩展名——只放行 md 与文本，挡住 exe / bat 这类可执行内容 */
const ALLOWED_EXT = new Set(['.md', '.txt', '.markdown']);

/**
 * 会**压过 .order.json** 的三档排序。
 *
 * ⚠ 'manual' 不在这里：它是"听 .order.json 的"，不是一种排法。
 *   故意只列三个 —— 将来加档位时，这里漏一个就会变成
 *   "界面上的按钮存在，但点了顺序没变"。
 */
const SORT_BY_NAME = ['name', 'modified', 'size'];

// 顺序存储（拖拽排序）。同一目录内 require，不走上层路径——
// 打包后模块在 asar 里，跨目录 require 会找不到。
const {
  applyOrder, recordLayer, reorderNames, readOrder, normDir, isAncestorPath,
} = require('./tree-order.js');

/**
 * 模板目录的显示优先级；不在表里的排最后。
 *
 * ⚠⚠ 2026-10-16 羽毛菌第二次报同一件事：
 *   「新建项目之后，设定文件夹在最上面，中间的是卷纲，你没修好」。
 *
 *   上一轮我只改了 `TEMPLATE_DIRS` 的**数组顺序**（卷纲,章节,设定 → 设定,卷纲,章节），
 *   以为"建目录的顺序 = 显示的顺序"。**没用**，因为真正的排序发生在别处：
 *     ① `tree()` 默认档是 'manual'，而顺序表（.order.json）为空时**落回按名字排**；
 *     ② 而 `localeCompare(x, 'zh')` 是**拼音序** —— juan(卷) < she(设) < zhang(章)，
 *        算出来正好是 卷纲 / 设定 / 章节，把建目录的顺序整个盖掉。
 *   ⚠ 教训：**改常量不等于改行为**。TEMPLATE_DIRS 只决定 mkdir 的先后，
 *     而它是"数据"，显示顺序是"逻辑"，两者之间还隔着一次排序。
 *     报同一件事第二次时，先去找那个把它盖掉的东西，别再把常量换个位置。
 */
function dirRank(name) {
  const i = TEMPLATE_DIRS.indexOf(name);
  return i === -1 ? TEMPLATE_DIRS.length : i;
}

/**
 * 目录内"一个名字"的显示比较器 —— **全项目唯一**的那一份。
 *
 * ⚠ 谁都要用它：`sortNodes`（界面显示）、`byName`（拖拽时算"屏幕上是什么样"）、
 *   `nameComparator`（顺序表里没登记的项往哪插）。
 *   三处但凡有一处偷偷用拼音序，就会变成
 *   「显示是一套、拖一下之后顺序突然变了」——用户会认为拖拽把目录搞乱了。
 */
function cmpName(a, b) {
  const ar = dirRank(a);
  const br = dirRank(b);
  if (ar !== br) return ar - br;
  return a.localeCompare(b, 'zh');
}

/**
 * 排序规则。
 *
 * ⚠ 目录永远排在文件前面，不管按什么排。
 *   混排时用户找不到文件夹、也拖不动它——
 *   文件树的基本预期是「先目录、后文件」。
 *
 * @param {'name'|'modified'|'size'} by
 */
function sortNodes(nodes, by) {
  const arr = [...nodes];
  arr.sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;

    if (by === 'modified') {
      const at = a.mtime ? Date.parse(a.mtime) : 0;
      const bt = b.mtime ? Date.parse(b.mtime) : 0;
      // 时间相同则回退到名称，保证排序稳定（不每次刷新都跳动）
      if (at !== bt) return bt - at;
    } else if (by === 'size') {
      if (a.size !== b.size) return b.size - a.size;
    }
    // name 档、以及时间/大小打平之后，都走 cmpName ——
    // 「设定」的优先级就是在这一层生效的（模板目录给 rank，其余按拼音）
    return cmpName(a.name, b.name);
  });
  return arr;
}

class ProjectFs {
  /**
   * @param {string} projectsRoot 所有项目文件夹的父目录
   */
  constructor(projectsRoot) {
    this.root = projectsRoot;
    /**
     * 项目 ID → 外部目录绝对路径的映射（"导入已有小说文件夹"用）。
     *
     * ⚠ 为什么需要它：项目原本一律建在 `userData/projects/<id>` 下。
     *   但用户可能已经有一个写了很久的小说文件夹在别处
     *   （还配着一整套自己的整理脚本），复制一份进去等于立刻分叉，
     *   两份从此对不上。**原地指过去**才是他要的。
     *
     * 只存主进程内存，不落库：项目文件夹被移走/改名后，
     * 重启后绑定自然失效，界面提示重新绑定即可 ——
     * 落一个绝对路径进库，只会在几个月后变成一堆看不懂的失效记录。
     */
    this.externalDirs = new Map();
  }

  /**
   * 把项目 ID 绑到一个已有的外部目录。之后所有读写都发生在那里。
   * @param {string} projectId
   * @param {string} dirAbs 绝对路径
   */
  bindExternal(projectId, dirAbs) {
    this.externalDirs.set(projectId, path.resolve(dirAbs));
  }

  /** 解除绑定，回到 `userData/projects/<id>`。文件夹本身不动。 */
  unbindExternal(projectId) {
    return this.externalDirs.delete(projectId);
  }

  /** 该项目是否绑定了外部目录 */
  isExternal(projectId) {
    return this.externalDirs.has(projectId);
  }

  /**
   * 项目根目录的唯一解析入口。
   *
   * ⚠ 全模块只有这里能把 projectId 变成绝对路径。
   *   之前散在 7 处各自 `path.resolve(this.root, projectId)`，
   *   漏掉一处就是一个「读到 A 项目、写进 B 项目」的串档 bug。
   */
  _dir(projectId) {
    const ext = this.externalDirs.get(projectId);
    return ext ? ext : path.resolve(this.root, projectId);
  }

  /**
   * 把不可信相对路径解析成绝对路径，并确认仍在项目目录内。
   *
   * ⚠ 这是整个模块的安全底线。三道检查：
   *   1. 拒绝绝对路径与盘符（C:\ / D:\ / \\server\share）
   *   2. 解析后用 path.relative 判断是否以 .. 开头或为空
   *   3. 用 path.resolve 后的**真实路径**（跟随已有的符号链接）
   *
   * 只做 1+2 不够：项目目录里若有一个指向外部的符号链接，
   * 第 3 步的 realpath 会把它挡下来。
   */
  resolveIn(projectId, relPath) {
    if (!projectId || /[\\/]/.test(projectId) || projectId.includes('..')) {
      throw new Error(`非法项目 ID：${projectId}`);
    }
    const base = this._dir(projectId);
    const rel = String(relPath == null ? '' : relPath).trim();

    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
      throw new Error(`不允许绝对路径：${rel}`);
    }
    // 归一化分隔符，统一按 posix 语义处理
    const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.resolve(base, norm);

    const relative = path.relative(base, abs);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`路径越界（只能访问项目目录内）：${rel}`);
    }

    // 跟随符号链接再确认一次。目录不存在时 realpath 会失败，
    // 那正是「新建文件」的场景，此时父目录存在即可校验。
    try {
      const real = fs.realpathSync(abs);
      const realBase = fs.realpathSync(base);
      const rr = path.relative(realBase, real);
      if (rr.startsWith('..') || path.isAbsolute(rr)) {
        throw new Error(`路径越界（符号链接指向项目外）：${rel}`);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        const parent = path.dirname(abs);
        if (fs.existsSync(parent)) {
          const realParent = fs.realpathSync(parent);
          const pr = path.relative(fs.realpathSync(base), realParent);
          if (pr.startsWith('..') || path.isAbsolute(pr)) {
            throw new Error(`路径越界（父目录在项目外）：${rel}`);
          }
        }
      } else {
        throw e;
      }
    }
    return abs;
  }

  /** 项目文件夹是否已存在 */
  exists(projectId) {
    return fs.existsSync(this._dir(projectId));
  }

  /**
   * 建项目文件夹 + 初始模板。幂等：已存在就直接返回，不覆盖用户改过的内容。
   */
  ensureProject(projectId) {
    const dir = this._dir(projectId);
    // ⚠ 外部目录**一个字都不许写**，包括模板。
    //
    // 目录还在时下面的 existsSync 会早退，看起来没事；
    // 但用户哪天把这个文件夹挪走或改名了，重开项目就会在
    // userData 里凭空建一个新的、带模板的空项目 —— 用户写了几百章的
    // 原稿"变成"了一个空文件夹，而他毫不知情。宁可报错。
    if (this.isExternal(projectId) && !fs.existsSync(dir)) {
      throw new Error(`导入的文件夹不存在了（可能已被移动或改名）：${dir}\n请在项目列表里重新绑定。`);
    }
    if (fs.existsSync(dir)) return { created: false, dir };
    fs.mkdirSync(dir, { recursive: true });
    // ⚠ 目录必须**先**建。模板文件里有 '设定/世界观.md' 这种带路径的，
    //   先写文件的话 writeFileSync 会因为父目录不存在而抛 ENOENT，
    //   而且是建到一半才抛——项目文件夹建了一半、进程挂掉。
    for (const d of TEMPLATE_DIRS) {
      fs.mkdirSync(this.resolveIn(projectId, d), { recursive: true });
    }
    for (const [name, content] of Object.entries(TEMPLATE_FILES)) {
      // 文件名是内置常量，仍走 resolveIn 保持单一入口
      const abs = this.resolveIn(projectId, name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
    return { created: true, dir };
  }

  /** 项目根的绝对路径（给"在文件管理器中打开"用） */
  projectDir(projectId) {
    return this._dir(projectId);
  }

  /**
   * 统计项目里有多少文件、多少目录、合计多少字。
   *
   * 导入完要给用户一个"到底装进来多少东西"的交代，
   * 否则他面对一个陌生文件夹，无法判断导入成功了没有。
   *
   * ⚠ 单个文件读失败**不**让整体失败：统计是给人看的交代，
   *   一个文件读不到（比如编码异常）不该让"导入成功"变成"导入失败"。
   */
  countTree(projectId) {
    const t = this.tree(projectId);
    let files = 0, dirs = 0, chars = 0;
    const walk = (n) => {
      for (const c of n.children || []) {
        if (c.type === 'dir') { dirs++; walk(c); continue; }
        files++;
        if (c.ext !== '.md' && c.ext !== '.txt') continue;
        try {
          const s = fs.readFileSync(this.resolveIn(projectId, c.path), 'utf8');
          // 粗略字数：去掉空白。刻意不引markdown-render 的 mdStat ——
          // 那是为了给渲染器用的，这里只要一个量级，别把渲染层拖进文件系统层。
          chars += s.replace(/\s+/g, '').length;
        } catch (_) { /* 读不到就算了 */ }
      }
    };
    walk(t);
    return { fileCount: files, dirCount: dirs, charCount: chars };
  }

  /**
   * 递归读目录，返回树。
   *
   * 只收 md/txt。理由：项目文件夹里可能有 .db-wal、.git 等，
   * 全收进来会让树变成噪音，而树的价值在于**快速找到资料**。
   *
   * @param {object} opts
   * @param {number} opts.maxDepth 默认 6，防止软链接成环导致无限递归
   * @param {string} [opts.sort] 'manual' | 'name' | 'modified' | 'size'
   *   **'manual'（默认）= 有 .order.json 就用它**，没有才按名字。
   *   其余三档是**用户主动选的排序方式**，会压过 .order.json。
   *   理由：用户拖出来的顺序只在「手动」这一档有意义——
   *   他要是明确点了「按时间」，却因为某个文件夹碰巧被拖过而
   *   看到顺序没变，第一反应就是「这控件坏了」。
   */
  tree(projectId, opts = {}) {
    const maxDepth = opts.maxDepth ?? 6;
    const sortBy = SORT_BY_NAME.includes(opts.sort) ? opts.sort : 'manual';
    const base = this.projectDir(projectId);
    if (!fs.existsSync(base)) return { name: path.basename(base), type: 'dir', children: [] };

    const walk = (dir, rel, depth) => {
      let items = [];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return [];
      }
      // 先按名字排一遍，让「按时间/大小」排序时同类的相对次序也是稳定的
      items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

      const nodes = [];
      for (const it of items) {
        if (it.name.startsWith('.')) continue;             // 隐藏文件与 .git
        const childRel = rel ? path.join(rel, it.name) : it.name;
        if (it.isDirectory()) {
          if (depth >= maxDepth) {
            nodes.push({ name: it.name, type: 'dir', path: childRel, children: [], truncated: true });
            continue;
          }
          nodes.push({ name: it.name, type: 'dir', path: childRel, children: walk(path.join(dir, it.name), childRel, depth + 1) });
        } else if (it.isFile()) {
          const ext = path.extname(it.name).toLowerCase();
          if (!ALLOWED_EXT.has(ext)) continue;
          let size = 0;
          let mtime = null;
          try {
            const st = fs.statSync(path.join(dir, it.name));
            size = st.size;
            mtime = st.mtime.toISOString();
          } catch (_) { /* 读不到就当空，不影响树 */ }
          nodes.push({ name: it.name, type: 'file', path: childRel, ext, size, mtime });
        }
      }
      // 顺序表 vs 显式排序：**谁赢取决于 sortBy**。
      //
      // sortBy === 'manual' → 顺序表优先。这保住「我刚拖好的顺序，
      //   刷新一次别乱」这个承诺，而拖拽是文件树里最常用的操作。
      // sortBy 是 name/modified/size → 用户主动选了就听他的，
      //   顺序表在这一层作废。
      //
      // ⚠ 两套规则不能混：这一层**要么**完全按顺序表，**要么**完全按 sortNodes。
      //   中间状态（顺序表为空却保留 readdir 的拼音序）会让目录与文件交错显示
      //   （卷纲 / 灵感碎片.md / 设定 / 世界观.md…），而 tree() 之前一直承诺
      //   "目录在前"。实测就是这里出的问题。
      const layerOrder = order?.dirs[normDir(rel)];
      const useOrder = sortBy === 'manual'
        && Array.isArray(layerOrder) && layerOrder.length;
      return useOrder
        ? applyOrder(nodes, layerOrder, nameComparator)
        : sortNodes(nodes, sortBy === 'manual' ? 'name' : sortBy);
    };

    const order = readOrder(base);
    return { name: path.basename(base), type: 'dir', path: '', children: walk(base, '', 0) };
  }

  /** 读文件内容。返回 {content, size, mtime}；不存在抛错。 */
  read(projectId, relPath) {
    const abs = this.resolveIn(projectId, relPath);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('不是文件');
    // 一次读 Buffer 再转字符串：避免大文件时按字节切片切出半个多字节字符
    const buf = fs.readFileSync(abs);
    return {
      content: buf.toString('utf8'),
      size: st.size,
      mtime: st.mtime.toISOString(),
    };
  }

  /** 写文件（覆盖）。自动建父目录。 */
  write(projectId, relPath, content) {
    const abs = this.resolveIn(projectId, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const text = String(content == null ? '' : content);
    fs.writeFileSync(abs, text, 'utf8');
    return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
  }

  /**
   * 新建文件 / 文件夹。
   *
   * 同名时**直接报错**，不静默覆盖——覆盖用户的资料是不可逆的。
   */
  create(projectId, relPath, opts = {}) {
    const abs = this.resolveIn(projectId, relPath);
    if (fs.existsSync(abs)) throw new Error(`已存在：${relPath}`);
    if (opts.dir) {
      fs.mkdirSync(abs, { recursive: true });
      return { ok: true, type: 'dir' };
    }
    const ext = path.extname(relPath).toLowerCase();
    if (ext && !ALLOWED_EXT.has(ext)) {
      throw new Error(`只允许 ${[...ALLOWED_EXT].join(' / ')}，收到 ${ext}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const seed = opts.content != null ? String(opts.content) : `# ${path.basename(relPath, ext)}\n\n`;
    fs.writeFileSync(abs, seed, 'utf8');
    return { ok: true, type: 'file', bytes: Buffer.byteLength(seed, 'utf8') };
  }

  /** 重命名 / 移动。目标已存在时同样拒绝覆盖。 */
  rename(projectId, fromPath, toPath) {
    const from = this.resolveIn(projectId, fromPath);
    const to = this.resolveIn(projectId, toPath);
    if (!fs.existsSync(from)) throw new Error(`源不存在：${fromPath}`);
    if (fs.existsSync(to)) throw new Error(`目标已存在：${toPath}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { ok: true };
  }

  /** 删除文件或空目录。recursive=true 才允许删非空目录。 */
  remove(projectId, relPath, opts = {}) {
    // 删整个项目文件夹是唯一允许"空相对路径"的操作。
    // 这个口子只能由主进程在删除项目时调用，
    // 渲染进程拿不到它——fs:remove 通道传进来的 relPath 必然非空
    // （resolveIn 对空字符串会抛「路径越界」）。
    if (opts.rootDelete) {
      if (!projectId || /[\\/]/.test(projectId) || projectId.includes('..')) {
        throw new Error(`非法项目 ID：${projectId}`);
      }
      const dir = this._dir(projectId);
      // ⚠⚠ 绑定了外部目录的项目，**绝不能在这里删文件夹**。
      //
      // 那个文件夹不是软件建的，是用户自己的原稿（可能还是几百章），
      // 软件对它只有读写的权限，没有删除的权限。
      //
      // 下面那句 path.relative 检查其实会顺带挡住它（外部目录不在 root 下，
      // 算出 .. 就抛错）——但那是**巧合**，报错还会显示成「路径越界」，
      // 让人以为是 bug。这里显式挡掉，意图写在代码里而不是靠副作用。
      if (this.isExternal(projectId)) {
        throw new Error('这是导入的外部文件夹，不会被删除。如需清理请到文件管理器里手动处理。');
      }
      // 再确认一次 dir 确实在 projects 根下（防 projectId 是符号链接）
      const rel = path.relative(path.resolve(this.root), dir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('路径越界：项目文件夹不在预期位置');
      }
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true, type: 'dir', root: true };
    }

    const abs = this.resolveIn(projectId, relPath);
    if (!fs.existsSync(abs)) throw new Error(`不存在：${relPath}`);
    if (!opts.recursive && fs.statSync(abs).isDirectory()) {
      const left = fs.readdirSync(abs);
      if (left.length) throw new Error('目录非空，删除需要勾选「含子内容」');
      fs.rmdirSync(abs);
      return { ok: true, type: 'dir' };
    }
    if (opts.recursive) {
      fs.rmSync(abs, { recursive: true, force: true });
    } else {
      fs.unlinkSync(abs);
    }
    return { ok: true };
  }

  /**
   * 移动文件 / 目录。拖拽的落点，跨目录与同目录重排都走这里。
   *
   * ## 为什么与 rename 分开
   *
   * `rename` 是"换个名字"，语义上 from 与 to 的父目录通常相同；
   * 拖拽的语义是"挪到别处去"，还要更新顺序表。
   * 混在一起的话，rename 也要去动顺序表——而重命名不该改变顺序。
   *
   * @param {string} fromRel 源相对路径
   * @param {string} toDirRel 目标目录相对路径（'' 表示项目根）
   * @param {object} [opts]
   * @param {'before'|'after'} [opts.place] 落在目标目录里、名为 toDirRel 的那一项之前还是之后
   * @param {string} [opts.anchor] 锚点项名；给了才算这一目录里的位置
   * @returns {{ok:true, moved:boolean, from:string, to:string}}
   */
  move(projectId, fromRel, toDirRel, opts = {}) {
    const fromPath = normDir(fromRel);
    const toDir = normDir(toDirRel);

    if (!fromPath) throw new Error('没有要移动的项');
    const src = this.resolveIn(projectId, fromPath);
    if (!fs.existsSync(src)) throw new Error(`源不存在：${fromRel}`);

    // ⚠ 父目录要用 dirname 算，不能用 `replace(/[/\\][^/\\]*$/,'')`——
    //   那个正则要求路径里含分隔符，顶层文件「甲.md」匹配不上，
    //   会把自身当成父目录，于是 name 算成空串、
    //   移动时报「目标已有同名「」」（第一版就这么错的，19 条用例一起红）。
    const srcParent = normDir(path.posix.dirname(fromPath));
    const name = path.posix.basename(fromPath);

    // ---- 目标目录必须存在且是目录 ----
    let dstDirAbs;
    if (toDir) {
      dstDirAbs = this.resolveIn(projectId, toDir);
      if (!fs.existsSync(dstDirAbs)) throw new Error(`目标目录不存在：${toDir}`);
      if (!fs.statSync(dstDirAbs).isDirectory()) throw new Error(`目标不是文件夹：${toDir}`);
    } else {
      dstDirAbs = path.resolve(this.projectDir(projectId));
    }

    // ---- 成环检查 ----
    // 文件系统允许把目录移进自己的后代（Windows 会拒绝一部分，
    // 但 POSIX 与某些 Windows 场景会成功），而一旦成环，
    // 之后 tree() 会无限递归、那个分支再也拿不到内容——
    // 而且用户看不出发生了什么，只觉得"文件夹里东西丢了"。
    if (isAncestorPath(fromPath, toDir)) {
      throw new Error(`不能把「${name}」移进它自己的子目录`);
    }
    // 移进自己所在目录的"自己"（同级重排）不算环，但要短路掉移动动作
    const sameDir = srcParent === toDir;

    let dst = path.join(dstDirAbs, name);
    const dstRel = toDir ? `${toDir}/${name}` : name;

    // 同级重排 + 目标就是自己 → 只改顺序，不动磁盘
    if (sameDir && dstRel === fromPath) {
      this._recordSiblingOrder(projectId, srcParent, name, opts.anchor, opts.place);
      return { ok: true, moved: false, from: fromPath, to: fromPath };
    }

    // 目标已存在：拒绝覆盖。资料是用户的东西，不能因为一次拖拽没了。
    if (fs.existsSync(dst)) throw new Error(`目标已有同名「${name}」，换个名字或先移走它`);

    if (!sameDir) {
      fs.renameSync(src, dst);
      // 从原目录的顺序表里摘掉
      this._forgetInLayer(projectId, srcParent, name);
    }

    // 落点排序
    this._recordSiblingOrder(projectId, toDir, name, opts.anchor, opts.place);

    return { ok: true, moved: !sameDir, from: fromPath, to: dstRel };
  }

  /**
   * 把 name 记到 dirRel 这一层的顺序里，位置由 anchor + place 决定。
   *
   * 没有 anchor 时追加到末尾——那是"拖进文件夹"的语义：
   * 移动本身已经决定了它在新目录里的存在，位置无所谓。
   */
  _recordSiblingOrder(projectId, dirRel, name, anchor, place) {
    const absDir = dirRel ? this.resolveIn(projectId, dirRel) : this.projectDir(projectId);
    let onDisk = [];
    try {
      onDisk = fs.readdirSync(absDir, { withFileTypes: true })
        .filter((it) => !it.name.startsWith('.'))
        .map((it) => it.name);
    } catch (_) {
      return;   // 目录读不到就不记顺序，界面下次仍能显示
    }

    const base = this.projectDir(projectId);
    const order = readOrder(base);
    const key = normDir(dirRel);
    const existing = Array.isArray(order.dirs[key]) ? order.dirs[key] : [];

    // ⚠⚠ 关键：没入表的项，基准顺序必须是**用户在屏幕上看到的那一版**
    //   （目录在前 + 同类按名字排），而不是 readdir 的原始返回顺序。
    //
    //   第一版直接用了 readdir 顺序，于是「第一次拖拽」会把其余项的
    //   相对位置也一起改掉——用户看到的是「目录 + 拼音」，
    //   拖一下之后变成了磁盘物理布局的顺序，其余文件全在挪动。
    //   表现是"我只想挪一个文件，结果一堆文件都跳了"。
    //
    //   而 tree() 用的正是 sortNodes(…, 'name')，
    //   这里必须用同一套，否则两边对不上。
    //
    // ⚠⚠⚠ 但**不能直接用 sortNodes 的输出**：它把目录与文件混在一个数组里排，
    //   拿它当基准会把三个模板目录的相对次序也改掉，而用户根本没碰过目录。
    //   （2026-10-16 前的实测：卷纲,设定,章节 → 卷纲,章节,设定）
    //   现在 cmpName 里已经钉死了模板目录的 rank，风险低了一档，
    //   但**分段处理**这条仍然要保留——原因与上面那条一样：
    //   拖文件不该动目录的顺序，反之亦然。
    //
    //   正确做法是**分段处理**——目录段与文件段各自独立，
    //   段内按顺序表排，段间的先后沿用既有规则（目录在前）。
    //   这样用户拖文件只会动文件段，拖目录只会动目录段。
    const dirOnDisk = onDisk.filter((n) => isDirName(absDir, n));
    const fileOnDisk = onDisk.filter((n) => !isDirName(absDir, n));

    const nameIsDir = isDirName(absDir, name);
    const seg = nameIsDir ? dirOnDisk : fileOnDisk;

    // 这一段「用户当前在屏幕上看到的样子」：先按顺序表，表里没有的按名字排。
    // ⚠ 锚点必须在这份数组里查 indexOf——用别的数组查会算出错误位置。
    //   第一版拿「表内项 + 表外项」拼起来查，两段的拼接顺序与屏幕不一致，
    //   于是 anchor 落到错的槽位，插进去的位置也就错了。
    //   表现是"我拖到某一行，松手后它跑到了另一行"。
    const layerOrder = Array.isArray(existing) && existing.length ? existing : null;
    const screenOrder = layerOrder
      ? applyOrder(
          seg.map((n) => ({ name: n, type: nameIsDir ? 'dir' : 'file' })),
          layerOrder,
          nameComparator
        ).map((n) => n.name)
      : byName(seg);
    const withoutName = screenOrder.filter((n) => n !== name);

    let nextSeg;
    if (anchor && seg.includes(anchor) && anchor !== name) {
      const idx = withoutName.indexOf(anchor);
      const at = place === 'before' ? idx : idx + 1;
      nextSeg = [...withoutName.slice(0, at), name, ...withoutName.slice(at)];
    } else {
      // 没锚点：同类项按屏幕顺序排，name 接在末尾——它是这次动作的产物，
      // 位置由这次动作（拖进哪个文件夹）决定
      nextSeg = [...withoutName, name];
    }

    // 另一段原样保留：拖文件不该动目录的顺序，反之亦然。
    // 但另一段也要落进顺序表（否则下次有人拖目录时，
    // 目录段会以「表外项」的身份重排，把刚才保住的次序冲掉）。
    //
    // ⚠ 关键：另一段必须按**它在屏幕上的样子**落盘——
    //   首次拖拽时顺序表还是空的，若这里直接用 readdir 序（dirOnDisk），
    //   三个目录的相对位置就会在用户没碰过的情况下悄悄改变
    //   （实测：卷纲,设定,章节 → 卷纲,章节,设定）。
    //   屏幕上的样子是 sortNodes(…, 'name') 的结果。
    const otherSeg = nameIsDir ? fileOnDisk : dirOnDisk;
    const otherOrder = byName(otherSeg);

    const next = nameIsDir
      ? [...nextSeg, ...otherOrder]
      : [...otherOrder, ...nextSeg];

    order.dirs[key] = next;
    const { writeOrder } = require('./tree-order.js');
    const r = writeOrder(base, order);
    if (!r.ok) throw new Error(`顺序没能保存：${r.error}`);
  }

  /** 把 name 从 dirRel 这一层的顺序表里摘掉（文件被移走/删除后调用） */
  _forgetInLayer(projectId, dirRel, name) {
    const base = this.projectDir(projectId);
    const order = readOrder(base);
    const key = normDir(dirRel);
    if (!Array.isArray(order.dirs[key])) return;
    order.dirs[key] = order.dirs[key].filter((n) => n !== name);
    if (!order.dirs[key].length) delete order.dirs[key];
    const { writeOrder } = require('./tree-order.js');
    writeOrder(base, order);
  }

  /** 校验一个待创建的名字是否可用（渲染进程做输入框实时提示用） */
  validateName(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) return { ok: false, error: '名字不能为空' };
    if (n.length > MAX_NAME) return { ok: false, error: `名字太长（上限 ${MAX_NAME} 字）` };
    if (/[\\/:*?"<>|]/.test(n)) return { ok: false, error: '不能含 \\ / : * ? " < > |' };
    if (n === '.' || n === '..') return { ok: false, error: '名字非法' };
    return { ok: true, name: n };
  }
}

module.exports = { ProjectFs, TEMPLATE_FILES, TEMPLATE_DIRS, ALLOWED_EXT, MAX_NAME, sortNodes, SORT_BY_NAME };

/** 某个名字在目录里是否是文件夹（排序时用来把目录放前面） */
function isDirName(absDir, name) {
  try {
    return fs.statSync(path.join(absDir, name)).isDirectory();
  } catch (_) {
    return false;
  }
}

/** 按界面上的规则排一组名字（模板目录优先，其余中文拼音序） */
function byName(names) {
  return [...names].sort(cmpName);
}

/** 节点按名字排的比较器（与 sortNodes 的 name 档一致） */
const nameComparator = (a, b) => cmpName(a.name, b.name);