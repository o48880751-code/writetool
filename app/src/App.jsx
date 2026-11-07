import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackgroundLayer, useBackground } from './components/Background.jsx';
import ConversationList from './components/ConversationList.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import FileBox from './components/FileBox.jsx';
import EditorSurface from './components/EditorSurface.jsx';
import SplitPanes from './components/SplitPanes.jsx';
import Bookshelf from './components/Bookshelf.jsx';
import MainWorkspace from './components/MainWorkspace.jsx';
import DocPreview from './components/DocPreview.jsx';
import ChapterPicker from './components/ChapterPicker.jsx';
import BookAnalyzer from './components/BookAnalyzer.jsx';
import FileTree from './components/FileTree.jsx';
import StyleDistill from './components/StyleDistill.jsx';
import IntroGen from './components/IntroGen.jsx';
import ToolModal from './components/ToolModal.jsx';
/** 品牌图标：由 make-icon.js 生成，和 exe / 启动动画同一份 */
import brandLogo from './assets/logo.svg';
import CoverModal from './components/CoverModal.jsx';
import ToolsPanel from './components/ToolsPanel.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import TrashModal from './components/TrashModal.jsx';
import ProjectSwitcher from './components/ProjectSwitcher.jsx';
import { ToolApprovalModal } from './components/ToolCards.jsx';
import AgreementModal from './components/AgreementModal.jsx';
import { GuideModal } from './components/Welcome.jsx';
import LanShare from './components/LanShare.jsx';
import { DEFAULT_MODE, applyTheme, isValidMode, systemPrefersDark } from './themes.js';
import { thinkLevelsOf, normalizeLevel } from './think-levels.js';
import { useBootstrapFonts } from './lib/fonts.js';
import { playChime } from './lib/chime.js';
import { Icon } from './components/Icons.jsx';

/**
 * 顶栏「卡片开关」能收起的栏。
 *
 * 只有左边两栏（AI 相关）可收起：右边两栏是目录与文件预览，
 * 它们是「自己写」的地盘，收起就没东西可看了。
 */
const CARD_PANES = ['conversations', 'main'];

/**
 * 把模型/网络的原始报错翻成用户能照着做的一句话（2026-11-05）。
 *
 * ⚠ 羽毛菌的原话：「如果 ai 不稳定应该直接回复用户换个 ai」。
 *   原来直接把 `fetch failed` / `ECONNREFUSED` 甩在红条上，
 *   用户既不知道发生了什么，也不知道下一步该点哪。
 */
function friendlyModelError(msg) {
  const m = String(msg || '');
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket|timeout|HTTP (?:5\d\d)|502|503|504/i.test(m)) {
    return `连不上模型（${m}）。换一个模型或服务商再发一次；刚才那条已经留在对话里，不用重打。`;
  }
  if (/401|403|invalid.*key|api.?key/i.test(m)) {
    return `这个模型的密钥不对或已失效（${m}）。去设置里换一条连接，再重发。`;
  }
  if (/429|rate.?limit|quota/i.test(m)) {
    return `这家服务商限流了（${m}）。等一会儿，或换一个模型再发。`;
  }
  return m;
}

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

  /**
   * 新版本提示（2026-10-29）。
   *
   * ⚠ 只提示、不自动更新：安装包没签名，自动下载的 exe 会被 SmartScreen 拦。
   * ⚠ 拉取失败一律静默 —— 没网的用户不该因为"检查版本"看到任何报错。
   * ⚠ 关掉后本次启动不再提示（sessionStorage），但下次开还会提示 ——
   *   新版本这件事值得反复提，只是不该在同一次使用里反复烦人。
   */
  const [updateInfo, setUpdateInfo] = useState(null);

  useEffect(() => {
    // 3 秒后再查：先让首屏把界面画出来，不要让一次网络请求拖慢启动
    const timer = setTimeout(async () => {
      if (sessionStorage.getItem('updateDismissed') === '1') return;
      try {
        const r = await window.api.update.check();
        if (r && r.ok && r.hasUpdate) setUpdateInfo(r);
      } catch (e) {
        // 检查失败静默，不给用户看
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);

  /**
   * 当前这一屏是「书架」还是「编辑器」（2026-11-01 加）。
   *
   * ⚠ 初始值**固定是 shelf**：羽毛菌要的是「进入软件先选择项目，
   *   而不是直接看到编辑聊天页面」。所以哪怕上次退出时停在第 12 章，
   *   下次打开也先落到书架 —— 由他决定这次写哪本。
   *
   * ⚠ 不持久化。持久化的话第二次打开就又是"直接进编辑器"，
   *   等于把这次改的东西抵消掉。
   */
  const [view, setView] = useState('shelf');

  /**
   * 欢迎页状态（2026-11-05）。
   *
   * ⚠ `welcomeMode` 是**算出来的**，不单独存：
   *   项目还没有对话 → 'first'（新书启航 / 搭建大纲 / 使用教程）；
   *   已经有对话     → 'returning'（继续写作 / 规划章纲 / 查询冲突）。
   *   存一份 state 就得在新建对话、删对话、切项目三处同步，漏一处就会
   *   显示上一本书的按钮。算出来没有这个问题。
   */
  const [showGuide, setShowGuide] = useState(false);
  /** 局域网传文件面板（2026-11-06）。打开才起服务，关掉就停 */
  const [showLan, setShowLan] = useState(false);
  /** 传给第 4 栏：要展开哪个目录。带 nonce，同一个目录连点两次也能重新展开。 */
  const [focusDir, setFocusDir] = useState(null);
  /**
   * 明暗档位。⚠ 2026-11-01 从「12 套主题平铺」改成「浅色/深色/跟随系统」，
   * 照 ChatGPT 的 Appearance（羽毛菌原话：不要固定主题，只要能选深浅 + 改底色字色）。
   */
  const [mode, setMode] = useState(DEFAULT_MODE);

  /**
   * 系统当前是不是深色（只给顶部那个一键切换按钮**画图标**用）。
   *
   * ⚠ 为什么要单独存一份 state：`mode === 'system'` 时真正的深浅由
   *   `matchMedia` 决定，而那个变化**不会让 App 重渲染** ——
   *   下面那个跟随系统的 effect 只调 `applyTheme`（改 CSS 变量），不动 state。
   *   不存这一份的话，系统白天切深色时界面变了、按钮上的月亮/太阳却不换。
   */
  const [sysDark, setSysDark] = useState(() => systemPrefersDark());

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

  /**
   * 生成结束后把工具卡片收成一行（2026-10-30）。
   *
   * ## 为什么要有这个
   *
   * 原来两种做法都不对：
   *   · 生成结束就清空 → 用户回头翻记录，看不到它读了哪些文件（看不到）
   *   · 一直平铺     → 文字吐完了，下面还压着十几行「完成」，
   *                    正文被顶到屏幕外，一屏全是执行记录（太吵）
   *
   * 现在：**生成中逐条显示**（能看到它在干嘛），
   *       **生成完收成一行摘要**（「执行了 13 步 · 读取 6 份资料」），
   *       想看细节点一下展开。
   */
  const [toolsCollapsed, setToolsCollapsed] = useState(false);

  /**
   * 切项目时清空工具卡片（2026-10-30 加）。
   *
   * ⚠ 现场：用户从「试用小说文件」切到新项目「测试哦」，中间栏还开着上一个项目的对话，
   *   卡片区残留着上一轮的「写文件 1」——他以为这次写了 `设定.md`，
   *   实际那份文件躺在另一个项目里。
   *
   * 工具卡片是**某一轮对话**的产物，换了项目就不再属于当前上下文。
   */
  useEffect(() => {
    setToolCalls([]);
    setToolsCollapsed(false);
  }, [projectId]);

  /**
   * 「同步维护文档」询问（2026-10-29）。
   *
   * 模型写完一章之后，`章节摘要.md` / `人物库.md` 很可能已经过时，
   * 但它不会主动想起来更新。所以生成结束时问一句：
   *   { paths: ['章节/第二章.md'] }
   *
   * ⚠ 只是**问**，不自动改：改摘要和人物库是动用户的长期资料，
   *   模型很可能改错（把临时角色写进人物库、把一句话扩写成三段），
   *   而用户不一定会去核对。**要他点头才动**。
   */
  const [syncAsk, setSyncAsk] = useState(null);
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

  /**
   * 生成卡死的兜底（2026-10-30 加）。
   *
   * ## 现场
   *
   * 主进程日志最后一行是「结束 2784ms 正文=64字」，之后再没有新日志；
   * 而界面一直转圈转了五十多分钟。前后端都查过：`onDone` 第一行就是
   * `setGenerating(false)`、只注册一次、渲染层没有任何报错 —— **断点找不到**。
   *
   * 这种情况下**先保证用户能自己脱身**，再靠主进程那两条 `[done]` 日志定位根因
   * （见 conv:send 的 onDone）。
   *
   * ## 为什么是「5 分钟没有数据」而不是「5 分钟没结束」
   *
   * 正常生成每几秒就有一段正文 / 思考 / 工具事件进来，
   * 这些变化都会重置定时器。**连续 5 分钟一点字节都没收到**，
   * 才说明这条连接已经没有下文了 —— 长文写十分钟以上也不会被误杀。
   */
  useEffect(() => {
    if (!generating) return undefined;
    const timer = setTimeout(() => {
      setGenerating(false);
      setError('生成似乎中断了（5 分钟没有收到任何数据）。可以重新发送，或点重试。');
    }, 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [generating, streamingText, streamingThink, toolCalls.length]);

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
  /**
   * 最后一次收到模型分片的时间（2026-11-05）。
   * 用来兜底「正文吐完了、done 却没到」——界面会一直停在「生成中」。
   */
  const lastChunkAt = useRef(0);

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
        /**
         * 兼容旧配置：老版本存的是 `theme: 'gold' | 'night' | …`。
         * 那些 id 现在不是 mode，`isValidMode` 会判假 → 落到默认浅色，
         * 正好是"旧的浅色主题用户平移到新体系"，不会突然变深。
         */
        const m = isValidMode(cfg.mode) ? cfg.mode : DEFAULT_MODE;
        setMode(m);
        applyTheme(m, cfg.customColors);
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
          mode: DEFAULT_MODE,
          notify: 'window', currentProject: null,
        });
        applyTheme(DEFAULT_MODE);
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
 *   另外 mode 做兜底：万一 cfg 里没有 mode 字段（配置损坏或
 *   桩实现返回了残缺对象），就用现有的 mode 状态，不要退回默认——
 *   那会把用户正在用的深色模式强行切回浅色。
 *
 *   ⚠ 这里必须把 `customColors` 一起传下去。设置页改颜色走的是
 *     `save({ customColors })`，只更新 config 不重算 DOM 的话，
 *     用户点色块界面纹丝不动，会以为取色器坏了。
 */
const applyConfig = useCallback(async (cfg) => {
  const next = cfg || {};
  setConfig(next);
  const m = isValidMode(next.mode) ? next.mode : (isValidMode(mode) ? mode : DEFAULT_MODE);
  setMode(m);
  applyTheme(m, next.customColors);
}, [mode]);

/**
 * 顶部那个「一键切深浅」的按钮（2026-11-02 羽毛菌要的）。
 *
 * ## 为什么不是三档循环
 *
 * 设置页里是**三档**（浅色 / 深色 / 跟随系统），因为那里是"一次性设定"。
 * 顶栏这个是**高频手癖**：只想"现在太亮了，换黑的"。所以点一下就在
 * 明↔暗之间翻，**不经过"跟随系统"**。停在 system 档时点它，
 * 按"当前实际长什么样"翻到相反的**固定**档 —— 否则跟随系统时点了没反应。
 *
 * ## 先改界面，再落盘
 *
 * `applyTheme` 同步生效（改 CSS 变量），不等 IPC 往返。
 * 写盘失败只提示，不回滚：主题是纯表现层，回滚反而会闪一下。
 */
const toggleDark = useCallback(() => {
  const isDark = mode === 'dark' || (mode === 'system' && sysDark);
  const next = isDark ? 'light' : 'dark';
  setMode(next);
  applyTheme(next, config && config.customColors);
  (async () => {
    try {
      const cfg = await window.api.config.set({ mode: next });
      applyConfig(cfg);
    } catch (e) {
      showToast && showToast(`主题没存上：${e.message || e}`);
    }
  })();
}, [mode, sysDark, config, applyConfig, showToast]);

/**
 * 「跟随系统」时监听 Windows 的深浅切换。
 *
 * ⚠ 只在 system 档挂监听：另外两档跟着系统变是错的（用户明确选了深色，
 *   系统白天切浅色不能把他拽回白底）。
 * ⚠ 依赖里带 config 是为了拿到最新的 customColors —— 监听回调闭包会
 *   捕获注册那一刻的值，不带就会用旧颜色重绘。
 */
useEffect(() => {
  if (mode !== 'system' || !window.matchMedia) return undefined;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    // ⚠ 顺手把 sysDark 同步一下：顶部的一键切换按钮靠它决定画月亮还是太阳。
    //   只 applyTheme 不 setState 的话 CSS 变了、图标还是旧的。
    setSysDark(mq.matches);
    applyTheme('system', config && config.customColors);
  };
  // 进这个 effect 时也先对齐一次，避免"系统本来就是深色、mode 却刚切成 system"那一下画错图标
  setSysDark(mq.matches);
  // Safari 老版本只有 addListener，Electron 里用 addEventListener 就够，加个兜底
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
  return () => {
    if (mq.removeEventListener) mq.removeEventListener('change', onChange);
    else if (mq.removeListener) mq.removeListener(onChange);
  };
}, [mode, config]);

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

  /**
   * ⚠⚠ 2026-11-05 这里从 `true` 改成 `false`：进项目先停在欢迎页，
   *   不再自动打开上次那条对话。
   *
   *   原来 `true` 会直接 `selectConversation(list[0])`，消息流立刻有内容，
   *   空状态根本不渲染 —— 于是「第二次从书架进来」永远看不到
   *   「继续写作 / 规划章纲 / 查询冲突」这三个按钮。
   *   现在打开上次对话的入口就是「继续写作」按钮本身
   *   （db 里 listConversations 已按 updated_at DESC 排好序）。
   */
  useEffect(() => { loadConversations(projectId, false); }, [projectId]);

  const selectConversation = useCallback(async (id) => {
    convSeq.current += 1;
    const seq = convSeq.current;
    /**
     * ⚠⚠ 点对话必须把「对话」标签打开并激活（2026-10-29 修）。
     *
     * 原来这里只 `setConvId` —— 如果用户之前把「对话」标签关掉了，
     * 点左侧对话只会让那一行**高亮**，中间栏还停在文档预览上，
     * 看起来像"对话内容不见了"。用户会以为数据丢了，实际是标签没开。
     *
     * ⚠ `setOpenTabs` / `setActiveTab` 虽然声明在下面，但它们是 state setter，
     *   稳定且调用时早已初始化 —— 这不构成 TDZ（和 useState 取值不同）。
     */
    setOpenTabs((prev) => (prev.includes('chat') ? prev : [...prev, 'chat']));
    setActiveTab('chat');
    setConvId(id);
    setStyleResult(null);
    setStreamingText('');
    setStreamingThink('');
    // ⚠ 切对话要清工具卡片（2026-10-29 改了清空时机后必须补这句）：
    //   不清的话，上一个对话的「读取文件 xxx」会跟着带进新对话，
    //   看起来像这个对话读过那些文件。
    setToolCalls([]);
    setToolsCollapsed(false);
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
        lastChunkAt.current = Date.now();
        setStreamingText((prev) => prev + text);
      }),
      window.api.generate.onDone((meta) => {
        setGenerating(false);
        setStreamingText('');
        // 正文吐完了，把工具卡片收成一行摘要 —— 留着能回看，但不占屏幕
        setToolsCollapsed(true);
        // 写完章节 → 问一句要不要同步维护文档（2026-10-29）。
        // ⚠ 只在**正常完成**时问：出错的、被停下的，章节本身可能都不完整，
        //   这时去更新摘要等于把半截内容写进长期资料。
        if (meta && !meta.stopped && Array.isArray(meta.chapterSaved) && meta.chapterSaved.length) {
          setSyncAsk({ paths: meta.chapterSaved });
        }
        // 生成完成提示音：notify 含「提示音」时播（'window'/'none' 不响）。
        // ⚠ 必须读 configRef.current 拿最新 notify——这个回调闭包捕获的
        //   config 是订阅那一刻的旧值，用户中途改了提示方式不会生效。
        if (!meta?.stopped) {
          const n = configRef.current && configRef.current.notify;
          if (n === 'sound' || n === 'both') {
            try { playChime(); } catch (_) { /* 音频不可用不影响主流程 */ }
          }
        }
        // ⚠ 工具卡片**不在这里清**（2026-10-29 改）。
        //   原来清在这儿，导致生成一结束卡片就消失，用户翻记录看不到它读了什么。
        //   现在改成下一轮 `send` 开头再清 —— 生成完能回看，又不会跟新卡片叠。
        // 思考留一小会儿让用户看到，1.2 秒后淡出
        setTimeout(() => setStreamingThink(''), 1200);
        /**
         * ⚠⚠ 停止也要把消息拉回来（2026-11-05）。
         *
         * 主进程 generate:stop 会把**已经吐出来的半截正文**落库，
         * 这里如果直接 `return`，界面就停在「什么都没有」——
         * 用户看到的是自己那句提问孤零零留着、AI 说的话凭空消失。
         */
        if (meta && meta.stopped) {
          setStatus('已停止');
          if (convId) window.api.conv.messages({ conversationId: convId }).then(setMessages);
          return;
        }
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
        lastChunkAt.current = Date.now();
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
        setToolsCollapsed(false);
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
   * 「正文吐完了、done 却没到」的兜底（2026-11-05）。
   *
   * 现场：AI 的回答已经整段显示出来，发送键却还是红色停止方块 ——
   * 说明 generate:done 没送到渲染层（流没正常收尾 / 窗口错过事件），
   * `generating` 永远为 true，界面看起来像卡死。
   *
   * 判据：收到过分片、且**两分钟**没有新分片 → 主动停一次并说明原因。
   * ⚠ 必须用 lastChunkAt 而不是"发了多久"：长文生成十几分钟是正常的，
   *   只有"完全没动静"才算卡住。思考分片也算动静（onThink 里同样刷新）。
   */
  useEffect(() => {
    if (!generating) return undefined;
    const timer = setInterval(() => {
      if (!lastChunkAt.current) return;
      if (Date.now() - lastChunkAt.current < 120000) return;
      lastChunkAt.current = 0;
      try { window.api.generate.stop(); } catch (_) { /* 停不掉也要把状态复位 */ }
      setError('模型两分钟没有返回新内容，已自动停止。换一个模型或服务商再试；已经写出来的部分留在了对话里。');
    }, 5000);
    return () => clearInterval(timer);
  }, [generating]);

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
  /**
   * @param {string} [targetConvId] 欢迎页的「规划章纲 / 查询冲突」用：
   *   进项目时我们刻意没有选中任何对话（convId 为 null），
   *   但这两个动作应该接着最近那条对话聊，而不是又新开一条。
   *   ⚠ 不能用 `await selectConversation(id)` 再调 send —— setConvId 是异步的，
   *   同一轮 send 的闭包里 convId 还是 null，照样新建对话。所以走局部变量 cid。
   *   不传时行为与以前完全一致。
   */
  const send = async (text, refs, agreementToken, targetConvId) => {
    /**
     * ⚠ 新一轮开始时清空上一轮的工具卡片（2026-10-29 调整）。
     *
     * 原来是在 `generate:done` 里清 —— 于是**生成一结束卡片就消失**，
     * 用户回头翻记录时看不到"它刚才读了哪些文件、写了什么"，只能从回复里猜。
     * 竞品的做法是留在历史里，随时能核对。
     *
     * 现在改成"下次发送时才清"：生成完的卡片留着能回看，
     * 又不会跟下一轮的叠在一起（那会让人以为命令跑了两遍）。
     */
    setToolCalls([]);
    setToolsCollapsed(false);
    // 这一轮从此刻开始计时；之后每秒没分片进来就会被兜底逻辑盯上
    lastChunkAt.current = Date.now();
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
    const cid = targetConvId || convId;
    // 指定了目标对话就把它选上，否则列表不高亮、下一轮又会新建一条
    if (targetConvId && targetConvId !== convId) setConvId(targetConvId);
    if (!cid) {
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
        setGenerating(false); setError(friendlyModelError(e.message)); setStatus('');
        /**
         * ⚠⚠ 用户消息「消失」的根因就在这（2026-11-05）。
         *
         * 主进程是先落库用户消息、再连模型的；连不上时 conv:send 直接抛错，
         * 渲染层这个 catch 只显示红字、**没有重新拉消息** ——
         * 气泡看起来就是被吞了。补这一下，字一定还在。
         */
        if (cid) window.api.conv.messages({ conversationId: cid }).then(setMessages);
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
        conversationId: cid, projectId, text, refs,
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
      window.api.conv.messages({ conversationId: cid }).then(setMessages);
    } catch (e) {
      setGenerating(false);
      setError(friendlyModelError(e.message));
      setStatus('');
      // 同上：用户消息已经落库，必须拉回来，否则气泡就“消失”了
      if (cid) window.api.conv.messages({ conversationId: cid }).then(setMessages);
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
    /**
     * 拆书（2026-10-28）。
     *
     * ⚠ 它**不是**广场里的商品 —— 广场是装别人技能的地方，
     *   而"拆解一本书"是写长篇的日常动作，不该让用户先下载才能用。
     *   所以：能力做成**内置技能**（builtin-skills/sk-story-analyze），
     *   入口放在**这一排**，点一下就走。
     *
     * ⚠ 与其他几个的区别：它**要调模型**、产出长文，所以点它直接发消息，
     *   不切 ToolsPanel（那个面板是一问一答的短交互）。
     */
    /**
     * 生成封面（2026-11-02）。
     *
     * ⚠ 羽毛菌纠正过两次：这是**小说封面**，不是"海报"。
     *   位置也是他定的：「封面功能按钮应该放在快捷工具那一栏」——
     *   设置页只负责配模型，不负责生成（那里只有「保存并测试」）。
     *
     * ⚠⚠ 放在**拆书前面**：这一排放不下时，后面的会收进「⋯」菜单里
     *   （ChatPanel 的 visibleTools 按宽度裁）。封面是新功能，
     *   第一次就要出现在「⋯」里等于没做 —— 而拆书是低频动作，往后排无妨。
     */
    { key: 'cover', label: '封面', icon: '🖼️', hint: '按书名和简介生成小说封面' },
    { key: 'analyze', label: '拆书', icon: '🔍', hint: '拆解一本书的钩子、爽点、结构与伏笔' },
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
    /**
     * ⚠ 2026-11-02 补的第三栏。原来只有前两个 ——
     *   文件树收起后没有任何入口能叫回来，用户只能重启。
     *   （苹果风原型里是三个开关，一栏一个。）
     */
    { pane: 'files', label: '文件树', icon: '📁' },
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
  /** 生成封面弹窗（2026-11-02）。挂在根层，书架和编辑器上都能盖。 */
  const [showCover, setShowCover] = useState(false);
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
   * 起名 / 脑洞 / 灵感碎片的弹窗（2026-11-03）。
   * 值是 `'name' | 'brain' | 'idea'`，null 表示没开。
   */
  const [toolModal, setToolModal] = useState(null);

  /**
   * 点顶栏某个快捷工具。
   *
   * ⚠ 重复点同一个按钮时**不重置** activeTool：
   *   用户正在灵感碎片里写了半段，点一下顶栏再点回来，
   *   如果重置成全部展开，他会丢掉"我在哪个工具"的上下文。
   */
  /**
   * ⚠ 这个 state 原属「项目文件树」那一段（约 1149 行），2026-10-28 提到这里。
   *
   * 起因：`openQuickTool` 一度依赖它，而依赖数组是**渲染时求值**的 ——
   * 声明在后面就炸 `Cannot access 'xx' before initialization`，整个 App 白屏。
   *
   * 拆书改成「让用户选文件」之后，`openQuickTool` 不再依赖它了，
   * **技术上可以放回原位**。但保持在这里也完全无害，
   * 而且下次谁要在上层回调里用它时，不会再踩一次同样的坑。
   */
  const [previewPath, setPreviewPath] = useState(null);

  /**
   * 正在拆的书（2026-10-28）。
   *
   * 点「拆书」选了文件之后不直接发 —— 先让用户勾章节。
   * 一本书几百章，全塞进去装不下；按字数硬切又会切在剧情中间。
   *
   * ⚠ 这个 state 必须在 `openQuickTool` **之前**声明：
   *   openQuickTool 里要调 `setAnalyzeBook`，而它是 useCallback，
   *   依赖数组在渲染时求值 —— 声明在后面就是 TDZ，整个 App 白屏。
   *   （这个坑今天刚踩过一次，见 previewPath 的注释。）
   */
  const [analyzeBook, setAnalyzeBook] = useState(null);

  /**
   * 正在跑的拆书任务（2026-10-28）。
   *
   * ⚠ 拆书**不进对话**：产出几万字，进历史会拖累后面每一轮，
   *   而它只是"一次性解析"，不需要模型记住。结果走保存，落到项目里的「拆书/」。
   */
  const [analyzeJob, setAnalyzeJob] = useState(null);

  const openQuickTool = useCallback(async (t) => {
    /**
     * 起名 / 脑洞 / 灵感碎片 → **各自一个弹窗**（2026-11-03）。
     *
     * ⚠ 羽毛菌：「都应该做单独的交互而不是和备忘录一样」。
     *   原来是四个工具共用同一个"打开 md 随便写"的模板 ——
     *   对备忘录是对的（它就是随手记），对这三个是错的：
     *   用户要的是"我提要求、模型给初稿"，而不是"给我一个空文件"。
     *
     * ⚠ 必须放在下面那些分支**之前**判断，且 `projectId` 为空时挡住：
     *   这三个最终要把结果写进项目文件，没项目就没有落点。
     */
    if (t.key === 'name' || t.key === 'brain' || t.key === 'idea') {
      if (!projectId) { showToast('先打开一本书，才有地方存'); return; }
      setToolModal(t.key);
      return;
    }
    // ⚠ 文风蒸馏是多步长任务（分块读 → 汇总 → 存技能），
    //   不适合塞进 ToolsPanel 那个一问一答的面板。
    if (t.key === 'style') { setShowStyleDistill(true); return; }
    if (t.key === 'intro') { setShowIntro(true); return; }
    // 封面：独立弹层。不切 ToolsPanel —— 那面板是一问一答的短交互，
    // 而它要跑一次几十秒的生图 + 一张大图预览。
    if (t.key === 'cover') {
      if (!projectId) { showToast('先打开一本书，才有封面可画'); return; }
      setShowCover(true);
      return;
    }
    /**
     * 拆书（2026-10-28）：直接发一条预设消息，产物落在对话里。
     *
     * ⚠ 为什么不弹面板：拆书的产出是**长文报告**（五层拆法，每层带证据），
     *   塞进小面板里根本看不完，也没法接着追问"第三层再细一点"。
     *   放对话里，用户能追问、能复制、能让它存成文件。
     *
     * ⚠ 书名优先取**当前打开的文件**（previewPath）—— 比让用户手打准，
     *   也和他的真实意图一致（他刚打开那本书，多半就是要拆它）。
     */
    if (t.key === 'analyze') {
      /**
       * ⚠⚠ 拆书拆的是**别人的完结作品**，不是用户自己的稿子（2026-10-28 改）。
       *
       * 第一版取的是 previewPath（当前打开的文件）——那基本是**他自己正在写的**，
       * 没写完，拆不出结构。他原话：「自己写得都没写完，能拆出个啥？」
       *
       * ⚠ 第二个问题同样致命：一整本网文几十万字，**塞不进上下文**。
       *   所以按字数分流：小文件给全文，大文件只给开头 + 明确告诉模型还有多少没读。
       *   这样模型不会假装"我读完了"，用户也知道这次拆的是局部。
       */
      let picked = null;
      try {
        picked = await window.api.dialog.pickTextFile();
      } catch (e) {
        showToast(`读取失败：${e?.message || '未知错误'}`);
        return;
      }
      if (!picked || !picked.ok) return;   // 用户点了取消

      /**
       * 认出了章节 → 开勾选面板，让用户自己决定拆哪几章。
       * 没认出来（短篇、片段、公告）→ 直接发全文，上限 3 万字。
       */
      if (Array.isArray(picked.chapters) && picked.chapters.length > 1) {
        setAnalyzeBook(picked);
        return;
      }

      const body = picked.text.slice(0, 30000);
      const cut = picked.chars > body.length
        ? `\n\n（这份文本共 ${picked.chars} 字，只给了前 ${body.length} 字，后面没读。拆的时候只说你能看见的部分。）`
        : '';
      send(`帮我拆一下《${picked.name}》的结构和节奏。${cut}\n\n---\n${body}`);
      return;
    }
    setOpenTabs((prev) => (prev.includes('tools') ? prev : [...prev, 'tools']));
    setActiveTab('tools');
    setActiveTool((prev) => (prev === t.key ? prev : t.key));
    // ⚠ 依赖不能是空数组（2026-10-28 改）：这个回调现在要用 send 和 previewPath，
    //   写成 [] 会永久冻住**第一次渲染时**的那份 send —— 它闭包里的 convId 是旧的，
    //   点"拆书"会发到上一条对话里去。这个坑在 agreeAndSend 那里踩过一次。
  // ⚠ 2026-11-02 加 projectId：封面要"当前这本书"，闭包里冻住旧值就会
  //   画到上一本书上（书名/简介全错，而界面看着一切正常）。
  }, [send, showToast, projectId]);

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
        // ⚠ 带上 mtime：欢迎页「查询冲突」要挑**最新**那卷卷纲，
        //   只留 path/name 就只能按文件名猜（「第十卷」字典序还排在「第二卷」前面）。
        if (n.type === "file") out.push({ path: prefix + n.name, name: n.name, mtime: n.mtime || '' });
        else if (n.children) walk(n.children, prefix + n.name + "/");
      }
    };
    walk(tree && tree.children, "");
    return out;
  }, [tree]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState(null);
  const [openFiles, setOpenFiles] = useState([]);      // [{path, name}] 多文档
  // ⚠ previewPath 的声明已上移到 openQuickTool 之前（TDZ，见那里的注释）
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

  /**
   * 正在收起的栏（2026-11-03）。
   *
   * 羽毛菌：「你只做了入场的动画，消失的没有」。
   * 原因很直白：`hiddenPanes` 一改，那一栏立刻被卸载，没有"离开"的时机。
   * 做法是**延迟 200ms 再真的收起**：先把 key 放进 closingPanes，
   * SplitPanes 给那一栏打上 `data-pane-closing`，CSS 把宽度收到 0 并淡出；
   * 200ms 后（宽度已经是 0）再从 hiddenPanes 里加进去，此时摘掉看不见。
   *
   * ⚠ 用 ref 读当前的 hiddenPanes：togglePane 是 useCallback([])，
   *   直接读 state 会拿到闭包里的旧值（连点两次判断就反了）。
   */
  const hiddenPanesRef = useRef(hiddenPanes);
  useEffect(() => { hiddenPanesRef.current = hiddenPanes; }, [hiddenPanes]);
  const [closingPanes, setClosingPanes] = useState([]);
  const closeTimers = useRef({});
  useEffect(() => () => {
    for (const t of Object.values(closeTimers.current)) clearTimeout(t);
  }, []);

  const togglePane = useCallback((key) => {
    const isHidden = hiddenPanesRef.current.includes(key);

    // 展开：立刻生效（paneIn 动画负责"进来"）
    if (isHidden) {
      setHiddenPanes((prev) => {
        const next = prev.filter((x) => x !== key);
        try { localStorage.setItem('wt.hiddenPanes', JSON.stringify(next)); } catch (_) { /* 存不了也不影响用 */ }
        return next;
      });
      return;
    }

    /**
     * 收起：如果它已经在"正在收起"里，说明用户连点了两下 —— 当成反悔，
     * 取消这次收起（否则两下之后它还是没了，手感像点漏了一下）。
     */
    if (closingPanes.includes(key)) {
      clearTimeout(closeTimers.current[key]);
      setClosingPanes((c) => c.filter((x) => x !== key));
      return;
    }

    setClosingPanes((c) => [...c, key]);
    clearTimeout(closeTimers.current[key]);
    closeTimers.current[key] = setTimeout(() => {
      setHiddenPanes((prev) => {
        const next = prev.includes(key) ? prev : [...prev, key];
        try { localStorage.setItem('wt.hiddenPanes', JSON.stringify(next)); } catch (_) { /* 同上 */ }
        return next;
      });
      setClosingPanes((c) => c.filter((x) => x !== key));
    }, 200);
  }, [closingPanes]);

  /** 左边两栏都收起来了 = 纯手工模式（顶栏给个提示，别让人以为软件坏了） */
  const manualMode = hiddenPanes.includes('conversations') && hiddenPanes.includes('main');

  // ================================================================
  // 欢迎页：第一次 / 第二次两套入口（2026-11-05）
  // ================================================================
  /**
   * ⚠ 用算的，不另存一份 state。
   *   存 state 就得在新建对话、删对话、切项目三处同步，漏一处会显示上一本书的按钮。
   */
  const welcomeMode = useMemo(
    () => (projectId ? (conversations.length ? 'returning' : 'first') : null),
    [projectId, conversations.length],
  );

  /**
   * 卷纲类文件，按修改时间倒序 —— 第 0 个就是「最新的卷纲」。
   *
   * ⚠ 不能按文件名排序：「第十卷.md」的字典序排在「第二卷.md」前面，
   *   按名字取最后一个会拿到最早写的那卷。fs:tree 本来就带 mtime，
   *   filePaths 压平的时候留一份就行。
   * ⚠ 顺带认短篇的「小节大纲.md」和短剧的「剧集/」，
   *   否则这两类项目点「查询冲突」会一个文件都找不到。
   */
  const outlineFiles = useMemo(() => filePaths
    .filter((f) => /(^|\/)卷纲\/.+\.(md|txt)$/i.test(f.path)
      || /(^|\/)小节大纲\.md$/i.test(f.path)
      || /(^|\/)剧集\/.+\.(md|txt)$/i.test(f.path))
    .slice()
    .sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || ''))),
  [filePaths]);

  /**
   * 文件引用的形状必须和 ChatPanel.toggleRef 一模一样：
   * key = kind + ':' + id，id 是**相对项目根的路径**。
   * 主进程 buildRefBlock 对这个 kind 会去 pfs.read(projectId, r.id) 把正文塞进上下文，
   * 所以 content 留空串即可 —— 写死内容反而是把旧稿钉死在这一轮。
   */
  const asFileRef = useCallback((f) => ({
    key: 'file:' + f.path, kind: 'file', id: f.path, name: f.name, content: '',
  }), []);

  /** 「查询冲突」要读的三份：世界观、人物库、最新卷纲 */
  const conflictRefs = useMemo(() => {
    const out = [];
    const world = filePaths.find((f) => /(^|\/)设定\/世界观\.md$/i.test(f.path))
      || filePaths.find((f) => /(^|\/)设定\.md$/i.test(f.path));
    const cast = filePaths.find((f) => /(^|\/)设定\/人物库\.md$/i.test(f.path))
      || filePaths.find((f) => /(^|\/)人物库\.md$/i.test(f.path));
    for (const f of [world, cast, outlineFiles[0]]) {
      if (f && !out.some((r) => r.id === f.path)) out.push(asFileRef(f));
    }
    return out;
  }, [filePaths, outlineFiles, asFileRef]);

  /** 「规划章纲」带上最新卷纲与章节摘要，AI 问下一章时才不是空问 */
  const outlineRefs = useMemo(() => {
    const out = [];
    if (outlineFiles[0]) out.push(asFileRef(outlineFiles[0]));
    const summary = filePaths.find((f) => /(^|\/)章节摘要\.md$/i.test(f.path));
    if (summary) out.push(asFileRef(summary));
    return out;
  }, [filePaths, outlineFiles, asFileRef]);

  const welcomeAction = useCallback(async (key) => {
    // 教程只开弹窗，不碰对话、不发消息
    if (key === 'guide') { setShowGuide(true); return; }

    // db 的 listConversations 已按 updated_at DESC 排好，第 0 条就是上次那段
    if (key === 'continue') {
      if (conversations.length) await selectConversation(conversations[0].id);
      else await createConversation('继续写作');
      return;
    }

    if (generating) { showToast('上一轮还没写完，等一下再点'); return; }

    // 下面四个动作接着最近那条对话聊，不另起一条；没有对话时传 undefined 走新建
    const recent = conversations.length ? conversations[0].id : undefined;

    if (key === 'newbook') {
      await send(
        '我们要开一本新书。先用几个短问题问我：写什么类型、给谁看、主角是谁、大概写多长、有没有已经定好的设定。一次最多问 4 个，别让我填表。等我回答之后，再给一版基础大纲：一到三卷的主线、主要人物、关键转折，并问我哪里要改。这一轮只提问，不要生成大纲，也不要写正文。',
        [], undefined, recent,
      );
      return;
    }

    if (key === 'build') {
      await send(
        '我要搭一份大纲。先问我手上有没有现成的大纲或零散想法，想细化哪一层：全书主线、分卷，还是章纲。等我回答后，把我给的内容整理成结构清楚的大纲，缺的地方标出来问我要不要补。这一轮只提问，不要生成大纲，也不要写正文。',
        [], undefined, recent,
      );
      return;
    }

    if (key === 'outline') {
      // 界面侧「打开卷纲文件夹」：第 4 栏展开这个目录（带 nonce，连点两次也会重开）
      setFocusDir({ path: '卷纲', nonce: Date.now() });
      await send(
        '我要规划下一章。卷纲文件夹已经打开了。请先只问我要不要现在规划下一章，以及想怎么生成：按现有卷纲顺推、我给要点你扩写、还是先看章节摘要再定。等我回答后再动手。这一轮不要生成章纲，也不要写正文。',
        outlineRefs, undefined, recent,
      );
      return;
    }

    if (key === 'conflict') {
      if (!conflictRefs.length) {
        showToast('还没找到设定或卷纲文件，先在项目文件夹里写点内容');
        return;
      }
      await send(
        '请检查设定与卷纲有没有冲突。世界观、人物库和最新一卷的卷纲已经作为文件引用带上了。逐条比对人物设定、时间线、地点、能力与境界规则、已经埋下的伏笔；只列确实有依据的冲突，每条写清是哪两份材料、哪一句互相矛盾；没有冲突就直说没有，不要凑数。缺哪份文件也先说明。这一轮不要改文件，也不要开始写正文。',
        conflictRefs, undefined, recent,
      );
    }
  }, [conversations, createConversation, selectConversation, send, generating,
    showToast, outlineRefs, conflictRefs]);

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

  /**
   * 新建项目。
   *
   * @param {string} name
   * @param {'long'|'short'|'drama'} [kind] 创作类型，决定建哪套骨架
   *   （2026-11-01 加）。不传就是长篇，和以前一样。
   */
  const createProjectBy = useCallback(async (name, kind = 'long', audience = '') => {
    const id = `p-${Date.now().toString(36)}`;
    const r = await window.api.project.create({ id, name, kind, audience });
    setProjects(r.projects || []);
    setProjectId(id);
    setActiveChapterId(null);
    if (r.createdFolder) {
      const label = kind === 'short' ? '短篇' : kind === 'drama' ? '短剧' : '长篇';
      showToast(`${label}项目已建，文件夹：${r.dir}`);
    }
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

  /**
   * 从书架点开一个项目（2026-11-01）。
   *
   * ⚠ 顺序不能反：先 `pickProject`（它会拉文件树、切 currentProject），
   *   再 `setView('editor')`。反过来的话编辑器会先渲染一帧"空项目"，
   *   文件树闪一下才填上。
   */
  const openProjectFromShelf = useCallback(async (id) => {
    await pickProject(id);
    /**
     * ⚠⚠ 2026-11-05：从书架进来必须**清空当前对话**，欢迎页才有机会出现。
     *   拉对话列表的 effect 只在 projectId 变化时跑，而用户点开的往往正好是
     *   config.currentProject（同一个 id）→ effect 根本不重跑，
     *   上次残留的 convId / messages 会直接把空状态顶掉，三个按钮永远看不见。
     *   自增 convSeq 是为了丢掉可能在途的 conv:messages 回包。
     */
    convSeq.current += 1;
    setConvId(null);
    setMessages([]);
    setStreamingText('');
    setStreamingThink('');
    setToolCalls([]);
    setToolsCollapsed(false);
    setFocusDir(null);
    setView('editor');
  }, [pickProject]);

  /**
   * 重新拉一次项目列表（书架封面改了之后要它）。
   *
   * ⚠ 必须**重拉**而不是改本地数组里那一条：`cover_path` 是主进程写的，
   *   前端手上那份还是旧的。改封面后书架毫无变化，用户会以为没生效。
   */
  const refreshProjects = useCallback(async () => {
    try {
      const ps = await window.api.project.list();
      setProjects(ps || []);
    } catch (e) {
      showToast && showToast(`刷新书架失败：${e.message || e}`);
    }
  }, [showToast]);

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
    /**
     * ⚠ 兜底值跟着主进程的默认一起改成 medium（2026-11-07）。
     *   两处不一致的话，config 还没加载完的那一帧会显示「关闭」，
     *   用户以为思考被关了，点半天没反应。
     */
    const want = stored || (config && config.thinkLevel) || 'medium';
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
            welcomeMode={welcomeMode}
            onWelcomeAction={welcomeAction}
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
            toolsCollapsed={toolsCollapsed}
            onExpandTools={() => setToolsCollapsed(false)}
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
        className="flex items-center gap-2 pl-3 h-10 shrink-0"
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
          {/**
            * 品牌图标（2026-11-03 换标）。
            *
            * ⚠ 用的是 `src/assets/logo.svg`，由 `make-icon.js` 生成 ——
            *   和 exe 图标、启动动画是**同一份** SVG，改一处三处一起变。
            *   不要在这里手画，否则换个大小就对不上。
            * ⚠ 原来是「写」字的色块：那个只是"占位图标"，不是品牌。
            */}
          <img
            src={brandLogo}
            alt=""
            aria-hidden="true"
            style={{ width: 20, height: 20, borderRadius: 5, display: 'block' }}
          />
          <span className="font-semibold text-[14px] tracking-wide"
                style={{ color: 'var(--ink)' }}>
            长卷
          </span>
        </div>

        {/**
          * 「回书架」（2026-11-01）。
          *
          * ⚠ 只在编辑器里出现 —— 书架上看不到它，因为已经在书架上了。
          * ⚠ 必须显式 `-webkit-app-region: no-drag`：顶栏整条是拖拽区，
          *   app-region 是继承的，漏标的话按钮按不动（表现为"点了没反应"）。
          */}
        {/**
          * ⚠⚠ 加 `!showSettings`（2026-11-07）：设置页是**盖在上面**的一层，
          *   底下的 view 状态照样能改 —— 点了这个箭头它会把底下的视图换成书架，
          *   而设置页还压着，用户看到的是"按了完全没反应"。
          */}
        {view === 'editor' && !showSettings && (
          <button
            onClick={() => setView('shelf')}
            className="ml-1 w-6 h-6 flex items-center justify-center rounded-md"
            style={{
              /**
               * 「回书架」2026-11-02 改成**纯箭头 + 底色**（羽毛菌：「简化成一个
               * 箭头按钮，带底色就行」）。
               * ⚠ 原来是没有底色的描边按钮 + "← 书架"两个字，在一排图标里很扎眼。
               */
              backgroundColor: 'var(--paper-2)',
              color: 'var(--ink-soft)',
              WebkitAppRegion: 'no-drag',
            }}
            title="回到书架（选另一本）"
            data-testid="back-to-shelf"
          >
            <Icon name="arrowLeft" size={14} />
          </button>
        )}

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

        {/* ⚠ 三条都是**编辑器**的状态（保存提示 / 正在做什么 / 正文有改动）。
            设置页盖着时它们说的是底下那层的事，摆在这儿只会让人以为设置没生效。 */}
        {!showSettings && toast && <span className="text-[11px] mr-1" style={{ color: 'var(--accent)' }}>{toast}</span>}
        {!showSettings && status && <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>{status}</span>}
        {!showSettings && dirty && <span className="text-[11px]" style={{ color: 'var(--accent)' }}>● 未保存</span>}

        {/* ---------- 卡片开关：收起左边两栏 ----------
            放在最右而不是紧跟快捷工具，是为了让 flex-1 把它们推到窗边。
            ⚠ 状态文字（toast/status/未保存）在它们**左边**：
               这样提示冒出来时按钮不会跟着往左跳一下。 */}
        <div
          className="flex items-center gap-1 ml-2 pl-2 shrink-0"
          style={{
            borderLeft: '1px solid var(--line)',
            WebkitAppRegion: 'no-drag',
            /**
             * 设置页打开时整组功能按钮藏起来（2026-11-07）。
             *
             * 羽毛菌截图里圈了这一整块：教程 / ⇄ 传文件 / 月亮 / 栏开关。
             * 它们在设置页上全是死的 —— 设置页不显示对话、不显示正文，
             * 点"教程"弹出来盖在设置页上、点"传文件"共享的是后台那个项目，
             * 用户看到的是"按了没反应"。
             * ⚠ 只藏这一组，**窗口三个按钮（最小化/最大化/关闭）必须留着**，
             *   否则进了设置页就关不掉窗口。它们在下一个 div 里，不受影响。
             * ⚠ 连 borderLeft 一起藏：留着就是一条悬空的竖线。
             */
            display: showSettings ? 'none' : undefined,
          }}
        >
          {/**
            * 一键切深浅（2026-11-02）。
            *
            * 位置：分隔线右边第一个 —— 羽毛菌圈的就是这块。放在这里而不是
            * 跟着"栏开关"走，是因为**书架页也要能切**（栏开关只有编辑器里有）。
            *
            * ⚠ 图标用**内联 SVG 线稿**，不用 emoji：旁边三个是彩色 emoji，
            *   再来一个黄月亮会像随手贴上去的；他给的参考图本身就是线稿。
            *   `currentColor` 让它跟着主题走，深色下自动变白。
            * ⚠ 纯图标必须有 title + aria-label，否则就是在猜。
            */}
          <button
            type="button"
            data-testid="theme-toggle"
            onClick={toggleDark}
            aria-label={mode === 'dark' || (mode === 'system' && sysDark) ? '切换到浅色模式' : '切换到深色模式'}
            title={mode === 'dark' || (mode === 'system' && sysDark)
              ? '切到浅色（当前深色）'
              : (mode === 'system' ? '切到深色（当前跟随系统）' : '切到深色（当前浅色）')}
            /**
             * ⚠ 同样改用 `.tb-btn`（2026-11-03）：原来靠 onMouseEnter/Leave
             *   手工改底色，只有"渐变"没有"按下回弹"，和旁边三个栏开关
             *   手感不一致。现在整条顶栏的图标按钮共用一套曲线。
             */
            className="tb-btn w-7 h-7 flex items-center justify-center rounded-lg mr-1"
            style={{ border: 'none', cursor: 'pointer' }}
            data-on="0"
          >
            {mode === 'dark' || (mode === 'system' && sysDark) ? (
              /* 太阳：当前是深色，点一下变浅 */
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4.1" />
                <path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5" />
              </svg>
            ) : (
              /* 月亮：当前是浅色，点一下变深（形状照参考图：内侧带一个缺口的弯月） */
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20.6 14.3A8.7 8.7 0 1 1 9.9 3.6a6.9 6.9 0 0 0 10.7 10.7Z" />
              </svg>
            )}
          </button>

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
            <Btn onClick={() => openSettings()} title="设置"><span className="text-[13px] leading-none">⚙</span></Btn>
          )}
          {/* 教程常驻入口。欢迎页只在空对话时出现，写起来之后也得有个地方能翻回来看。
              ⚠ 底色/字色全交给 .tb-btn，不写 inline style（inline 会压掉 :hover）。 */}
          {view === 'editor' && (
            <button
              type="button"
              data-testid="guide-open"
              className="tb-btn h-7 px-2 rounded-lg text-[12px] shrink-0"
              title="使用教程"
              onClick={() => setShowGuide(true)}
            >
              教程
            </button>
          )}
          {/**
            * 局域网传文件（2026-11-06）。
            *
            * ⚠ 只在编辑器里出现，而且必须有项目 —— 共享的是**当前这本**，
            *   书架上没有"当前项目"，按钮会出现点了报错的尴尬。
            * ⚠ 图标 + 三个字，不写成纯图标：这是个新功能，用户不认识它的图形，
            *   但也不该占一整个按钮的宽度去解释（解释在 title 里）。
            */}
          {view === 'editor' && !!projectId && (
            <button
              type="button"
              data-testid="lan-open"
              className="tb-btn h-7 px-2 rounded-lg text-[12px] shrink-0"
              title="局域网传文件：手机扫码就能收发，文件不经过任何服务器"
              onClick={() => setShowLan(true)}
            >
              ⇄ 传文件
            </button>
          )}
          {/**
            * 栏开关只在**编辑器**里出现（2026-11-01）。
            *
            * ⚠ 书架模式下这两个按钮点什么都没反应 —— 它们控制的是
            *   编辑器那三栏的显隐，书架上没有栏可收。
            *   点不动比不显示更糟：用户会以为软件卡了。
            */}
          {view === 'editor' && CARD_TOGGLES.map((c) => {
            const on = !hiddenPanes.includes(c.pane);
            return (
              <button
                key={c.pane}
                data-card-toggle={c.pane}
                aria-pressed={on}
                onClick={() => togglePane(c.pane)}
                /**
                 * 2026-11-02 苹果风：**只留图标，不留文字**。
                 *
                 * 苹果的工具栏从来不写对话列表这种标签 —— 一堆图标排着，
                 * 把解释放进 tooltip。文字一多，界面立刻变成后台管理系统。
                 *
                 * ⚠ 但**必须有 title**：纯图标没文字，不给 tooltip 就是在猜。
                 * ⚠ 选中态别用 --accent-soft：那个变量会被自定义颜色重算，
                 *   用户把强调色调深后选中态会变成一块深色（实测黑底白字）。
                 *   直接按 accent 算 14% 透明底。
                 */
                /**
                 * ⚠⚠ 底色/字色/过渡**全部交给 `.tb-btn`**（index.css 末尾），
                 *   这里只留 `data-on` 这个开关信号。
                 *
                 *   原来这一坨是 inline style：`transition` 写了但没有 hover 态，
                 *   所以除了开关那一瞬间变色，**什么动画都不会发生**。
                 *   而 inline style 的优先级高于任何选择器，:hover 规则盖不过它，
                 *   想加动画就只能把它搬进 CSS。详见 index.css 那段注释。
                 */
                data-on={on ? '1' : '0'}
                className="tb-btn w-7 h-7 flex items-center justify-center rounded-lg"
                title={on ? `收起${c.label}` : `展开${c.label}`}
              >
                {/* ⚠ 只留 emoji，不配文字 —— 羽毛菌：「这里面本来就有图标，
                    直接把文字去掉不就行了」*/}
                <span className="tb-ico text-[13px] leading-none">{c.icon}</span>
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
          {/**
            * 2026-11-06 第二次改：回到**常规图标按钮**。
            *
            * ⚠ 上一版是 macOS 红绿灯（三个 12px 圆点，悬停才浮符号）。
            *   羽毛菌的原话：「你觉得按钮那么小，还搞得和红绿灯一样好看吗，
            *   正常按钮图标，鼠标悬浮后凸显带 r 角矩形气泡底色不就行了」。
            *   他是对的：12px 圆点认不出功能，还得先悬停才看得见符号。
            * 现在：11px 线性图标（横线 / 方框 / 叉），平时淡，悬停浮出
            *   7px 圆角浅底；关闭键悬停才变红（常驻红底就是之前那块红方块）。
            * ⚠ 图形用内联 SVG 不用字符：`─ □ ✕` 在中文系统里字宽不一，
            *   三个按钮的图标会左右错开半像素。
            * ⚠ 点击热区 34×26，比图标大得多。
            */}
          <div className="win-ctrls">
            {[
              {
                key: 'min', label: '最小化',
                act: () => window.api.win.minimize(),
                ico: <path d="M3 6.2h6" />,
              },
              {
                key: 'max', label: maximized ? '还原' : '最大化',
                act: () => window.api.win.toggleMaximize(),
                ico: maximized
                  ? (
                    <>
                      <rect x="1.8" y="3.4" width="5" height="5" rx="1" />
                      <path d="M4 3.4V2.4a1 1 0 0 1 1-1h4.1a1 1 0 0 1 1 1v4.1a1 1 0 0 1-1 1H8.2" />
                    </>
                  )
                  : <rect x="2.2" y="2.2" width="6.6" height="6.6" rx="1.4" />,
              },
              {
                key: 'close', label: '关闭', danger: true,
                act: () => window.api.win.close(),
                ico: <path d="M2.9 2.9l5.2 5.2M8.1 2.9L2.9 8.1" />,
              },
            ].map((b) => (
              <button
                key={b.key}
                data-win-btn={b.key}
                title={b.label}
                aria-label={b.label}
                onClick={b.act}
                className={'win-ctrl' + (b.danger ? ' win-ctrl-danger' : '')}
              >
                <svg
                  viewBox="0 0 11 11" width="11" height="11" aria-hidden="true"
                  fill="none" stroke="currentColor" strokeWidth="1.15"
                  strokeLinecap="round" strokeLinejoin="round"
                >
                  {b.ico}
                </svg>
              </button>
            ))}
          </div>
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
      {/**
       * ⚠ 2026-11-02：这里必须 `flex flex-col`。原来只有 `flex-1 min-h-0`
       *   —— 那是"作为 flex item 占多少高"，但**自己不是 flex 容器**，
       *   孩子（Bookshelf）写的 `flex-1` 就完全不生效，高度退化成内容高度。
       *   表现：书架底部的统计条贴着卡片，而不是固定在窗口底部。
       */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/**
          * 书架 / 编辑器二选一（2026-11-01）。
          *
          * ⚠ 用条件渲染而不是"盖一层遮罩"：编辑器里有一堆订阅
          *   （文件树、对话、流式输出），藏起来但仍在跑，
          *   切回书架时会继续吃 CPU 和内存。
          */}
        {view === 'shelf' ? (
          <Bookshelf
            projects={projects}
            onCreate={createProjectBy}
            onOpen={openProjectFromShelf}
            onImport={importProjectFolder}
            onToast={showToast}
            /**
             * ⚠ 必须传：书架是首屏，而**没有项目就进不了编辑器**，
             *   编辑器才是唯一有设置入口的地方。不传的话新用户
             *   打开软件连主题都改不了（齿轮按钮是 `{onSettings && …}` 条件渲染）。
             */
            onSettings={() => openSettings()}
            /**
             * 每日目标（2026-11-02）：横幅上"目标 N 字/天"点一下就地改。
             * ⚠ 存 **config** 而不是每个项目：这是"我一天写多少"的个人习惯，
             *   换本书不该重设一遍。config:set 会返回保存后的完整配置，
             *   走 applyConfig 统一入口，和设置页改配置是同一条路。
             */
            dailyGoal={config && config.dailyGoal}
            onSetDailyGoal={async (n) => {
              try {
                const cfg = await window.api.config.set({ dailyGoal: n });
                applyConfig(cfg);
                showToast && showToast(`每日目标已改为 ${n.toLocaleString('zh-CN')} 字`);
              } catch (e) {
                showToast && showToast(`每日目标没存上：${e.message || e}`);
              }
            }}
          />
        ) : (
        <SplitPanes
          appVersion={appVersion}
          hidden={hiddenPanes}
          closing={closingPanes}
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
                  focusDir={focusDir}
                />
              ),
            },
          ]}
        />
        )}
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

      {/* ---------- 生成封面：居中弹窗 ----------
        * 入口在**快捷工具栏**（羽毛菌：「封面功能按钮应该放在快捷工具那一栏」）。
        * 它要能盖在书架和编辑器上面，所以挂在根层，不跟着 view 走。 */}
      {showCover && (
        <CoverModal
          projectId={projectId}
          projectName={currentProject?.name || ''}
          penName={config && config.penName}
          onClose={() => setShowCover(false)}
          onToast={showToast}
          /**
           * 设成封面后要**立刻**刷新书架。
           * ⚠ 只 rely on 重新拉 list 不够：书架拿的是 projects 数组，
           *   里面 cover_path 还是旧的 —— 不刷新的话用户点了"设为封面"，
           *   书架看上去毫无变化，会以为没生效。
           */
          onSaved={() => { refreshProjects(); }}
        />
      )}

      {/**
       * 起名 / 脑洞 / 灵感碎片（2026-11-03）。
       *
       * ⚠ 这三个**不再走 ToolsPanel**：那个面板是"打开一个 md 随便写"的
       *   通用模板，而羽毛菌要的是「先填要素 → 模型出初稿 → 改完存」。
       *   同一个弹窗组件 + 三套配置，差别只在字段和动作。
       */}
      {toolModal && (
        <ToolModal
          mode={toolModal}
          projectId={projectId}
          /** 题材从项目里带过去，别让用户再选一次 */
          genre={(currentProject && currentProject.genre) || ''}
          onClose={() => setToolModal(null)}
          onToast={showToast}
          /** 存完要刷新文件树：新文件得立刻出现在左栏，否则用户以为没存上 */
          onSaved={() => refreshTree()}
        />
      )}

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

      {/* ---------- 使用教程：可随时按按钮关闭的弹窗 ---------- */}
      {showGuide && (
        <GuideModal
          onClose={() => setShowGuide(false)}
          onOpenSettings={openSettings}
        />
      )}

      {/* ---------- 局域网传文件：打开才起服务，关掉就停 ---------- */}
      {showLan && (
        <LanShare
          projectName={(projects || []).find((p) => p.id === projectId)?.name || ''}
          onClose={() => setShowLan(false)}
          onReceived={() => { refreshTree(); }}
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
          /**
           * ⚠ 装完技能/角色卡之后要通知 App 重拉引用源（2026-10-29）。
           *   不通知的话，用户从广场装完技能回到对话，@ 面板里看不到它 ——
           *   必须重启软件才出现，用户会以为"下载了但没装上"。
           */
          onDataChanged={bump}
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
      {/* 拆书：章节勾选（2026-10-28）。
          ⚠ 必须条件渲染 —— 组件本身是一层 fixed 全屏遮罩，
             `book` 为 null 时若还挂着，整个界面会被一层透明遮罩挡住点不动。 */}
      {analyzeBook && (
        <ChapterPicker
          book={analyzeBook}
          onCancel={() => setAnalyzeBook(null)}
          onConfirm={(sel) => {
            setAnalyzeBook(null);
            /**
             * ⚠ 不再发进对话（2026-10-28）：
             *   拆书产出几万字，进历史会拖累后面每一轮，而它只是一次性解析。
             *   改成开独立窗口，结果存成文件，需要时用 @ 引用。
             */
            setAnalyzeJob({
              name: sel.name,
              body: sel.body,
              count: sel.count,
              firstTitle: sel.title,
              mode: sel.mode,
            });
          }}
        />
      )}

      {/* 拆书独立窗口（2026-10-28）：产出不进对话，完成后保存成文件 */}
      {analyzeJob && (
        <BookAnalyzer
          name={analyzeJob.name}
          body={analyzeJob.body}
          count={analyzeJob.count}
          firstTitle={analyzeJob.firstTitle}
          mode={analyzeJob.mode}
          projectId={projectId}
          onClose={() => setAnalyzeJob(null)}
          onToast={showToast}
        />
      )}
      {/* 新版本提示（2026-10-29）：浮在顶部中央，不占布局、不挡操作区，
          关掉后本次启动不再出现。⚠ 没有自动更新——exe 没签名，下来也装不上。 */}
      {updateInfo && (
        <div
          className="fixed left-1/2 -translate-x-1/2 top-2 z-50 flex items-center gap-3 px-4 py-2 rounded-lg"
          style={{
            background: 'var(--paper)',
            border: '1px solid var(--line)',
            boxShadow: '0 8px 24px -6px rgba(0,0,0,.35)',
          }}
        >
          <span className="text-[12px]" style={{ color: 'var(--ink)' }}>
            新版本 <b>v{updateInfo.latest}</b> 已发布
            <span className="ml-1" style={{ color: 'var(--ink-soft)' }}>
              （当前 v{updateInfo.current}）
            </span>
          </span>
          <button
            onClick={() => window.api.app.openExternal(updateInfo.url)}
            className="px-2.5 py-1 rounded text-[12px]"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            去下载
          </button>
          <button
            onClick={() => {
              sessionStorage.setItem('updateDismissed', '1');
              setUpdateInfo(null);
            }}
            className="text-[15px] leading-none px-1"
            style={{ color: 'var(--ink-soft)' }}
            title="本次启动不再提示"
          >
            ×
          </button>
        </div>
      )}
      {/* 同步维护文档的询问（2026-10-29）。
          写完章节后问一句，用户点头才动摘要/人物库/世界观 ——
          那三样是长期资料，模型改错了用户不一定会发现。 */}
      {/**
        * 「同步维护文档」询问（2026-10-30 改位置）。
        *
        * ⚠ 原来贴在 `bottom-4`，正好压住输入框上方 ——
        * 用户的原话：「这个更新维护文档的弹窗怎么在最底下，不方便看啊」。
        * 回答区是纵向滚动的，用户视线多半停在**刚写完的那段正文**上，
        * 弹窗出现在窗口最底下等于在他视野之外，很容易漏掉。
        *
        * 改成屏幕中央 + 半透明遮罩：出现时视线一定被拉过去，
        * 而且它本来就是个"要不要继续"的决策点，值得打断一下。
        * ⚠ 点遮罩可以关掉（等同「暂不更新」），不强迫用户只在两个按钮里选。
        */}
      {syncAsk && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,.38)' }}
          onClick={() => setSyncAsk(null)}
        >
          <div
            className="rounded-xl px-5 py-4"
            style={{
              background: 'var(--paper)',
              border: '1px solid var(--line)',
              boxShadow: '0 20px 50px -12px rgba(0,0,0,.5)',
              maxWidth: 540,
              width: '100%',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[13px] mb-2" style={{ color: 'var(--ink)' }}>
              <b>{syncAsk.paths.join('、')}</b> 已保存。
              <span style={{ color: 'var(--ink-soft)' }}>要同步更新维护文档吗？</span>
            </div>
            <div className="text-[11.5px] mb-3" style={{ color: 'var(--ink-soft)' }}>
              章节摘要 / 人物库 / 世界观 —— 只改确实需要改的地方，不动其他段落。
            </div>
            <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const paths = syncAsk.paths.join('、');
                setSyncAsk(null);
                send(
                  `刚写完 ${paths}。请同步更新维护文档：\n`
                  + '· 章节/章节摘要.md —— 追加本章摘要（150 字以内，按已有格式）\n'
                  + '· 设定/人物库.md —— **只在出现新角色、或已有角色有实质变化时**才改\n'
                  + '· 设定/世界观.md —— **只在出现新设定时**才改\n\n'
                  + '⚠ 只改确实需要改的地方，**不要顺手润色其他段落**，也不要重写整个文件。\n'
                  + '改之前先读一遍现有内容，按它的格式来。'
                );
              }}
              className="px-3 py-1.5 rounded text-[12px]"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              更新维护文档
            </button>
            <button
              onClick={() => setSyncAsk(null)}
              className="px-3 py-1.5 rounded text-[12px]"
              style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
            >
              暂不更新
            </button>
          </div>
          </div>
        </div>
      )}
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