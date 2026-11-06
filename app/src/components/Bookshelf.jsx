import { useState, useRef, useEffect } from 'react';

/**
 * 书架：打开软件先看到的那一屏（2026-11-01 加）。
 *
 * ## 为什么要有它
 *
 * 羽毛菌的原话：「进入软件先选择项目，而不是直接看到编辑聊天页面」。
 *
 * 之前的行为是：上次打开哪个项目就直接进那个项目的四栏编辑器。
 * 对一个只写一本书的人是省事，但对"同时有几本书"的人（他就是）来说，
 * 打开软件立刻落进某一本的正文里，**没有任何"我有几本书"的感觉**，
 * 也没有一个体面的入口——只能去第 4 栏那个小小的项目切换弹窗里找。
 *
 * ## 设计取舍
 *
 * · **封面用首字 + 色块**：我们没有生图能力，与其做一个"上传封面"
 *   的空壳按钮，不如给一个一眼能认出是哪本书的色块（颜色从项目 id 稳定派生，
 *   同一本书永远是同一个色）。
 * · **类型用一个小标**：长篇 / 短篇 / 短剧，右边显示，方便区分。
 * · **不在卡片上放删除/改名**：那些是低频危险操作，放右键菜单或切换弹窗里，
 *   不让第一屏承担。
 */
export default function Bookshelf({
  projects, onOpen, onCreate, onSettings, onImport, onToast,
  dailyGoal = 2000, onSetDailyGoal,
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('long');

  /**
   * 受众（2026-11-01 加）：male / female / ''（不限）。
   *
   * ⚠ 只影响 **AI 提案方向** 和 **存进项目备查**，不影响建哪套目录。
   *   同一个"重生 + 无敌金手指"，男频出《我靠签到成神》，
   *   女频出《重生后我让反派跪着喊姐姐》—— 差得远。
   */
  const [audience, setAudience] = useState('');

  const AUDIENCES = [
    { id: '', label: '不限' },
    { id: 'male', label: '男频' },
    { id: 'female', label: '女频' },
  ];
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  /**
   * 「每日目标」的行内编辑（2026-11-02）。
   *
   * 羽毛菌要的是「有个入口能设目标」。做成**点一下数字就地改**，
   * 不另开弹窗：这是个一天改一次的小数值，为它开一层模态成本太高。
   */
  const [goalEdit, setGoalEdit] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const goalInputRef = useRef(null);
  /** 编辑态是否真的开着（state 在同一个 tick 里读不到最新值，用它做一次性开关） */
  const goalOpenRef = useRef(false);

  useEffect(() => {
    if (creating && inputRef.current) inputRef.current.focus();
  }, [creating]);

  useEffect(() => {
    if (goalEdit && goalInputRef.current) {
      goalInputRef.current.focus();
      goalInputRef.current.select();
    }
  }, [goalEdit]);

  /**
   * 每个项目的字数 / 文件数（2026-11-01）。
   *
   * ⚠ 一个项目一次 IPC、**串行**拉：主进程那边是同步 readFileSync，
   *   一次算五个项目会把界面堵住。串行的话每次只堵几十毫秒。
   * ⚠ 先渲染卡片、字数后到 —— 宁可文字晚半秒出现，
   *   也不要"打开书架先白屏等统计"。
   */
  const [stats, setStats] = useState({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const p of projects) {
        if (cancelled) return;
        try {
          const r = await window.api.project.stat({ id: p.id });
          if (cancelled) return;
          // 存整个返回对象：横幅要章数/今日字数/连续天数/简介，卡片只要字数
          if (r && r.ok) setStats((prev) => ({ ...prev, [p.id]: r }));
        } catch (_) {
          // 单个项目统计失败不该影响整排卡片
        }
      }
    })();
    return () => { cancelled = true; };
    // ⚠ 依赖用 id 串：父组件每次传新数组，用 projects 会导致无限重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.map((p) => p.id).join(',')]);

  /** 字数说得像人话：不到一万给原数，过万给"万字" */
  const fmtChars = (n) => {
    if (n == null) return null;
    if (!n) return '空';
    if (n < 10000) return `${n} 字`;
    return `${(n / 10000).toFixed(1)} 万字`;
  };

  /**
   * 底部统计条（2026-11-02）。
   *
   * 羽毛菌看竞品：「选小说后底下还能看小说数据，我们这个太单调了」。
   *
   * ⚠ **只在全部项目都拉完再显示总数**：边拉边跳（7 → 3.2万 → 9.8万）比不显示更烦。
   *   没拉完时显示「—」，用户知道它在算。
   * ⚠ 统计是**所有书合计**，不是当前选中那本 —— 书架本来就没有"当前书"的概念。
   */
  const statValues = projects.map((p) => stats[p.id]);
  const statReady = projects.length > 0 && statValues.every((s) => s != null);
  const totalChars = statValues.reduce((a, s) => a + (s?.chars || 0), 0);
  const totalFiles = statValues.reduce((a, s) => a + (s?.files || 0), 0);
  const bigNum = (n) => {
    if (!statReady) return '—';
    if (n < 10000) return String(n);
    return (n / 10000).toFixed(1);
  };
  const bigUnit = (n) => (statReady && n >= 10000 ? '万字' : statReady ? '字' : '');

  /**
   * 封面：首字 + 稳定色相（`.shelf-cover` 负责颜色，这里只传 `--h`）。
   *
   * ⚠ 抽成一个函数是因为要**两处用同一个样子**：大横幅（竖版 3:4）和小卡片（横版）。
   *   写两份的话，"改了卡片的绿、忘了改横幅的"必然发生。
   */
  /**
   * 封面图地址（2026-11-02）。
   *
   * ⚠ `cover_path` 存的是**项目内相对路径**（如 `_assets/封面-123.png`），
   *   协议和项目 id 都在前端拼 —— 这样以后换协议/换目录不用迁移老数据。
   * ⚠ 每段都要 `encodeURIComponent`：文件名里有中文（我们生成的封面就是），
   *   不编码的话 `wtfile://` 解析时会被当成非法字符。
   */
  const coverUrlOf = (p) => {
    const rel = String(p && p.cover_path || '').trim();
    if (!rel) return '';
    return `wtfile://${p.id}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  };

  /**
   * 横幅封面的宽度。
   * ⚠ 抽成常量：右缘那条柔化带要按它定位，写两处数字早晚会不同步
   *   （改了宽度忘了改柔化带 → 带子飘在图中间）。
   */
  const HERO_COVER_W = 208;

  /**
   * @param {number|string|null} h 高度。传 `null` = **跟着父容器拉伸**
   *   （横幅里要靠这个铺满，固定值会在内容变高时于下方留空）。
   * @param {object} [extra] 额外的内联样式（横幅里用来抬层级/定位）。
   */
  const renderCover = (p, w, h, size, extra) => {
    const url = coverUrlOf(p);
    return (
      <div
        className="shelf-cover shrink-0 flex items-center justify-center overflow-hidden"
        style={{
          position: 'relative',
          width: w,
          ...(h ? { height: h } : null),
          '--h': hueOf(p.id),
          fontSize: size,
          fontWeight: 500,
          ...(extra || {}),
        }}
      >
        {/**
         * ⚠⚠ **首字永远先渲染**，图片绝对定位盖在上面。
         *
         * 不能写成「有 url 就渲染 img、否则渲染文字」——那样一旦
         * `cover_path` 有值但文件不在了（项目目录被清、封面没存成功、
         * 用户手动删了 `_assets/`），`<img>` 就是个**透明空框**，
         * 整块封面区域变成一片空白色块（连首字都没有）。
         * 实测羽毛菌那张截图就是这样：左侧一块淡橙、没有字、也没有图。
         *
         * 垫底 + 覆盖之后：图在就是图，图挂了自动露出首字，不需要 JS 状态。
         */}
        <span aria-hidden={!!url}>{String(p.name || '?').trim().charAt(0)}</span>
        {url && (
          <img
            src={url}
            alt=""
            data-testid="shelf-hero-cover-img"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        )}
      </div>
    );
  };

  /**
   * 大横幅 = **最近在写的那一本**（2026-11-02，照竞品补的）。
   *
   * 羽毛菌澄清过：「大横幅和我的书架都是展示用户写的书」——
   * 不是推荐位，是"上次写到哪了"的入口。所以取 updated_at 最新的那本。
   *
   * ⚠ 只有一本时**不做横幅 + 列表的重复展示**（同一本书出现两次很怪），
   *   横幅就是全部。
   */
  const sorted = [...projects].sort((a, b) =>
    String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const hero = sorted[0] || null;
  const rest = sorted.slice(1);

  /**
   * 横幅用的派生值（2026-11-02）。
   *
   * ⚠⚠ 这里是**每日目标**，不是"这本书总共要写多少"（2026-11-02 羽毛菌骂过一次：
   *   「这个目标是当日的目标，不是书本的目标，谁tm一天写100万字啊」）。
   *   我原来按类型给了 long=100 万 / short=1 万 / drama=10 万，算的是
   *   `已写字数 ÷ 全书目标` —— 那是一本书的进度，放到"今日写多少"这一栏里，
   *   任何正常作者早期都是 0.1%，进度条看着像坏了。
   *   正确的算法：**今日字数 ÷ 每日目标**，今天写了 441 / 2000 → 22%。
   */
  const hs = hero ? (stats[hero.id] || {}) : {};
  const hChapters = hs.chapters || 0;
  const hChars = hs.chars || 0;
  const hAvg = hChapters > 0 ? Math.round(hChars / hChapters) : 0;

  /** 每天打算写多少。非法值（0 / 负数 / 非数字）一律退回默认，别让界面崩成 0% 或 Infinity */
  const hGoalRaw = Math.round(Number(dailyGoal));
  const hGoal = Number.isFinite(hGoalRaw) && hGoalRaw > 0 ? hGoalRaw : 2000;
  const hToday = hs.todayChars || 0;
  /** 达成率按**今日**算，封顶 100（超额写了不该显示 230%） */
  const hPct = Math.min(100, (hToday / hGoal) * 100);
  const hGoalText = hGoal.toLocaleString('zh-CN');

  /**
   * 每日目标的开关与保存。
   *
   * ⚠⚠ 一开始写成"Enter 只负责 `blur()`，保存全交给 `onBlur`"，结果在
   *   **未获得系统焦点的窗口**里 `blur()` 只把 activeElement 换成 body，
   *   `blur` / `focusout` 事件根本不派发 → 回车没反应、点了别处也没反应。
   *   （判据里就是这么发现的：keydown 进去了，commitGoal 一次没进。）
   *   → 改成 **Enter / Esc / 失焦 三条路都各自能独立提交**，
   *     用 `goalOpenRef` 保证只提交一次，谁先到谁算。
   *
   * `goalOpenRef` 而不是读 `goalEdit` state：state 在同一个 tick 里读到的还是旧值，
   * 事件连发时（Enter 后紧跟着 blur）会重复保存。
   */
  const openGoal = () => {
    goalOpenRef.current = true;
    setGoalDraft(String(hGoal));
    setGoalEdit(true);
  };

  /** @param {boolean} save false = 放弃（Esc）；true = 提交当前 draft */
  const closeGoal = (save) => {
    if (!goalOpenRef.current) return;   // 已经关过了（Enter 之后紧跟的那次 blur）
    goalOpenRef.current = false;
    setGoalEdit(false);
    if (!save) return;
    const n = Math.round(Number(goalDraft));
    if (!Number.isFinite(n) || n <= 0) return;   // 清空 / 负数 = 放弃，保留原值
    if (n === hGoal) return;
    if (onSetDailyGoal) onSetDailyGoal(n);
  };
  const hDaysAgo = (() => {
    const t = Date.parse(String(hero?.updated_at || '').replace(' ', 'T'));
    if (!Number.isFinite(t)) return '';
    const d = Math.floor((Date.now() - t) / 86400000);
    if (d <= 0) return '今天更新';
    if (d === 1) return '昨天更新';
    return `${d} 天前更新`;
  })();

  const KINDS = [
    { id: 'long', label: '长篇', hint: '设定 / 卷纲 / 章节' },
    { id: 'short', label: '短篇', hint: '设定.md / 小节大纲.md / 正文.md' },
    { id: 'drama', label: '短剧 / 漫剧', hint: '剧集/EP001/{剧本, 视觉设定, 分镜}' },
  ];

  /**
   * 从项目 id 派生一个稳定的色相。
   *
   * ⚠ 不能用随机数：同一本书每次打开颜色都不一样，比没有颜色更糟。
   * ⚠ 只用色相（hsl 的第一位），饱和度和明度写死，
   *   这样浅色主题下也是一组克制的色块，不会花。
   */
  const hueOf = (id) => {
    let h = 0;
    for (let i = 0; i < String(id).length; i += 1) {
      h = (h * 31 + String(id).charCodeAt(i)) % 360;
    }
    return h;
  };

  const doCreate = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      await onCreate(n, kind, audience);
      setCreating(false);
      setName('');
      setDraft(null);
      setHint('');
    } finally {
      setBusy(false);
    }
  };

  /**
   * AI 提案（2026-11-01）。
   *
   * ⚠ 这一步是**可选**的，不是必经流程：没连模型、模型报错、用户不想等，
   *   都应该还能手动起名直接建。所以失败只 toast，不挡路。
   */
  const [hint, setHint] = useState('');
  const [draft, setDraft] = useState(null);
  const [drafting, setDrafting] = useState(false);

  const doDraft = async () => {
    setDrafting(true);
    try {
      const r = await window.api.project.draft({ kind, hint: hint.trim(), name: name.trim(), audience });
      if (!r || !r.ok) {
        onToast?.(`提案失败：${(r && r.error) || '未知原因'}。可以手动起名。`);
        return;
      }
      setDraft(r);
    } catch (e) {
      onToast?.(`提案失败：${e.message}。可以手动起名。`);
    } finally {
      setDrafting(false);
    }
  };

  const kindLabel = (k) => (k === 'short' ? '短篇' : k === 'drama' ? '短剧' : '长篇');

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="bookshelf">
      {/* 顶部一行：标题 + 动作 */}
      <div className="shrink-0 flex items-center justify-between px-8 pt-7 pb-4">
        <div>
          {/**
            * 大标题（2026-11-03）：17px → 26px。
            *
            * 这是"看着不像苹果"的第一处。iOS / macOS 的页面标题是**大字号**
            * （Large Title 34pt / 内页 22-26pt），副标题小一号灰字 ——
            * 靠字号的**强对比**建立层级。原来 17px 标题 + 12px 副标题，
            * 两者只差 5px，读起来像"两行说明"，不像"标题 + 说明"。
            *
            * ⚠ 字距要收（`-.02em`）：中文在大字号下默认字距偏松，
            *   不加这一条会显得散。
            */}
          <h1 className="text-[26px] font-semibold leading-tight"
              style={{ color: 'var(--ink)', letterSpacing: '-.02em' }}>我的书架</h1>
          <p className="text-[12.5px] mt-1.5" style={{ color: 'var(--ink-soft)' }}>
            {projects.length ? `${projects.length} 个项目 · 点一下开始写` : '还没有项目，从下面新建一个'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onImport && (
            <button
              onClick={onImport}
              className="px-3 py-1.5 rounded-lg text-[12.5px]"
              style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)', border: '1px solid var(--line)' }}
            >
              导入文件夹
            </button>
          )}
          <button
            onClick={() => setCreating(true)}
            className="px-3.5 py-1.5 rounded-lg text-[12.5px]"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            data-testid="bookshelf-new"
          >
            ＋ 新建项目
          </button>
          {onSettings && (
            <button
              onClick={onSettings}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[14px]"
              style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)', border: '1px solid var(--line)' }}
              title="设置"
              data-testid="bookshelf-settings"
            >
              ⚙
            </button>
          )}
        </div>
      </div>

      {/**
        * 新建项目 —— **modal 弹窗**，不是内嵌（2026-11-01 羽毛菌改）。
        *
        * 原来是往下展开一块，压在书架上面：书架的卡片被挤走、
        * 提案区一出来整页都在跳。他原话「应该是弹出来的…要么把项目弄好，
        * 要么取消建项」—— 这个动作本身就是一次"要么成要么不成"的决策，
        * 用模态框天然表达这层语义。
        *
        * ⚠ 点遮罩 = 取消（和右上角「取消」等价），不强迫用户只在按钮里选。
        * ⚠ `stopPropagation` 不能漏：否则点输入框也会被当成点遮罩，弹窗直接没了。
        */}
      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,.45)' }}
          onClick={() => setCreating(false)}
        >
          <div
            className="w-full max-w-[720px] rounded-xl p-5 max-h-[86vh] overflow-y-auto"
            style={{
              background: 'var(--paper)',
              border: '1px solid var(--line)',
              boxShadow: '0 24px 64px -24px rgba(0,0,0,.65)',
            }}
            onClick={(e) => e.stopPropagation()}
            data-testid="bookshelf-modal"
          >
          <div className="flex items-center gap-1.5 mb-3">
            {KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => setKind(k.id)}
                title={k.hint}
                className="px-3 py-1.5 rounded-full text-[12px]"
                style={{
                  background: kind === k.id ? 'var(--accent)' : 'var(--paper)',
                  color: kind === k.id ? 'var(--accent-ink)' : 'var(--ink-soft)',
                  border: `1px solid ${kind === k.id ? 'transparent' : 'var(--line)'}`,
                }}
              >
                {k.label}
              </button>
            ))}
            <span className="text-[11.5px] ml-2" style={{ color: 'var(--ink-soft)' }}>
              {KINDS.find((k) => k.id === kind)?.hint}
            </span>
          </div>

          {/**
            * 受众（2026-11-01）。
            *
            * ⚠ 独占一行、不塞进类型那排：类型决定"建什么目录"，
            *   受众决定"AI 往哪个方向提案"，两件事不该挤在一起让人以为是一组。
            */}
          <div className="flex items-center gap-1.5 mb-3">
            <span className="text-[11.5px] mr-0.5" style={{ color: 'var(--ink-soft)' }}>受众</span>
            {AUDIENCES.map((a) => (
              <button
                key={a.id || 'any'}
                onClick={() => setAudience(a.id)}
                className="px-2.5 py-1 rounded-full text-[11.5px]"
                style={{
                  background: audience === a.id ? 'var(--ink)' : 'var(--paper-2)',
                  color: audience === a.id ? 'var(--paper)' : 'var(--ink-soft)',
                  border: `1px solid ${audience === a.id ? 'transparent' : 'var(--line)'}`,
                }}
                title={
                  a.id === 'male' ? '提案走爽点 / 成长 / 事业线'
                    : a.id === 'female' ? '提案走情绪张力 / 关系变化 / 代入感'
                      : '不预设，按题材本身的气质来'
                }
                data-testid={`audience-${a.id || 'any'}`}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doCreate();
                if (e.key === 'Escape') setCreating(false);
              }}
              placeholder="给你的作品起个名字"
              className="flex-1 px-3 py-2 rounded-lg text-[13px] outline-none"
              style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }}
            />
            <button
              onClick={doDraft}
              disabled={drafting || busy}
              className="px-3 py-2 rounded-lg text-[12.5px] whitespace-nowrap disabled:opacity-40"
              style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)', border: '1px solid var(--line)' }}
              title="让模型给三个书名 + 一句话故事 + 人物方向"
              data-testid="bookshelf-draft"
            >
              {drafting ? '想…' : 'AI 帮我起'}
            </button>
            <button
              onClick={doCreate}
              disabled={busy || !name.trim()}
              className="px-4 py-2 rounded-lg text-[12.5px] disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              {busy ? '…' : '创建'}
            </button>
            <button
              onClick={() => setCreating(false)}
              className="px-3 py-2 rounded-lg text-[12.5px]"
              style={{ background: 'transparent', color: 'var(--ink-soft)' }}
            >
              取消
            </button>
          </div>

          {/**
            * 想法（可选）。
            *
            * ⚠ 放在名字下面而不是做成第二步：多一步就多一次点击，
            *   而这个框是可选的 —— 不想写就留空，AI 从零提案。
            */}
          <div className="mt-2.5 flex items-start gap-2">
            <span className="text-[11.5px] mt-2 shrink-0" style={{ color: 'var(--ink-soft)' }}>想法</span>
            <textarea
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="可选：一句话说个方向（比如「凡人流，主角苟，不当救世主」），AI 起名和立意会更准"
              rows={2}
              className="flex-1 px-3 py-2 rounded-lg text-[12.5px] outline-none resize-none"
              style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }}
            />
          </div>

          {/* AI 提案：书名可点，点一下填进名字框 */}
          {draft && (
            <div className="mt-3 rounded-lg p-3.5" style={{ background: 'var(--paper)', border: '1px solid var(--line)' }}>
              {draft.titles && draft.titles.length > 0 && (
                <div className="mb-2.5">
                  <div className="text-[11px] mb-1.5" style={{ color: 'var(--ink-soft)' }}>书名（点一个填进去）</div>
                  <div className="flex flex-wrap gap-1.5">
                    {draft.titles.map((t) => (
                      <button
                        key={t}
                        onClick={() => setName(t)}
                        className="px-2.5 py-1 rounded-md text-[12px]"
                        style={{
                          background: name === t ? 'var(--accent)' : 'var(--paper-2)',
                          color: name === t ? 'var(--accent-ink)' : 'var(--ink)',
                          border: `1px solid ${name === t ? 'transparent' : 'var(--line)'}`,
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {draft.logline && (
                <div className="mb-2">
                  <div className="text-[11px] mb-0.5" style={{ color: 'var(--ink-soft)' }}>一句话</div>
                  <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink)' }}>{draft.logline}</div>
                </div>
              )}
              {Array.isArray(draft.characters) && draft.characters.length > 0 && (
                <div className="mb-2">
                  <div className="text-[11px] mb-0.5" style={{ color: 'var(--ink-soft)' }}>人物</div>
                  <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink)' }}>
                    {draft.characters.map((c) => `${c.name}（${c.role || '—'}）`).join(' · ')}
                  </div>
                </div>
              )}
              {draft.outline && (
                <div>
                  <div className="text-[11px] mb-0.5" style={{ color: 'var(--ink-soft)' }}>走向</div>
                  <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>{draft.outline}</div>
                </div>
              )}
              <div className="text-[11px] mt-2.5" style={{ color: 'var(--ink-soft)' }}>
                ⚠ 这只是一份提案，点「创建」建的仍是空模板 —— 想把它写进设定，建完让 AI 整理一次。
              </div>
            </div>
          )}
          </div>
        </div>
      )}

      {/* 卡片网格 */}
      <div className="flex-1 overflow-y-auto min-h-0 px-8 pb-10">
        {projects.length === 0 && !creating ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-sm">
              <div className="text-[13px] mb-2" style={{ color: 'var(--ink)' }}>书架还是空的</div>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
                新建一个项目，选好类型（长篇 / 短篇 / 短剧），
                <br />软件会按那种类型的习惯把目录和初始文件建好。
              </div>
            </div>
          </div>
        ) : (
          /**
           * ⚠⚠ 内容**不再从左到右占满**（2026-11-02 羽毛菌：
           *   「把横幅和其他作品居中，不要从左到右占满，至少留点空隙，
           *     占用整个横向长度的二分之一到三分之二，必须要两边留白留空」）。
           *
           * 用**百分比**不用固定 max-width：窗口拉宽时它跟着变，
           * 始终是"居中一条"，而不是到了某个宽度就不动了。
           * `minWidth` 是给小窗口兜底 —— 太窄的话卡片会挤成一列，
           * 那时候"留白"反而更难看。
           */
          <div style={{ width: '64%', minWidth: 620, maxWidth: 1180, margin: '0 auto' }}>
            {/* ===== 大横幅：最近在写的那一本 ===== */}
            {hero && (
              /**
               * ⚠⚠ 横幅**整块不可点**，只有「继续写作」能进去（2026-11-02 羽毛菌：
               *   「现在是随便点哪里都能进入主界面，那继续写作那个按钮的意义在哪？
               *     要么取消按钮，要么只能通过按钮进入」）。
               *
               * 取舍：留按钮、只让按钮进。
               *   · 横幅里有可交互的小控件（每日目标点一下就能改），
               *     整块可点会让"我想改目标"变成"我进编辑器了"；
               *   · 横幅比卡片大得多，误触的代价也更大。
               *   · ⚠ 下面的「其他作品」卡片**仍然整块可点** —— 那是小块、无内嵌控件，
               *     点哪进哪才是它的直觉。两者规则不同是**故意的**。
               *
               * ⚠ 也不能改回 `<button>`：里面有 `<input>`（每日目标），
               *   `<button>` 里放交互元素是非法 HTML，浏览器会把它们拆开。
               */
              <div
                data-testid="shelf-hero"
                className="w-full text-left rounded-2xl overflow-hidden flex items-stretch mb-5"
                style={{
                  position: 'relative',
                  background: 'var(--paper)',
                  border: '1px solid color-mix(in srgb, var(--ink) 6%, transparent)',
                  /**
                   * ⚠ `minHeight` 而不是固定高度：横幅高度应当**由内容决定**
                   *   （简介多一行就高一点），但内容太矮时要有个下限，
                   *   否则只剩一条扁条，撑不起"大横幅"的分量。
                   */
                  minHeight: 300,
                }}
              >
                {/**
                 * ---------------- 背景：封面放大 + 截取 + 淡化 ----------------
                 *
                 * 2026-11-03 羽毛菌：「可以把封面放大截取淡化当背景图啊」——
                 * 原来横幅右侧是一大片纯纸色（准备留给插图的），
                 * 一本书时整块空着，看着像"没做完"。
                 *
                 * ⚠⚠ 第一版做错了：我按"模糊淡化"做的（`blur(22px)` + opacity .62）。
                 *   实测在 208px 宽的封面上，22px 模糊 = 把图糊成一团色雾，
                 *   **完全看不出那是封面**（羽毛菌原话：「太糊了」）。
                 *   他要的是"放大截取"，靠**透明**淡化，不是靠模糊消失。
                 *
                 * 现在的做法：
                 *   · `scale(1.45)` —— 放大，只取封面**局部**（人物上半身那片）。
                 *     不做等比铺满：那样背景和前景是同一张缩略图，看着像失误；
                 *     放大截取之后是"同一张图的不同景别"，才自然。
                 *   · `blur(5px)` —— 只够柔化细节，画面结构（人、窗、光）仍然认得出。
                 *   · `opacity .4` —— 淡化的主力是**透明度**，不是模糊。
                 *   · `transformOrigin: 'center 35%'` —— 放大的锚点偏上，
                 *     因为封面主体（人脸/主视觉）几乎都在上三分之二。
                 */}
                {coverUrlOf(hero) && (
                  <div
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: 0,
                      pointerEvents: 'none',
                      backgroundImage: `url("${coverUrlOf(hero)}")`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center center',
                      /**
                       * ⚠ blur 必须配 scale 一起用：blur 会采样到画布外，
                       *   不放大四周会透出一圈半透明晕边。1.45 同时满足
                       *   "截到局部"和"盖住边缘"两个需求。
                       */
                      filter: 'saturate(0.95)',
                      transform: 'scale(1.45)',
                      transformOrigin: 'center 35%',
                      opacity: 'var(--hero-bg-opacity, 0.5)',
                    }}
                  />
                )}

                {/**
                 * 背景之上再盖一层**渐变遮罩**，从左到右逐渐回到纸色。
                 *
                 * ⚠ 这层不是装饰，是**可读性保障**：封面可能是任何颜色，
                 *   浅色封面上深色文字直接糊掉。遮罩保证右侧永远是
                 *   "纸色打底"，文字在两种主题下都稳。
                 *
                 * ⚠⚠ 起点必须在**封面右缘之后**（约 25%，封面 208 / 横幅 845 ≈ 24.6%）。
                 *   第一版从 22% 就开始渐变 —— 结果在封面右边缘处，
                 *   左边是清晰图、右边已经被遮罩提亮了一截，接缝成了一条**硬直线**，
                 *   深色主题下尤其刺眼（像贴了两张图）。
                 *   现在 0–28% 完全透明，接缝处两侧亮度一致，过渡才自然。
                 * ⚠ 用 `color-mix` 而不是写死 rgba：深色主题下
                 *   终点自动变成深色纸，不用写第二条规则。
                 */}
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 0,
                    pointerEvents: 'none',
                    backgroundImage: 'linear-gradient(100deg,'
                      + ' transparent 0%,'
                      + ' transparent 26%,'
                      + ' color-mix(in srgb, var(--paper) 30%, transparent) 50%,'
                      + ' color-mix(in srgb, var(--paper) 56%, transparent) 74%,'
                      + ' color-mix(in srgb, var(--paper) 78%, transparent) 100%)',
                  }}
                />

                {/**
                 * 封面：竖版 7:10，**跟着横幅高度拉伸**。
                 * ⚠ 原来是写死的 297 —— 统计块改成大数字后右侧内容变高，
                 *   封面却还是 297，于是**下面空出一截**（羽毛菌圈的就是这里）。
                 *   现在传 `null`：靠外层的 `items-stretch` 自动铺满，
                 *   高度差多少都不会再留白。
                 */}
                {renderCover(hero, HERO_COVER_W, null, 64, { position: 'relative', zIndex: 1 })}

                {/**
                 * 封面右缘的**柔化带**。
                 *
                 * ⚠ 不加这条，封面（清晰）和背景（模糊）之间是一条笔直的硬边：
                 *   左边锐利、右边虚化，交界处像"两张图拼在一起"。
                 *   叠一条 44px 的渐变把清晰图的右边沿"溶"进背景，
                 *   视觉上就变成一张图从清晰过渡到模糊。
                 *
                 * ⚠ 44px 是权衡：太窄（<20）盖不住硬边，太宽（>70）会吃掉
                 *   封面标题区（叠加的书名常压在封面下半部靠右的位置）。
                 */}
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: HERO_COVER_W - 44,
                    width: 44,
                    zIndex: 1,
                    pointerEvents: 'none',
                    backgroundImage: 'linear-gradient(to right,'
                      + ' transparent 0%,'
                      + ' color-mix(in srgb, var(--paper) 26%, transparent) 70%,'
                      + ' color-mix(in srgb, var(--paper) 52%, transparent) 100%)',
                  }}
                />

                {/**
                 * 右侧分四段（2026-11-02 羽毛菌定的顺序）：
                 *   书名 → 类型 → 介绍 → 已写数据 → 写作统计 → 继续写作
                 * ⚠ 用 `flex-col` + `mt-auto` 把"数据/统计"压到底部，
                 *   书名在上、按钮在最下 —— 上下结构稳，不靠固定高度凑。
                 */}
                <div className="relative flex-1 min-w-0 flex flex-col px-6 pt-6 pb-5"
                     style={{ zIndex: 1 }}>
                  <div className="text-[22px] font-semibold truncate leading-tight"
                       style={{ color: 'var(--ink)' }}>
                    {hero.name || '未命名'}
                  </div>
                  <div className="text-[12px] mt-1.5" style={{ color: 'var(--ink-soft)' }}>
                    {kindLabel(hero.kind)}
                  </div>

                  {hs.intro ? (
                    <div
                      className="text-[13px] mt-3.5 mb-2.5 leading-relaxed"
                      style={{
                        color: 'var(--ink-soft)',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {hs.intro}
                    </div>
                  ) : (
                    <div className="text-[13px] mt-3" style={{ color: 'var(--ink-soft)', opacity: 0.65 }}>
                      （还没有简介 —— 在「设定」里写一段，这里会显示）
                    </div>
                  )}

                  <div className="flex-1" />

                  {/* 已写数据 */}
                  <div className="text-[12px] flex items-center gap-2 flex-wrap"
                       style={{ color: 'var(--ink-soft)' }}>
                    <span>{hChapters} 章</span>
                    <span style={{ opacity: 0.4 }}>·</span>
                    <span>{fmtChars(hChars) || '空'}</span>
                    <span style={{ opacity: 0.4 }}>·</span>
                    <span>平均 {hAvg ? hAvg.toLocaleString('zh-CN') : 0} 字/章</span>
                    {hDaysAgo && <><span style={{ opacity: 0.4 }}>·</span><span>{hDaysAgo}</span></>}
                  </div>

                  {/**
                   * 写作统计 + 继续写作（2026-11-02 第二次调，按羽毛菌的圈注：
                   *   「进度条弄一半长度就行，然后继续写作的按钮放在进度条下方」）。
                   * ⚠ 所以这里是**竖向三段**：数字 → 进度条 → 按钮，不是原来那种
                   *   "统计块在左、按钮在右、两者顶部对齐"。
                   * ⚠ 统计块固定 `w-1/2`：进度条是块内的满宽，于是它自然只有横幅的一半长。
                   *   别用 `basis-full` —— 那是"占满整行"，又回到原来那条长条了。
                   */}
                  <div className="flex flex-col mt-2.5">
                    <div
                      data-testid="shelf-stats-block"
                      className="w-1/2 min-w-[320px] rounded-2xl px-5 pt-4 pb-3"
                      /**
                       * 2026-11-03：`ink 4%`（灰）→ **半透明纸色**。
                       *
                       * 灰底在纯纸色上是"轻轻一块"，但横幅现在有了模糊背景，
                       * 灰 + 照片色叠在一起会发脏（像蒙了一层土）。
                       * 换成半透明纸色 = 磨砂玻璃：把背景压下去但不改变色相，
                       * 深色主题下同样成立（paper 是深色，叠出来是更暗的一层）。
                       */
                      style={{ background: 'color-mix(in srgb, var(--paper) 58%, transparent)' }}
                    >
                      {/**
                        * 三个指标：大数字在上、极小灰标签在下（2026-11-03）。
                        *
                        * 这是苹果那套"指标卡"的核心语法 —— 数字 26px、标签 11px，
                        * 两者差 15px，一眼先看到数再读标签。原来写成
                        * 「今日 0 字 · 连续 0 天」的行内小字，数字和文案同字号同颜色，
                        * 读者只能"读句子"，不能"扫数据"。
                        *
                        * ⚠ 达成率放第三列而不是塞进下面那行小字：三个数字并排才是
                        *   一个整体（今天写了多少 / 坚持了几天 / 完成了几成）。
                        */}
                      <div className="flex items-start gap-8">
                        {[
                          { label: '今日字数', value: (hs.todayChars || 0).toLocaleString('zh-CN'), tint: false },
                          { label: '连续天数', value: String(hs.streakDays || 0), tint: false },
                          {
                            label: '今日达成',
                            value: (hPct >= 10 ? Math.round(hPct) : Math.round(hPct * 10) / 10) + '%',
                            // 达标了才上强调色：这是唯一需要"跳出来"的状态
                            tint: hPct >= 100,
                          },
                        ].map((m) => (
                          <div key={m.label} className="flex flex-col">
                            <span className="text-[26px] font-semibold tabular-nums leading-none"
                                  style={{
                                    color: m.tint ? 'var(--accent)' : 'var(--ink)',
                                    letterSpacing: '-.02em',
                                  }}>
                              {m.value}
                            </span>
                            <span className="text-[11px] mt-2" style={{ color: 'var(--ink-soft)' }}>
                              {m.label}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/**
                       * 进度条：填充宽度 = 今日达成率。
                       * ⚠⚠ 这里**不要再写 `w-1/2`**：统计块本身已经是横幅的一半，
                       *   条再砍一半 → 只剩横幅的 19%，比上面那行字还短，"一半长度"
                       *   被缩了两次。条的"一半"是相对**横幅**说的，所以它铺满统计块即可。
                       */}
                      <div data-testid="shelf-progress"
                           className="mt-3.5 h-1.5 w-full rounded-full overflow-hidden"
                           style={{ background: 'color-mix(in srgb, var(--ink) 10%, transparent)' }}>
                        <div className="h-full rounded-full"
                             style={{ width: Math.max(1.5, hPct) + '%', background: 'var(--accent)' }} />
                      </div>

                      {/**
                        * 每日目标：点一下就改（2026-11-02）。
                        *
                        * ⚠ 挪到进度条**下方**：数字那一排现在是纯指标（不可点），
                        *   可编辑的东西单独一行、但视觉上仍是"块的脚注"，不抢主视觉。
                        * ⚠ 必须 `stopPropagation`：外层有可交互区域，不拦的话
                        *   点目标会先触发一次外层动作。`onMouseDown` 也要拦，
                        *   否则 mousedown 已经冒泡过一次。
                        */}
                      {goalEdit ? (
                        <span className="text-[11.5px] mt-2.5 flex items-center gap-1"
                              style={{ color: 'var(--ink-soft)' }}>
                          目标
                          <input
                            ref={goalInputRef}
                            type="number"
                            min="1"
                            step="100"
                            inputMode="numeric"
                            value={goalDraft}
                            data-testid="daily-goal-input"
                            aria-label="每日目标字数"
                            onChange={(e) => setGoalDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              // 别让按键冒到外层（Enter 会被当成"打开这本书"）
                              e.stopPropagation();
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                closeGoal(true);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                closeGoal(false);
                              }
                            }}
                            onBlur={() => closeGoal(true)}
                            className="w-[74px] px-1.5 py-0.5 rounded-md text-[11.5px] tabular-nums outline-none"
                            style={{
                              background: 'var(--paper)',
                              border: '1px solid var(--accent)',
                              color: 'var(--ink)',
                            }}
                          />
                          <span>字 / 天</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          data-testid="daily-goal-edit"
                          title="点这里改每天的目标字数"
                          onClick={(e) => {
                            e.stopPropagation();
                            openGoal();
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="text-[11.5px] mt-2.5 px-1 -mx-1 rounded-md transition-colors self-start"
                          style={{ color: 'var(--ink-soft)', background: 'transparent', border: 'none', cursor: 'text' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--ink) 8%, transparent)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          目标 <span className="tabular-nums">{hGoalText}</span> 字 / 天
                          · {hPct >= 100 ? '今日已达标' : hPct <= 0 ? '今日还没写' : `达成 ${hPct.toFixed(hPct >= 10 ? 0 : 1)}%`}
                        </button>
                      )}
                    </div>

                    {/**
                     * 「继续写作」是**唯一**进入这本书的入口（2026-11-02 羽毛菌定的）。
                     * ⚠ 所以它必须是**真的 `<button>`**：外层已经不可点了，
                     *   再写成 `<span>` 的话键盘 Tab 不到、Enter 按不动。
                     *
                     * 2026-11-03：填充色从强调蓝改成**近黑**。
                     *   iOS 的主按钮不用彩色 —— 它用 label 色（近黑/近白）当底，
                     *   彩色只留给状态（达标、警示）。蓝色实底在苹果语境里
                     *   是"链接"，不是"主操作"。
                     * ⚠ 用 `var(--ink)` / `var(--paper)` 而不是写死 #000/#fff：
                     *   深色主题下 ink 变近白，按钮自动变成"白底黑字"，
                     *   正好是 iOS 深色模式的样子，不用再写一条分支。
                     */}
                    <button
                      type="button"
                      data-testid="shelf-hero-continue"
                      onClick={() => onOpen(hero.id)}
                      className="mt-3.5 self-start px-6 py-3 rounded-full text-[14px] font-medium whitespace-nowrap"
                      style={{
                        background: 'var(--ink)', color: 'var(--paper)',
                        border: 'none', cursor: 'pointer', letterSpacing: '-.01em',
                        transition: 'opacity .15s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.88'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                      title={`进入《${hero.name || '这本书'}》`}
                    >
                      继续写作
                    </button>
                  </div>
                </div>
              </div>
            )}

            {rest.length > 0 && (
              /**
               * ⚠ 别写「全部作品 · {projects.length}」：横幅那本不在这个列表里，
               *   3 本却只显示 2 张卡，用户会以为少了一本。
               *   写「其他作品」，和上面那本明确区分开。
               */
              <div className="text-[11.5px] font-semibold mb-3 mt-1"
                   style={{ color: 'var(--ink-soft)', letterSpacing: '.01em' }}>
                其他作品
              </div>
            )}

            {rest.length > 0 && (
          <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))' }}>
            {rest.map((p) => {
              const h = hueOf(p.id);
              const first = String(p.name || '?').trim().charAt(0);
              return (
                <button
                  key={p.id}
                  onClick={() => onOpen(p.id)}
                  className="shelf-card text-left overflow-hidden"
                  /**
                   * 2026-11-03：**去掉 1px 描边，改成白卡 + 极轻阴影**。
                   *
                   * 苹果的卡片不画线 —— 它靠"卡片比底色亮" + 一层几乎看不见的
                   * 投影把卡片托起来。描边是"表格"的语言，投影才是"卡片"的语言。
                   * 我们底色差只有 2.6%（`--paper` vs `--paper-2`），光靠明度
                   * 撑不住，所以用投影补那一口气。
                   *
                   * ⚠ 阴影要**双层**：一层 1px 贴边的（定义轮廓），
                   *   一层大半径低透明度的（定义体积）。单层阴影不是太脏就是太糊。
                   */
                  style={{
                    background: 'var(--paper)',
                    borderRadius: 16,
                    /**
                     * ⚠ 深色主题下**光靠阴影撑不住**：黑底上的黑影等于没有，
                     *   卡片会和页面糊成一片（实测深色截图里两张卡几乎看不出边界）。
                     *
                     * 但也不能退回 `1px solid var(--line)` —— 那条在浅色下太"硬"，
                     * 正是要去掉的"表格感"。
                     *
                     * 折中：`ink 6%` 的描边。
                     *   浅色：ink 是近黑，6% ≈ #f2f2f2，几乎看不见，只帮一圈轮廓；
                     *   深色：ink 是近白，6% ≈ #262626，正好够把卡片从背景里勾出来。
                     * 一条规则同时满足两个主题，不用写主题分支。
                     */
                    border: '1px solid color-mix(in srgb, var(--ink) 6%, transparent)',
                    boxShadow: '0 1px 2px rgba(0,0,0,.05), 0 6px 16px -6px rgba(0,0,0,.10)',
                  }}
                  /**
                   * ⚠ 悬停/按下的动效交给 `.shelf-card`（index.css），不再写在
                   *   onMouseEnter 里 —— inline style 会被 CSS 里的 :hover 覆盖不掉，
                   *   而且 JS 里没有：active，按下那一刻没有反馈。
                   */
                  data-testid="bookshelf-card"
                >
                  {/**
                    * 封面：首字 + 稳定色相。
                    *
                    * ⚠ 颜色交给 CSS（`.shelf-cover`），这里只传 `--h`。
                    *   原来把 `hsl(... / 0.16)` 写在这儿，深色主题下
                    *   五个卡片几乎同一个暗色 —— 主题相关的值必须进 CSS，
                    *   否则深色/浅色只能二选一。
                    */}
                  <div
                    className="shelf-cover shelf-card-cover flex items-center justify-center overflow-hidden"
                    style={{
                      // 128（原 104）：卡片变大后封面跟着长，否则标题栏占比过高、像"标签卡"
                      height: 128,
                      '--h': h,
                      fontSize: 38,
                      fontWeight: 500,
                    }}
                  >
                    {coverUrlOf(p) ? (
                      <img src={coverUrlOf(p)} alt=""
                           style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : first}
                  </div>
                  <div className="px-3.5 py-3">
                    <div className="text-[13.5px] font-medium truncate"
                         style={{ color: 'var(--ink)' }}>{p.name || '未命名'}</div>
                    <div className="text-[11px] mt-1 flex items-center gap-1.5" style={{ color: 'var(--ink-soft)' }}>
                      <span>{kindLabel(p.kind)}</span>
                      {fmtChars(stats[p.id]?.chars) && (
                        <span style={{ opacity: 0.5 }}>·&nbsp;{fmtChars(stats[p.id].chars)}</span>
                      )}
                      <span style={{ opacity: 0.5 }}>·&nbsp;</span>
                      <span>{(p.updated_at || '').slice(0, 10)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
            )}
          </div>
        )}
      </div>

      {/**
       * 书架底部统计条 —— 固定在底部（不跟着滚），
       * 书多了滚到最后也一直能看到"我一共写了多少"。
       *
       * 2026-11-03：宽度收进**同一条居中轴**（64% / 居中）。
       *   原来它铺满整个窗口（px-8），而上方的横幅与卡片只占 64% 居中 ——
       *   底部那条右边缘比内容多伸出 200 多 px，越看越歪。
       *   苹果的做法是所有内容共享一条轴，滚动区与固定条都对同一条边。
       */}
      {projects.length > 0 && (
        <div className="shrink-0 px-8 pb-5 pt-1">
          <div style={{ width: '64%', minWidth: 620, maxWidth: 1180, margin: '0 auto' }}>
          <div
            className="flex items-stretch rounded-2xl overflow-hidden"
            style={{ background: 'var(--paper-2)' }}
            data-testid="shelf-stats"
          >
            {[
              { v: String(projects.length), u: '本', l: '作品' },
              { v: bigNum(totalChars), u: bigUnit(totalChars), l: '累计字数' },
              { v: statReady ? String(totalFiles) : '—', u: statReady ? '个' : '', l: '文档' },
            ].map((s, i) => (
              <div
                key={s.l}
                className="flex-1 flex flex-col items-center justify-center py-3"
                style={i ? { borderLeft: '1px solid color-mix(in srgb, var(--ink) 8%, transparent)' } : undefined}
              >
                <div className="flex items-baseline gap-1">
                  <span className="text-[20px] font-semibold tabular-nums"
                        style={{ color: 'var(--ink)', letterSpacing: '-.01em' }}>{s.v}</span>
                  {s.u && (
                    <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>{s.u}</span>
                  )}
                </div>
                <span className="text-[11px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>{s.l}</span>
              </div>
            ))}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
