import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackgroundLayer, useBackground } from './components/Background.jsx';
import ConversationList from './components/ConversationList.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import FileBox from './components/FileBox.jsx';
import EditorSurface from './components/EditorSurface.jsx';
import SplitPanes from './components/SplitPanes.jsx';
import MainWorkspace from './components/MainWorkspace.jsx';
import DocPreview from './components/DocPreview.jsx';
import FileTree from './components/FileTree.jsx';
import StyleDistill from './components/StyleDistill.jsx';
import IntroGen from './components/IntroGen.jsx';
import ToolsPanel from './components/ToolsPanel.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import TrashModal from './components/TrashModal.jsx';
import ProjectSwitcher from './components/ProjectSwitcher.jsx';
import { ToolApprovalModal } from './components/ToolCards.jsx';
import AgreementModal from './components/AgreementModal.jsx';
import { THEMES, DEFAULT_THEME, applyTheme, isValidTheme } from './themes.js';
import { thinkLevelsOf, normalizeLevel } from './think-levels.js';
import { useBootstrapFonts } from './lib/fonts.js';
import { playChime } from './lib/chime.js';

/**
 * 顶栏「卡片开关」能收起的栏。
 *
 * 只有左边两栏（AI 相关）可收起：右边两栏是目录与文件预览，
 * 它们是「自己写」的地盘，收起就没东西可看了。
 */
const CARD_PANES = ['conversations', 'main'];

/**
 * 主界面：对话优先布局。
 *
 * ## 四栏结构
 *
 *   ┌──────────┬────────────────────────┬──────────────┐
 *   │ 对话列表  │      对话消息流        │   文件框      │
 *   │          ├────────────────────────┤ 章节/设定/    │
 *   │          │  输入区 + @ + 发送     │ 状态/伏笔/    │
 *   └──────────┴────────────────────────┴──────────────┘
 *
 * ## 为什么从「编辑器为主」改成「对话为主」
 *
 * 原来的三栏是「章节树 | 编辑器 | 设置」，本质是以文档为中心，
 * 动作是「打开章节 → 编辑 → 保存」。
 * 改成对话优先后，动作变成「聊 → 生成 → 落到某个章节」——
 * 这才是用 AI 写长篇的natural节奏。
 * 编辑器没消失，挪进右栏的「正文」页签，需要时展开。
 *
 * ## 状态归属
 *
 * 每类状态只有一个主人，避免多处同步：
 *   配置       config（主进程 config.json 持久化）
 *   项目/章节   refreshToken 触发重载
 *   对话/消息   直接持有，随 conv:* IPC 刷新
 *   编辑器     editorApi ref（不参与渲染，避免每分片重渲染）
 */
export default function App() {
  const [config, setConfig] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [theme, setTheme] = useState(DEFAULT_THEME);

  /**
   * 启动期把已安装的开源字体的 @font-face 挂上，正文/聊天才能用。
   * 这是个只跑一次的副作用 hook（内部自带空依赖）。
   */
  useBootstrapFonts();

  /**
   * config 的实时引用。生成完成回调（onDone）闭包里捕获的 config 可能是旧的，
   * 读 notify 时要用这个 ref 拿最新值，否则用户刚改了「仅提示音」、回调还照老的「窗口」走。
   */
  const configRef = useRef(config);
  configRef.current = config;

  // 对话
  const [conversations, setConversations] = useState([]);
  const [convId, setConvId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [streamingText, setStreamingText] = useState('');
  /**
   * 思考内容。与正文完全分开——它只用于在界面上显示"模型在想什么"，
   * 绝不进编辑器、绝不落库。
   */
  const [streamingThink, setStreamingThink] = useState('');

  /**
   * 本轮生成里的工具调用。
   *
   * ⚠ 只在生成中显示，生成结束（done / error / 停止）就清空。
   *   它们是「这一轮的过程」而不是对话记录——落库的只有助手正文。
   *   生成结束不清的话，下一次生成时旧卡片会跟新卡片叠在一起，
   *   用户会以为模型又把刚才那几条命令跑了一遍。
   */
  const [toolCalls, setToolCalls] = useState([]);
  /** 待用户决定的危险命令；null = 没有 */
  const [approval, setApproval] = useState(null);

  // 回收站：改成**居中弹窗**（覆盖整个窗口），不再是第 4 栏的一个页面。
  // 原因见 TrashModal 顶部的注释——替换掉第 4 栏时用户"关不掉"。
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashCount, setTrashCount] = useState(0);
  // 项目切换弹窗
  const [switcherOpen, setSwitcherOpen] = useState(false);
  /**
   * 打开弹窗时是否**直接展开「新建」输入框**。
   *
   * ⚠ 这不是装饰。零项目时（首次使用、或用户把项目删光了）
   *   第 1 栏那个「＋ 新对话」点了应该变成「＋ 新建项目」，
   *   用户点它就是想去建项目——再让他在弹窗里找一次
   *   「＋ 新建」按钮，等于把同一个动作拆成两步。
   */
  const [switcherNew, setSwitcherNew] = useState(false);

  // 生成
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('');
  const [lastUserText, setLastUserText] = useState('');   // 失败重试用

  // 引用源
  const [skills, setSkills] = useState([]);
  const [settings, setSettings] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [states, setStates] = useState([]);
  const [threads, setThreads] = useState([]);

  /**
   * AI 连接：服务商量表 + 当前用了哪条。
   *
   * 输入框旁边的「思考强度」档位由**当前连接**决定——
   * Ollama 有四档、百炼只有开与关、QwQ 那类靠模型名区分（没有档位）。
   * 所以这两个值要在主界面拿一份，而不是只有设置页知道。
   *
   * 拿不到时 caps 为 null → thinkLevelsOf 返回 null → 不渲染控件。
   * 这是有意的降级：宁可没有控件，也不要给一个点了没用的按钮。
   */
  const [caps, setCaps] = useState(null);
  const [connections, setConnections] = useState([]);

  // 文件框内部状态
  const [fileTab, setFileTab] = useState('chapters');
  const [newTitle, setNewTitle] = useState('');
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(null);
  const [newItem, setNewItem] = useState({ type: 'character', name: '', note: '', summary: '', importance: 3 });
  const [editingState, setEditingState] = useState(null);
  const [editForm, setEditForm] = useState({ location: '', 境界: '' });
  const [activeChapterId, setActiveChapterId] = useState(null);

  // 文风
  const [styleProfile, setStyleProfile] = useState(null);
  const [styleResult, setStyleResult] = useState(null);
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleDirectiveText, setStyleDirectiveText] = useState('');

  /**
   * 设置页是否整页覆盖。
   *
   * 原来是顶栏一个主题下拉 + 一个「设置」按钮开侧栏面板，
   * 结果同一个设置散在两处、用户找不到。现在统一到 SettingsPage：
   * 左下角一个入口，点开整页覆盖，左上角返回键回来。
   */
  const [showSettings, setShowSettings] = useState(false);

  /**
   * 设置页要停在哪个类目（2026-10-14）。
   *
   * ⚠ 联网 chip 显示「缺 Key」时，用户点它就是要去改这个 ——
   *   所以必须直接落到「工具」页。停在默认的「外观」页等于让他自己找，
   *   那一跳就白跳了。null = 用设置页自己的默认。
   */
  const [settingsCat, setSettingsCat] = useState(null);

  /** 从别处打开设置页，可指定落点 */
  const openSettings = useCallback((cat) => {
    setSettingsCat(cat || null);
    setShowSettings(true);
  }, []);

  /**
   * 初始化失败的错误信息。
   *
   * ⚠ 不是可选功能：初始化失败时如果什么都不显示，
   *   用户看到的是一片空白，完全不知道软件坏了。
   */
  const [initError, setInitError] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [dirty, setDirty] = useState(false);

  const [toast, setToast] = useState(null);

  /**
   * 轻提示（顶栏浮层）。
   *
   * ⚠ 声明位置有讲究：必须排在**所有 useCallback 之前**。
   *   renderMainTab 里用到 showToast，而它自己是要在 render 里执行的；
   *   showToast 若声明在后面，渲染时就是 TDZ 错误
   *   「Cannot access ... before initialization」——
   *   整个 React 树挂不上，界面全白且**不报任何错**。
   *   那个错是靠临时加的 ErrorBoundary 才抓到的。
   */
  const showToast = useCallback((text) => {
    setToast(text);
    /**
     * ⚠ 停留 3.2 秒 → 5 秒（2026-10-14）。
     *
     * 羽毛菌说「点保存没有任何提示」。查下来 toast 弹了，但
     * 「已保存 ✓ 但系统没提供加密，重启后需要重填」这种带条件的提示
     * 3.2 秒根本读不完 —— 他只看到一闪而过。
     *
     * ⚠ 单纯加时长治不了根：**再长也会消失**，而"存没存上"
     *    是要反复确认的事。所以真正的修法是 ToolCat 里那个常驻的
     *    「✓ 已保存」标记（data-testid=search-key-saved-badge）。
     *    这里加时长只是让它别太赶。
     */
    setTimeout(() => setToast(null), 5000);
  }, []);

  // 版本号显示在状态栏。读不到就留空——不该为了显示一个版本号
  // 在启动路径上抛错。
  const [versionInfo, setVersionInfo] = useState('');
  /**
   * 完整版本号（1.0.0）。分割面板的持久化键按「主版本」分，
   * 所以大更新时用户的栏宽设置会自动重置——界面变了就该重置。
   */
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    window.api.app.version()
      .then((v) => {
        setVersionInfo(v.full || `v${v.version}`);
        setAppVersion(v.full || `v${v.version}`);
      })
      .catch(() => { setVersionInfo(''); setAppVersion(''); });
  }, []);

  const editorApi = useRef(null);
  const unsubs = useRef([]);
  const convSeq = useRef(0);

  const bump = () => setRefreshToken((t) => t + 1);

  /**
   * 打开项目切换弹窗。
   *
   * @param {boolean} creating 是否直接展开「＋ 新建」输入框。
   *   零项目时从「＋ 新对话」点进来要传 true ——
   *   用户点那一下的意图就是"建东西"，再让他找一次新建按钮是多余的一步。
   */
  const openSwitcher = useCallback((creating = false) => {
    setSwitcherNew(!!creating);
    setSwitcherOpen(true);
  }, []);

  // ================================================================
  // 初始化
  // ================================================================
  useEffect(() => {
    /**
     * ⚠ 这里必须有 try/catch，而且失败时也要 setConfig。
     *
     * 原来写成裸的 await：任何一个通道失败（比如 preload 没挂上、
     * 主进程某处抛错）都会让 setConfig 永远不执行，
     * 而 `if (!config) return 加载中…` 会让整个界面**永远停在加载中**——
     * 白屏且不报错，用户只能重启。
     *
     * 现在：失败时用一份可用的默认配置兜底，并显示出错原因，
     * 让用户知道是哪里坏了而不是界面没反应。
     */
    (async () => {
      try {
        const cfg = await window.api.config.get();
        setConfig(cfg);
        const t = isValidTheme(cfg.theme) ? cfg.theme : DEFAULT_THEME;
        setTheme(t);
        applyTheme(t);
        const ps = await window.api.project.list();
        setProjects(ps);
        if (cfg.currentProject && ps.some((p) => p.id === cfg.currentProject)) {
          setProjectId(cfg.currentProject);
        } else if (ps.length) {
          setProjectId(ps[0].id);
        }
      } catch (e) {
        console.error('初始化失败：', e);
        setInitError(e.message || String(e));
        // 兜底配置：让界面能起来，用户至少能看到「哪里坏了」而不是白屏
        setConfig({
          model: 'qwen3:latest',
          ollamaBase: 'http://127.0.0.1:11434',
          numCtx: 8192, temperature: 0.3, fontSize: 16,
          editorFontSize: 16, chatFontSize: 16,
          fontFamily: 'system-ui', editorFont: 'system-ui', chatFont: 'system-ui',
          theme: DEFAULT_THEME,
          notify: 'window', currentProject: null,
        });
        applyTheme(DEFAULT_THEME);
        setProjects([]);
      }
    })();
  }, []);

  /**
 * 配置变更的统一入口。
 *
 * ⚠ 主题必须在这里 applyTheme，而不只是存进 config。
 *   设置页的 `save()` 走的是 `config.set` + `onConfigChange(cfg)`，
 *   如果只更新 React state 不动 DOM 上的 data-theme 属性，
 *   界面就会「显示已保存但颜色没变」——用户改了看不到，只能重启。
 *   CSS 变量挂 data-theme，不重渲染组件就能变色。
 *
 *   另外 theme 做兜底：万一 cfg 里没有 theme 字段（配置损坏或
 *   桩实现返回了残缺对象），就用现有的 theme 状态，不要退回默认——
 *   那会把用户正在用的深色主题强行切回浅色。
 */
const applyConfig = useCallback(async (cfg) => {
  const next = cfg || {};
  setConfig(next);
  const t = isValidTheme(next.theme) ? next.theme : (isValidTheme(theme) ? theme : DEFAULT_THEME);
  setTheme(t);
  applyTheme(t);
}, [theme]);

const changeTheme = useCallback(async (id) => {
  setTheme(id);
  applyTheme(id);
  try {
    await window.api.config.set({ theme: id });
    const cfg = await window.api.config.get();
    setConfig(cfg);
  } catch (_) { /* 持久化失败不影响本次切换 */ }
}, []);

  // ================================================================
  // 引用源加载
  // ================================================================
  useEffect(() => {
    if (!projectId) { setSkills([]); setSettings([]); setChapters([]); setStates([]); setThreads([]); return; }
    (async () => {
      try {
        const [sk, st, ch, es, th] = await Promise.all([
          window.api.skill.list({ projectId }),
          window.api.settings.list({ projectId }),
          window.api.chapter.list({ projectId }),
          window.api.state.list({ projectId }),
          window.api.thread.open({ projectId }),
        ]);
        setSkills(sk || []);
        setSettings(st || []);
        setChapters(ch || []);
        setStates(es || []);
        setThreads(th || []);
      } catch (e) {
        console.warn('加载项目数据失败：', e.message);
      }
    })();
  }, [projectId, refreshToken]);

  /**
   * AI 连接读取。
   *
   * ⚠ 依赖里带 showSettings：用户在设置页换了连接（或改了某条连接的
   *   协议）之后关掉设置页，输入框旁边的档位必须跟着变——
   *   否则会出现"我明明换成百炼了，档位还显示四档"。
   *   设置页是整页覆盖，关掉时 showSettings 从 true → false，正好是一次刷新点。
   */
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [c, conns] = await Promise.all([
          window.api.provider.capabilities(),
          window.api.provider.listConnections(),
        ]);
        if (dead) return;
        setCaps(c);
        setConnections(conns || []);
      } catch (e) {
        if (dead) return;
        console.warn('读 AI 连接信息失败（思考档位控件会隐藏）：', e.message);
        setCaps(null);
        setConnections([]);
      }
    })();
    return () => { dead = true; };
  }, [showSettings, refreshToken]);

  // ================================================================
  // 对话
  // ================================================================
  const loadConversations = useCallback(async (pid, selectFirst = false) => {
    if (!pid) { setConversations([]); setConvId(null); setMessages([]); return; }
    const list = await window.api.conv.list({ projectId: pid });
    setConversations(list || []);
    if (selectFirst && list?.length) {
      await selectConversation(list[0].id);
    } else if (convId && list && !list.some((c) => c.id === convId)) {
      // 当前对话被删了
      setConvId(null);
      setMessages([]);
    }
  }, [convId]);

  useEffect(() => { loadConversations(projectId, true); }, [projectId]);

  const selectConversation = useCallback(async (id) => {
    convSeq.current += 1;
    const seq = convSeq.current;
    setConvId(id);
    setStyleResult(null);
    setStreamingText('');
    setStreamingThink('');
    const ms = await window.api.conv.messages({ conversationId: id });
    // IPC 往返期间用户可能又切了对话，丢弃过期响应
    if (seq !== convSeq.current) return;
    setMessages(ms || []);
  }, []);

  const createConversation = useCallback(async (title) => {
    /**
     * ⚠ 没项目时**不能静默 return**。
     *
     * 原来这里写的就是 `if (!projectId) return;`，表现是：
     * 用户点「＋ 新对话」什么都不发生——不报错、不提示、不加载。
     * 而"零项目"根本不是异常状态，是**首次使用的正常状态**
     * （羽毛菌那台机器的 projects 表就是 0 条）。
     *
     * 静默失败是最贵的一种错：用户以为是软件坏了，
     * 而实际只差一步"先建个项目"。
     */
    if (!projectId) {
      showToast('还没有小说项目，先建一个');
      openSwitcher(true);
      return;
    }
    const c = await window.api.conv.create({ projectId, title });
    await loadConversations(projectId);
    await selectConversation(c.id);
  }, [projectId, loadConversations, selectConversation, openSwitcher, showToast]);

  /**
   * 改这一条对话的思考强度。
   *
   * 两件事都要做：
   *   1. 落库（conv:setThink）—— 切走再回来、甚至重启后还是这一档
   *   2. 更新本地 conversations —— 控件要立刻显示新档位
   *
   * ⚠ 先改本地再发请求：IPC 一个来回要几十毫秒，
   *   按钮会"点了不动"。失败了再回滚，并把原因说出来。
   */
  const changeThinkLevel = useCallback(async (level) => {
    /**
     * ⚠ 还没开对话时改档位，要落到**全局默认**，不能直接 return。
     *
     * 直接 return 的表现是：空白界面上点「高」，按钮纹丝不动——
     * 看着就像坏了。而用户那一刻的意图很明确：
     * "接下来这一轮用高"。而"接下来那一轮"确实会读全局默认，所以落到那里是对的。
     */
    if (!convId) {
      setConfig((c) => ({ ...c, thinkLevel: level }));
      try {
        await window.api.config.set({ thinkLevel: level });
      } catch (e) {
        showToast(`档位没能保存：${e.message}`);
      }
      return;
    }
    const prev = conversations.find((c) => c.id === convId)?.thinkLevel || '';
    setConversations((list) => list.map(
      (c) => (c.id === convId ? { ...c, thinkLevel: level } : c)
    ));
    try {
      await window.api.conv.setThink({ conversationId: convId, level });
    } catch (e) {
      setConversations((list) => list.map(
        (c) => (c.id === convId ? { ...c, thinkLevel: prev } : c)
      ));
      showToast(`档位没能保存：${e.message}`);
    }
  }, [convId, conversations, showToast]);

  const deleteConversation = useCallback(async (id) => {
    await window.api.conv.remove({ id });
    const rest = conversations.filter((c) => c.id !== id);
    setConversations(rest);
    if (convId === id) {
      if (rest.length) await selectConversation(rest[0].id);
      else { setConvId(null); setMessages([]); }
    }
  }, [convId, conversations, selectConversation]);

  const renameConversation = useCallback(async (id, title) => {
    await window.api.conv.rename({ id, title });
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  // ================================================================
  // 生成
  // ================================================================
  useEffect(() => {
    unsubs.current = [
      window.api.generate.onChunk((text) => {
        setStreamingText((prev) => prev + text);
      }),
      window.api.generate.onDone((meta) => {
        setGenerating(false);
        setStreamingText('');
        // 生成完成提示音：notify 含「提示音」时播（'window'/'none' 不响）。
        // ⚠ 必须读 configRef.current 拿最新 notify——这个回调闭包捕获的
        //   config 是订阅那一刻的旧值，用户中途改了提示方式不会生效。
        if (!meta?.stopped) {
          const n = configRef.current && configRef.current.notify;
          if (n === 'sound' || n === 'both') {
            try { playChime(); } catch (_) { /* 音频不可用不影响主流程 */ }
          }
        }
        // ⚠ 工具卡片必须清：不清的话下一轮生成时它们会跟新卡片叠在一起，
        //   用户会以为模型把刚才那几条命令又跑了一遍。
        //   （结束卡片也可能还挂在"执行中"，那更吓人。）
        setToolCalls([]);
        // 思考留一小会儿让用户看到，1.2 秒后淡出
        setTimeout(() => setStreamingThink(''), 1200);
        if (meta && meta.stopped) { setStatus('已停止'); return; }
        if (meta && meta.tokensOut) {
          setStatus(`${((meta.ms || 0) / 1000).toFixed(1)}s · ${meta.tokensOut} tokens`);
        } else {
          setStatus('');
        }
        // 回答已由主进程落库，重新拉一次消息
        if (convId) window.api.conv.messages({ conversationId: convId }).then(setMessages);
        if (convId) window.api.conv.list({ projectId }).then(setConversations);
      }),
      /**
       * 思考分片。只累加到 streamingThink，**不碰 streamingText**——
       * streamingText 是正文，会进编辑器、进落盘校验、进对话历史。
       * 把思考混进去，用户稿子里就会多一段「嗯，用户让我写…」。
       */
      window.api.generate.onThink((text) => {
        setStreamingThink((prev) => prev + text);
      }),
      /**
       * 生成结束后，主进程把正文自动写回了章节文件（2026-10-18）。
       *
       * ⚠ 必须提示。这是"用户没有逐字要求、但软件替他做了"的动作 ——
       *   静默写入等于让他某天发现稿子被改了却不知道为什么。
       *   文件树由 fs:changed 那条链路自己刷新，这里只管告诉人。
       */
      window.api.generate.onAutosave((info) => {
        if (!info || !info.path) return;
        const bits = [];
        if (info.chars) bits.push(`${info.chars} 字`);
        bits.push(info.mode === 'create' ? '新建' : '已覆盖');
        if (info.backup) bits.push('原稿已备份');
        showToast(`已写入 ${info.path}（${bits.join(' · ')}）`);
      }),
      /**
       * 行为审计把对话暂停了（2026-10-18）。
       *
       * ⚠ 走推送而不是等 conv:send 的返回值：暂停是在**上一轮结束时**
       *   判定的，用户此刻可能已经切走了对话。等他下次点发送才告诉，
       *   他只会觉得"打字没反应"。
       */
      window.api.audit.onPaused((msg) => {
        setAuditPaused(true);
        setScopeNotice(msg || '连续两轮没有任何写作产出，已暂停对话功能。');
      }),
      window.api.generate.onError((e) => {
        setGenerating(false);
        setStreamingText('');
        setStreamingThink('');
        setToolCalls([]);
        // ⚠ 出错时审批弹窗要一起收掉。不收的话主进程已经不再等这个决定了，
        //   弹窗会一直挂在屏幕上，用户点了也没反应——看起来像软件死了。
        setApproval(null);
        setError(e.message);
        setStatus('');
      }),

      // ---- 工具 ----
      /**
       * 按 id 合并而不是追加。
       *
       * ⚠ 追加会有两类重复：同一次调用的 start/end 各来一条
       *   （那就得靠"上一条是不是同一个 id"来猜），
       *   以及模型在同一轮里两次查同一个东西（id 可能重复）。
       *   用 id 覆盖更新，前者后者都自然对。
       */
      window.api.tool.onStart((c) => {
        setToolCalls((prev) => upsertTool(prev, { ...c, status: 'running', output: '' }));
      }),
      window.api.tool.onEnd((c) => {
        setToolCalls((prev) => upsertTool(prev, {
          ...c,
          // ⚠ 主进程只给 ok:false 的粗粒度状态；被拒绝的卡片
          //   要显示成"已拒绝"而不是"失败"——命令没跑，跟跑出错是两件事。
          status: c.status === 'failed' ? 'failed' : 'done',
        }));
      }),
      window.api.tool.onApprove((req) => {
        setApproval(req);
      }),
    ];
    return () => { unsubs.current.forEach((f) => f()); unsubs.current = []; };
  }, [convId, projectId]);

  /**
   * 《用户协议》弹窗。
   *
   * ⚠⚠ 它挂在 **App 层**、不挂在 ChatPanel 里：范围守卫有**两个**入口
   *   （聊天发送、正文生成），而这两个入口回来的拦截结果形状是一样的。
   *   挂在某一个面板里，等于另一个入口拦下时就没有弹窗 ——
   *   那种"点了没反应、也没提示"最难查。
   *
   * `state` 形状：{ version, text, token, reason, retry:{text,refs} }
   */
  const [agreement, setAgreement] = useState(null);
  const openAgreement = useCallback(async (info) => {
    let doc = { version: '', text: '' };
    try { doc = (await window.api.scope.agreement()) || doc; } catch (_) { /* 取不到就显示占位 */ }
    setAgreement({ ...doc, token: info.token, reason: info.reason, retry: info.retry });
  }, []);
  /**
   * ⚠⚠ 这两个刻意**不用 useCallback**：`send` 每次渲染都是新的，
   *   而 `send` 闭包里有 convId / projectId / thinkLevel。
   *   用 useCallback([agreement]) 会把**旧的那份 send** 冻在闭包里 ——
   *   弹窗开着的时候切了对话，勾完同意就发到**另一条对话**去了。
   */
  const agreeAndSend = async () => {
    if (!agreement) return;
    const { token, retry } = agreement;
    setAgreement(null);
    await send(retry.text, retry.refs, token);
  };
  const cancelAgreement = () => {
    setAgreement(null);
    setError(null);
    setScopeNotice('');
    showToast('已取消 —— 这条内容没有发送');
  };

  /**
   * 解除行为审计暂停（2026-10-18，第三道防线）。
   *
   * ⚠ 通道失败也要放行：这是用户自己的软件，他点了"继续"就该继续。
   *   卡在一个 IPC 调用上等于把他锁在门外 —— 那正是这个功能最不该有的结果。
   */
  const resumeAudit = async () => {
    try { await window.api.audit.resume(); } catch (_) { /* 通道挂了也照样放行界面 */ }
    setAuditPaused(false);
    setScopeNotice('');
  };

  /**
   * 发一条消息。
   *
   * ⚠⚠ `agreementToken` 不是"用户点了同意"的意思，是主进程发下来的
   *   **一次性凭据**（范围守卫第一次拦到"涉及法律/道德伦理"时给的）。
   *   带上它 → 那一条放行，且**不再重复记警告**；不带 → 按第一次那样又被拦一次。
   *   它绑定原文，所以弹窗期间改了输入就失效（这是有意的）。
   */
  const send = async (text, refs, agreementToken) => {
    /**
     * ⚠ 零项目时的文案要**指得出位置**。
     *
     * 原来写的是「先在顶部选一个项目」——而项目选择早就从顶栏
     * 搬到第 4 栏第 2 行了（见下面 header 里的注释）。
     * 用户按这个提示去顶栏找，只会找到 WriteTool 的 logo。
     */
    if (!projectId) {
      setError('还没有小说项目。点第 4 栏顶部的「（未选项目）」，选「＋ 新建」。');
      return;
    }
    /**
     * 思考强度只在**真正要发**的时候才落到这次请求上。
     *
     * 传的是界面上算好的那个值（thinkLevel），主进程会顺手存进这条对话，
     * 所以"改了档位但没有发送"也不会丢——changeThinkLevel 已经落过库了。
     */
    const think = thinkLevel;
    if (!convId) {
      // 没选对话就现建一个——比弹窗问「要不要新建」顺手
      const c = await window.api.conv.create({ projectId, title: (text || '').slice(0, 16) });
      await loadConversations(projectId);
      setConvId(c.id);
      setMessages([]);
      setLastUserText(text || '');
      setError(null);
      setGenerating(true);
      setStatus('生成中…');
      try {
        const r = await window.api.conv.send({
          conversationId: c.id, projectId, text, refs,
          model: config?.model, temperature: config?.temperature, thinkLevel: think,
          tools: toolsThisTurn, agreementToken,
          /**
           * 界面当前打开的文件（2026-10-18）。
           * 主进程据此判断"这一轮写的是哪一章" —— 用户打开第一章说
           * 「重写一下」时不带章节号，只有这个信号能定到文件。
           */
          activePath: previewPath,
        });
        // ⚠ 被范围守卫拦下时**必须看返回值**：这里原来是 `await` 完就不管了，
        //   于是"新对话 + 越狱请求"这一条路会静默什么都不发生。
        if (r && r.blocked) {
          setGenerating(false); setStatus('');
          setScopeNotice(r.reason || '');
          if (r.locked) setScopeLocked(true);
          // ⚠ 需要签协议的：弹窗，不往提示条里一写了之
          if (r.needAgreement && r.agreementToken) {
            await openAgreement({ token: r.agreementToken, reason: r.reason, retry: { text, refs } });
          }
        }
        // 行为审计暂停（2026-10-18）：不是"这句话被拦"，是整个对话被暂停
        if (r && r.paused) {
          setGenerating(false); setStatus('');
          setAuditPaused(true);
          setScopeNotice(r.reason || '连续两轮没有任何写作产出，已暂停对话功能。');
        }
      } catch (e) {
        setGenerating(false); setError(e.message); setStatus('');
      }
      return;
    }

    setError(null);
    setGenerating(true);
    setStatus('生成中…');
    setStreamingText('');
    setLastUserText(text || '');
    try {
      const r = await window.api.conv.send({
        conversationId: convId, projectId, text, refs,
        model: config?.model, temperature: config?.temperature, thinkLevel: think,
        tools: toolsThisTurn, agreementToken,
        // 同上：当前打开的文件，用于"重写这一章"时定到具体章节
        activePath: previewPath,
      });
      if (!r.started) {
        setGenerating(false);
        setStatus('');
        if (r.blocked) {
          // 守卫拦的：不是"上一次还没结束"，用不抢眼的说明 + 上方的横条
          setScopeNotice(r.reason || '');
          if (r.locked) setScopeLocked(true);
          else setError(null);
          // ⚠ 需要签协议的：弹窗（必须勾选同意才能继续），不往提示条里一写了之
          if (r.needAgreement && r.agreementToken) {
            await openAgreement({ token: r.agreementToken, reason: r.reason, retry: { text, refs } });
          }
        } else if (r.paused) {
          // 行为审计暂停（2026-10-18）：不是 error，是"这个对话被劝停了"
          setAuditPaused(true);
          setScopeNotice(r.reason || '连续两轮没有任何写作产出，已暂停对话功能。');
        } else {
          setError(r.reason || '上一次生成还没结束');
        }
        return;
      }
      // 用户消息已落库，立刻回显，不等生成结束
      window.api.conv.messages({ conversationId: convId }).then(setMessages);
    } catch (e) {
      setGenerating(false);
      setError(e.message);
      setStatus('');
    }
  };

  const stop = async () => { await window.api.generate.stop(); };

  // ================================================================
  // 章节
  // ================================================================
  const createChapter = async () => {
    const t = newTitle.trim();
    if (!t || !projectId) return;
    const ch = await window.api.chapter.create({ projectId, title: t, content: '', origin: 'human' });
    setNewTitle('');
    bump();
    await selectChapter(ch.id);
  };

  const selectChapter = useCallback(async (id) => {
    setActiveChapterId(id);
    setFileTab('text');
    // 等正文页签的 EditorSurface 挂载完再灌内容
    for (let i = 0; i < 40; i++) {
      if (editorApi.current) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const c = await window.api.chapter.get({ id });
    if (c) editorApi.current?.setText(c.content || '');
    setDirty(false);
  }, []);

  const saveChapter = useCallback(async () => {
    if (!activeChapterId || !editorApi.current) return true;
    const text = editorApi.current.getText();
    await window.api.chapter.save({ id: activeChapterId, content: text });
    setDirty(false);
    try { await window.api.state.writeback({ projectId, chapterId: activeChapterId }); }
    catch (e) { console.warn('状态回写失败：', e.message); }
    bump();
    return true;
  }, [activeChapterId, projectId]);

  // ================================================================
  // 设定检索 / 状态编辑 / 新增
  // ================================================================
  const runSearch = async (kw, type) => {
    if (!projectId || !kw) { setSearchHits(null); return; }
    setSearching(true);
    try {
      const r = await window.api.bible.query({ projectId, query: kw, entityType: type || undefined, topK: 20 });
      setSearchHits(r.hits || []);
    } catch { setSearchHits([]); }
    finally { setSearching(false); }
  };

  const addSetting = async () => {
    if (!newItem.name.trim() || !projectId) return;
    await window.api.settings.upsert({
      projectId, type: newItem.type, name: newItem.name.trim(), note: newItem.note.trim(),
    });
    setAdding(null);
    setNewItem({ type: newItem.type, name: '', note: '', summary: '', importance: 3 });
    bump();
  };

  const addThread = async () => {
    if (!newItem.name.trim() || !projectId) return;
    await window.api.thread.create({
      projectId, name: newItem.name.trim(), summary: newItem.summary.trim(),
      plantedIn: activeChapterId || null, importance: Number(newItem.importance) || 3,
    });
    setAdding(null);
    setNewItem({ type: 'character', name: '', note: '', summary: '', importance: 3 });
    bump();
  };

  const saveState = async (name) => {
    if (!projectId) return;
    const cur = states.find((s) => s.entity_name === name);
    const merged = { ...(cur?.state || {}) };
    if (editForm.location.trim()) merged.location = editForm.location.trim(); else delete merged.location;
    if (editForm.境界.trim()) merged.境界 = editForm.境界.trim(); else delete merged.境界;
    await window.api.state.set({ projectId, entityName: name, state: merged });
    setEditingState(null);
    bump();
  };

  // ================================================================
  // 文风
  // ================================================================
  const refreshStyle = useCallback(async () => {
    if (!projectId) { setStyleProfile(null); return; }
    try {
      // style:profile 直接返回 directive（注入给模型的文风要求），一并显示给用户看
      const p = await window.api.style.profile({ projectId });
      setStyleProfile(p);
      setStyleDirectiveText(p?.available ? (p.directive || '') : '');
    } catch (e) {
      setStyleProfile({ available: false, reason: e.message });
      setStyleDirectiveText('');
    }
  }, [projectId]);

  const checkStyle = async () => {
    if (!projectId || !editorApi.current) return;
    setStyleBusy(true);
    try {
      const r = await window.api.style.check({ projectId, text: editorApi.current.getText() });
      setStyleResult(r);
      setFileTab('style');
    } catch (e) {
      setStyleResult({ ok: false, error: e.message });
    } finally {
      setStyleBusy(false);
    }
  };

  useEffect(() => { refreshStyle(); setStyleResult(null); }, [refreshStyle]);

  // ================================================================
  // Esc 关闭设置页。
  //
  // 只在设置页打开时拦截：其他界面按 Esc 不该有任何反应，
  // 否则用户以为是程序没响应。
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e) => { if (e.key === 'Escape') setShowSettings(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings]);

  // 菜单栏动作 + 快捷键
  // ================================================================
  useEffect(() => {
    const off = window.api.onMenuAction((action) => {
      if (action === 'new-project') {
        // 走同一个弹窗，而不是自己 window.prompt ——
        // 菜单动作与界面按钮必须是同一条路，否则两处行为会分叉。
        // 传 true：菜单项的字面就是"新建项目"，打开就该能直接输入名字。
        openSwitcher(true);
      } else if (action === 'new-conversation') {
        createConversation('');
      } else if (action === 'save-chapter') {
        saveChapter();
      } else if (action === 'import-bible') {
        setShowSettings(true);
      }
    });
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveChapter();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { off(); window.removeEventListener('keydown', onKey); };
  }, [createConversation, saveChapter, openSwitcher]);
  // ================================================================
  // 快捷工具按钮（顶栏）
  //
  // 只放「随手能用、不依赖上下文」的四件事。放在顶栏而不是藏进菜单，
  // 是因为它们的使用时机是"想到就记"，多一次点击就等于不用。
  //
  // ⚠⚠ `key` 必须是**各自不同**的（2026-10-13 修）。
  //   原来三个按钮的 key 全是 'tools'，于是：
  //     1. React 拿重复的 key 渲染 → 同名元素复用，点击高亮会串
  //     2. 点「起名」和点「备忘录」跳到同一个 place
  //   羽毛菌的反馈是「灵感碎片没有在脑洞后面那里」——
  //   他要的是一个**独立入口**，不是"脑洞工具里管着的某个文件"。
  //   所以这里给灵感碎片自己一个 key，让它点开就是那个文件。
  //
  // ⚠ label 与 file 要对得上：按钮写「灵感碎片」，点进去就该是
  //   灵感碎片.md。工具名叫「脑洞」而文件叫「灵感碎片.md」，
  //   用户会去找一个叫"灵感碎片"的按钮而找不到（ToolsPanel 的 hint
  //   写明了映射，但顶栏这一排才是他第一眼扫的地方）。
  // ================================================================
  const QUICK_TOOLS = [
    { key: 'memo', label: '备忘录', icon: '📌', hint: '随手记待办与提醒' },
    { key: 'name', label: '起名', icon: '✒️', hint: '人物名、地名、功法名候选' },
    { key: 'brain', label: '脑洞', icon: '💡', hint: '剧情走向与反转设计' },
    { key: 'idea', label: '灵感碎片', icon: '🗒️', hint: '随手记的碎片想法与对话片段' },
    // ⚠ 文风蒸馏放这里（羽毛菌：「而且应该放在这个快捷工具栏」），
    //   但它**不走** ToolsPanel —— 别的几个是一问一答，它是多步长任务，
    //   硬塞进同一个面板会把「正在读第几段」这类进度挤没。
    //   所以点它开独立弹层，别的四个照旧切 tab。
    { key: 'style', label: '文风蒸馏', icon: '📖', hint: '读原文学习写作风格，生成可挂载的文风技能' },
    // ⚠ 简介生成（2026-10-15 羽毛菌要的功能）。
    //   它**要调模型**，而备忘录/起名/脑洞只是往 md 追加一段 ——
    //   所以点它开独立面板，不走 ToolsPanel。
    // ⚠ 标签用「简介」两个字（2026-10-16 羽毛菌：「简介生成四个字缩略成简介」）：
    //   这一排六个工具，只有它是四个字，挤得整行更早溢出到三点菜单里。
    //   面板内部标题仍是「简介生成器」，不影响用户理解。
    { key: 'intro', label: '简介', icon: '✨', hint: '读书稿生成作品简介，可存成文件' },
  ];

  /**
   * 顶栏右侧的卡片开关：单击收起 / 再单击展开。
   * 收起是「整栏不渲染」，不是 display:none——
   * 留在 DOM 里的隐藏面板会继续跑它自己的 effect
   * （对话流还在收 chunk、编辑器还挂着 TipTap 实例）。
   *
   * 两个都收起就是纯手工模式，提示见 manualMode。
   */
  const CARD_TOGGLES = [
    { pane: 'conversations', label: '对话列表', icon: '🗂' },
    { pane: 'main', label: '对话框', icon: '💬' },
  ];

  // ⚠ 原来这里有个 newProject（window.prompt 问名字 → 建项目）。
  //   顶栏的「＋ 新建项目」按钮删掉之后它就没有调用方了，
  //   现在统一走 ProjectSwitcher 弹窗里的「＋ 新建」——
  //   那个弹窗能同时看到现有项目，新建时不容易起重名。

  // ================================================================
  // 第 2 栏标签内容
  //
  // 复用既有组件，不重写。对应关系：
  //   chat     → ChatPanel
  //   chapters → FileBox 的章节页签
  //   draft    → FileBox 的正文页签（含 EditorSurface）
  //   bible    → FileBox 的设定页签
  //   state    → FileBox 的状态页签
  //   threads  → FileBox 的伏笔页签
  //   style    → FileBox 的文风页签
  //   ⚠ 原来的 distill（资料蒸馏）**已删**（2026-10-15 羽毛菌：「没用的功能删除掉就行」）。
  //     那个面板没接后端，是个死界面；文风蒸馏改走 StyleDistill（快捷工具栏入口）。
  //   tools    → ToolsPanel（新）
  // ================================================================

  // ================================================================
  // 顶部工具栏
  // ================================================================
// ================================================================
  // 主标签（第 2 栏）
  //
  // 对话是常驻的（closable:false），其余按需打开。
  // openTabs 而不是单独一个 activeTab——用户能自己决定开哪几个，
  // 而不是被程序按流程一步步带过去。
  // ================================================================
  const [showStyleDistill, setShowStyleDistill] = useState(false);
  /** 自定义背景图（毛玻璃）—— 必须在所有面板之下 */
  const bg = useBackground();
  /**
   * 范围守卫：模型连接被关掉了吗（与小说创作无关的请求被拦下）。
   *
   * ⚠ 状态**以主进程为准**（`scope:status`）：界面这边只是显示与禁用，
   *   判定和状态都在主进程的 `scope-guard.js` 里 —— 安全边界写在渲染层等于没写。
   */
  const [scopeLocked, setScopeLocked] = useState(false);
  const [scopeNotice, setScopeNotice] = useState('');
  /**
   * 行为审计暂停（2026-10-18，第三道防线）。
   *
   * 与 scopeNotice 分开一格：那是"这句话被拦了"，这是"这个对话整体被暂停了"。
   * 两者要显示的按钮不一样（前者可能弹协议，后者是「继续使用」）。
   */
  const [auditPaused, setAuditPaused] = useState(false);
  const refreshScope = useCallback(async () => {
    try {
      const s = await window.api.scope.status();
      setScopeLocked(!!(s && s.locked));
      if (s && !s.locked) setScopeNotice('');
    } catch (_) { /* 读不到就当没锁，别让界面卡住 */ }
  }, []);
  const unlockModel = useCallback(async () => {
    try {
      await window.api.scope.unlock();
      await refreshScope();
      setScopeNotice('');
      showToast('模型连接已重新启用');
    } catch (e) { showToast('重新启用失败：' + e.message); }
  }, [refreshScope, showToast]);
  useEffect(() => {
    refreshScope();
    // ⚠ 订阅广播：守卫可能在**别的入口**把模型锁掉（正文生成那条），
    //   光在自己发消息时看返回值是不够的。
    const off = window.api.scope.onChange((st) => {
      if (st) setScopeLocked(!!st.locked);
    });
    return off;
  }, [refreshScope]);
  const [showIntro, setShowIntro] = useState(false);
  const [openTabs, setOpenTabs] = useState(['chat']);
  const [activeTab, setActiveTab] = useState('chat');

  const openTab = useCallback((key) => {
    setOpenTabs((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setActiveTab(key);
  }, []);
  const closeTab = useCallback((key) => {
    setOpenTabs((prev) => prev.filter((k) => k !== key));
  }, []);

  /**
   * 当前展开的是哪个快捷工具。
   *
   * ⚠ 为什么要这个 state：顶栏四个按钮点开的都是**同一个页签**
   *   （activeTab === 'tools'），但用户期待点「灵感碎片」就看到灵感碎片，
   *   点「起名」就看到起名。只靠 activeTab 区分不出来。
   */
  const [activeTool, setActiveTool] = useState(null);

  /**
   * 点顶栏某个快捷工具。
   *
   * ⚠ 重复点同一个按钮时**不重置** activeTool：
   *   用户正在灵感碎片里写了半段，点一下顶栏再点回来，
   *   如果重置成全部展开，他会丢掉"我在哪个工具"的上下文。
   */
  const openQuickTool = useCallback((t) => {
    // ⚠ 文风蒸馏是多步长任务（分块读 → 汇总 → 存技能），
    //   不适合塞进 ToolsPanel 那个一问一答的面板。
    if (t.key === 'style') { setShowStyleDistill(true); return; }
    if (t.key === 'intro') { setShowIntro(true); return; }
    setOpenTabs((prev) => (prev.includes('tools') ? prev : [...prev, 'tools']));
    setActiveTab('tools');
    setActiveTool((prev) => (prev === t.key ? prev : t.key));
  }, []);

  // ================================================================
  // 项目文件树（第 4 栏）与文档预览（第 3 栏）
  // ================================================================
  const [tree, setTree] = useState(null);

  /**
   * 项目文件夹里的文件（压平的 {path, name}）—— 给 @文件 面板用。
   *
   * ⚠ 2026-10-15 羽毛菌：「单击 @文件 后…我可以选择目录里的文件」。
   *   而那个面板原来只列数据库里的 chapters / settings ——
   *   新建的项目这两个都是空的，于是弹出来一句「没有匹配的内容」，
   *   而 设定/世界观.md 明明就在硬盘上。
   *   写文件（write_note）落地之后，模型改的也是这些文件，
   *   不列它们，「模型改了某个文件、我也想看一眼」这条链是断的。
   */
  const filePaths = useMemo(() => {
    const out = [];
    const walk = (nodes, prefix) => {
      for (const n of nodes || []) {
        if (n.type === "file") out.push({ path: prefix + n.name, name: n.name });
        else if (n.children) walk(n.children, prefix + n.name + "/");
      }
    };
    walk(tree && tree.children, "");
    return out;
  }, [tree]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState(null);
  const [openFiles, setOpenFiles] = useState([]);      // [{path, name}] 多文档
  const [previewPath, setPreviewPath] = useState(null);
  const [doc, setDoc] = useState(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState(null);

  /**
   * 文件树排序档位。'manual' | 'name' | 'modified' | 'size'
   *
   * ⚠ 存 localStorage 而**不进 config**：
   *   config 是"用户对软件的意见"（模型、温度、要不要联网），
   *   要跟着数据备份走、会导出；
   *   而「我这次想按时间看文件」是**看的方式**，换台电脑就该重来。
   *   混进 config 的话，导出的配置里会带一条"文件按时间排"，
   *   别人拿去用会莫名其妙。
   *
   * 默认 'manual'：拖出来的顺序优先。这一档下 .order.json 说了算，
   * 也就是本项目引入排序控件之前的行为——一字不改。
   */
  const [treeSort, setTreeSort] = useState(() => {
    try {
      const v = localStorage.getItem('wt.treeSort');
      return ['manual', 'name', 'modified', 'size'].includes(v) ? v : 'manual';
    } catch (_) { return 'manual'; }
  });

  const changeTreeSort = useCallback((next) => {
    setTreeSort(next);
    try { localStorage.setItem('wt.treeSort', next); } catch (_) { /* 存不了也不影响用 */ }
  }, []);

  /**
   * 收起哪些栏（对话列表 / 对话框）。
   *
   * 两个都收起 = **纯手工模式**：只剩目录与文件预览，
   * 一个人自己想、自己写，AI 那两块整栏不占地方也不在眼前。
   * 对「用腻了 AI」的用户这是个能随时回来的退路，
   * 不是把功能删掉——所以必须一眼能看见怎么把它点回来。
   *
   * ⚠ 存 localStorage 不进 config，理由同 wt.treeSort：
   *   「我现在只想自己写」是**看的方式**，不是对软件的配置，
   *   不该跟着备份导出跑到别人机器上去。
   *   但它必须存：纯手工模式的人不想每次开软件都点两下。
   */
  const [hiddenPanes, setHiddenPanes] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('wt.hiddenPanes') || '[]');
      return Array.isArray(raw) ? raw.filter((k) => CARD_PANES.includes(k)) : [];
    } catch (_) { return []; }
  });

  /**
   * 自定义标题栏（2026-10-16 20:20）：主窗口 frame:false，
   * 系统那条标题栏和它的三个按钮都没了 —— 这一条顶栏要自己当标题栏。
   *
   * ⚠⚠⚠ **必须返回取消订阅的函数**。不取消的话，App 每次重渲染都会
   *   再注册一个 win:state 监听 → 点一次「最大化」发 N 次 IPC，
   *   监听器还会越堆越多（表现：窗口按钮越来越卡）。
   */
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let alive = true;
    window.api.win.isMaximized().then((v) => { if (alive) setMaximized(Boolean(v)); }).catch(() => {});
    const off = window.api.win.onStateChange((st) => { if (alive) setMaximized(Boolean(st && st.maximized)); });
    return () => { alive = false; off(); };
  }, []);

  const togglePane = useCallback((key) => {
    setHiddenPanes((prev) => {
      const next = prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key];
      try { localStorage.setItem('wt.hiddenPanes', JSON.stringify(next)); } catch (_) { /* 存不了也不影响用 */ }
      return next;
    });
  }, []);

  /** 左边两栏都收起来了 = 纯手工模式（顶栏给个提示，别让人以为软件坏了） */
  const manualMode = hiddenPanes.includes('conversations') && hiddenPanes.includes('main');

  const refreshTree = useCallback(async () => {
    if (!projectId) { setTree(null); return; }
    setTreeLoading(true);
    setTreeError(null);
    try {
      setTree(await window.api.fs.tree({ projectId, sort: treeSort }));
      // 回收站计数：与文件树一起刷，两者都在项目文件夹里
      try {
        const t = await window.api.trash.list({ projectId });
        setTrashCount(t.stats?.count || 0);
      } catch (_) { setTrashCount(0); }
    } catch (e) {
      setTreeError(e.message);
      setTree(null);
    } finally {
      setTreeLoading(false);
    }
  }, [projectId, treeSort]);

  useEffect(() => { refreshTree(); }, [refreshTree]);

  /**
   * 项目文件夹在**主进程那边**被改了 → 重拉文件树。
   *
   * ⚠ 2026-10-15 加的。现场：模型答「已写入 `章节/第一章.md`（3443 字）」，
   *   右边目录里**没有**那个文件，重启一次又出来 —— 文件真在磁盘上，
   *   缺的只是「写完通知界面」这一步。能力加上了，配套通知没跟上，
   *   于是用户看到的是"功能没生效"。
   *
   * ⚠⚠ **必须放在 refreshTree 定义之后**，单独一个 effect。
   *   第一版我把它塞进上面那个订阅 effect（line ~502）并加上 `refreshTree`
   *   依赖 —— 而那个 effect 在 refreshTree **声明之前**就执行了，
   *   命中 TDZ：`ReferenceError: Cannot access 'yn' before initialization`，
   *   **整棵 React 树起不来，界面全白**。
   *   `node --check` 与所有单测都绿（它们不跑 React），只有真渲染才抓得到。
   */
  useEffect(() => window.api.onFilesChanged((info) => {
    if (!info || !info.projectId) return;
    // ⚠ 按 projectId 过滤：多个项目时别让 A 项目的写入刷新 B 项目的树
    if (info.projectId !== projectId) return;
    refreshTree();
  }), [projectId, refreshTree]);

  // 切项目时清空预览状态。理由：上一个项目的文件路径在新项目里
  // 不存在，继续显示会让人以为预览卡住了；而如果不清，
  // 后续的写入会落到错误的项目上——那是数据问题不是显示问题。
  //
  // ⚠ 这里只清状态，**不调 refreshTree**——
  //   refreshTree 已经依赖 projectId，单独一个 effect 就会重复扫两次。
  useEffect(() => {
    setOpenFiles([]);
    setPreviewPath(null);
    setDoc(null);
    setDocError(null);
    setTrashCount(0);
    setTrashOpen(false);
  }, [projectId]);

  /**
   * 打开预览。
   *
   * ⚠ 竞态处理用的是**请求序号**，不是「读一下当前 path 再比较」。
   * 第一版读 previewPathRef.current —— 但那个 ref 要等 useEffect 跑完
   * 才更新，而 setPreviewPath 是异步的，于是函数体里读到的还是上一次的值，
   * 判定 `ref.current !== path` 恒成立，**doc 永远不会被写入**。
   * 症状是预览栏一直停在「载入中…」，而通道明明返回了数据。
   *
   * 请求序号：只有最后一次请求的结果才生效，不依赖任何 ref 的更新时机。
   * 同 convSeq 的用法（第 9 章已验证过）。
   */
  const docSeq = useRef(0);

  const openPreview = useCallback(async (pathOrNode) => {
    if (!projectId) return;
    const path = typeof pathOrNode === 'string' ? pathOrNode : pathOrNode.path;
    const name = typeof pathOrNode === 'string' ? path.split('/').pop() : pathOrNode.name;

    docSeq.current += 1;
    const seq = docSeq.current;

    // 已打开就只切换，不重复读文件
    setOpenFiles((prev) => (prev.some((f) => f.path === path) ? prev : [...prev, { path, name }]));
    setPreviewPath(path);
    setDocLoading(true);
    setDocError(null);
    try {
      const d = await window.api.fs.read({ projectId, path });
      if (seq !== docSeq.current) return;   // 已有更新的请求，丢弃本次
      setDoc(d);
    } catch (e) {
      if (seq !== docSeq.current) return;
      setDocError(e.message);
      setDoc(null);
    } finally {
      if (seq === docSeq.current) setDocLoading(false);
    }
  }, [projectId]);

  const closePreview = useCallback((path) => {
    setOpenFiles((prev) => {
      const rest = prev.filter((f) => f.path !== path);
      // 关掉当前显示的那一个时，落到相邻的那个，别留下空白
      if (path === previewPath) {
        const idx = prev.findIndex((f) => f.path === path);
        const next = rest[idx] || rest[idx - 1] || null;
        setPreviewPath(next ? next.path : null);
        if (!next) setDoc(null);
        else openPreviewRef.current?.(next.path);
      }
      return rest;
    });
  }, [previewPath]);
  const openPreviewRef = useRef(null);
  useEffect(() => { openPreviewRef.current = openPreview; }, [openPreview]);

  const saveDoc = useCallback(async (path, content) => {
    await window.api.fs.write({ projectId, path, content });
    // 保存后重读：拿到 stat 让字数显示更新，也验证真的写进去了。
    // 同样用请求序号判过期——不能读 ref，那要等 effect 跑完（见 openPreview 的注释）。
    docSeq.current += 1;
    const seq = docSeq.current;
    const d = await window.api.fs.read({ projectId, path });
    if (seq !== docSeq.current) return;
    setDoc(d);
    refreshTree();
  }, [projectId, refreshTree]);

  /**
   * 放入回收站。
   *
   * 与永久删除（removeEntry）是两条路：这条可还原。
   * 放进回收站后要把已打开的预览标签关掉——那个路径已经不存在了。
   */
  const trashEntry = useCallback(async (path) => {
    try {
      const r = await window.api.trash.add({ projectId, path });
      setOpenFiles((prev) => prev.filter((f) => f.path !== path && !f.path.startsWith(path + '/')));
      if (previewPath === path || previewPath?.startsWith(path + '/')) {
        setPreviewPath(null); setDoc(null);
      }
      await refreshTree();
      showToast(`已放入回收站：${r.entry?.name || path}`);
    } catch (e) {
      showToast(`放入回收站失败：${e.message}`);
    }
  }, [projectId, previewPath, refreshTree, showToast]);

  // 文件树操作
  const createEntry = useCallback(async (path, isDir) => {
    await window.api.fs.create({ projectId, path, dir: isDir });
    await refreshTree();
  }, [projectId, refreshTree]);

  const renameEntry = useCallback(async (from, to) => {
    await window.api.fs.rename({ projectId, from, to });
    // 重命名后已打开的标签会指向不存在的路径，必须关掉
    setOpenFiles((prev) => {
      const hit = prev.find((f) => f.path === from);
      if (hit) {
        if (previewPath === from) { setPreviewPath(null); setDoc(null); }
        return prev.filter((f) => f.path !== from);
      }
      return prev;
    });
    await refreshTree();
  }, [projectId, refreshTree, previewPath]);

  const removeEntry = useCallback(async (path, recursive) => {
    await window.api.fs.remove({ projectId, path, recursive });
    // 删掉的若是目录，里面已打开的文件标签也一并关掉
    setOpenFiles((prev) => {
      const killed = prev.filter((f) => f.path === path || f.path.startsWith(path + '/'));
      if (killed.some((f) => f.path === previewPath)) { setPreviewPath(null); setDoc(null); }
      return prev.filter((f) => !(f.path === path || f.path.startsWith(path + '/')));
    });
    await refreshTree();
  }, [projectId, refreshTree, previewPath]);

  // 快捷工具用：判断文件是否已存在（不读内容，只看有没有）
  const fileExists = useCallback(async (path) => {
    if (!projectId) return false;
    try {
      await window.api.fs.read({ projectId, path });
      return true;
    } catch (_) {
      return false;
    }
  }, [projectId]);

  /**
   * 拖拽落点。跨目录移动与同目录重排都走这条。
   *
   * ⚠ 移动之后必须处理**已打开的预览标签**：
   *   文件换了路径或没了，但第 3 栏还开着它的标签，
   *   用户点过去看到的是「载入中…」转圈到底——
   *   那个路径已经不存在了。表现像是预览坏了，其实只是标签没关。
   */
  const moveEntry = useCallback(async (from, toDir, anchor, place) => {
    // ⚠ 用户在「按时间/大小/名称」这几档下拖东西，顺序会被 sort 立刻盖掉 ——
    //   表现为「我明明拖了，松手又弹回去了」。
    //   与其让拖拽失效，不如把排序切回「手动」：那是唯一一档拖得动的。
    const needManual = treeSort !== 'manual';
    if (needManual) changeTreeSort('manual');
    try {
      const r = await window.api.fs.move({ projectId, from, toDir, anchor, place });
      const newPath = r.to || from;

      // 路径变了：把旧标签换成新的（同一份内容，只换了位置）
      setOpenFiles((prev) => {
        const hit = prev.find((f) => f.path === from);
        if (!hit) {
          // 源被移进某个目录，已在它内部打开的子文件标签也失效了
          const killed = prev.filter((f) => f.path.startsWith(from + '/'));
          return killed.length ? prev.filter((f) => !f.path.startsWith(from + '/')) : prev;
        }
        const renamed = { ...hit, path: newPath, name: newPath.split('/').pop() };
        if (previewPath === from) setPreviewPath(newPath);
        return prev.map((f) => (f.path === from ? renamed : f));
      });

      // 预览指向的内容也变了，重新读一次
      if (previewPath === from) {
        docSeq.current += 1;
        const seq = docSeq.current;
        setDocLoading(true);
        try {
          const d = await window.api.fs.read({ projectId, path: newPath });
          if (seq === docSeq.current) setDoc(d);
        } catch (e) {
          if (seq === docSeq.current) { setDoc(null); setDocError(e.message); }
        } finally {
          if (seq === docSeq.current) setDocLoading(false);
        }
      }

      await refreshTree();
      showToast(needManual
        ? '顺序已保存 · 排序已切回「手动」（只有这一档拖得动）'
        : (r.moved ? `已移动到「${toDir || '项目根'}」` : '顺序已保存'));
    } catch (e) {
      showToast(`移动失败：${e.message}`);
    }
  }, [projectId, previewPath, refreshTree, showToast, treeSort, changeTreeSort]);

  // ================================================================
  // 项目操作（切换弹窗用）
  // ================================================================

  const currentProject = projects.find((p) => p.id === projectId) || null;

  const createProjectBy = useCallback(async (name) => {
    const id = `p-${Date.now().toString(36)}`;
    const r = await window.api.project.create({ id, name });
    setProjects(r.projects || []);
    setProjectId(id);
    setActiveChapterId(null);
    if (r.createdFolder) showToast(`项目已建，文件夹：${r.dir}`);
    bump();
    return id;
  }, [showToast]);

  /**
   * 导入一个已有的小说文件夹（原地指过去，不复制）。
   *
   * 主进程负责弹系统选择框并绑定；这里只把结果接到界面上。
   */
  const importProjectFolder = useCallback(async () => {
    const r = await window.api.project.importFolder({});
    if (r && r.canceled) return r;
    setProjects(r.projects || []);
    setProjectId(r.id);
    setActiveChapterId(null);
    bump();
    return r;
  }, [bump]);

  /**
   * 导入完成后的交代。
   *
   * ⚠ 必须报数量。用户面对的是一个**原本就存在**的陌生文件夹，
   *   屏幕上已经有很多文件了 —— 不给数字他没法判断到底成功了没有，
   *   只能猜。而"导入成功"的观感来自"我看到的东西确实被读进去了"。
   */
  const importDone = useCallback((r) => {
    if (!r) return;
    if (r.reused) showToast(`「${r.name}」已经在列表里了，直接切过去了`);
    else showToast(`已导入「${r.name}」· ${r.fileCount} 个文件 · ${(r.charCount / 10000).toFixed(1)} 万字`);
  }, [showToast]);

const pickProject = useCallback(async (id) => {
    setProjectId(id);
    await window.api.project.open({ id });
    setActiveChapterId(null);
    bump();
  }, []);

  const renameProject = useCallback(async (id, name) => {
    const r = await window.api.project.rename({ id, name });
    setProjects(r.projects || await window.api.project.list());
    showToast(`已改名为「${name}」`);
  }, [showToast]);

  const deleteProject = useCallback(async (id, keepFiles) => {
    const r = await window.api.project.delete({ id, keepFiles });
    if (r && r.ok === false) return r;   // 主进程已经给出可读原因
    setProjects(r.projects || []);
    if (projectId === id) {
      const rest = r.projects || [];
      if (rest.length) { setProjectId(rest[0].id); await window.api.project.open({ id: rest[0].id }); }
      else setProjectId(null);
      setActiveChapterId(null);
      bump();
    }
    showToast(keepFiles ? '项目已从软件里删除，文件夹保留' : '项目与文件夹都已删除');
    return r;
  }, [projectId, showToast]);

  const exportProject = useCallback((id) => window.api.project.export({ id }), []);


  // ================================================================
  // 思考强度：可用档位与当前值
  //
  // ⚠ 这一块必须排在 renderMainTab **之前**。renderMainTab 是渲染期
  //   执行的，它引用的绑定若声明在后就是 TDZ 错误
  //   「Cannot access ... before initialization」——
  //   整个 React 树挂不上，界面全白且**不报任何错**。
  //   这个文件里已经栽过两次（showToast、appVersion），都是靠 ErrorBoundary 才抓到。
  // ================================================================

  /**
   * 当前连接 = config.activeConnectionId 指向的那条。
   *
   * ⚠⚠ **不再退回 connections[0]**（2026-10-13 改）。
   *   原来写的是 `... || connections[0] || null`，看着是兜底，实际是掩盖：
   *   用户主动「断开连接」之后 activeConnectionId 是空的，
   *   这里却悄悄捡起列表第一条当作正在用的——
   *   界面上显示着思考档位（像是连着），主进程发请求却按空配置走，
   *   两边对不上，用户完全看不出发生了什么。
   *   断开就该真的断开：没有 active 就没有档位控件，
   *   发消息时主进程会明确告诉他「还没有在用任何模型」。
   *
   * ⚠ `config && ...` 这一层不能省。虽然"connections 为空时回调不会执行"
   *   让它眼下碰巧不崩，但那是巧合：connections 与 config 分属两个
   *   互不等待的异步 effect，谁先回来没有保证。
   *   一旦 connections 先到（比如 IPC 排队顺序变了），
   *   这里就是 `Cannot read properties of null`——白屏。
   */
  const activeConn = connections.find((c) => c.id === (config && config.activeConnectionId))
    || null;

  /**
   * 这条连接可用的档位。
   *
   * null 有三种来源，界面上的表现一致（**不渲染控件**）：
   *   1. 量表还没加载回来（caps 为 null）
   *   2. 一条连接都没有
   *   3. 这家是 model-only（靠模型名区分，没有"强度"这个概念）
   * 第 3 种是真正的"不支持"，前两种是"还不知道"——
   * 都不该给一个点了没用的按钮。
   */
  const thinkLevels = useMemo(() => {
    if (!caps || !activeConn) return null;
    const preset = (caps.providers || []).find((p) => p.key === activeConn.providerKey);
    if (!preset) return null;
    return thinkLevelsOf(preset).levels;
  }, [caps, activeConn]);

  /**
   * 当前连接是不是**本地**。
   *
   * 用途：设置页「上下文窗口」那一项只对本地有意义。
   *   云端模型的窗口由服务商定（Claude 200K、DeepSeek 128K），客户端传不了，
   *   摆一个滑块在那儿会让人以为它在起作用。
   *
   * ⚠ 判断用 protocol 而不是 isLocal 字段：连接是用户自己建的，
   *   自定义连接可能填的是本机地址（比如局域网里的 vLLM），
   *   而 preset.isLocal 只在内置预设上有。protocol === 'ollama'
   *   是唯一稳的判据 —— Ollama 协议只有本地会跑。
   *   另：vLLM 走 openai 协议，所以判不出来，这里按"非 ollama 即云端"处理，
   *   宁可对极少数自部署用户显示一句"由服务端定"，也不要给出错的滑块。
   */
  /**
   * ⚠ 这里原本还有个 `isLocalConn`（= activeConn 是不是 ollama）传给设置页，
   *   用来决定「上下文窗口」那一项显不显示。2026-10-14 删掉了：
   *   设置页自己向主进程要 provider:connParams（窗口/输出上限/输出预留是
   *   **按连接**存的，与 config 的全局字段不是一回事），
   *   本地还是云端由主进程一并给出，前端不该再判一遍。
   */

  /**
   * 这一轮放不放行工具（终端 / 联网）。
   *
   * 两个 chip 的勾选状态。**不进 config、不跟对话走** ——
   *   它是"这一轮我要不要"的临时意图，刷新页面就该回到默认。
   *   存进 config 会变成"以后每轮都这样"，那正是总开关该管的事。
   *
   * 默认值跟着总开关：总开关关着时两个都是未放行（点了提示去开），
   *   开着时两个都放行（既然同意了就给用，想收窄再点掉）。
   */
  const [toolGroups, setToolGroups] = useState(() => (
    config && config.toolsEnabled ? ['terminal', 'web'] : []
  ));
  // 总开关变化时同步默认值：用户在设置页刚打开工具，回来就该是能用的状态
  useEffect(() => {
    setToolGroups(config && config.toolsEnabled ? ['terminal', 'web'] : []);
  }, [config && config.toolsEnabled]);

  const toggleToolGroup = useCallback((g) => {
    if (!(config && config.toolsEnabled)) {
      setShowSettings(true);
      showToast('功能总开关还没开 —— 在「设置 → 功能」里打开');
      return;
    }
    setToolGroups((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }, [config && config.toolsEnabled, showToast]);

  /**
   * 联网到底能不能用（2026-10-14）。
   *
   * ⚠ 起因是羽毛菌反馈「填了 Key，联网还是标红不可用」。查下来发现：
   *   chip 亮只代表"这一轮放行了"，**不代表搜索真能跑** ——
   *   没填 Key 时 chip 照样是亮的，而搜索必然失败。
   *   这两件事被界面混成了一件，用户无从判断该改哪里。
   *
   * 所以这里向主进程要一份完整判定（总开关 / Key / 服务商），
   * 由它把缺哪几层算清楚，界面只负责显示。**判定不放前端**——
   * 前端拿不到 Key 明文，只能问主进程问"有没有"，没法自己判断。
   */
  const [webReady, setWebReady] = useState(null);
  const refreshWebReady = useCallback(() => {
    // ⚠ 不 catch 会静默失败：这次拿不到就保持 null（界面按"不知道"处理，
    //   而不是假装联网没问题 —— 后者又变成骗用户）。
    window.api.tool.webReady().then(setWebReady).catch(() => setWebReady(null));
  }, []);
  useEffect(() => {
    refreshWebReady();
    // Key 与服务商在设置页里改，config 一变就该重新问一次
  }, [config && config.toolsEnabled, config && config.searchProvider, refreshWebReady]);

  /**
   * 设置页存完/清完搜索 Key 会广播这个事件。
   *
   * ⚠ 为什么用事件而不是把 refreshWebReady 一路透传下去：
   *   ToolCat 已经在第三层了，再加两层 props 只为"存完喊一声"不划算。
   *   代价是两边靠字符串约定 —— 所以事件名带 `wt:` 前缀，且
   *   这里顺手在 cleanup 里摘掉监听，避免设置页反复开关后监听堆积。
   */
  useEffect(() => {
    const h = () => refreshWebReady();
    window.addEventListener('wt:searchkey-changed', h);
    return () => window.removeEventListener('wt:searchkey-changed', h);
  }, [refreshWebReady]);

  /** 真正下发给主进程的：这一轮允许的工具 chip */
  const toolsThisTurn = useMemo(() => (
    (config && config.toolsEnabled && toolGroups.length) ? toolGroups : []
  ), [config && config.toolsEnabled, toolGroups]);

  /**
   * 当前该显示的档位：**这条对话存的 > 全局默认**。
   *
   * ⚠ 一定要过 normalizeLevel。存的档位与当前连接支持的档位
   *   是两个独立的集合：用户在 Ollama（四档）下把对话设成「中」，
   *   之后换到只有开/关的百炼——那个 'medium' 发出去服务端不认（400），
   *   而界面上控件显示的是"开启"，用户完全看不懂为什么报错。
   */
  const thinkLevel = useMemo(() => {
    const stored = (conversations.find((c) => c.id === convId) || {}).thinkLevel || '';
    /**
     * ⚠ `config` 可能是 null，必须判。
     *
     * Hook 在**早退之前**执行，而 `if (!config) return 加载中…` 在函数后半段——
     * 于是首帧渲染时 config 还是 null，直接读 config.thinkLevel 就是
     * `TypeError: Cannot read properties of null (reading 'thinkLevel')`。
     * 后果不是"档位不显示"，是**整个 React 树挂不上、界面全白**，
     * 而且白屏上只有一行报错，用户看到的和"软件坏了"没区别。
     * （这条是截图脚本抓出来的：渲染进程的代码没有任何自动化测试真跑过。）
     */
    const want = stored || (config && config.thinkLevel) || 'off';
    return thinkLevels ? normalizeLevel(want, thinkLevels) : want;
  }, [conversations, convId, config && config.thinkLevel, thinkLevels]);

  // ================================================================
  // 渲染
  // ================================================================
  const fileBoxPanel = (tab, children) => (
    <FileBox
      tab={tab}
      onTab={() => {}}
      hideTabs
      chapters={chapters}
      activeChapterId={activeChapterId}
      onSelectChapter={selectChapter}
      onCreateChapter={createChapter}
      newTitle={newTitle}
      setNewTitle={setNewTitle}
      settings={settings}
      states={states}
      threads={threads}
      searchHits={searchHits}
      searching={searching}
      query={query}
      setQuery={setQuery}
      onSearch={(t) => runSearch(t || query)}
      onFilter={(t) => runSearch(query, t)}
      adding={adding}
      setAdding={setAdding}
      newItem={newItem}
      setNewItem={setNewItem}
      onAddSetting={addSetting}
      onAddThread={addThread}
      editingState={editingState}
      setEditingState={setEditingState}
      editForm={editForm}
      setEditForm={setEditForm}
      onSaveState={saveState}
      fontSize={config.chatFontSize || config.fontSize || 16}
      fontFamily={config.chatFont || 'system-ui'}
      generating={generating}
      styleProfile={styleProfile}
      styleResult={styleResult}
      styleBusy={styleBusy}
      onRefreshStyle={refreshStyle}
      onCheckStyle={checkStyle}
      styleDirectiveText={styleDirectiveText}
      config={config}
      projectId={projectId}
    >
      {children}
    </FileBox>
  );

  /**
   * FileBox 作为一个纯内容面板（隐藏它自己的 tab 条）。
   *
   * ⚠ 必须在 renderMainTab **之前**——后者会调用它，
   *   而两者都是渲染期执行的，反过来就是 TDZ 错误。
   */
  const renderMainTab = (key) => {
    switch (key) {
      case 'chat':
        return (
          <ChatPanel
            conversation={conversations.find((c) => c.id === convId)}
            messages={messages}
            streamingText={streamingText}
            streamingThink={streamingThink}
            generating={generating}
            error={error}
            status={status}
            skills={skills}
            settings={settings}
            chapters={chapters}
            filePaths={filePaths}
            quickTools={QUICK_TOOLS}
            onQuickTool={openQuickTool}
            activeTool={activeTool}
            toolsOpen={activeTab === 'tools'}
            onSend={send}
            onStop={stop}
            scopeLocked={scopeLocked}
            scopeNotice={scopeNotice}
            // 行为审计（2026-10-18）：暂停 + 「继续使用」的明路
            auditPaused={auditPaused}
            onAuditResume={resumeAudit}
            onUnlockModel={unlockModel}
            onRetry={() => send(lastUserText, [])}
            onMessageAction={messageAction}
            // ⚠⚠ 这两行**漏了很久**，而现象是「修改文字大小没有用」：
            //   渲染进程明明拿得到 config.chatFontSize（实测 19），
            //   消息却永远是 16px —— 因为 fontSize/fontFamily 传给了
            //   SettingsPanel，**ChatPanel 一个字都没收到**，
            //   于是在自己内部落到 `|| 16` 的兜底值。
            //   存是存进去了（config.json 里能看到 chatFontSize），
            //   只是没人在用它 —— 典型的「界面显示已保存、实际没变」。
            fontSize={config.chatFontSize || config.fontSize || 16}
            fontFamily={config.chatFont || config.fontFamily || 'system-ui'}
            styleResult={styleResult}
            hasProject={!!projectId}
                    thinkLevel={thinkLevel}
                    thinkLevels={thinkLevels}
                    onThinkLevel={changeThinkLevel}
                    toolGate={{
                      enabled: !!(config && config.toolsEnabled),
                      groups: toolGroups,
                      onToggle: toggleToolGroup,
                    }}
                    // ⚠⚠ 这两项在**顶层**，不是 toolGate 对象里。
                    //   第一版我塞进了 toolGate={{...}}，
                    //   而 ChatPanel 是把它们当独立 props 收的 ——
                    //   结果 ToolGateChips 拿到 undefined，
                    //   缺 Key 时 chip 照样显示"已放行"（琥珀实心）。
                    //   编译与运行都不报错，**只有截图判据能看出来**。
                    webReady={webReady}
                    onOpenSettings={openSettings}
            toolCalls={toolCalls}
            bottomSlot={null}
          />
        );

      case 'tools':
        return (
          <ToolsPanel
            projectId={projectId}
            readFile={(pid, path) => window.api.fs.read({ projectId: pid, path })}
            writeFile={(pid, path, content) => window.api.fs.write({ projectId: pid, path, content })}
            exists={fileExists}
            onToast={showToast}
            onOpenPreview={openPreview}
            activeKey={activeTool}
            onPickTool={setActiveTool}
          />
        );

      case 'draft':
        // 正文编辑：只在这一页挂载 TipTap
        return fileBoxPanel('text', (
          <div className="flex-1 min-h-0 overflow-hidden" style={{ borderTop: '1px solid var(--line)' }}>
            <EditorSurface
              onReady={(api) => { editorApi.current = api; }}
              onChange={() => setDirty(true)}
              fontSize={config.editorFontSize || config.fontSize || 16}
              // 书名栏显示「书名 / 文件名」，书名取当前项目名
              bookTitle={(projects.find((x) => x.id === projectId) || {}).name || ''}
              fontFamily={config.editorFont || config.fontFamily || 'system-ui'}
              generating={generating}
            />
          </div>
        ));

      default:
        return fileBoxPanel(
          { chapters: 'chapters', bible: 'settings', state: 'state', threads: 'threads', style: 'style' }[key] || 'chapters'
        );
    }
  };

  /** FileBox 作为一个纯内容面板（隐藏它自己的 tab 条） */

  /**
   * 第 2 栏各标签的内容。
   *
   * ⚠ 这个块必须放在**所有 useCallback 之后**。
   *   它是渲染期执行的，里面引用的每个绑定都必须已经初始化——
   *   否则就是 TDZ 错误「Cannot access ... before initialization」，
   *   整个 React 树挂不上，界面全白且**不报任何错**。
   *   （今天连踩两次：showToast、appVersion，都是靠 ErrorBoundary 才抓到的。）
   */
  if (showIntro) {
    return (
      <div className="h-full flex flex-col" style={{ background: 'var(--paper)' }}>
        <IntroGen
          projectId={projectId}
          tree={tree}
          onClose={() => setShowIntro(false)}
          onToast={showToast}
          onSaveToFile={(text) => {
            // ⚠ 存到项目根的 简介.md —— 走既有的写文件通道，不新开一条
            const p = '简介.md';
            window.api.fs.write({ projectId, path: p, content: text })
              .then(() => {
                showToast('已存成 ' + p);
                refreshTree();
              })
              .catch((e) => showToast('保存失败：' + e.message));
          }}
        />
      </div>
    );
  }

  if (showStyleDistill) {
    return (
      <div className="h-full flex flex-col" style={{ background: 'var(--paper)' }}>
        <StyleDistill
          projectId={projectId}
          tree={tree}
          onClose={() => setShowStyleDistill(false)}
          onToast={showToast}
        />
      </div>
    );
  }

  if (!config) {
    return <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--ink-soft)' }}>加载中…</div>;
  }

  /**
   * 消息上的操作：删除 / 撤回。
   *
   * ⚠⚠ **生成中删消息要先停生成**。不停的话主进程还在往库里落内容，
   *   而界面已经把它删了 —— 表现是"删完刷新又冒出来"，
   *   用户会以为删除没生效。
   */
  const messageAction = async (kind, m) => {
    if (!convId || !m) return;
    // ⚠⚠ 这里**不能**用 window.confirm：它在渲染进程里是同步阻塞的，
    //   调用那一刻整个窗口冻结 —— 定时器、动画、生成中的流式全停。
    //   开发时被它卡死过一轮（判据脚本点了删除就再没输出）。
    //   二次确认放在按钮上做两段式（见 MessageActions 的 CONFIRM_MS）。
    try {
      if (generating) await stop();
      const r = kind === 'undo'
        ? await window.api.msg.undo({ id: m.id })
        : await window.api.msg.remove({ id: m.id });
      setMessages(await window.api.conv.messages({ conversationId: convId }) || []);
      await loadConversations(projectId);
      if (r && r.deleted) showToast(`已删除 ${r.deleted} 条`);
    } catch (e) {
      showToast(`删除失败：${e.message}`);
    }
  };

  return (
    <div
      className="h-full flex flex-col"
      style={{
        // ⚠ 有背景图时这一层必须透明：它是一个不透明的普通流背景，
        //   而背景图是 z-index:-1 —— 不透明的话图会被它整个盖住，
        //   表现为"设了图但界面一点变化都没有"。没图时保持 --paper（body 同色）。
        background: bg.bg.enabled && bg.bg.url ? 'transparent' : 'var(--paper)',
      }}
    >
      <BackgroundLayer bg={bg.bg} />

      {/* ---------- 顶栏：品牌 / 快捷工具 / 状态 ---------- */}
      {/* 项目选择与「新建项目」已从顶栏移走。
          它们原本是「项目 select ＋ ＋新建」两个控件，
          而第 4 栏第二行也显示项目名、也能切换——
          同一件事两个入口、两种行为，用户会不知道该点哪个。

          现在统一到第 4 栏第二行的项目切换弹窗里：
          新建 / 改名 / 删除 / 导出 / 回收站 都在一处，
          而且它带着"当前是哪个项目"的上下文
          （回收站是每个项目自己的，割裂开就找不到东西）。 */}
      {/* ⚠⚠⚠ 这一条现在**同时是窗口标题栏**（2026-10-16 20:20 羽毛菌：
          「整个软件最上面那个带最小化、关闭的那一横，和下面那一横着带对话列表按钮、
          对话框按钮的，两横合并」）。

          主窗口改成了 frame:false，系统那条标题栏被拿掉了，所以这一条要自己扛：
            · `-webkit-app-region: drag` = 这一条可以按住拖动窗口
            · 双击 = 最大化/还原（自己接，frame:false 下系统不再处理）
            · 右端补上最小化/最大化/关闭三个按钮

          ⚠⚠⚠ 里面所有能点的东西都必须标 no-drag，否则**按钮点不动**——
            app-region 是继承的，所以只要给"交互容器"这一层标上，
            里面的 button/div 全部自动免疫。
          ⚠ 留白的 flex-1 不标 no-drag → 那一段正好是拖动区。*/}
      <header
        className="flex items-center gap-2 pl-3 h-10 border-b shrink-0"
        data-testid="app-titlebar"
        style={{
          borderColor: 'var(--line)',
          background: 'var(--paper)',
          WebkitAppRegion: 'drag',
        }}
        onDoubleClick={() => window.api.win.toggleMaximize()}
      >
        {/* ⚠ 顶栏这一条 `background: var(--paper)` 是**2026-10-16 补的**。
            它原来完全没有底色，而当时的 `--paper` 又是不透明的 ——
            于是它成了整窗唯一的一条缝：背景图只从这里露出来，
            羽毛菌看到的"怎么就顶部"就是这条缝。
            现在 --paper 带 alpha（见 index.css），顶栏加不加底色都不会
            再"漏"得比别人多 —— 加它是为了**四栏 + 顶栏一致**。 */}        {/* ---------- 品牌：图标 + 名字，一个就够 ----------
         *
         * ⚠ 2026-10-15 羽毛菌：「不要顶部一个 writetool，下面还一个，
         *   直接两个整合成一个大的品牌名就可以了，软件图标放在左侧当品牌图标，
         *   后面跟着 writetool。然后那个文件夹图标没有用处啊，可以去掉的。」
         *
         * 之前是**两个**独立的 WriteTool：一个是应用窗口标题（系统画的，
         *   那个动不了），另一个在顶栏里（font-semibold 文字）。
         * 现在顶栏改成「图标 + 名字」的组合，两边视觉上是一整个品牌。
         *
         * ⚠ 顺带删掉了那个 📂 按钮（"在文件管理器中打开项目文件夹"）——
         *   项目文件夹在第 4 栏的导出菜单里已经有了，重复入口。
         */}
        <div className="flex items-center gap-2 shrink-0" style={{ WebkitAppRegion: 'no-drag' }}>
          <span
            aria-hidden="true"
            className="flex items-center justify-center rounded"
            style={{
              width: 20, height: 20,
              background: 'var(--accent)', color: 'var(--accent-ink)',
              fontSize: 12, fontWeight: 700, lineHeight: 1,
            }}
          >
            写
          </span>
          <span className="font-semibold text-[14px] tracking-wide"
                style={{ color: 'var(--ink)' }}>
            WriteTool
          </span>
        </div>

        {/* ⚠ 快捷工具栏已从顶栏移到**对话列顶部**（2026-10-15 羽毛菌：「移到这里」）。
            理由：那几个都是写作辅助，跟着对话场景走更合理；
            而顶栏原本被菜单栏 + 工具栏占掉三行，纵向空间很挤。 */}

        <div className="flex-1" />
        {initError && (
          <span className="text-[11px] max-w-[260px] truncate"
                style={{ color: 'var(--danger)' }}
                title={`初始化失败：${initError}`}>
            初始化失败：{initError}
          </span>
        )}

        {toast && <span className="text-[11px] mr-1" style={{ color: 'var(--accent)' }}>{toast}</span>}
        {status && <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>{status}</span>}
        {dirty && <span className="text-[11px]" style={{ color: 'var(--accent)' }}>● 未保存</span>}

        {/* ---------- 卡片开关：收起左边两栏 ----------
            放在最右而不是紧跟快捷工具，是为了让 flex-1 把它们推到窗边。
            ⚠ 状态文字（toast/status/未保存）在它们**左边**：
               这样提示冒出来时按钮不会跟着往左跳一下。 */}
        <div
          className="flex items-center gap-1 ml-2 pl-2 shrink-0"
          style={{ borderLeft: '1px solid var(--line)', WebkitAppRegion: 'no-drag' }}
        >
          {manualMode && (
            <span
              className="text-[11px] mr-1"
              style={{ color: 'var(--ink-soft)' }}
              title="纯手工模式：对话列表与对话框都收起来了，只剩目录与文件预览。点右边任意一个按钮就能把 AI 那部分叫回来。"
            >
              ✍️ 纯手工模式
            </span>
          )}
          {/* 设置入口住在第 1 栏内部，收起第 1 栏就找不到了。
              所以这里补一个——只在收起时出现，正常布局下仍然只有一个设置入口。 */}
          {hiddenPanes.includes('conversations') && (
            <Btn onClick={() => openSettings()}>⚙ 设置</Btn>
          )}
          {CARD_TOGGLES.map((c) => {
            const on = !hiddenPanes.includes(c.pane);
            return (
              <button
                key={c.pane}
                data-card-toggle={c.pane}
                aria-pressed={on}
                onClick={() => togglePane(c.pane)}
                className="px-2 py-1 rounded text-[12px] whitespace-nowrap"
                style={{
                  background: on ? 'var(--accent-soft)' : 'transparent',
                  color: on ? 'var(--ink)' : 'var(--ink-soft, #c2c2cc)',
                  opacity: on ? 1 : 0.75,
                }}
                title={on ? `收起${c.label}（腾出地方给目录和文件预览）` : `展开${c.label}`}
              >
                {c.icon} {c.label}
              </button>
            );
          })}
        </div>

        {/* 主题下拉与「设置」按钮都已移入设置页（SettingsPage）。
            同一份设置散在顶栏与面板两处，是用户找不到功能的主因。 */}

        {/* ---------- 窗口控制：最小化 / 最大化 / 关闭 ----------
         *
         * ⚠⚠⚠ 因为主窗口是 frame:false，系统那条标题栏**连同它的三个按钮一起没了**。
         *   不补这三个，窗口就没有任何办法最小化或关闭。
         *
         * ⚠⚠ 订阅主进程推来的 maximize/unmaxize：
         *   按钮图标要跟着当前状态变，否则「最大化」按下去之后再点就是反的。
         *   ⚠⚠⚠ useEffect 的清理函数**必须**取消订阅 —— 不取消的话每次重渲染
         *   都会再注册一个监听，点一次窗口按钮就发 N 次 IPC。
         *
         * ⚠ 宽度按 Windows 11 标题栏按钮的惯例来（各 46px），
         *   悬停才显出底色 —— 不然一条横线上三个常驻色块，比原来的系统按钮还吵。
         */}
        <div
          className="flex shrink-0"
          data-testid="win-controls"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          {[
            { key: 'min', label: '最小化', glyph: '─', act: () => window.api.win.minimize() },
            {
              key: 'max', label: maximized ? '还原' : '最大化',
              glyph: maximized ? '❐' : '□',
              act: () => window.api.win.toggleMaximize(),
            },
            { key: 'close', label: '关闭', glyph: '✕', act: () => window.api.win.close(), danger: true },
          ].map((b) => (
            <button
              key={b.key}
              data-win-btn={b.key}
              title={b.label}
              aria-label={b.label}
              onClick={b.act}
              className="flex items-center justify-center"
              style={{
                width: 46, height: '100%', border: 'none',
                background: 'transparent',
                color: 'var(--ink-soft)',
                fontSize: 12, lineHeight: 1, cursor: 'default',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = b.danger ? '#c42b1c' : 'var(--paper-2)';
                e.currentTarget.style.color = b.danger ? '#fff' : 'var(--ink)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--ink-soft)';
              }}
            >
              {b.glyph}
            </button>
          ))}
        </div>
      </header>

      {/*
       * 四栏。
       *
       * ⚠⚠ hasProject 那几个 prop 的注释写在**这里**（标签外），不写在属性之间。
       *
       *   2026-10-14 踩过两条：
       *   1. 裸块注释放在 JSX 属性之间 → React 当文本渲染，聊天区顶上
       *      一整段源码注释，用户以为软件坏了。
       *   2. 给它补上花括号 → **构建直接失败**：
       *      「Expected `...` but found `}`」。
       *      花括号注释只能当**子节点**，属性位置是 JSX 语法禁区。
       *
       *   没有项目时，「＋ 新对话」这个按钮的**职责要变**：
       *   零项目下它是个死按钮（没有项目挂不上对话），
       *   而用户此刻唯一能做的、也是真正想做的事是**建项目**。
       *   详见 createConversation 里的注释。
       */}
      <div className="flex-1 min-h-0">
        <SplitPanes
          appVersion={appVersion}
          hidden={hiddenPanes}
          panes={[
            {
              key: 'conversations',
              render: () => (
                <ConversationList
                  conversations={conversations}
                  activeId={convId}
                  onSelect={selectConversation}
                  onCreate={createConversation}
                  onRename={renameConversation}
                  onDelete={deleteConversation}
                  onOpenSettings={() => openSettings()}
                  hasProject={!!projectId}
                  onNewProject={() => openSwitcher(true)}
                  versionInfo={versionInfo}
                  statusLine={
                    // 优先级：初始化失败 > 生成错误 > 对话数
                    // 初始化失败最严重——那意味着软件根本没起来，
                    // 而生成错误只影响当前这一次对话。
                    initError
                      ? { text: `初始化失败：${initError}`, danger: true }
                      : error
                        ? { text: error, danger: true }
                        : conversations.length > 0
                          ? { text: `${conversations.length} 个对话`, danger: false }
                          : null
                  }
                />
              ),
            },
            {
              key: 'main',
              render: () => (
                <MainWorkspace
                  openTabs={openTabs}
                  activeTab={activeTab}
                  onActivate={setActiveTab}
                  onClose={closeTab}
                  renderTab={renderMainTab}
                />
              ),
            },
            {
              key: 'preview',
              render: () => (
                <DocPreview
                  files={openFiles}
                  activePath={previewPath}
                  doc={doc}
                  loading={docLoading}
                  error={docError}
                  onSelect={openPreview}
                  onClose={closePreview}
                  onSave={saveDoc}
                  // 历史版本（2026-10-18）：AI 改坏了能退回去
                  projectId={projectId}
                  onRestored={openPreview}
              // ⚠ 预览页的字号之前**完全不受控**（DocBody 里写死 13.5），
              //   而用户默认就停在预览页 → 「编辑器字号」滑块看着像没用。
              fontSize={config.editorFontSize || config.fontSize || 16}
                />
              ),
            },
            {
              key: 'files',
              render: () => (
                <FileTree
                  tree={tree}
                  loading={treeLoading}
                  error={treeError}
                  activePath={previewPath}
                  onRefresh={refreshTree}
                  onOpenFile={openPreview}
                  onCreate={createEntry}
                  onRename={renameEntry}
                  onRemove={removeEntry}
                  onTrash={trashEntry}
                  onMove={moveEntry}
                  onOpenTrash={() => setTrashOpen(true)}
                  trashCount={trashCount}
                  projectName={currentProject?.name || ''}
                  onSwitchProject={() => openSwitcher(false)}
                  sortBy={treeSort}
                  onSortChange={changeTreeSort}
                />
              ),
            },
          ]}
        />
      </div>

      {/* ---------- 底部状态栏：已移除 ---------- */}
      {/* ⚠ 曾经做成一条**横跨整个窗口宽度**的底栏（28px → 36px）。
         那样做等于给四栏都加了一条底边——第 2/3/4 栏全被压掉一截，
         而正文、文档预览、文件树恰恰是用户盯着看的东西。
         为了一个设置入口让三栏都变小，方向就错了。

         现在设置入口住在**第 1 栏内部**（ConversationList 的固定底座，
         见该组件里的注释），另外三栏保持完整高度、贯穿到窗口底部。

         这里不再有任何横跨全宽的条。错误提示移到了底座里
         ——它属于"出事了"的提示，跟着设置入口一起待在第 1 栏
         不会侵占正文空间，而顶栏本来也有一处状态显示。*/}

      {/* ---------- 回收站：居中弹窗 ---------- */}
      {trashOpen && (
        <TrashModal
          projectId={projectId}
          projectName={currentProject?.name || ''}
          onClose={() => setTrashOpen(false)}
          onChanged={refreshTree}
          onToast={showToast}
        />
      )}

      {/* ---------- 项目切换：居中弹窗 ---------- */}
      {switcherOpen && (
        <ProjectSwitcher
          projects={projects}
          currentId={projectId}
          trashCount={trashCount}
          startCreating={switcherNew}
          onPick={pickProject}
          onCreate={createProjectBy}
          onImport={importProjectFolder}
          onImportDone={importDone}
          onRename={renameProject}
          onDelete={deleteProject}
          onExport={exportProject}
          onOpenTrash={() => { setSwitcherOpen(false); setTrashOpen(true); }}
          onClose={() => { setSwitcherOpen(false); setSwitcherNew(false); }}
          onToast={showToast}
        />
      )}

      {/* ---------- 设置页：整页覆盖 ---------- */}
      {showSettings && (
        <SettingsPage
          config={config}
          onConfigChange={applyConfig}
          onClose={() => { setShowSettings(false); setSettingsCat(null); }}
          projectId={projectId}
          projects={projects}
          onToast={showToast}
          initialCat={settingsCat}
        />
      )}
      {/* ---------- 审批弹窗：盖在设置页之上 ---------- */}
      {/* ⚠ 顺序有讲究：它在设置页**之后**渲染，所以 z-50 能盖住 z-40 的设置页。
          绝不能放到设置页前面——那正是"模型要跑危险命令、而用户正好在改设置"的情况，
          弹窗被盖住 = 看起来什么都没发生，而主进程会一直等 120 秒。 */}
      <ToolApprovalModal
        request={approval}
        onDecide={(allow) => {
          setApproval(null);
          // ⚠ 回传失败（超时/已结束）不算错：主进程那边已经按拒绝处理了。
          //   这里只把它记录下来，免得"点了没反应"变成一个查不出来的现象。
          window.api.tool.decide({ id: approval.id, allow }).catch((e) => {
            setStatus(`审批没送到：${e.message}`);
          });
        }}
      />
      {/* ---------- 《用户协议》弹窗：同样盖在设置页之上 ---------- */}
      {/* ⚠ 渲染在**最后**：协议弹窗是"你签了才继续"的那道门，
          要是被设置页或任何面板压住，用户就看不到也点不到同意 ——
          那等于把"第一次警告"变成了"卡死"。 */}
      <AgreementModal
        open={!!agreement}
        version={agreement ? agreement.version : ''}
        text={agreement ? agreement.text : ''}
        reason={agreement ? agreement.reason : ''}
        busy={generating}
        onAgree={agreeAndSend}
        onCancel={cancelAgreement}
      />
    </div>
  );
}

/**
 * 按 id 合并一条工具调用。
 *
 * ⚠ 为什么要合并而不是追加：一次调用的 start 与 end 是两条事件，
 *   追加会得到两张卡片（一张永远停在"执行中"）。
 *   而"模型这一轮查了三次同一个东西"用 id 合并也自然只在同一条上更新。
 *
 * ⚠ 没有 id 时退回"追加"：主进程理论上会给 id（模型返回的 tool_call id），
 *   但 Ollama 某些版本不给。拿一个 undefined 当 key 会让 React 报
 *   "同层 key 重复"，那时候界面会整块崩掉——比多几张卡片严重得多。
 */
function upsertTool(list, item) {
  const id = item && item.id;
  if (id) {
    const i = list.findIndex((t) => t.id === id);
    if (i >= 0) {
      const next = [...list];
      next[i] = { ...next[i], ...item };
      return next;
    }
  }
  return [...list, item];
}

function Btn({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-1 rounded text-[12px] shrink-0"
      style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
    >
      {children}
    </button>
  );
}