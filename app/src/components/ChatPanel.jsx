import { useEffect, useMemo, useRef, useState } from 'react';
import CtxMeter from './CtxMeter.jsx';

/**
 * 用了但没 import 的 hook **只有真渲染才炸**（打包不报错、语法合法）。
 * 2026-10-15：加了 useMemo 做工具栏溢出计算却忘了 import ——
 * `useMemo is not defined`，整个界面白屏。
 * 判据 `test-ui-wiring.js` 里有一条专盯这个。
 */
import {
  LEVEL_LABEL, LEVEL_HINT, LEVEL_ICON,
  DEFAULT_LEVEL, DEFAULT_LABEL, DEFAULT_HINT,
} from '../think-levels.js';
import { ToolCallList } from './ToolCards.jsx';

/**
 * 对话面板 —— 主交互区。
 *
 * 布局分三段（对应需求里的「中间上面聊天框、下面打字对话框」）：
 *   上：消息流（可滚动，只读）
 *   下：输入区（可输入光标）+ 工具条 + 发送按钮
 *
 * ## 为什么把编辑器从主位挪走
 *
 * 原来三栏是「章节树 | 编辑器 | 设置」，本质是以文档为中心。
 * 改成对话优先后，**对话是主位，编辑器变成右侧文件框里的一个视图**——
 * 因为写作时的动作是「聊 → 生成 → 落到某个章节」，
 * 而不是「打开章节 → 编辑 → 保存」。
 *
 * ## 引用（@技能 / @文件）
 *
 * 引用的内容**不进消息正文**，而是单独存到 `refs` 里，
 * 发送时拼到 prompt 的【本次引用】段落。
 * 这样消息记录里看到的是用户真正写的话，
 * 不会被一大段设定原文淹没——历史回看时能看清在聊什么。
 *
 * ## 思考强度为什么在输入框旁边
 *
 * 它不是"设置"，是**每一轮的参数**：改错别字要「关」（快且省），
 * 搭世界观框架要「高」（想得深）。同一个对话里这两件事会交替发生，
 * 所以它必须能随手改，而不是藏在设置页里翻三层。
 *
 * 档位跟着**对话**记住（conversations.think_level）：
 * 一个对话通常就是一个任务，切对话时档位跟着变才符合直觉。
 * 可用档位由当前连接的服务商量表决定（见 src/think-levels.js）。
 */
/**
 * 一条消息下面的操作条：复制 / 删除 / 撤回。
 *
 * ## 为什么要「撤回」和「删除」两个
 *
 * 删掉一条 user 消息却留下模型那段回答，历史会变成「问了没答」，
 * 下一轮模型会把上一条 assistant 当成自己的上一段接着写 ——
 * 那种脏历史比留一条孤儿消息更难解释。所以：
 *   删除 = 删这一条（连带成对的那条回答）
 *   撤回 = 从这条起后面全清，回到能重新提问的状态
 *
 * ⚠ 撤回只给 user 消息：对 assistant 来说「从这条起全清」等于
 *   把整段历史删掉，代价和收益不成比例。
 *
 * ## ⚠⚠ 为什么不用 window.confirm
 *
 * 它在渲染进程里是**同步阻塞**的：调用那一刻整个窗口冻结，
 * 定时器、动画、生成中的流式全部停住。开发时被它卡死过一轮
 * （判据脚本点了删除就再也没输出）。
 * 而且样式是系统原生的，跟整个界面不像一回事。
 *
 */

/**
 * 操作条用的三个图标。
 *
 * ## 为什么是内联 SVG，而不是 emoji 或字符
 *
 * emoji（📋 ↶ 🗑）在 Windows 上会渲染成**彩色字形**，颜色不受主题控制 ——
 * 而正文是跟随主题变的，结果就是三个彩色小图钉在一片灰里，像贴纸。
 * 几何字符（⧉ ↶）颜色是对的，但**没有垃圾桶**能用的，缺一个就得拿别的凑。
 *
 * 内联 SVG 只用 `stroke="currentColor"`：跟随文字颜色，hover 变蓝、删除变红
 * 都自动成立，也不依赖字体、不怕某个系统缺字。
 * （同一条规矩在顶栏的思考强度图标上也用过，见 think-levels.js 的 LEVEL_ICON。）
 */
const SvgIcon = ({ d, size = 14 }) => (
  <svg
    width={size} height={size} viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
  >
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
);

const ICON_COPY = ['M5.6 5.6V3.4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2.2', 'M10.4 6.6h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1z'];
// 撤回 = 逆时针弧形箭头：从左下绕回左上
const ICON_UNDO = ['M2.8 8.2a5.2 5.2 0 1 1 1.7 3.7', 'M2.6 4.4v3.9h3.9'];
// 删除 = 垃圾桶（盖 + 桶身 + 两道竖线）
const ICON_TRASH = ['M2.8 4.3h10.4', 'M6.4 4.3V2.9a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.4', 'M4.2 4.3l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2', 'M6.6 6.8v4M9.4 6.8v4'];
const ICON_CHECK = ['M3.2 8.4l3.1 3.1 6.5-6.7'];

/**
 * 一条消息下面的操作条：复制 / 删除 / 撤回。
 *
 * ## 为什么要「撤回」和「删除」两个
 *
 * 删掉一条 user 消息却留下模型那段回答，历史会变成「问了没答」，
 * 下一轮模型会把上一条 assistant 当成自己的上一段接着写 ——
 * 那种脏历史比留一条孤儿消息更难解释。所以：
 *   删除 = 删这一条（连带成对的那条回答）
 *   撤回 = 从这条起后面全清，回到能重新提问的状态
 *
 * ⚠ 撤回只给 user 消息：对 assistant 来说「从这条起全清」等于
 *   把整段历史删掉，代价和收益不成比例。
 *
 * ## 二次确认为什么用「图标变感叹号」而不是弹窗
 *
 * ⚠⚠ `window.confirm` 在渲染进程里是**同步阻塞**的：调用那一刻
 *   整个窗口冻结 —— 定时器、动画、生成中的流式全部停住。
 *   开发时被它卡死过一轮（判据脚本点了删除就再没输出）。
 *
 * 所以做成两段式：第一次点图标变成叹号（并且变红），
 * 3 秒内再点才真删。误点最多多按一下，不冻结任何东西。
 * 悬停提示也跟着变，用户知道现在这一下是真删。
 */
const CONFIRM_MS = 3000;

function MessageActions({ m, canUndo, onAction }) {
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState(null);   // null | 'remove' | 'undo'
  const armTimer = useRef(null);

  useEffect(() => () => clearTimeout(armTimer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(m.content || ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (_) {
      // 剪贴板不可用（权限/非安全上下文）时如实说，不要假装复制了
      setCopied(false);
    }
  };

  const run = (kind) => {
    if (armed === kind) {
      clearTimeout(armTimer.current);
      setArmed(null);
      onAction(kind, m);
      return;
    }
    setArmed(kind);
    clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmed(null), CONFIRM_MS);
  };

  return (
    <div className="msg-acts">
      <button
        onClick={copy} data-label={copied ? '已复制' : '复制'}
        className={copied ? 'ok' : ''}
      >
        {copied ? <SvgIcon d={ICON_CHECK} /> : <SvgIcon d={ICON_COPY} />}
      </button>
      {canUndo && (
        <button
          onClick={() => run('undo')}
          data-label={armed === 'undo' ? '再点一次，确认撤回这一轮' : '撤回这一轮，重新提问'}
          className={armed === 'undo' ? 'armed' : ''}
        >
          <SvgIcon d={armed === 'undo' ? ICON_CHECK : ICON_UNDO} />
        </button>
      )}
      <button
        onClick={() => run('remove')}
        data-label={armed === 'remove' ? '再点一次，确认删除' : '删除这一条'}
        className={`danger ${armed === 'remove' ? 'armed' : ''}`}
      >
        <SvgIcon d={armed === 'remove' ? ICON_CHECK : ICON_TRASH} />
      </button>
    </div>
  );
}

export default function ChatPanel({
  conversation,
  messages,
  streamingText,
  /**
   * 思考内容（模型的内部推理）。
   *
   * ⚠ 它只用于显示，**绝不进消息气泡、不进对话历史**——
   *   否则用户回看聊天记录会看到"嗯，用户让我写…"这类内容。
   */
  streamingThink = '',
  generating,
  /** 聊天字号（px）。来自 config.chatFontSize，默认 16 */
  fontSize,
  /** 聊天字体 CSS family。来自 config.chatFont，默认 system-ui */
  fontFamily,
  error,
  skills,
  settings,
  chapters,
  /** 项目文件夹里的文件（App 从 fs:tree 压平后传入） */
  filePaths = [],
  onSend,
  onStop,
  onRetry,
  styleResult,
  /**
   * 思考强度。
   *
   * `thinkLevels` 为 null 表示这家服务商没有档位概念（model-only 或没接量表），
   * 那时**不渲染控件** —— 给一个点了没用的按钮比不给更糟。
   */
  thinkLevel = 'off',
  thinkLevels = null,
  onThinkLevel,
  /** 有没有小说项目。零项目时引导语要换一套（见下面空状态那段）。 */
  hasProject = true,
  /**
   * 本轮生成里的工具调用（终端 / 联网搜索 / 读网页）。
   *
   * ⚠ 只在生成中显示，生成结束就清空。
   *   它们是「这一轮的过程」，不是对话记录的一部分——
   *   落库的只有助手正文，工具卡片刷新页面后就没了。
   *   要留痕的话得单独存表，那是另一件事，不在这里偷偷做。
   */
  toolCalls = [],
  /**
   * 这一轮放不放行工具。
   *
   * ⚠ 与设置页那个总开关是**两件事**：
   *   总开关是"我同不同意这个软件有能力碰我的电脑"（长期、默认关），
   *   这两个 chip 是"这一轮让不让它用"（逐轮、默认跟着总开关）。
   *   合成一个开关的话，用户要么永远开着（不安全），
   *   要么每次想用都得进设置页翻一遍（等于没有）。
   *
   * @type {{enabled: boolean, groups: string[], onToggle: (g:string)=>void, onBlocked: ()=>void}}
   */
  toolGate = null,
  bottomSlot,
  /** 联网可用性判定（缺哪几层）+ 缺配置时把用户送到设置页 */
  webReady = null,
  onOpenSettings = null,
  /** 消息上的操作（复制/删除/撤回）。不传就不渲染操作条。 */
  onMessageAction = null,
  /**
   * 快捷工具栏（备忘录 / 起名 / 脑洞 / 灵感碎片 / 文风蒸馏）。
   *
   * ⚠ 2026-10-15 从**顶栏**移到**这里**（对话列顶部）：
   *   羽毛菌标了「移到这里」。这几个都是写作辅助，跟着对话场景走更合理；
   *   而顶栏原本被菜单栏 + 工具栏占掉三行，纵向空间很挤。
   */
  quickTools = [],
  onQuickTool = null,
  activeTool = null,
  toolsOpen = false,
  /**
   * 范围守卫把模型连接关掉了（与小说创作无关的请求被拦下）。
   *
   * ⚠ 关掉的是**模型**，不是这个软件：输入框要禁掉、发送键要禁掉
   *   （羽毛菌：「无法发出文字」），但界面其他部分照常能用，
   *   而且要给出**重新启用**的按钮 —— 没有这条路，一次误报就等于软件坏了。
   */
  scopeLocked = false,
  onUnlockModel = null,
  /** 上次被拦下来的说明（显示在输入框上方，让用户知道为什么发不出去） */
  scopeNotice = '',
  /** 行为审计是否把对话暂停了（2026-10-18，第三道防线） */
  auditPaused = false,
  /** 点「继续使用」：解除暂停 */
  onAuditResume,
}) {
  const [text, setText] = useState('');
  const [refs, setRefs] = useState([]);          // 引用的 skill / file
  const [picker, setPicker] = useState(null);     // 'skill' | 'file' | null
  const flowRef = useRef(null);
  const taRef = useRef(null);

  // 换对话时清空输入与引用——旧对话的引用对新对话无意义
  useEffect(() => {
    setText('');
    setRefs([]);
    setPicker(null);
  }, [conversation?.id]);

  // 新消息或流式输出时滚到底。
  // ⚠ toolCalls.length 也要进依赖：模型查完资料开始写正文时，
  //   卡片会从 1 张变成 2 张，不跟着滚的话用户会以为程序停了。
  useEffect(() => {
    const el = flowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, streamingText, generating, toolCalls.length]);

  // 快捷键：Enter 发送，Shift+Enter 换行
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const submit = () => {
    const t = text.trim();
    // ⚠ 锁住时连回车都不许发（主进程也拦，这里是让界面别装作能发）
    if (scopeLocked) return;
    if ((!t && refs.length === 0) || generating) return;
    onSend(t, refs);
    setText('');
    setRefs([]);
    setPicker(null);
  };

  const toggleRef = (kind, item) => {
    setRefs((prev) => {
      const key = `${kind}:${item.id}`;
      const hit = prev.find((r) => r.key === key);
      if (hit) return prev.filter((r) => r.key !== key);
      return [...prev, { key, kind, id: item.id, name: item.name, content: item.content || '' }];
    });
  };

  const hasRef = (kind, id) => refs.some((r) => r.key === `${kind}:${id}`);

  /** 溢出菜单（工具栏放不下时出现的三点） */
  const [showMoreTools, setShowMoreTools] = useState(false);

  /**
   * 算出「哪些工具放不下」。
   *
   * ## 为什么不能靠 CSS 溢出就完事
   *
   * 原来是 `overflow-x-auto` —— 挤不下的直接**看不见**，
   * 而用户不知道它们存在（羽毛菌：「当对话框卡片被压缩时，
   * 无法显示的工具应该变成三个点，单击三个点弹出一个列表」）。
   *
   * ⚠ 必须**显式测量**：量容器可用宽度，再按各按钮宽度做前缀和，
   *   超出的就是被挤走的。CSS 溢出会让它们"能滚到"，
   *   但用户不会想到要横向滚 —— 而"看不见"与"要滚一下才看见"是两回事。
   *
   * ⚠ 用 ResizeObserver 而不是 window.resize ——
   *   中栏宽度不由窗口决定（左右栏各自可折叠，拖分割线也会变）。
   */
  const toolsBarRef = useRef(null);
  const [toolsBarRect, setToolsBarRect] = useState(null);
  // ⚠ 菜单要相对**三点按钮自己**定位（羽毛菌：「要相对那三个点做菜单列表」），
  //   所以单独给它一个 ref —— 工具栏右端不等于三点所在位置。
  const dotsRef = useRef(null);
  const [dotsRect, setDotsRect] = useState(null);
  const [avail, setAvail] = useState(0);
  // ⚠ 存**字符串**而不是数组：数组每次都是新引用，setState 必定触发重渲染，
  //   而量宽度的 effect 依赖里又带 avail → 重新量 → 再 set → **死循环**。
  //   症状就是「对话内容一直在跳，闪得厉害」（2026-10-15 用户现场）。
  const [btnW, setBtnW] = useState('');

  useEffect(() => {
    const el = toolsBarRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      // ⚠ 减掉 padding（左右各 12px）与三点按钮的预留
      const w = Math.max(0, entries[0].contentRect.width - 24 - 34);
      setAvail((prev) => (Math.abs(prev - w) < 1 ? prev : w));   // ⚠ 值变了才 set
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 量每个按钮宽度（按钮都在 DOM 里，只是有的被 hiddenTools 收走了）
  useEffect(() => {
    if (!toolsBarRef.current || !quickTools.length) return undefined;
    const id = setTimeout(() => {
      const kids = toolsBarRef.current.querySelectorAll('[data-qt]');
      const next = [...kids].map((k) => Math.ceil(k.getBoundingClientRect().width) + 4).join(',');
      setBtnW((prev) => (prev === next ? prev : next));   // ⚠ 同上：没变就不 set
      setToolsBarRect(toolsBarRef.current.getBoundingClientRect());
    }, 0);
    return () => clearTimeout(id);
  }, [quickTools.length]);

  const hiddenTools = useMemo(() => {
    if (!avail || !btnW) return [];
    const widths = btnW.split(',').map(Number);
    if (widths.length !== quickTools.length) return [];
    let used = 0;
    let cut = quickTools.length;
    for (let i = 0; i < quickTools.length; i++) {
      if (used + widths[i] > avail) { cut = i; break; }
      used += widths[i];
    }
    // ⚠ 至少留一个在明面上 —— 全收进三点会让工具栏看着像坏了
    return cut >= quickTools.length ? [] : quickTools.slice(Math.min(cut, quickTools.length - 1));
  }, [avail, btnW, quickTools]);

  const visibleTools = useMemo(
    () => quickTools.slice(0, quickTools.length - hiddenTools.length),
    [quickTools, hiddenTools],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">

      {/* ---------- 上：消息流 ---------- */}
      {/* 快捷工具栏：从顶栏搬过来的（2026-10-15） */}
      {quickTools.length > 0 && (
        <div
          ref={toolsBarRef}
          /* ⚠⚠ 高度写死 h-8，与左边「对话列表」标题行一致（2026-10-16 20:04
             羽毛菌：「下面那一条分隔线有高低差，我想把它连起来到同一水平」）。
             ⚠ 原来靠 12px 文字行 + py-1.5 撑高，而对面是 15px SVG + py-1.5，
             差出来几 px —— 分隔线因此不在同一水平。写死高度 + items-center 解决。*/
          className="quick-tools shrink-0 px-3 h-8 flex items-center gap-1"
          data-testid="rail-head-main"
          style={{ borderBottom: '1px solid var(--line)', background: 'var(--paper)' }}
        >
          {visibleTools.map((t) => {
            const on = toolsOpen && activeTool === t.key;
            return (
              <button
                key={t.key}
                data-qt={t.key}
                onClick={() => onQuickTool && onQuickTool(t)}
                className="px-2 py-1 rounded text-[12px] whitespace-nowrap shrink-0"
                style={{
                  background: on ? 'var(--accent-soft)' : 'transparent',
                  color: on ? 'var(--ink)' : 'var(--ink-soft)',
                }}
                title={t.hint}
              >
                {t.icon} {t.label}
              </button>
            );
          })}
          {/* ⚠ 放不下的**不隐藏**，收进三点里（2026-10-15 羽毛菌：
              「当对话框卡片被压缩时，无法显示的工具应该变成三个点，
                单击三个点弹出一个列表可以选择无法显示的工具」）。
              原来是 `overflow-x-auto` —— 挤不下的直接**看不见**，
              而用户不知道它们存在。 */}
          {hiddenTools.length > 0 && (
            <button
              ref={dotsRef}
              onClick={() => {
                // ⚠ 点开时立刻量它自己的位置 —— 菜单就贴着它定位。
                //   不量的话要等 ResizeObserver 回调，时机上晚一拍。
                setDotsRect(dotsRef.current ? dotsRef.current.getBoundingClientRect() : null);
                setShowMoreTools((v) => !v);
              }}
              className="px-2 py-1 rounded text-[12px] shrink-0"
              style={{ color: 'var(--ink-soft)' }}
              title={`还有 ${hiddenTools.length} 个工具：${hiddenTools.map((t) => t.label).join('、')}`}
            >
              ⋯
            </button>
          )}
        </div>
      )}
      {/* 三点菜单：列出被挤出可见区的工具 */}
      {showMoreTools && hiddenTools.length > 0 && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMoreTools(false)} />
          <div
            className="tools-menu fixed z-50 rounded overflow-hidden"
            style={{
              top: dotsRect ? Math.round(dotsRect.bottom + 4) : 40,
              // ⚠ 左边缘对齐**三点按钮自己**，不是工具栏右端
              //   （羽毛菌：「要相对那三个点做菜单列表」）。
              //   原来用 `toolsBarRect.right - 150` 是拿工具栏右端倒推的，
              //   而三点并不在右端 —— 菜单于是伸到窗口右边去了。
              // ⚠ 而且菜单比按钮宽，右对齐式地贴着三点会**伸出中栏**、压到右边的文件框
              //   （用户截图里就是这样）。所以再钳一道窗口右缘。
              left: dotsRect
                ? Math.max(8, Math.round(
                  Math.min(dotsRect.left, (window.innerWidth || 1200) - 172)))
                : 24,
              minWidth: 150,
              background: 'var(--paper)',
              border: '1px solid var(--line)',
              boxShadow: '0 6px 20px rgba(0,0,0,.14)',
            }}
          >
            {hiddenTools.map((t) => (
              <button
                key={t.key}
                onClick={() => { setShowMoreTools(false); onQuickTool && onQuickTool(t); }}
                className="w-full text-left px-3 py-1.5 text-[12.5px] flex items-center gap-2"
                style={{ color: 'var(--ink)' }}
                title={t.hint}
              >
                <span>{t.icon}</span>
                <span className="truncate">{t.label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div ref={flowRef} className="chat-surface flex-1 overflow-y-auto overflow-x-hidden px-5 py-4">
        {!messages?.length && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-sm">
              {/* ⚠ 零项目时不能说「开始一个新对话」——
                  对话挂在项目下，这会儿连输入框都发不出去。
                  空状态是用户第一次见到这个界面时**唯一**会读的文字，
                  它必须说清"下一步点哪"。 */}
              <div className="text-[15px] mb-2" style={{ color: 'var(--ink)' }}>
                {hasProject ? '开始一个新对话' : '先建一个小说项目'}
              </div>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
                {hasProject ? (
                  <>
                    左边是对话列表，右边是章节与设定。<br />
                    输入框旁的「技能」「文件」可以把写作要求与设定直接带进这一轮。
                  </>
                ) : (
                  <>
                    对话、章节、设定都挂在项目下，所以得先有项目。<br />
                    点左上角第 1 栏的「＋ 新建项目」，或右下角第 4 栏的「（未选项目）」。
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="max-w-5xl mx-auto space-y-3">
          {messages?.map((m) => (
            /**
             * ⚠⚠ 结构：头像+气泡 是一行，**操作条在下一行**（2026-10-15 羽毛菌：
             *   「这个复制删除的按钮应该对话文字框的下方而不是侧方，
             *     work buddy 也是在下方啊」）。
             *
             * 之前是三个元素横排（头像 / 气泡 / 操作条），
             * 操作条挤在气泡**侧面**，短消息时那一段空白特别难看。
             *
             * ⚠ 拆成 `.msg-head` 是为了让 CSS 只需要管两件事：
             *   这一行左右排（用户右对齐 / 模型左对齐），操作条单独占一行。
             */
            <div key={m.id} className={`msg-row ${m.role === 'user' ? 'is-user' : 'is-ai'}`}>
              <div className="msg-head">
                {/* 头像：跟 workbuddy 一样，一眼分清谁在说话 */}
                <div className={`msg-avatar ${m.role === 'user' ? 'user' : 'ai'}`}
                  title={m.role === 'user' ? '你' : '模型'}>
                  {m.role === 'user' ? '我' : 'AI'}
                </div>
                <div
                  className={m.role === 'user' ? 'msg-user' : 'msg-ai'}
                  style={{ fontSize: `${fontSize || 16}px`, fontFamily: fontFamily || 'system-ui' }}
                >
                  {m.content}
                </div>
              </div>
              {onMessageAction && (
                <MessageActions
                  m={m}
                  canUndo={m.role === 'user'}
                  onAction={onMessageAction}
                />
              )}
            </div>
          ))}

          {/* ---------- 工具调用：贴在正文之前 ---------- */}
          {toolCalls.length > 0 && (
            <div className="space-y-1.5">
              {toolCalls.some((t) => t.status === 'running') && (
                <div className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                  正在用工具…（{toolCalls.filter((t) => t.status === 'running').length} 项进行中）
                </div>
              )}
              <ToolCallList items={toolCalls} />
            </div>
          )}

          {/* 流式中的回答：内容追加到最后一条，避免屏幕跳两次 */}
          {generating && (
            <div className="flex">
              <div className="flex-1 min-w-0">
                {/* 思考过程：独立一块，灰色斜体，可折叠。
                    正文还没开始时先显示它，让用户知道模型在动。 */}
                {streamingThink && (
                  <details
                    className="mb-2 text-[12px]"
                    open={!streamingText}
                    style={{ color: 'var(--ink-soft)' }}
                  >
                    <summary
                      className="cursor-pointer select-none"
                      style={{ fontSize: 11, opacity: 0.8 }}
                    >
                      正在思考（{streamingThink.length} 字）
                    </summary>
                    <div
                      className="mt-1 pl-2.5"
                      style={{
                        borderLeft: '2px solid var(--line)',
                        fontStyle: 'italic',
                        lineHeight: 1.7,
                        maxHeight: 160,
                        overflowY: 'auto',
                        whiteSpace: 'pre-wrap',
                        opacity: 0.75,
                      }}
                    >
                      {streamingThink}
                    </div>
                  </details>
                )}
                {/* 正文气泡：**只有真的有正文才渲染**。
                    ⚠ 2026-10-15 修。原来写的是
                        {streamingText || (streamingThink ? '' : '…')}
                      有思考、正文还没开始时落到空字符串 —— 于是聊天区
                      出现一个什么字都没有的圆角框，而且会一直挂在那儿。
                      羽毛菌第一眼就问"这么大一个框是干什么"。
                      上面那块思考区已经说明"模型在动"，不需要再占一个
                      空气泡；真正一个字都还没来时才显示省略号。 */}
                {streamingText ? (
                  <div
                    className="msg-ai streaming"
                    style={{ fontSize: `${fontSize || 16}px`, fontFamily: fontFamily || 'system-ui' }}
                  >{streamingText}</div>
                ) : (!streamingThink ? (
                  <div
                    className="msg-ai streaming"
                    style={{ fontSize: `${fontSize || 16}px`, fontFamily: fontFamily || 'system-ui' }}
                  >…</div>
                ) : null)}
              </div>
            </div>
          )}

          {/**
           * 范围守卫的说明：**贴在消息流末尾**，不在输入框上方。
           *
           * ⚠⚠ 2026-10-16 羽毛菌：「能不能把这个条隐藏」（截图上圈的是输入框正上方）。
           *
           * 量过才知道它是什么：`diag-composer-bar.js` 从输入框卡片往上爬三层，
           * 兄弟节点里只有一个 `data-testid="scope-banner"`、高 57px、带完整文字。
           * 它长驻的原因是 `scopeNotice` 一旦被设置就没有清空路径 ——
           * 所以用户点过一次"你用什么模型"之后，这条就一直压在输入框上。
           *
           * 为什么不干脆删掉：锁住的时候必须有常驻的恢复入口
           * （横条 + 「重新启用」），否则一次误报就等于软件坏了。
           * 所以分成两处：
           *   · **没锁**：只是"这条没发出去"的说明，属于**对话内容**，
           *     该待在消息流末尾 —— 跟最后一句话读在一起，不压着输入框。
           *   · **锁了**：必须是常驻红条 + 恢复入口，留在原来的位置（输入框上方），
           *     因为那时整个输入框是禁用的，那儿才是它该被看见的地方。
           */}
          {scopeNotice && !scopeLocked && (
            <div
              data-testid="scope-notice"
              className="mt-3 rounded-lg px-3 py-2 text-[12px] leading-relaxed"
              style={{
                background: 'var(--accent-soft)',
                color: 'var(--ink)',
                border: '1px solid var(--line)',
              }}
            >
              {scopeNotice}
              {/*
                行为审计暂停后的**明路**（2026-10-18）。
                ⚠ 这个按钮不是"给个台阶"，是必需品：暂停判据是
                  "短问短答 + 零产出"，它一定会误伤连着两轮问人物动机的用户。
                  没有它，被误判的人只能重启软件。
              */}
              {auditPaused && (
                <button
                  onClick={onAuditResume}
                  className="mt-2 text-[11px] px-2.5 py-1 rounded"
                  style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                >
                  继续使用（刚才是在构思/讨论）
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 文风检测结论：贴着消息流下方，不打断阅读 */}
      {styleResult && !generating && (
        <div className="px-5 pb-1 shrink-0">
          <div className="max-w-5xl mx-auto">
            <StyleNote r={styleResult} />
          </div>
        </div>
      )}

      {error && (
        <div className="px-5 py-2 shrink-0">
          <div className="max-w-5xl mx-auto flex items-start gap-2 text-[12px] px-3 py-2 rounded"
               style={{ color: 'var(--danger)', background: 'var(--accent-soft)' }}>
            <span className="flex-1">{error}</span>
            {onRetry && (
              <button onClick={onRetry} className="underline shrink-0">重试</button>
            )}
          </div>
        </div>
      )}

      {/* ----------
        * ⚠⚠ 这里必须是 relative + z-20（2026-10-14 修）。
        *
        * 思考菜单浮在**上方**（bottom:100%），而上方是聊天消息区。
        * 原来这层没有 z-index，菜单的 z-50 只在自己那层里生效 ——
        * 结果菜单被消息区压住：几何位置对，但**看得见摸不着**。
        *
        * 判据不是肉眼看图，是 elementFromPoint：取菜单第一行的中心点，
        * 看命中的元素属不属于菜单。第一版就是只看 rect.bottom，
        * 判据说"浮在上方=true"、截图却明显被盖 —— 假绿。
        *
        * z-20 而不是 z-50：审批弹窗是 z-50，它必须仍然盖住这里。
        *
        * ⚠⚠⚠ 这段必须用「花括号 + 块注释」的形式写（也就是第一行那种）。
        *   我第一版漏了开头的花括号，只剩块注释部分，
        *   React 就把它当普通文本渲染到了聊天区里 ——
        *   羽毛菌装完第一版，聊天框上方直接显示一整段源码注释。
        *   **JSX 里的注释必须带花括号。**
        * ---------- */}
      {/**
        * ⚠ 这里**没有**分隔线（2026-10-16 羽毛菌要求）。
        *
        * 原来有一条通栏的 `border-top: 1px solid var(--line)`。
        * 那条线把"输入区"和"消息区"切成上下两块，输入框看着像嵌在边框里；
        * 而他要是的效果是：**输入框自己单独浮在卡片上**，上面不要任何横线。
        *
        * ⚠ 别改成"白色线"顶上 —— 贴背景图时白线照样看得出来。
        *   要去掉就真的去掉。
        */}
      <div className="shrink-0 px-5 pb-4 pt-2 relative z-20 chat-composer">
        <div className="max-w-5xl mx-auto">

          {/* 已选引用 */}
          {refs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {refs.map((r) => {
                const isSkill = r.kind === 'skill';
                /**
                 * 2026-10-14：文件=浅绿底/深绿字，技能=浅紫底/深紫字。
                 *
                 * ⚠ 为什么原来统一用 accent-soft 不够用：
                 *   两种引用挤在一行里长得一模一样，用户分不清哪个是技能、
                 *   哪个是文件 —— 而它们对模型的意义完全不同
                 *   （技能是行为规则，文件是要改的正文）。
                 *   两种颜色在扫视时就能分开，不必读文字。
                 *
                 * ⚠ 颜色写死不走 CSS 变量：这两组色只在这一个地方用，
                 *   而 accent 是随主题（gold/…）变的。
                 *   跟着主题走的话，浅绿底会随主题偏色，变成脏色。
                 *   这里要的是「稳定的、能一眼分辨」的两组色。
                 *
                 * 深浅对比：绿 #166534 / 底 #dcfce7，紫 #6b21a8 / 底 #f3e8ff，
                 *   都是「底浅字深」且字与底之间 ≥ 7:1，读得清。
                 *
                 * ⚠⚠ 这段必须放在标签**外**。2026-10-14 在这里栽了两遍：
                 *   1. 裸注释写在属性之间 → React 当文本渲染，
                 *      羽毛菌装的第一版聊天框上方顶着一整段源码注释。
                 *   2. 给它补上花括号 → 构建直接失败
                 *      （「Expected `...` but found `}`」）——
                 *      花括号注释只能当**子节点**，属性位置是 JSX 语法禁区。
                 *   所以：属性之间的注释，一律挪到 return ( 之前。
                 */
                return (
                  <button
                    key={r.key}
                    onClick={() => toggleRef(r.kind, { id: r.id, name: r.name })}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px]"
                    style={{
                      // ⚠ 颜色全走 CSS 变量（index.css 里有深浅两套）——
                      //   写死浅色的话，深色主题下这两个 chip 就是贴上去的荧光块。
                      background: isSkill ? 'var(--chip-skill-bg)' : 'var(--chip-file-bg)',
                      color: isSkill ? 'var(--chip-skill-ink)' : 'var(--chip-file-ink)',
                      // 描边跟着字色淡一点，边界清楚但不抢眼
                      border: '1px solid ' + (isSkill ? 'var(--chip-skill-edge)' : 'var(--chip-file-edge)'),
                    }}
                    title={'点击移除这个' + (isSkill ? '技能' : '文件') + '引用'}
                    data-testid={'ref-chip-' + r.key}
                  >
                    <span style={{ fontWeight: 600 }}>{isSkill ? '技能' : '文件'}</span>
                    <span style={{ opacity: 0.85 }}>{r.name}</span>
                    <span style={{ opacity: 0.6 }}>×</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 引用选择浮层 */}
          {picker && (
            <RefPicker
              kind={picker}
              skills={skills || []}
              settings={settings || []}
              chapters={chapters || []}
              filePaths={filePaths}
              has={hasRef}
              onToggle={toggleRef}
              onClose={() => setPicker(null)}
            />
          )}

{/* 范围守卫：**只有锁住时**才常驻在这里（恢复入口 + 为什么不能用）。
          没锁的那部分说明已经挪到消息流末尾，见上面 `scope-notice`。 */}
      {scopeLocked && (
            <div
              data-testid="scope-banner"
              className="mb-2 rounded-lg px-3 py-2 text-[12px] leading-relaxed flex items-start gap-2"
              style={{
                background: 'var(--accent-soft)',
                color: 'var(--danger)',
                border: '1px solid var(--line)',
              }}
            >
              <span className="flex-1 min-w-0">
                模型连接已关闭：这个工具只用于小说创作。
                {scopeNotice ? ` ${scopeNotice}` : ''}
              </span>
              {onUnlockModel && (
                <button
                  onClick={onUnlockModel}
                  data-testid="btn-scope-unlock"
                  className="shrink-0 text-[11.5px] px-2 py-0.5 rounded"
                  style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }}
                  title="确认要继续用，就重新打开模型连接"
                >
                  重新启用
                </button>
              )}
            </div>
          )}

{/* 输入框 = 一张**有范围的白色卡片**，但它与消息区之间**无缝**（2026-10-16 19:49）。

              ⚠⚠⚠ 这是两件**互相独立**的事，我前几轮一直混着做，所以两边都没做对：
                ① 「消息区 ↔ 输入区之间不要有横线」→ 靠 **composer 与消息区同色**
                   （`.chat-composer{background:#f5f6f8}`）—— 无痕，指的就是这个；
                ② 「输入框本身要有一个范围」→ 靠**卡片有白底 / 圆角 / 边框**。
              ⚠ 我上一轮为了做①，把②的 border/圆角/背景一起删了，
                 结果输入框糊进背景里，羽毛菌：「能不能像它这样有个范围」。

              ⚠ 两者同时成立的关键：卡片**两端有留白**（外层 composer 的 px-5），
                 所以它的上边缘是一段带圆角的短边 —— 读作"卡片"，
                 而不像一条横贯的分割线。
              ⚠ 阴影只给向下的一点点（负 spread），否则上半又会落回消息区变成那条线。
      */}
      <div className="rounded-lg overflow-hidden"
           style={{
             border: '1px solid var(--line)',
             background: 'var(--paper)',
             boxShadow: '0 3px 10px -4px rgba(0,0,0,.10)',
           }}>
        <textarea
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={scopeLocked
                ? '模型连接已关闭 —— 点上面的「重新启用」才能继续'
                : '说点什么…（Enter 发送，Shift+Enter 换行）'}
              rows={3}
              readOnly={scopeLocked}
              className="w-full px-3 py-2.5 outline-none resize-none leading-relaxed"
              // ⚠ 输入框跟着**对话**字号走（羽毛菌：「然后这个输入框里的字大小要和对话框里的
              //   字大小一样变化」）。之前是写死的 text-[13.5px]，拖滑块它纹丝不动。
              style={{
                background: 'transparent', color: 'var(--ink)',
                fontSize: `${fontSize || 16}px`, fontFamily: fontFamily || 'system-ui',
              }}
            />
            {/* 工具条 + 发送 */}
            <div className="flex items-center gap-1.5 px-2 pb-2 flex-wrap">
              <ToolBtn
                label="技能"
                active={picker === 'skill' || refs.some((r) => r.kind === 'skill')}
                onClick={() => setPicker(picker === 'skill' ? null : 'skill')}
              />
              <ToolBtn
                label="文件"
                active={picker === 'file' || refs.some((r) => r.kind === 'file')}
                onClick={() => {
                  const next = picker === 'file' ? null : 'file';
                  setPicker(next);
                  /**
                   * ⚠ 这里原来会往输入框里塞一个 `@`，2026-10-18 删掉。
                   *
                   * 那是按他早先一句「单击 @文件 后，聊天框里应该有个 @ 啊」加的。
                   * 他当时以为选文件是做在输入框里的 **@ 提及**（像别的软件那样
                   * 打一个 @ 就弹候选），后来发现这里是**独立的浮层面板**，
                   * 那个字符就成了一段没有任何用处的残留 —— 他的原话：
                   * 「没想到是单独一个区域选择文件」，让删掉。
                   *
                   * ⚠ 教训：他说的"应该有个 @ 啊"描述的是**他以为的交互方式**，
                   *   不是他要的结果。转述型的诉求先分清"X 是手段还是目的"，
                   *   否则做出来的是一个双方都没要的形状。
                   */
                }}
              />

              {/**
                * 终端 / 联网的放行开关。
                *
                * ⚠ 放在这里而不是顶栏 QUICK_TOOLS 那排：
                *   那排是「随手记」性质的独立工具（备忘录 / 起名 / 脑洞 / 灵感碎片），
                *   点开是另一个面板。而这两个 chip 管的是**这一轮对话**
                *   让不让模型动手，与 @技能 @文件 是同一类（给这一轮补充材料）。
                *
                * ⚠ 总开关关着时**仍然渲染**（不是隐藏）：
                *   藏在设置页里正是"做了功能却看不见"的那种错。
                *   灰着 + 点了给提示，用户才知道有这回事、要去哪开。
                */}
              {toolGate && (
                <ToolGateChips gate={toolGate} webReady={webReady} onOpenSettings={onOpenSettings} />
              )}

              {/**
               * 上下文用量指示器。
               *
               * ⚠ 位置在工具条里、弹性空格**之前**（贴着发送键那一侧）：
               *   它是"发出去之前就该看一眼"的信息，不是设置项。
               *
               * ⚠ 它不做"手动压缩"按钮 —— 按现在的实现那只能丢工具调用噪声，
               *   点了会让人以为对话被删了，而真正缺的是**可见性**。
               */}
              <CtxMeter />

              {/**
                * 弹性空格放在档位控件**之前**。
                *
                * 第 2 栏是可以拖窄的（SplitPanes），窄到一定程度这一行必然要换行。
                * 空格放前面，换行时第 1 行剩下的只有「@技能 @文件」，
                * 第 2 行是「思考」+ 圆形发送键这一组**靠右的行动区**——
                * 看起来是有意的两行。
                * 反过来把空格放最后的话，换行后发送键会独自掉到第 2 行最左边，
                * 像是布局崩了。
                *
                * ⚠ 2026-10-14 改版后这一行比原来短了很多：
                *   思考控件由四格横排（约 150px）变成一个弹出按钮（约 46px），
                *   发送键由「发送」长条（约 78px）变成圆形（32px）。
                *   合计省下约 150px，正好把第 2 栏从"默认就换行"拉回"默认不换行"。
                */}
              <div className="flex-1" />

              {/* 思考强度：与发送同一组，因为都是"这一轮怎么跑" */}
              {thinkLevels?.length > 0 && (
                <ThinkPicker
                  levels={thinkLevels}
                  value={thinkLevel}
                  onChange={onThinkLevel}
                />
              )}
              {generating ? (
                <SendBtn kind="stop" onClick={onStop} />
              ) : (
                <SendBtn
                  kind="send"
                  onClick={submit}
                  disabled={scopeLocked || (!text.trim() && refs.length === 0)}
                />
              )}
            </div>
          </div>

          {bottomSlot}
        </div>
      </div>
    </div>
  );
}

/**
 * 圆形发送键（2026-10-14 改）。
 *
 * ## 为什么从「发送」两个字的长条改成圆形图标
 *
 * 1. **占宽**。长条按钮 ~78px，而第 2 栏默认只有 ~350px 宽。
 *    思考控件从横排四档改成弹出后省下约 100px，正好把它换成圆的。
 * 2. **「发送」两个字是冗余的**。它在输入框右边，按钮位置本身已经说明了作用；
 *    真需要说明可以用 title 与 aria-label，悬停能看到，不必占常驻宽度。
 * 3. 圆形与输入框的圆角、@chip 的圆角在视觉上是一套，不突兀。
 *
 * ## 为什么图形是白色的纸飞机而不是 ↑ 箭头
 *
 * 箭头在很多界面里是"向上=发送"，但也常被用作"折叠/收起"。
 * 纸飞机没有这个歧义，而且**在深色底上辨识度明显高于箭头**。
 *
 * ## 状态
 *
 *   send  蓝底白飞机   —— 可发
 *   send  灰底灰飞机   —— 禁用（空输入且没有 @ 引用）
 *   stop  红底白方块   —— 生成中
 *
 * ⚠ 停止用**方块**而不是第二个圆图标：圆 + 圆并列会让人以为是两个可点的动作，
 *   而"停止"是唯一可点的。形状上的差异就是语义。
 */
function SendBtn({ kind, onClick, disabled }) {
  const isStop = kind === 'stop';
  const bg = isStop
    ? 'var(--danger)'
    : (disabled ? 'var(--ink-faint, #c2c2cc)' : 'var(--accent)');
  // 禁用时图形也要淡下去，否则会看成"能点"
  const fg = disabled ? 'rgba(255,255,255,.65)' : 'var(--accent-ink, #fff)';
  const label = isStop ? '停止生成' : '发送（Enter）';

  return (
    <button
      onClick={onClick}
      disabled={!!disabled}
      title={label}
      aria-label={label}
      data-testid={isStop ? 'btn-stop' : 'btn-send'}
      className="shrink-0 rounded-full flex items-center justify-center disabled:cursor-not-allowed"
      style={{
        width: '32px',
        height: '32px',
        background: bg,
        // 无边框：圆形 + 蓝底已经够像按钮了，
        // 加边框会让直径看着缩水一圈。
        border: 'none',
        transition: 'background .12s, opacity .12s',
        opacity: disabled ? 0.75 : 1,
      }}
    >
      {isStop ? (
        // 停止：圆角方块，SVG 免得依赖字体里有没有 ■
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill={fg} />
        </svg>
      ) : (
        // 纸飞机：向上偏右，尾巴带一点缺口，看起来才像"飞出去"而不是"上三角"
        <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden
          style={{ transform: 'rotate(8deg)' }}>
          <path
            d="M3.4 11.2 20.3 4.1a.6.6 0 0 1 .79.78L13.9 21.5a.6.6 0 0 1-1.1-.03l-2.1-5.7-5.7-2.1a.6.6 0 0 1-.03-1.1z"
            fill={fg}
          />
          <path d="M10.8 15.7 12.6 9.9l2.8-1.8z" fill={bg} opacity=".9" />
        </svg>
      )}
    </button>
  );
}

/**
 * 工具放行开关的两个 chip。
 *
 * 每个 chip 三态，必须一眼分得开 —— 点上去**什么都不发生**是最糟的反馈：
 *
 *   1. 可用 + 已放行   深色实心（真的会给模型用）
 *   2. 可用 + 未放行   描边（这一轮不给用）
 *   3. 总开关没开      灰 + 虚线描边（点了会提示去设置页）
 */
/**
 * ⚠⚠ `file` 必须**单独立一个 chip**，不能塞进 terminal（2026-10-15）。
 *
 * 羽毛菌的原话：「模型或者软件应该自己直接就会去找文件写入、修改」，
 * 并把「没有写入文件的能力」叫做「开发出来也是没有用」。
 * 也就是说写文件是这个产品的**底层能力**，不是可选项。
 *
 * 为什么不能和「终端」合并：
 *   两者危险等级差着数量级 —— 一个是"往这个文件里写一段字"，
 *   一个是"任意执行命令"。合并的后果只有两种：
 *   为了写文件被迫开放任意命令执行，或者为了安全关掉终端、
 *   于是连写文件也一起关掉（实测他就是这么卡的：
 *   `toolsEnabled=false` → 模型一个工具都没有 → 只能吐字）。
 */
const TOOL_CHIPS = [
  { key: 'terminal', icon: '⌘', label: '终端', hint: '让模型在你的项目文件夹里跑命令（危险命令会先问你）' },
  { key: 'web', icon: '🔍', label: '联网', hint: '让模型搜资料、读网页' },
];

function ToolGateChips({ gate, webReady, onOpenSettings }) {
  const on = new Set(gate.groups || []);
  return (
    <>
      {TOOL_CHIPS.map((c) => {
        const allowed = gate.enabled;
        const active = allowed && on.has(c.key);

        /**
         * ⚠⚠ 联网 chip 的可用性不能只看总开关（2026-10-14 修）。
         *
         * 原来只有三态：放行 / 未放行 / 总开关关。**没有「没配 Key」这一态**，
         * 于是用户开了总开关、chip 也是亮的，搜索却必然失败 ——
         * 界面看着一切正常，实际发不出去。羽毛菌就是这么撞上的。
         *
         * 现在加第四态：**缺配置时 chip 标红**，
         * 而且点它不再是"放行了"，而是**指名道姓地说缺哪一层**。
         * 笼统说"联网不可用"没用，用户不知道自己该改哪里。
         */
        const webMissing = c.key === 'web' && webReady ? (webReady.missing || []) : [];
        const webBroken = c.key === 'web' && webMissing.length > 0;

        let title = allowed
          ? `${c.hint}\n${active ? '这一轮会给模型用（再点一下收回去）' : '这一轮不给模型用'}`
          : '总开关还没开。点一下会带你去设置页开';
        if (webBroken) {
          title = `联网还差：${webMissing.join('、')}。点一下带你去设置`;
        }

        const onClick = () => {
          /**
           * ⚠⚠ 这里传的值必须是 **SettingsPage 里 CATS 的 key**。
           *   我第一版写的是 'web' / 'tool'，而真实 key 是 'tools' ——
           *   两边都对不上，`cat === 'tools'` 不成立，
           *   设置页打开后停在默认的「外观」页。
           *
           *   而这一跳的全部意义就是"把他送到能改的地方"，
           *   停错页等于没跳：用户还得自己再翻一遍。
           *
           *   判据里特意验了"落点是不是工具页"，
           *   就是为了钉住这条 —— 光验"设置页打开了"会放过这个错。
           */
          if (!allowed || webBroken) {
            if (onOpenSettings) onOpenSettings('tools');
            return;
          }
          gate.onToggle(c.key);
        };

        return (
          <button
            key={c.key}
            data-testid={`tool-chip-${c.key}`}
            title={title}
            onClick={onClick}
            className="px-2 py-1 rounded text-[12px] flex items-center gap-1"
            style={{
              // ⚠ 标红优先于放行态：缺配置时即便 chip 被选中，
              //   显示上也必须让人看出"这东西现在跑不通"。
              background: webBroken ? 'var(--danger-soft, #fdecec)'
                : (active ? 'var(--accent)' : 'transparent'),
              color: webBroken ? 'var(--danger)'
                : (active ? 'var(--accent-ink)' : (allowed ? 'var(--ink-soft)' : 'var(--ink-faint, var(--ink-soft)')),
              border: `1px ${webBroken || !allowed ? 'dashed' : 'solid'} `
                + (webBroken ? 'var(--danger)' : (active ? 'var(--accent)' : 'var(--line)')),
              opacity: allowed ? 1 : 0.55,
            }}
          >
            <span className="text-[11px]">{c.icon}</span>
            {c.label}
            {webBroken
              ? <span className="text-[10px]">缺{webMissing[webMissing.length - 1]}</span>
              : (!allowed && <span className="text-[10px]">🔒</span>)}
          </button>
        );
      })}
    </>
  );
}

/**
 * 「@技能 / @文件」的触发按钮。
 *
 * ## 配色与上面那些 chip 是同一套（2026-10-14）
 *
 * 浅绿=文件、浅紫=技能。这里未选时是**淡字色底**（而不是透明），
 * 因为它跟已选引用 chip 用同一套颜色才连得上 —— 用户一眼能看出
 * 「点了这个按钮，会出现那种颜色的标签」。
 *
 * 未选时保持很浅：这两个按钮常驻，而真正要引起注意的是选中之后的 chip。
 */
function ToolBtn({ label, onClick, active }) {
  const isSkill = label === '技能';
  // 未选：同色系的最浅一档，看得出归属但不抢眼
  // ⚠ 颜色走变量（深浅各一套），JSX 不写死 —— 否则深色主题下是荧光块
  const bgOn = isSkill ? 'var(--chip-skill-bg)' : 'var(--chip-file-bg)';
  const inkOn = isSkill ? 'var(--chip-skill-ink)' : 'var(--chip-file-ink)';
  const edgeOn = isSkill ? 'var(--chip-skill-edge)' : 'var(--chip-file-edge)';
  return (
    <button
      onClick={onClick}
      data-testid={'ref-btn-' + label}
      className="px-2.5 py-1 rounded text-[12px]"
      style={{
        background: active ? bgOn : (isSkill ? 'var(--chip-skill-bg-off)' : 'var(--chip-file-bg-off)'),
        color: active ? inkOn : (isSkill ? 'var(--chip-skill-ink-off)' : 'var(--chip-file-ink-off)'),
        border: '1px solid ' + (active ? edgeOn : 'var(--line)'),
        fontWeight: active ? 600 : 400,
      }}
    >
      @{label}
    </button>
  );
}

/**
 * 思考强度档位。
 *
 * ⚠ 下面这段是**历史记录**，2026-10-14 已改成弹出式菜单。
 *
 * 原来是**分段控件**（横排四格）：档位一共就 2~4 个，展开一次下拉要点两下。
 * 改掉的理由：
 *   1. 占宽 ~150px，而第 2 栏默认只有 ~350px —— 挤得发送键换行
 *   2. 「低」和「中」并排摆着，用户看不出差别
 *   3. 放不下第五档「默认」
 * 现在是 ThinkPicker：触发器占一行文字宽，菜单竖排、每项带说明。
 */

/**
 * 思考强度：**弹出式单选菜单**（2026-10-14 改）。
 *
 * ## 为什么从横排分段控件改成弹出
 *
 * 原来是「关|低|中|高」四格横排。三个问题：
 *   1. **占宽**。四档横排 ~150px，而第 2 栏默认只有 ~350px 宽 ——
 *      挤得「发送」按钮换行（原来那行注释里记着实测：px-2 时 369 > 359）。
 *   2. **看不出差别**。「低」和「中」并排摆着，用户不知道该选哪个。
 *   3. **放不下第五档**。想加「默认」这一档就必然换行。
 *
 * 改成弹出后按钮只占一行文字的宽度，腾出的空间给了发送键。
 * 菜单竖排，每项后面能跟一句说明，用户终于看得见「关闭」和「低」的差别。
 *
 * ## 交互
 *
 *   点按钮 → 菜单浮在**上方**（输入框下方是正文，往下会遮内容）
 *   Esc / 点外部 / 选完 → 都关。**不自动聚焦**，
 *   跟审批弹窗一个原则：鼠标操作不该被焦点抢走。
 */
function ThinkPicker({ levels, value, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  /**
   * 菜单的**视口坐标**（fixed 定位用）。
   *
   * ⚠⚠ 为什么必须用 fixed 而不是 absolute（2026-10-14 踩过）。
   *
   * 原来用 `absolute bottom-full`，想着"浮在按钮上方"。实测**菜单被聊天
   * 消息区盖住了** —— 而且不是 z-index 输了，是**被裁掉**：
   * ChatPanel 的根 SECTION 是 `overflow:hidden`，而 absolute 的后代
   * 会被任何 `overflow:hidden` 的祖先裁剪。加 z-index 一点用都没有。
   *
   * 实测证据（截图脚本会打这条链）：
   *   DIV#think-menu  z=50  absolute
   *   DIV            z=auto relative
   *   DIV            z=auto static
   *   DIV            z=auto static overflow=hidden   ← 裁在这里
   *
   * `fixed` 的定位参照**视口**，不受祖先 overflow 影响，所以能浮出去。
   * 代价是要自己算坐标 —— 换来的是它真的能看见。
   */
  const [pos, setPos] = useState(null);

  // ⚠ 每次打开都重算：窗口可能被拖动/缩放，缓存的坐标会错位。
  useEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(r.right - 176, window.innerWidth - 184)),
      top: Math.max(8, r.top - 4),
      width: Math.max(176, r.width),
    });
  }, [open]);

  // ⚠ 点外面就关。listen 用 capture 阶段，
  //   否则浮层自己会被同一次点击判成"点到外面"，刚打开就关掉。
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!levels || !levels.length) return null;

  const cur = value;
  const curLabel = cur === DEFAULT_LEVEL ? DEFAULT_LABEL : (LEVEL_LABEL[cur] || cur);
  // 触发器上带一个前导图标，选中哪档一眼能认出来
  const curIcon = cur === DEFAULT_LEVEL ? '✦' : (LEVEL_ICON[cur] || '·');

  const pick = (v) => { onChange?.(v); setOpen(false); };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="think-trigger"
        title={'思考强度：当前「' + curLabel + '」。' + DEFAULT_HINT}
        className="flex items-center gap-1 px-2 py-1 rounded text-[11.5px]"
        style={{
          background: open ? 'var(--accent-soft)' : 'transparent',
          color: 'var(--ink-soft)',
          border: '1px solid var(--line)',
        }}
      >
        <span aria-hidden style={{ color: 'var(--accent)' }}>{curIcon}</span>
        {curLabel}
        {/* ▼ 展开时转 180°。用 inline style 而不是 CSS 类 —— 类名会和现有样式打架 */}
        <span aria-hidden style={{
          display: 'inline-block',
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform .12s',
          fontSize: '9px',
          opacity: 0.7,
        }}>▼</span>
      </button>

      {open && pos && (
        <div
          data-testid="think-menu"
          className="fixed z-[60] py-1.5 rounded-lg"
          style={{
            // fixed 的 left/top 参照视口，不受祖先 overflow:hidden 裁剪。
            // ⚠ top 给的是**按钮上沿**，所以要 translateY(-100%) 把菜单
            //   整体提上去 —— 这样它正好贴在按钮上方，不依赖知道菜单高度。
            left: pos.left,
            top: pos.top,
            transform: 'translateY(-100%)',
            // 白卡片 + 阴影：弹层必须明显浮在内容之上，
            // 否则和背景混在一起，用户不知道那是可点的。
            background: 'var(--paper)',
            border: '1px solid var(--line)',
            boxShadow: '0 6px 22px rgba(0,0,0,.16)',
            minWidth: '176px',
          }}
        >
          {/* ---- 默认档：与下面几个性质不同，用分隔线隔开 ---- */}
          <MenuRow
            on={cur === DEFAULT_LEVEL}
            icon="✦"
            label={DEFAULT_LABEL}
            hint={DEFAULT_HINT}
            onClick={() => pick(DEFAULT_LEVEL)}
          />

          <div style={{ height: '1px', margin: '3px 6px', background: 'var(--line)' }} />

          {levels.map((lv) => (
            <MenuRow
              key={lv}
              on={cur === lv}
              icon={LEVEL_ICON[lv] || '·'}
              label={LEVEL_LABEL[lv] || lv}
              hint={LEVEL_HINT[lv] || ''}
              onClick={() => pick(lv)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 菜单里的一行。
 *
 * ## 为什么单选圈 + 图标 + 文字是三样东西
 *
 * 单选圈表示"当前选中"，图标表示"这档大概是多强的思考"，
 * 文字是名字。三者信息不重叠，缺一样用户就得猜。
 * 选中时**整行**变蓝（圈与图标一起），而不是只有文字变色 ——
 * 扫一眼就能找到自己在哪一档。
 */
function MenuRow({ on, icon, label, hint, onClick }) {
  return (
    <button
      onClick={onClick}
      title={hint || label}
      data-testid={'think-opt-' + label}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-left"
      style={{
        // 选中 = 淡蓝底；未选中 = 透明。底色比文字弱一级，
        // 免得整个菜单看起来是一整块蓝色。
        background: on ? 'var(--accent-soft)' : 'transparent',
        color: on ? 'var(--accent)' : 'var(--ink)',
        fontWeight: on ? 600 : 400,
      }}
    >
      {/* 单选圈：选中=实心蓝+白点，未选中=灰圈 */}
      <span
        aria-hidden
        className="rounded-full"
        style={{
          width: '13px',
          height: '13px',
          border: '1.5px solid ' + (on ? 'var(--accent)' : 'var(--ink-faint, #b9b9c2)'),
          background: on ? 'var(--accent)' : 'transparent',
          position: 'relative',
          flexShrink: 0,
          display: 'inline-block',
        }}
      >
        {on && (
          <span style={{
            position: 'absolute',
            inset: '0',
            margin: 'auto',
            width: '4px',
            height: '4px',
            borderRadius: '50%',
            background: 'var(--accent-ink, #fff)',
          }} />
        )}
      </span>
      <span aria-hidden style={{ width: '13px', textAlign: 'center', fontSize: '12px', flexShrink: 0 }}>
        {icon}
      </span>
      <span className="text-[12.5px]">{label}</span>
    </button>
  );
}

/** 引用选择浮层。技能与文件分两栏，文件按「章节 / 设定」分组。 */
function RefPicker({ kind, skills, settings, chapters, filePaths = [], has, onToggle, onClose }) {
  const [q, setQ] = useState('');
  const k = q.trim().toLowerCase();
  const hit = (name) => !k || String(name).toLowerCase().includes(k);

  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  return (
    <div className="mb-2 rounded-lg overflow-hidden"
         style={{ border: '1px solid var(--line)', background: 'var(--paper)', maxHeight: '260px' }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: '1px solid var(--line)' }}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={kind === 'skill' ? '搜技能…' : '搜章节或设定…'}
          className="flex-1 px-1 py-0.5 text-[12.5px] outline-none bg-transparent"
          style={{ color: 'var(--ink)' }}
        />
        <button onClick={onClose} className="text-[11px] px-1.5 py-0.5 rounded"
                style={{ color: 'var(--ink-soft)' }}>关闭</button>
      </div>

      <div className="overflow-y-auto" style={{ maxHeight: '200px' }}>
        {kind === 'skill' ? (
          skills.filter((s) => hit(s.name)).length === 0
            ? <Empty text="没有匹配的技能" />
            : skills.filter((s) => hit(s.name)).map((s) => (
              <Item key={s.id} active={has('skill', s.id)}
                    title={s.name}
                    sub={s.prompt_content?.slice(0, 60) || (s.type === 'built-in' ? '内置' : '自建')}
                    onClick={() => onToggle('skill', s)} />
            ))
        ) : (
          <>
            {/**
             * ⚠⚠ 第一组是**项目文件夹里的文件**（2026-10-15 羽毛菌）：
             *   「单击 @文件 后，聊天框里应该有个 @ 啊，
             *     然后我可以选择目录里的文件」
             *
             * 原来这里只列数据库里的 chapters 与 settings ——
             * 新建的项目这两个都是空的，于是弹层就是一句「没有匹配的内容」，
             * 而 `设定/世界观.md`、`卷纲/…` 这些**明明就在硬盘上**。
             *
             * 写文件能力（write_note）落地之后，模型写出来的也是这些文件，
             * 不列它们的话「模型改了某个文件、我也想看一眼」这条链是断的。
             */}
            <GroupTitle text={`项目文件（${filePaths.length}）`} />
            {filePaths.length === 0
              ? <Empty text="项目文件夹里还没有文件" />
              : filePaths.filter((f) => hit(f.name) || hit(f.path)).map((f) => (
                <Item key={f.path} active={has('file', f.path)}
                      title={f.name} sub={f.path}
                      onClick={() => onToggle('file', { id: f.path, name: f.name, content: '' })} />
              ))}
            {chapters.filter((c) => hit(c.title)).length > 0 && (
              <>
                <GroupTitle text={`章节（${chapters.filter((c) => hit(c.title)).length}）`} />
                {chapters.filter((c) => hit(c.title)).map((c) => (
                  <Item key={c.id} active={has('file', c.id)}
                        title={c.title} sub={`${c.word_count || 0} 字`}
                        onClick={() => onToggle('file', c)} />
                ))}
              </>
            )}
            {settings.filter((s) => hit(s.name) || hit(s.note)).length > 0 && (
              <>
                <GroupTitle text={`设定（${settings.filter((s) => hit(s.name) || hit(s.note)).length}）`} />
                {settings.filter((s) => hit(s.name) || hit(s.note)).map((s) => (
                  <Item key={s.id || s.name} active={has('file', s.id || s.name)}
                        title={s.name} sub={(s.note || '').slice(0, 70)}
                        onClick={() => onToggle('file', { id: s.id || s.name, name: s.name, content: s.note })} />
                ))}
              </>
            )}
            {filePaths.length === 0 &&
             chapters.filter((c) => hit(c.title)).length === 0 &&
             settings.filter((s) => hit(s.name) || hit(s.note)).length === 0 &&
              <Empty text="没有匹配的内容" />}
          </>
        )}
      </div>
    </div>
  );
}

function GroupTitle({ text }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[11px] font-semibold sticky top-0"
         style={{ color: 'var(--ink-soft)', background: 'var(--paper)' }}>
      {text}
    </div>
  );
}

function Item({ title, sub, active, onClick }) {
  return (
    <button
      onClick={onClick}
      // ⚠ 截图脚本要靠它精确点条目。第一版脚本只能"找一个文字短于
      //   24 字的按钮"，结果点中了「＋新建」「确定」——
      //   判据说"一个引用都没选上"，而真实原因是脚本点错了地方。
      //   **脚本点不准时，先怀疑脚本，别急着改实现。**
      data-testid={'ref-item-' + String(title).slice(0, 12)}
      className="w-full text-left px-3 py-1.5 hover:bg-[var(--paper-2)] transition-colors"
      style={{ background: active ? 'var(--accent-soft)' : 'transparent' }}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[12.5px] truncate" style={{ color: 'var(--ink)' }}>{title}</span>
        {active && <span className="text-[10px] shrink-0" style={{ color: 'var(--accent)' }}>✓</span>}
      </div>
      {sub && <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--ink-soft)' }}>{sub}</div>}
    </button>
  );
}

function Empty({ text }) {
  return (
    <div className="px-3 py-4 text-[12px] text-center" style={{ color: 'var(--ink-soft)' }}>
      {text}
    </div>
  );
}

/** 文风检测结论：一行摘要 + 可展开的偏离项 */
function StyleNote({ r }) {
  const [open, setOpen] = useState(false);
  if (!r || !r.deviations) return null;
  const n = r.deviations.length;
  if (!n && !(r.tics && r.tics.length)) return null;

  return (
    <div className="text-[11.5px] rounded-lg px-3 py-2"
         style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 w-full text-left">
        <span style={{ color: 'var(--ink)' }}>文风</span>
        <span>{n ? `${n} 项偏离你的写法` : (r.tics.length ? `提示：${r.tics.join('、')}` : '符合你的写法')}</span>
        <span className="flex-1" />
        <span style={{ fontSize: 10 }}>{open ? '收起' : '详情'}</span>
      </button>
      {open && n > 0 && (
        <div className="mt-1.5 space-y-1">
          {r.deviations.map((d) => (
            <div key={d.metric} className="flex gap-1.5">
              <span className="shrink-0" style={{ color: 'var(--accent)' }}>
                {d.direction === 'high' ? '↑' : '↓'}
              </span>
              <span>{d.label}：{d.advice}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}