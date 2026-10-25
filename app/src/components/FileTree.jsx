import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * 第 4 栏：项目文件树。
 *
 * ## 头部为什么是这两行
 *
 * 第一版堆了四样东西在两行里：标题 + 回收站 + 刷新 + 「＋md」，
 * 下面再来一个筛选框 + 5 个排序/展开按钮。截图里那栏窄（260px），
 * 于是"名称/时间/大小/展开/折叠"五个文字按钮挤成两行竖排，
 * 谁也看不清哪个是什么。
 *
 * 现在排法按**用户在这个面板里要做的事**分：
 *   第 1 行  这是什么面板（目录）+ 四个高频动作（排序 / 找 / 刷新 / 回收站）
 *   第 2 行  我在看哪个项目（点它切项目）
 *   下面     树本身
 *
 * 四个按钮都只有图标 + tooltip，不占文字宽度——
 * 260px 的栏里，文字标签是奢侈品。
 *
 * ## 排序为什么是"点一下轮换"而不是下拉
 *
 * 试过上拉菜单，四档（手动/名称/时间/大小）在 260px 里要换行，
 * 于是又变成"谁也看不清哪个是什么"——就是上面记的那次教训。
 * 四档转一个循环，四次点击可达任意档，比开菜单再点一项还快。
 * 当前档位用**图标本身**表示（见 SORT_CYCLE），不用文字。
 *
 * ⚠ 排序与拖拽的关系（这条最容易做错）：
 *   .order.json（拖拽落盘的顺序）在「手动」档下说了算，
 *   选另外三档时它作废。反过来，用户在非手动档拖东西，
 *   App.moveEntry 会把排序切回「手动」——因为只有那一档拖得动，
 *   否则松手就弹回去，用户会以为程序坏了。
 */

const TYPE_LABEL = { dir: '文件夹', file: '文件' };

/**
 * 排序档位轮换表。**顺序即轮换顺序**，最后回到第一档。
 *
 * 图标不统一成一个「排序」符号，是为了让当前档位一眼可见：
 * 四个图标长得不一样，用户扫一眼就知道自己在哪一档，
 * 而不用去读 tooltip。
 */
const SORT_CYCLE = [
  { key: 'manual', icon: '↕', label: '手动', hint: '按你拖出来的顺序排（拖拽只在这一档有效）' },
  { key: 'name', icon: '🔤', label: '名称', hint: '按文件名排（中文按拼音）' },
  { key: 'modified', icon: '🕐', label: '时间', hint: '按最后修改时间排，最新的在上面' },
  { key: 'size', icon: '📐', label: '大小', hint: '按文件大小排，大的在上面' },
];

/** 拖拽落点的两种视觉：插在项的上边 / 下边 */
const DROP_BEFORE = 'before';
const DROP_AFTER = 'after';

/**
 * 项目根目录的"伪节点"。
 *
 * ⚠ 用它而不是 `null`：菜单里到处在读 `node.type` / `node.path`，
 *   传 null 得在每一处都加判断，漏一处就是白屏级的报错。
 * ⚠ `path: ''` 同时也是"这是根"的判据 —— 根不能重命名、不能删除。
 */
const ROOT_NODE = { type: 'dir', path: '', name: '项目根目录' };

/**
 * 一个树节点。
 *
 * ## 拖拽的两个手势（2026-10-13 改过判定方式）
 *
 * 旧版按**横向**位置分：左 2/3 排序、右 1/3 放进去。
 * 羽毛菌的实际反馈是：「我试着拖动文件夹，但是文件居然不跟随移动」。
 *
 * 磁盘层其实是对的（fs.renameSync 整个目录搬走，子文件跟着走，
 * 见 project-fs.move 的用例），问题在**判定几乎命中不了**：
 * 文件树窄的时候一行就 120~200px，右 1/3 只有几十像素，
 * 而人拖东西时鼠标落在文件夹**名字**上——那是在左边。
 * 于是绝大多数拖拽都被判成"同层排序"：
 * 文件夹在原地换了个位置，里面的文件当然"不跟随"。
 *
 * 现在按**纵向**分，符合 Windows 资源管理器的肌肉记忆：
 *
 *   落在行**上沿/下沿** → 插到这一项之前/之后（同层排序）
 *   落在行**中间**       → 放进去（跨目录移动，文件夹整棵跟着走）
 *
 * 中间那一带占了大半行面积，命中率高得多。
 * 纵向分还有个附带好处：不需要横向坐标，窄栏、缩进深浅都不影响。
 *
 * ⚠ 视觉反馈必须跟着改，否则用户还是不知道会落在哪：
 *   排序 → 画插入线；放进去 → 整行高亮 + 左边加一条竖条表示"沉进去"。
 */
function Node({
  node, depth, expanded, onToggle, onOpen, ctxMenuAt, activePath,
  drag, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
}) {
  const isDir = node.type === 'dir';
  const open = expanded.has(node.path);
  const isActive = activePath === node.path;

  // 拖拽视觉的三种态：自己是源 / 插入点在上或下 / 目标文件夹
  const isSource = drag?.path === node.path;
  const dropLine = drag?.overPath === node.path && !drag?.intoDir ? drag.place : null;
  const isDropDir = drag?.overPath === node.path && drag?.intoDir;

  /**
   * 拖拽落点的视觉。**用 box-shadow 画**，不影响布局高度。
   *
   * ⚠ 三种态必须**一眼能分开**，因为它们的后果完全不同：
   *   插在上/下边  → 只是换个顺序
   *   左边一条竖条  → 整个文件夹进去，里面的文件跟着走
   * 只靠背景色的话，窄栏里用户根本判断不出自己会落在哪
   * （羽毛菌：「我试着拖动文件夹，但是文件居然不跟随移动」——
   *  一部分原因就是他看到的反馈不足以让他确认落点）。
   *
   * ⚠ 提前算成变量而不是写在三元里：三元的各个分支之间插注释会让
   *   解析器报错（`Expected ',' or '}' but found 'string'`），
   *   而这个报错信息完全指不到真正的原因。
   */
  let shadow;
  if (dropLine === DROP_BEFORE) shadow = 'inset 0 2px 0 var(--accent)';
  else if (dropLine === DROP_AFTER) shadow = 'inset 0 -2px 0 var(--accent)';
  else if (isDropDir) shadow = 'inset 3px 0 0 var(--accent)';

  return (
    <div>
      <div
        /**
         * `data-tree-row` 是给"点空白弹菜单"用来分辨"点在节点上还是空白处"的（见树容器）。
         * ⚠ 别用 `title` 之类的属性当标记：行的 title 是路径，
         *   而容器里别的地方也可能有 title（原来 onDrop 就是这么判的，脆）。
         */
        data-tree-row="1"
        className="flex items-center gap-1 py-[3px] pr-1 group min-w-0"
        style={{
          paddingLeft: 6 + depth * 12,
          background: isActive || isDropDir ? 'var(--accent-soft)' : undefined,
          borderRadius: 4,
          boxShadow: shadow,
          opacity: isSource ? 0.4 : 1,
          cursor: isSource ? 'grabbing' : 'pointer',
        }}
        title={node.path || node.name}
        // ---- 拖拽 ----
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          // Firefox / 部分环境要求必须 setData，否则 dragstart 之后没有 dragover
          e.dataTransfer.setData('text/plain', node.path);
          onDragStart?.(node, e);
        }}
        onDragOver={(e) => {
          // 不 preventDefault 就不会触发 drop
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          e.stopPropagation();
          onDragOver?.(node, e);
        }}
        onDragLeave={(e) => {
          e.stopPropagation();
          onDragLeave?.(node, e);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDrop?.(node, e);
        }}
        onDragEnd={(e) => onDragEnd?.(node, e)}
        // ---- 点击 ----
        onClick={() => {
          // 拖拽刚结束时浏览器还会补一次 click，会误触发打开/展开
          if (drag) return;
          if (isDir) onToggle(node.path);
          else onOpen(node);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          ctxMenuAt(e.clientX, e.clientY, node);
        }}
      >
        {/* 缩进占位箭头 */}
        <span className="w-3 shrink-0 text-[9px]" style={{ color: 'var(--ink-soft)' }}>
          {isDir ? (open ? '▼' : '▶') : ''}
        </span>
        <span className="shrink-0 text-[12px]">{isDir ? '📁' : '📄'}</span>
        <span
          /**
           * 文件名字号：12px（2026-10-15 羽毛菌：「然后目录这种文件名字的字大小再小一号」，
           * 原来是 13px）。
           *
           * ⚠ **不跟随对话/编辑器字号**：目录是导航，字大一点就挤，
           *   而且它与正文分开调（`config.fontSize` 不管这一栏）。
           */
          className="text-[12px] truncate flex-1 min-w-0"
          style={{ color: isDir ? 'var(--ink)' : 'var(--ink-soft)' }}
        >
          {node.name}
        </span>
        {node.truncated && (
          <span className="text-[10px] shrink-0" style={{ color: 'var(--ink-soft)' }} title="层级太深未展开">
            …
          </span>
        )}
      </div>

      {isDir && open && (
        (node.children && node.children.length > 0) ? (
          <div>
            {node.children.map((c) => (
              <Node
                key={c.path}
                node={c}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
                ctxMenuAt={ctxMenuAt}
                activePath={activePath}
                drag={drag}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
              />
            ))}
          </div>
        ) : (
          /**
           * ⚠⚠ 展开的**空**文件夹要明确说"我里面没东西"。
           *
           * 2026-10-16 羽毛菌：「章节文件夹依然无法合并」——
           *   真相是 `章节/` 本来就是空的，而紧跟它下面的
           *   `第一卷.md / 第一章.md / 章节摘要.md` 是**项目根目录**下的文件
           *   （目录排在前、文件排在后，所以根文件正好落在最后一个文件夹后面）。
           *   折叠一个空文件夹，屏幕上当然一点变化都没有 ——
           *   在他看来就是"点了没反应"。
           *   写一行「（空）」，这一条就自证了。
           */
          <div
            data-testid="tree-empty"
            className="text-[11px] py-[2px]"
            style={{
              paddingLeft: 6 + (depth + 1) * 12 + 12,
              color: 'var(--ink-soft)',
              opacity: 0.65,
            }}
          >
            （空）
          </div>
        )
      )}
    </div>
  );
}

/** 递归算出"包含命中节点的路径集合"，用于搜索时自动展开 */
function pathsOfMatched(node, keyword, acc) {
  if (!node) return acc;
  const hit = node.name.toLowerCase().includes(keyword);
  let childHit = false;
  for (const c of node.children || []) {
    if (pathsOfMatched(c, keyword, acc)) childHit = true;
  }
  if (hit || childHit) acc.add(node.path);
  return hit || childHit;
}

/** 节点所在目录（顶层返回 ''） */
function dirOf(nodePath) {
  const s = String(nodePath || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}

/**
 * 一个路径的**所有祖先目录**（不含它自己），从外到内。
 *
 * '卷纲/子集/甲.md' → ['', '卷纲', '卷纲/子集']
 *
 * ⚠ 必须含根 ''：项目根默认是展开的，但用户可能手动折叠过。
 *   不含它的话，拖进深层目录后外层还是折的，一样看不见。
 *
 * ⚠ 用 function 声明（不是 const 箭头）：FileTree 在渲染期会调用它，
 *   声明在后也会因提升而可用 —— 这条有 TDZ 检查钉着。
 */
function ancestorDirs(dirPath) {
  const out = [''];
  const s = String(dirPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s) return out;
  const parts = s.split('/');
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    out.push(acc);
  }
  return out;
}

export default function FileTree({
  tree, loading, error,
  onRefresh, onOpenFile,
  onCreate, onRename, onRemove,
  onTrash,
  onOpenTrash, trashCount = 0,
  /** 拖拽落点。跨目录移动与同目录重排都走这里 */
  onMove,
  /** 第 2 行：当前项目名 + 点击切换 */
  projectName, onSwitchProject,
  activePath,
  /** 排序档位 'manual'|'name'|'modified'|'size' + 切换回调 */
  sortBy = 'manual', onSortChange,
}) {
  /**
   * 默认**全部收起**（2026-10-15 羽毛菌：「刚进软件文件夹应该是关着的，而不是打开的」）。
   * ⚠ 原来是 `new Set([''])` —— 空串是**根路径**，所以整棵树默认全展开。
   */
  const [expanded, setExpanded] = useState(() => new Set());
  const [keyword, setKeyword] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState(null);           // {x, y, node}
  const [dialog, setDialog] = useState(null);       // {mode, node, value}
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  // 拖拽状态。放在组件顶层（不进 Node 的 state）——
  // 每个节点各存一份会让"当前拖的是谁"难以判断，
  // 而拖拽天然是全局的一件事。
  const [drag, setDrag] = useState(null);
  /**
   * 拖拽源的路径。**同步的**，不依赖 setState 生效。
   *
   * ⚠ 为什么不能只用 drag state：drop 事件可能在 dragover 的
   *   setState 提交之前就到达（快速拖动、自动化测试连续派发），
   *   那时 drag 还是 null 或上一帧的值，
   *   表现为"拖到文件夹上、松手没反应、也不报错"。
   */
  const dragRef = useRef(null);
  // 各节点的行矩形，drop 时按 clientX 算落点比例要用
  const nodeEl = useRef({});

  const toggle = useCallback((p) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  /**
   * 排序档位轮换。四档循环，回第一档收尾。
   *
   * ⚠ 找不到当前档时**退回 manual** 而不是崩在 undefined 上：
   *   档位可能来自旧版本 localStorage，也可能被手改过。
   *   「排序控件点了报错」比「默默按手动排」糟糕得多。
   */
  const cycleSort = useCallback(() => {
    if (!onSortChange) return;
    const i = SORT_CYCLE.findIndex((s) => s.key === sortBy);
    const next = SORT_CYCLE[(i + 1) % SORT_CYCLE.length] || SORT_CYCLE[0];
    onSortChange(next.key);
  }, [sortBy, onSortChange]);

  const sortNow = (SORT_CYCLE.find((s) => s.key === sortBy) || SORT_CYCLE[0]);


  const visibleTree = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return tree;
    const dirs = new Set();
    pathsOfMatched(tree, kw, dirs);
    const filter = (node) => {
      if (node.type === 'file') return node.name.toLowerCase().includes(kw);
      const kids = (node.children || []).map(filter).filter(Boolean);
      return kids.length ? { ...node, children: kids } : null;
    };
    const kids = (tree?.children || []).map(filter).filter(Boolean);
    return { ...tree, children: kids, searchDirs: [...dirs] };
  }, [tree, keyword]);

  useEffect(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw || !visibleTree?.searchDirs) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of visibleTree.searchDirs) next.add(p);
      return next;
    });
  }, [keyword, visibleTree]);

  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  // 点菜单外关闭
  useEffect(() => {
    if (!menu) return;
    const off = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null);
    };
    window.addEventListener('pointerdown', off);
    /**
     * ⚠⚠ 这里**不能写具名函数表达式**（2026-10-15 用户现场：
     *   `ReferenceError: esc is not defined`，整个渲染崩掉）。
     *
     * 原来是 `addEventListener('keydown', function esc(e) { … esc … })` ——
     * 源码里完全合法（具名函数表达式的名字在函数作用域内可见），
     * **开发态也不报错**，但打包器重写这段时把函数变成箭头/匿名，
     * 名字就没了，`esc` 变成未定义变量 —— 只在 dist 里炸。
     *
     * 正解：先取一个局部变量，用它注册和移除（下面 remove 也用它）。
     */
    const onEsc = (e) => {
      if (e.key === 'Escape') { setMenu(null); window.removeEventListener('keydown', onEsc); }
    };
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('pointerdown', off);
      window.removeEventListener('keydown', onEsc);
    };
  }, [menu]);

  /**
   * 落点计算。**纯函数**，dragover 用来画指示线、drop 用它真正执行。
   *
   * ⚠ 为什么 drop 不能直接读 drag state：
   *   dragover 里的 setDrag 是异步的，而 drop 可能在它提交之前就到来
   *   （快速拖动、或自动化测试里连续派发两个事件）。
   *   那时 state 里的 targetPath 还是上一帧的值——
   *   表现是"拖到了文件夹上，松手却没进去"，
   *   而且没有任何报错，很难定位。
   *
   *   所以 drop 自己根据事件坐标重算一次，不依赖任何 state。
   *
   * ## 判定按**纵向**，不按横向（2026-10-13）
   *
   * 旧版是横向：右 1/3 放进去、左 2/3 排序。实测几乎命不中"放进去"——
   * 窄栏里一行才 120~200px，右 1/3 只有几十像素，而人会把鼠标放在
   * **文件夹名字**上（左边）。于是拖文件夹几乎总是被判成"同层排序"，
   * 用户看到的就是「我试着拖动文件夹，但是文件居然不跟随移动」。
   * （磁盘层一直是对的：fs.renameSync 整棵搬走，子文件跟着走，
   *   project-fs 的 move 用例里钉着。）
   *
   * 现在按纵向：上沿/下沿各 20% 是排序，中间 60% 是放进去。
   * 中间那带面积最大、命中率高，而且不依赖横向坐标。
   */
  const resolveDrop = useCallback((node, clientY, vRatioHint) => {
    const srcPath = dragRef.current;
    if (!srcPath || !node || srcPath === node.path) return null;

    const rect = nodeEl.current[node.path];
    const v = vRatioHint != null
      ? vRatioHint
      : (rect ? (clientY - rect.top) / Math.max(1, rect.height) : 0.5);

    // 文件行没有"里面"，所以一律按纵向分排序。
    const intoDir = node.type === 'dir' && v > 0.2 && v <= 0.8;
    return {
      from: srcPath,
      // 放进文件夹：位置 = 该文件夹末尾
      toDir: intoDir ? node.path : dirOf(node.path),
      // 同层排序：位置由落点在上半还是下半决定
      anchor: intoDir ? null : node.name,
      place: intoDir ? null : (v < 0.5 ? DROP_BEFORE : DROP_AFTER),
    };
  }, []);

  /**
   * 真正执行移动。
   * @param {object|null} plan resolveDrop 的结果
   */
  const runDrop = useCallback(async (plan) => {
    if (!plan) return;
    const { from, toDir, anchor, place } = plan;
    const sameDir = dirOf(from) === toDir;
    const sameSpot = sameDir && anchor
      && (anchor === from || !place);   // 落在自己身上 = 只改顺序

    // 落在自己身上且同目录 → 只重排，位置由 anchor+place 决定
    if (sameDir && anchor && anchor === from) {
      // 拿同层的下一项当锚点，避免"移到自己前面"这种空操作
      return;
    }
    await onMove?.(from, toDir, anchor, place);

    /**
     * 放进去之后自动展开目标文件夹。
     *
     * ⚠ 少了这一步，用户会以为"没移动成功"：
     *   文件确实进了目标文件夹，但那个文件夹在树上可能是折叠的，
     *   屏幕上什么都看不到——而"拖了没反应"和"进去了要展开才看得到"
     *   在他眼里是同一件事（羽毛菌：「文件居然不跟随移动」）。
     *
     * ⚠ 还要展开**每一层祖先**：从 章节/卷纲 拖到 设定 时，
     *   中间路径也得是开的，否则文件还是看不见。
     */
    if (!sameDir) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const p of ancestorDirs(toDir)) next.add(p);
        // 拖的是文件夹时把它自己也展开：进去之后能直接看到里面的文件跟着走了
        next.add(toDir ? `${toDir}/${from}` : from);
        return next;
      });
    }
  }, [onMove]);

  // ---- 拖拽事件 ----

  const onDragStartNode = useCallback((node, e) => {
    dragRef.current = node.path;
    setDrag({ path: node.path, name: node.name, type: node.type, overPath: null });
  }, []);

  const onDragOverNode = useCallback((node, e) => {
    // dragRef 是同步的，所以即使 state 还没提交也能算出落点
    if (!dragRef.current || dragRef.current === node.path) return;
    const el = e.currentTarget;
    nodeEl.current[node.path] = el.getBoundingClientRect();
    // ⚠ 传 clientY 不是 clientX：判定改成纵向了（见 resolveDrop 的注释）
    const plan = resolveDrop(node, e.clientY);
    if (!plan) return;
    setDrag((prev) => ({
      ...(prev || { path: dragRef.current }),
      overPath: node.path,
      targetPath: node.path,
      intoDir: plan.anchor === null && plan.toDir === node.path,
      place: plan.place || 'after',
    }));
  }, [resolveDrop]);

  const onDragLeaveNode = useCallback((node) => {
    setDrag((prev) => (prev && prev.overPath === node.path
      ? { ...prev, overPath: null, targetPath: null, intoDir: false }
      : prev));
  }, []);

  const onDropOn = useCallback(async (node, e) => {
    const el = e.currentTarget;
    nodeEl.current[node.path] = el.getBoundingClientRect();
    // ⚠ 同上：clientY，与 dragover 用同一个坐标轴，
    //   否则会出现"拖的时候显示放进去、松手却排在前面"的分裂。
    const plan = resolveDrop(node, e.clientY);
    dragRef.current = null;
    setDrag(null);
    await runDrop(plan);
  }, [resolveDrop, runDrop]);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);

  /** 拖到没有节点的空白处 = 移到项目根末尾 */
  const onDropOnTree = useCallback(async () => {
    const from = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!from || dirOf(from) === '') return;
    await onMove?.(from, '', null, null);
  }, [onMove]);

  const runAction = async (fn, msg) => {
    setBusy(true);
    setMenu(null);
    try {
      await fn();
      await onRefresh();
      setToast({ ok: true, text: msg });
    } catch (e) {
      setToast({ ok: false, text: e.message || String(e) });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 2600);
    }
  };

  const doCreate = async (d) => {
    const name = String(d.value || '').trim();
    if (!name) return;
    const base = d.node.type === 'dir'
      ? d.node.path
      : (d.node.path ? dirOf(d.node.path) : '');
    const nameWithExt = d.mode === 'file' && !/\.(md|txt|markdown)$/i.test(name) ? `${name}.md` : name;
    const rel = base ? `${base}/${nameWithExt}` : nameWithExt;
    const isDir = d.mode === 'dir';
    setDialog(null);
    await runAction(() => onCreate(rel, isDir), isDir ? `已新建文件夹「${name}」` : `已新建「${nameWithExt}」`);
    if (!isDir) setExpanded((prev) => new Set(prev).add(base || ''));
  };

  const doRename = async (d) => {
    const name = String(d.value || '').trim();
    if (!name) return;
    const oldPath = d.node.path;
    const dir = dirOf(oldPath);
    const newPath = dir ? `${dir}/${name}` : name;
    if (newPath === oldPath) { setDialog(null); return; }
    setDialog(null);
    await runAction(() => onRename(oldPath, newPath), `已重命名为「${name}」`);
  };

  const doRemove = async () => {
    const node = dialog.node;
    const isDir = node.type === 'dir';
    setDialog(null);
    await runAction(
      () => onRemove(node.path, isDir && dialog.recursive),
      `已删除「${node.name}」`
    );
  };

  const fileCount = useMemo(() => {
    let n = 0;
    const walk = (nodes) => {
      for (const x of nodes || []) {
        if (x.type === 'file') n++;
        else walk(x.children);
      }
    };
    walk(tree?.children);
    return n;
  }, [tree]);

  const treeRef = useRef(null);
  /**
   * 已经见过的目录（用来分辨"新出现的文件夹"）。
   * ⚠ 只在第一次加载时为 null，之后一直留着 —— 见下面那段注释。
   */
  const seenDirs = useRef(null);
  /**
   * ⚠⚠ 树刷新时**不能把展开状态整个覆盖掉**。
   *
   * 2026-10-16 羽毛菌：「章节文件夹左键单击后无法合并，但是设定文件夹却可以」。
   *
   *   原来这里是 `setExpanded(所有目录)` —— 每次 `tree` 换了新对象就**全部展开**。
   *   而 `tree` 会在每次写文件 / 每次刷新后重新取一份（对象换了、内容没变），
   *   于是：点一下 章节 折叠 → 恰好来一次刷新 → 又被展开。
   *   表现就是"点 章节 收不起来"，而 设定 偶尔能收起来 ——
   *   **看谁点得离下一次刷新更远**。这种"时灵时不灵"最难被当成 bug 报出来。
   *
   * 现在的规矩：
   *   · 第一次加载 → 全部展开（保持原来的观感）；
   *   · 之后 → **只把"新出现的目录"展开**，用户手动折叠过的目录一律不动。
   *     （新建文件夹之后它自己会冒出来，展开它是合理的；
   *       而"刷新了一下就全开"是没道理的。）
   */
  useEffect(() => {
    if (!tree || treeRef.current === tree) return;
    treeRef.current = tree;
    const dirs = new Set(['']);
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.type === 'dir') { dirs.add(n.path); walk(n.children); }
      }
    };
    walk(tree.children);

    if (seenDirs.current === null) {
      seenDirs.current = dirs;
      setExpanded(dirs);
      return;
    }
    const fresh = [...dirs].filter((p) => !seenDirs.current.has(p));
    seenDirs.current = dirs;
    if (fresh.length) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const p of fresh) next.add(p);
        return next;
      });
    }
  }, [tree]);

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: 'var(--paper-2)' }}>
      {/* ============ 第 1 行：面板名 + 三个图标按钮 ============
        ⚠⚠ 高度写死 h-8，与「对话列表」「快捷工具」两栏一致（2026-10-16 20:04）。
        原来是 pt-2 pb-1.5（上下不对称，高度又与别人不同）→ 三栏三条线三个 y。
        统一之后这三行顶端齐平，扫一眼就是一条线。*/}
      <div
        className="shrink-0 flex items-center gap-1 pl-2.5 pr-1.5 h-8"
        data-testid="rail-head-tree"
      >
        <span className="text-[12.5px] font-medium flex items-center gap-1">
          <span className="text-[11px]">📁</span>目录
        </span>
        <span className="flex-1" />
        <IconBtn
          onClick={cycleSort}
          active={sortNow.key !== 'manual'}
          title={`排序：${sortNow.label} · ${sortNow.hint}（点一下换一个）`}
          testId="tree-sort-btn"        >
          {sortNow.icon}
        </IconBtn>
        <IconBtn
          onClick={() => setSearchOpen((v) => !v)}
          active={searchOpen || !!keyword}
          title="查找文件"
        >
          {searchOpen || keyword ? '✕' : '🔍'}
        </IconBtn>
        <IconBtn onClick={onRefresh} disabled={loading} title="重新扫描文件夹">
          {loading ? '…' : '⟳'}
        </IconBtn>
        <IconBtn onClick={onOpenTrash} title="回收站：可还原的文件都在这">
          🗑
          {trashCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 text-[9px] min-w-[13px] px-[3px] rounded-full tabular-nums"
                  style={{ background: 'var(--danger)', color: 'var(--accent-ink)' }}>
              {trashCount}
            </span>
          )}
        </IconBtn>
      </div>

      {/* 搜索框：点 🔍 才展开，不占常态空间 */}
      {searchOpen && (
        <div className="shrink-0 px-2.5 pb-1.5">
          <input
            ref={searchRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setKeyword(''); setSearchOpen(false); } }}
            placeholder="按文件名查找…"
            className="w-full px-2 py-1 rounded text-[12px] outline-none"
            style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }}
          />
          {keyword.trim() && (
            <div className="text-[10px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
              匹配 {countMatches(visibleTree)} 项 · 回车或 Esc 退出
            </div>
          )}
        </div>
      )}

      {/* 排序档位的后果说明：只在非「手动」时出现。
          拖拽不禁用 —— 跨目录移动任何档位下都该能用，
          而用户在拖拽前就该知道「同层重排会被这一档盖掉」。 */}
      {sortNow.key !== 'manual' && (
        <div className="shrink-0 px-2.5 pb-1" data-testid="tree-sort-note">
          <div className="text-[10px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            按{sortNow.label}排。同层拖拽会被这一档盖掉——
            拖完自动切回「手动」。
          </div>
        </div>
      )}

      {/* ============ 第 2 行：当前项目（点击切换） ============ */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-y"
        style={{ borderColor: 'var(--line)' }}
      >
        <button
          onClick={onSwitchProject}
          className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1 rounded text-left"
          style={{ background: 'var(--paper)', border: '1px solid var(--line)' }}
          title="点击切换小说项目（新建 / 改名 / 删除 / 导出 / 回收站）"
        >
          <span className="text-[12px] shrink-0">📕</span>
          <span className="text-[12.5px] truncate flex-1">
            {projectName || '（未选项目）'}
          </span>
          <span className="text-[9px] shrink-0" style={{ color: 'var(--ink-soft)' }}>⇅</span>
        </button>
      </div>

      {/* ============ 树 ============ */}
      <div
        className="flex-1 overflow-y-auto py-1 min-h-0"
        data-testid="tree-scroll"
        /**
         * ⚠⚠ 空白处弹菜单用的是**右键**（`onContextMenu`），不是左键。
         *
         * 2026-10-16 我先写成了 `onClick` —— 羽毛菌当场纠正：
         *   「不是左键单击，是右键，我左键单击就弹出了，右键没反应」。
         *   左键在这一栏是"选中/展开"的意思（而且空点一下弹菜单会误触），
         *   右键才是"这里能干什么"。⚠ **别自作主张把左键也接上**。
         *
         * ⚠ 判定"点到空白"用 `closest('[data-tree-row]')`，
         *   不能只比 `e.target === e.currentTarget`：
         *   行是包在子 div 里的，空白处可能落在内层容器上（那时 target 不是 currentTarget，
         *   就会漏判 → 点了没反应）。
         */
        onContextMenu={(e) => {
          if (drag) return;
          if (e.target.closest('[data-tree-row]')) return;   // 点在节点上，由节点自己弹
          e.preventDefault();                                 // 挡掉系统菜单
          setMenu({ x: e.clientX, y: e.clientY, node: ROOT_NODE });
        }}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          // 只在事件真的落在容器空白处（而不是某个节点上）时才处理。
          // 节点自己的 onDrop 会 stopPropagation，所以能走到这里的
          // 就是"拖到了没有节点的空白区域"。
          if (!drag) return;
          if (e.target.closest('[title]')) return;
          e.preventDefault();
          onDropOnTree();
        }}
      >
        {error ? (
          <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--danger)' }}>{error}</div>
        ) : !tree?.children?.length ? (
          <div className="px-3 py-4 text-[12px] text-center leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            {keyword.trim() ? `没有匹配「${keyword.trim()}」的文件` : '这个项目还没有文件'}
            <br />
            <span className="text-[11px]">点空白处可以新建文件或文件夹</span>
          </div>
        ) : (
          (visibleTree.children || []).map((n) => (
            <Node
              key={n.path}
              node={n}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              onOpen={(node) => onOpenFile(node)}
              ctxMenuAt={(x, y, node) => setMenu({ x, y, node })}
              activePath={activePath}
              drag={drag}
              onDragStart={onDragStartNode}
              onDragOver={onDragOverNode}
              onDragLeave={onDragLeaveNode}
              onDrop={onDropOn}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>

      {/* 文件数（原来这里还有个「＋ 新建」按钮，2026-10-16 去掉） */}
      <div
        className="shrink-0 px-2.5 py-1 border-t flex items-center gap-2"
        style={{ borderColor: 'var(--line)' }}
      >
        <span className="text-[10.5px]" style={{ color: 'var(--ink-soft)' }}>
          {fileCount} 个文件
        </span>
        {/**
         * ⚠ 那个「＋ 新建」按钮是 2026-10-16 羽毛菌点名去掉的：
         *   「新建文件只会添加在章节文件夹下面，所以底下那个新建按钮取消掉，没有用」。
         *   新建的入口统一到菜单里（右键文件夹 / 点空白处）——
         *   这样"在哪儿新建"由**你点的地方**决定，而不是由一个固定按钮决定。
         */}
      </div>

      {/* 右键 / 点空白 弹出的菜单 */}
      {menu && (() => {
        const n = menu.node;
        const isRoot = !n.path;                 // 项目根：不能改名、不能删除
        const isDir = n.type === 'dir';
        return (
          <div
            ref={menuRef}
            data-testid="tree-menu"
            className="fixed z-50 rounded-lg shadow-lg py-1 text-[12.5px]"
            style={{
              left: Math.min(menu.x, window.innerWidth - 180),
              top: Math.min(menu.y, window.innerHeight - 210),
              background: 'var(--paper)',
              border: '1px solid var(--line)',
              minWidth: 164,
            }}
          >
            {/**
             * ⚠ 菜单按羽毛菌给的参考图排列（2026-10-16）：
             *   新建文件 / 新建文件夹 / 导入文件 · 重命名 / 移至回收站
             *   文案统一成「新建文件」—— 原来的「在此新建 md」
             *   既绕口又暴露了实现（用户关心的是"新建一个文件"）。
             */}
            <MenuItem label="新建文件" onClick={() => setDialog({ mode: 'file', node: n, value: '' })} />
            <MenuItem label="新建文件夹" onClick={() => setDialog({ mode: 'dir', node: n, value: '' })} />
            {!isDir && <MenuItem label="打开预览" onClick={() => { onOpenFile(n); setMenu(null); }} />}
            {!isRoot && <div className="h-px my-1" style={{ background: 'var(--line)' }} />}
            {!isRoot && (
              <MenuItem label="重命名" onClick={() => setDialog({ mode: 'rename', node: n, value: n.name })} />
            )}
            {!isRoot && (
              <MenuItem
                label="移至回收站"
                onClick={() => {
                  setMenu(null);
                  onTrash(n.path);
                }}
              />
            )}
            {!isRoot && (
              <MenuItem
                label="永久删除…"
                danger
                onClick={() => setDialog({ mode: 'delete', node: n, value: '', recursive: false })}
              />
            )}
          </div>
        );
      })()}

      {/* 新建 / 重命名 / 删除 对话框 */}
      {dialog && dialog.mode !== 'delete' && (
        <PromptDialog
          title={dialog.mode === 'rename' ? '重命名' : dialog.mode === 'dir' ? '新建文件夹' : '新建文件'}
          label={dialog.mode === 'rename' ? '新名字' : '名字（会自动补 .md）'}
          initial={dialog.value}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={(v) => (dialog.mode === 'rename' ? doRename({ ...dialog, value: v }) : doCreate({ ...dialog, value: v }))}
        />
      )}

      {dialog && dialog.mode === 'delete' && (
        <ConfirmDelete
          node={dialog.node}
          recursive={!!dialog.recursive}
          onRecursive={(v) => setDialog({ ...dialog, recursive: v })}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={doRemove}
        />
      )}

      {/* 轻提示 */}
      {toast && (
        <div
          className="shrink-0 px-2.5 py-1.5 text-[11px] border-t"
          style={{
            borderColor: 'var(--line)',
            color: toast.ok ? 'var(--ok)' : 'var(--danger)',
          }}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

/** 计数：搜索时匹配了多少项 */
function countMatches(t) {
  let n = 0;
  const walk = (nodes) => {
    for (const x of nodes || []) {
      if (x.type === 'file') n++;
      else walk(x.children);
    }
  };
  walk(t?.children);
  return n;
}

/** 只有图标的按钮。窄栏里文字标签是奢侈品。 */
function IconBtn({ onClick, title, children, active, disabled, testId }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      data-testid={testId}
      className="relative w-6 h-6 rounded flex items-center justify-center text-[12px] disabled:opacity-40"
      style={{
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? 'var(--accent-ink)' : 'var(--ink-soft)',
      }}
    >
      {children}
    </button>
  );
}

function MenuItem({ label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 hover:bg-[var(--accent-soft)]"
      style={{ color: danger ? 'var(--danger)' : 'var(--ink)' }}
    >
      {label}
    </button>
  );
}

/** 输入对话框。这里不用 window.prompt——Electron 里它不阻塞且样式不可控 */
function PromptDialog({ title, label, initial, busy, onCancel, onSubmit }) {
  const [v, setV] = useState(initial || '');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="rounded-lg p-4 shadow-xl"
        style={{ background: 'var(--paper)', width: 340, border: '1px solid var(--line)' }}
      >
        <div className="text-[13px] font-medium mb-2">{title}</div>
        <div className="text-[11px] mb-1" style={{ color: 'var(--ink-soft)' }}>{label}</div>
        <input
          ref={ref}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && v.trim()) onSubmit(v.trim());
            if (e.key === 'Escape') onCancel();
          }}
          className="w-full px-2 py-1.5 rounded text-[13px] outline-none"
          style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
        />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onCancel} className="px-3 py-1 rounded text-[12px]"
                  style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}>取消</button>
          <button
            onClick={() => v.trim() && onSubmit(v.trim())}
            disabled={!v.trim() || busy}
            className="px-3 py-1 rounded text-[12px] disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 永久删除的确认。目录要额外勾"含子内容" */
function ConfirmDelete({ node, recursive, onRecursive, busy, onCancel, onConfirm }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="rounded-lg p-4 shadow-xl"
           style={{ background: 'var(--paper)', width: 380, border: '1px solid var(--line)' }}>
        <div className="text-[13px] font-medium mb-2" style={{ color: 'var(--danger)' }}>
          永久删除{TYPE_LABEL[node.type]}「{node.name}」？
        </div>
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
          {node.type === 'dir' ? '目录里的所有文件都会消失。' : '文件内容会立即消失。'}
          <br />
          <b style={{ color: 'var(--danger)' }}>不进回收站，也无法还原。</b>
          <br />
          <span className="text-[11px]">若只是想删掉，用「放入回收站」更安全。</span>
        </div>
        {node.type === 'dir' && (
          <label className="flex items-center gap-2 mt-3 text-[12px] cursor-pointer">
            <input type="checkbox" checked={recursive} onChange={(e) => onRecursive(e.target.checked)} />
            <span>我确认，连同目录内的所有内容一起删除</span>
          </label>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="px-3 py-1 rounded text-[12px]"
                  style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}>取消</button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-3 py-1 rounded text-[12px] disabled:opacity-40"
            style={{ background: 'var(--danger)', color: 'var(--accent-ink)' }}
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}
