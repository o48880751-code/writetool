import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ParamGuide from './ParamGuide.jsx';
import AgreementModal from './AgreementModal.jsx';
import { BackgroundSection } from './Background.jsx';
import { MODES, normalizeHex, resolveDark, modeDefaults, applyTheme } from '../themes.js';
// 这两个是 2026-10-12 拆出去的：各自都是几百行，
// 与设置页的主框架（类目导航 + 渲染分发）不是一回事。
import ProviderCat from './ProviderCat.jsx';
import SkillCat from './SkillCat.jsx';
import ToolCat from './ToolCat.jsx';
import { H1, Group, Field, Hint, StatusDot } from './settings-ui.jsx';
import { useFonts } from '../lib/fonts.js';
import { playChime } from '../lib/chime.js';

/**
 * 独立设置界面：整页覆盖，左上角返回键，左侧类目导航。
 *
 * ## 为什么整页覆盖而不是主区标签
 *
 * 设置是「改完就走」的场景，不是「边看边改」的场景。
 * 放进主区标签会占掉写作位置，而用户改完一项就想去接着写。
 * 整页覆盖 + 明确的返回键，语义是"暂时离开工作区"。
 *
 * ## 类目怎么分
 *
 * 按**用户脑子里在调什么**分，不按代码模块分：
 *   外观 = 长什么样（主题、字号）
 *   模型 = 换哪个模型、连到哪台 Ollama
 *   参数 = 调多少（温度、上下文窗口）
 *   数据 = 我的东西在哪、怎么备份
 *   关于 = 版本、更新
 *
 * 早期版本把"主题"做成顶栏一个下拉、"设置"按钮打开一个侧栏面板，
 * 结果是同一个设置散在两处，用户找不到。这次都收到这里，顶栏只留入口。
 */

const CATS = [
  { key: 'appearance', label: '外观', icon: '🎨' },
  { key: 'provider', label: 'AI 提供商', icon: '🤖' },
  { key: 'skill', label: 'Skill', icon: '🧩' },
  /**
   * ⚠ 这里原来叫「工具」，2026-10-14 羽毛菌要求改成「功能」。
   *
   *   理由（他的原话）：这一类里装的是「能不能用」的能力
   *   （终端 / 联网搜索 / 读网页），不是「工具」这种偏实现的说法。
   *
   * ⚠⚠ **key 改了，所有引用它的字符串必须一起核对**：
   *   - toolGate 里 onOpenSettings 传的字符串
   *   - 各处提示文案里写的「设置 → 功能」
   *   - 搜索失败提示里的「去「设置 → 功能」里重填」
   *   少改一处，用户就点不到那个类目（点过去是空白页，看着像坏了）。
   */
  { key: 'tools', label: '功能', icon: '⌘' },
  { key: 'params', label: '参数', icon: '🎚️' },
  { key: 'data', label: '数据', icon: '💾' },
  { key: 'author', label: '作者', icon: '✒️' },
  { key: 'about', label: '关于', icon: 'ℹ️' },
];

/**
 * 合法类目 key。提到模块级，避免每次渲染新数组
 * —— 那会让下面那个 useEffect 的依赖每轮都变，
 * 效果是设置页跟着无关的重渲染反复切页。
 */
const VALID_CATS = CATS.map((c) => c.key);

/** 主题预览色：直接把变量值填进 swatch，切换后立刻能看到真实效果 */

export default function SettingsPage({
  config, onConfigChange, onClose, projectId, projects,
  /** 轻提示。设置页自己不发 toast，交给 App 统一显示 */
  onToast,
  /**
   * 装完技能 / 角色卡后叫一声，让 App 重拉引用源（2026-10-29）。
   *
   * ⚠ 不叫的话，用户从广场装完技能回到对话，@ 面板里**看不到它** ——
   *   必须重启软件才出现。用户只会得出一个结论：「下载了但没装上」。
   */
  onDataChanged = null,
  /**
   * 一打开就落到哪个类目（2026-10-14）。
   *
   * ⚠ 用户点了「联网 chip 显示缺 Key」之后，设置页必须直接停在能改的地方。
   *   停在默认的「外观」页等于让他自己再翻一遍 —— 那就白跳了。
   */
  initialCat = 'appearance',
}) {
  /**
   * ⚠ 非法 key 要退回默认，而不是让 `cat === 'xxx'` 全部落空。
   *
   *   真踩过：聊天框传过来的是 'web'，而 CATS 里的 key 是 'tools' ——
   *   设置页照样打开，但内容区一个分支都没命中，
   *   用户看到一片空白，还以为设置页坏了。
   *
   *   挡在这里比在调用方逐个核对可靠：新增入口时忘了改 key，
   *   至少会退回默认页，而不是白屏。
   */
  const [cat, setCat] = useState(
    VALID_CATS.includes(initialCat) ? initialCat : 'appearance'
  );
  // 设置页已经开着时再点 chip，要能跟着跳过去
  useEffect(() => {
    setCat(VALID_CATS.includes(initialCat) ? initialCat : 'appearance');
  }, [initialCat]);
  const [local, setLocal] = useState(config || {});
  const [saveMsg, setSaveMsg] = useState('');
  /** 保存失败的原因（主进程抛的错原样显示，别自己编一句） */
  const [saveErr, setSaveErr] = useState('');

  /**
   * 生成参数：窗口 / 输出上限 / 输出预留。
   *
   * ⚠ 这三项**按连接存**，不是 config 的全局字段，所以单独问主进程要。
   *
   * 为什么不能共用一个全局值：同一个「上下文窗口」在两边含义不同 ——
   *   本地它是 `num_ctx`，发给 Ollama 让它按这个分配 KV cache（**真吃显存**）；
   *   云端它只是"这个模型的窗口有多大"，客户端传不了，唯一用途是
   *   告诉**上下文压缩器**该在什么时候丢历史。
   * 共用一个值会坏在两个方向：
   *   云端切回本地 → 200000 被当 num_ctx 发出去，直接爆显存；
   *   本地切到云端 → 压缩器把 200K 窗口当 8192 用，前文设定被大量丢弃，
   *   表现为"写着写着忘了开头的设定"，而且**不报任何错**。
   */
  const [connParams, setConnParams] = useState(null);
  const [conns, setConns] = useState([]);


  const activeConnId = config && config.activeConnectionId;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // ⚠ preload 的 `call()` **已经拆掉了外层信封**（它返回 res.data，
        //   外层不 ok 时直接 throw）。所以这里拿到的是数据本身，
        //   不要再判 `r.ok`/`r.data` —— 那样永远取不到值，
        //   表现是界面一直显示兜底默认值 8192，看着"正常"其实没连上。
        const r = await window.api.provider.connParams();
        if (alive && r && typeof r === 'object') setConnParams(r);
        // 教程要按**当前连接**给推荐值（DeepSeek 128K / 硅基 32K…），
        // 所以得知道当前用的是哪一条。
        try { const cs = await window.api.provider.listConnections();
          if (alive && Array.isArray(cs)) setConns(cs); } catch (_) { /* 拿不到就用通用说明 */ }
      } catch (_) { /* 拿不到就退回默认显示，不阻塞设置页 */ }
    })();
    return () => { alive = false; };
  }, [activeConnId]);

  /**
   * 存生成参数。
   *
   * ⚠ 这个通道返回的是**内层信封**（{ok:false,error} 也算业务上的拒绝），
   *   而 preload 的 call() 只拆外层。所以这里要自己看 inner.ok，
   *   并 catch 外层抛出的异常（IPC 真的挂了）。
   */
  const saveConnParam = useCallback(async (patch) => {
    let inner = null;
    try {
      inner = await window.api.provider.setConnParams(null, patch);
    } catch (e) {
      onToast && onToast(e.message || '没存上');
      return;
    }
    if (!inner || !inner.ok) {
      onToast && onToast((inner && inner.error) || '没存上');
      return;
    }
    setConnParams((p) => ({ ...(p || {}), ...inner.params }));
    setSaveMsg('已保存');
    setTimeout(() => setSaveMsg(''), 1500);
  }, [onToast]);

  // 切回设置页时同步最新 config：可能在别处改过（比如主区字号滑块）
  useEffect(() => { setLocal(config || {}); }, [config]);

  /**
   * 只改本地草稿，不落盘。
   *
   * 输入框必须"边打边显示"——如果每次按键都走 IPC 写 config.json，
   * 一边打字一边写磁盘，既慢又会在崩溃时留下半截配置。
   * 所以：改草稿用这个，失焦/回车才 save()。
   */
  const setLocalDraft = useCallback((patch) => {
    setLocal((l) => ({ ...l, ...patch }));
  }, []);

  /**
   * ⚠ 保存失败**必须说出来**（2026-11-03 加 catch）。
   *   原来这里没有 catch：主进程拒绝保存（比如称谓填了「干爹」）时，
   *   Promise 直接变 unhandled rejection —— 界面上什么都不显示，
   *   用户以为存上了，重启才发现还是旧的。
   */
  const save = useCallback(async (patch) => {
    setLocal((l) => ({ ...l, ...patch }));
    try {
      await window.api.config.set(patch);
      const cfg = await window.api.config.get();
      onConfigChange(cfg);
      setSaveErr('');
      setSaveMsg('已保存');
      setTimeout(() => setSaveMsg(''), 1500);
    } catch (e) {
      setSaveMsg('');
      setSaveErr(e.message || '保存失败');
      setTimeout(() => setSaveErr(''), 4000);
    }
  }, [onConfigChange]);

  return (
    /**
     * ⚠⚠ `top-10` 不能省（2026-11-07 羽毛菌截图：设置页右上角没有最小化/关闭按钮）。
     *
     *   原来写的是 `absolute inset-0` —— 设置页从窗口最顶端开始铺，
     *   把 App 的自定义标题栏（h-10 = 40px）整个盖住了。
     *   而窗口三颗按钮就长在那条标题栏上，于是整页设置的时候既最小化不了、
     *   也关不掉，只剩 Esc 和"返回"能用。
     *
     * ⚠ 这个 40 必须和 App.jsx 里标题栏的 `h-10` 一致。改任一处都要同步，
     *   判据里有一条专门比对两者（test-settings-v3.js）。
     */
    <div
      className="settings-root absolute inset-x-0 bottom-0 top-10 z-40 flex flex-col"
      style={{ background: 'var(--paper)' }}
    >
      {/* ---- 顶栏：返回键 + 标题 + 保存提示 ---- */}
      <div
        className="shrink-0 h-11 flex items-center gap-3 px-4"
      >
        <button
          onClick={onClose}
          className="flex items-center gap-1 px-2 py-1 rounded text-[12px]"
          style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
          title="返回工作区（Esc）"
        >
          ← 返回
        </button>
        <div className="text-[13px] font-semibold">设置</div>
        {saveMsg && <div className="text-[11px]" style={{ color: 'var(--ok)' }}>{saveMsg}</div>}
        {saveErr && (
          <div data-testid="settings-save-error" className="text-[11px]" style={{ color: 'var(--danger)' }}>
            {saveErr}
          </div>
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ---- 类目导航 ---- */}
        <nav
          className="shrink-0 w-40 flex flex-col gap-0.5 p-2 border-r overflow-y-auto"
          style={{ borderColor: 'var(--line)', background: 'var(--paper-2)' }}
        >
          {CATS.map((c) => (
            <button
              key={c.key}
              onClick={() => setCat(c.key)}
              className="settings-nav-item flex items-center gap-2 px-2.5 py-2 text-[12.5px] text-left"
              data-on={cat === c.key ? '1' : '0'}
              aria-current={cat === c.key ? 'page' : undefined}
            >
              <span>{c.icon}</span>
              <span>{c.label}</span>
            </button>
          ))}
        </nav>

        {/* ---- 内容区 ---- */}
        {/*
          ⚠ data-testid 是给判据用的：整页 innerText 的前 400 字会被左侧栏
          和底下的工作区吃掉，判据根本读不到这一栏写了什么
          （2026-10-16 就因此把参数页的两条提示判成"没有"）。
        */}
        <div className="flex-1 overflow-y-auto min-h-0" data-testid="settings-body">
          {/**
            * ⚠ key={cat} 是**入场动画的开关**（2026-11-06）：
            *   key 一变 React 就重挂这个子树，CSS 动画从头播一次。
            *   不加 key 只改内容，动画不会重播（元素还是同一个）。
            */}
          <div className="settings-pane max-w-2xl px-6 py-5" key={cat}>
            {cat === 'appearance' && <Appearance local={local} save={save} onToast={onToast} />}
            {cat === 'provider' && (
              <ProviderCat onToast={onToast} onConfigChange={onConfigChange} />
            )}
            {cat === 'skill' && (
              <SkillCat projectId={projectId} onToast={onToast} onDataChanged={onDataChanged} />
            )}
            {cat === 'params' && (
              <Params
                local={local}
                save={save}
                connParams={connParams}
                onConnParam={saveConnParam}
                // 教程要按**当前连接**给推荐值，所以得知道它是谁
                connName={(conns.find((c) => c.id === activeConnId) || {}).name || ''}
                connBase={(conns.find((c) => c.id === activeConnId) || {}).base || ''}
              />
            )}
            {cat === 'tools' && (
              <ToolCat
                config={local}
                onConfigChange={onConfigChange}
                projectId={projectId}
                onToast={onToast}
              />
            )}            {cat === 'data' && <DataCat projectId={projectId} projects={projects} />}
            {cat === 'author' && <AuthorCat local={local} save={save} setLocalDraft={setLocalDraft} />}
            {cat === 'about' && <AboutCat />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================
// 外观
// ===========================================================
/**
 * 自定义系统提示词的默认值（2026-11-06）。
 *
 * ⚠⚠ 必须与 `electron/main.js` 的 DEFAULT_CUSTOM_PROMPT **逐字一致**。
 *   两份是没法共享的（一个在主进程、一个在渲染进程，中间隔着 preload），
 *   所以用判据 test-send-resilience 里的字符串比对来兜底 ——
 *   只改一处，判据立刻红。
 */
const DEFAULT_CUSTOM_PROMPT = [
  '你是一个创意小说写作助手。你可以读取和写入小说项目目录中的文件。',
  '当用户要求你写作、修改或审阅内容时，使用可用工具读取现有章节和资料，然后据此撰写或更新内容。',
  '始终保持与现有故事、角色和世界设定的一致性。请使用与用户相同的语言进行回复。',
].join('');

/**
 * 越狱特征库（2026-11-06）。**界面这份只用来提前告知，真正的拦截在主进程。**
 *
 * ⚠⚠ 必须与 `electron/main.js` 的 PROMPT_GUARD_SOURCES **逐条一致**。
 *   两份没法共享（CJS vs ESM），判据里按源串逐条比对，改一处忘另一处会红。
 * ⚠ 界面份的意义：用户在这里敲「忽略以上所有指令」时，下方立刻出现红字
 *   「N 处不会生效」。不告诉他的话，他会以为自己设置成功了，
 *   然后困惑"为什么 AI 还是那套规则"。
 */
const PROMPT_GUARD_SOURCES = [
  // 1) 指令覆盖（忽略/无视 + 上述/之前 + 指令/规则…）
  '(?:忽略|无视|忘记|抛开|不要管|别管|不必遵守|无需遵守|覆盖|作废|跳过)[^。；;\\n]{0,16}(?:上述|以上|之前|前面|先前|系统|全部|所有|一切)[^。；;\\n]{0,8}(?:指令|规则|提示|约束|限制|要求|命令|规矩)',
  // 2) 解除限制（没有限制 / 关闭审核 / 绕过过滤…）
  '(?:没有|不受|无需|取消|解除|关闭|绕过|突破|逃过)[^。；;\\n]{0,8}(?:任何)?(?:限制|约束|审核|审查|过滤|禁忌|道德|伦理)',
  // 3) 索取提示词（说出你的系统提示词 / 重复初始指令…）
  '(?:输出|重复|复述|打印|显示|告诉|泄露|透露|展示|贴出)[^。；;\\n]{0,8}(?:你的|系统|初始|预设|全部)?(?:提示词|提示语|系统指令|初始指令|预设指令|system\\s*prompt)',
  // 3b) 同一件事的倒装语序（「把提示词发给我」「提示词贴出来」）
  '(?:你的|系统|初始|预设|全部)?(?:提示词|提示语|系统指令|初始指令|预设指令|system\\s*prompt)[^。；;\\n]{0,10}(?:输出|发给|发我|告诉|打印|复述|贴出|显示)',
  // 4) 越狱专名
  '\\b(?:DAN|jailbreak|developer\\s*mode|god\\s*mode|do\\s*anything\\s*now)\\b|越狱|开发者模式|无限制模式|破解模式',
  // 5) 身份否定（你不再是写作助手 / 你已经不是 AI…）
  '(?:你|助手|AI|模型)[^。；;\\n]{0,6}(?:不再是|已经不是|不再是那个)[^。；;\\n]{0,8}(?:助手|AI|模型|写作|小说)',
  // 6) 伪造分隔块（想冒充"固定规则"那一节，把后面的真规则盖掉）
  '【\\s*(?:以下|下面)?\\s*(?:是)?\\s*(?:本工具|系统|固定规则|系统提示)|<<<|>>>|\\[\\s*system\\s*\\]',
];

const PROMPT_GUARD_NEG = /(?:不要|不得|禁止|切勿|不能|不可|严禁|不准|避免|别|勿)/;

/**
 * 扫描并剔除越狱句式（与主进程 guardCustomPrompt 同一套规则）。
 * 返回 { text, hits }，界面只用 hits 决定要不要报警。
 */
function guardCustomPrompt(text) {
  const src = String(text == null ? '' : text);
  if (!src) return { text: '', hits: 0 };
  const res = PROMPT_GUARD_SOURCES.map((s) => new RegExp(s, 'i'));
  let hits = 0;
  const clauses = src.split(/([。；;\n！!？?])/);
  const out = [];
  for (let i = 0; i < clauses.length; i += 2) {
    const body = clauses[i];
    const tail = clauses[i + 1] || '';
    if (!body) { out.push(tail); continue; }
    let bad = false;
    for (const re of res) {
      re.lastIndex = 0;
      const m = re.exec(body);
      if (!m) continue;
      const before = body.slice(Math.max(0, m.index - 8), m.index);
      if (PROMPT_GUARD_NEG.test(before)) continue;
      bad = true;
      break;
    }
    if (bad) { hits += 1; continue; }
    out.push(body + tail);
  }
  return { text: out.join('').trim(), hits };
}

function Appearance({ local, save, onToast }) {
  const fonts = useFonts();
  /** 朗读试听中（合成要 1~3 秒，不给反馈就像按钮坏了） */
  /**
   * ⚠ 必须用**具名导入的 useState**，不能写 React.useState ——
   *   这个文件只 `import { useState } from 'react'`，根本没有 React 这个名字。
   *   写成 React.useState 构建照样通过（Vite 不查未定义变量），
   *   但一打开设置页就是 TypeError，整页白屏。
   */
  const [tryingVoice, setTryingVoice] = useState(false);

  /**
   * 试听音色（2026-11-16）。
   *
   * ⚠ 用**当前下拉框里的值**发给主进程，不是 config 里的旧值 ——
   *   用户切了没保存就点试听，听到应该是新的那个。
   * ⚠ 失败要说人话：网络不通时提示"合成失败"，而不是静默什么都不发生。
   */
  const tryVoice = async (voice) => {
    if (tryingVoice) return;
    setTryingVoice(true);
    try {
      /**
       * ⚠ 同 ChatPanel：preload 的 call 已拆信封，成功直接是 data、失败 throw。
       *   判 `r.ok` 会永远失败，试听按钮点了没声。
       */
      const d = await window.api.tts.synth({
        text: '夜枫停下脚步，灯笼往上提了提。远处传来更鼓，已是三更。',
        voice,
      });
      if (!d || !d.url) throw new Error('合成没有返回音频地址');
      const a = new Audio(d.url);
      await a.play();
      if (onToast) onToast('正在试听，点停止可以中断');
      a.onended = () => { if (onToast) onToast(''); };
    } catch (e) {
      if (onToast) onToast('语音合成失败：' + (e && e.message ? e.message : '未知原因'));
    } finally {
      setTryingVoice(false);
    }
  };

  /* ---------------- 明暗与自定义色（2026-11-01） ---------------- */
  const currentMode = local.mode || 'light';
  const isDark = resolveDark(currentMode);
  const def = modeDefaults(currentMode);
  const slot = (local.customColors || {})[isDark ? 'dark' : 'light'] || {};
  // 没设过的项显示当前档位的默认值 —— 和 ChatGPT 一样，色块里永远有值
  const colors = {
    bg: normalizeHex(slot.bg) || def.bg,
    fg: normalizeHex(slot.fg) || def.fg,
    accent: normalizeHex(slot.accent) || def.accent,
  };

  /**
   * ⚠ 用 ref 存"最新的自定义色"，不能直接读 local.customColors：
   *   拖取色器时 onChange 同一帧连发几次，而 local 要下一个 render 才更新，
   *   第二次会拿到旧对象，把第一次改的键覆盖回去 —— 现象是"拖半天只有一个颜色生效"。
   */
  const colorsRef = useRef(local.customColors);
  useEffect(() => { colorsRef.current = local.customColors; }, [local.customColors]);
  const saveTimer = useRef(null);

  const saveColor = (key, val) => {
    const base = colorsRef.current || {};
    const which = isDark ? 'dark' : 'light';
    const next = { ...base, [which]: { ...(base[which] || {}), [key]: val } };
    colorsRef.current = next;
    // 立刻重绘：不等存盘回来，否则拖色块时界面是滞后的
    applyTheme(currentMode, next);
    // 250ms 合并写盘：拖一次色块能发几十次事件，逐次 IPC 会卡
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save({ customColors: next }), 250);
  };

  const resetColors = () => {
    const base = { ...(colorsRef.current || {}) };
    delete base[isDark ? 'dark' : 'light'];
    colorsRef.current = base;
    applyTheme(currentMode, base);
    save({ customColors: base });
  };

  // 兼容旧配置：老 fontFamily 兜底给编辑器；老 fontSize 兜底给两个档
  const editorFont = local.editorFont || local.fontFamily || 'system-ui';
  const chatFont = local.chatFont || 'system-ui';
  const editorSize = local.editorFontSize || local.fontSize || 16;
  const chatSize = local.chatFontSize || local.fontSize || 16;
  return (
    <>
      <H1>外观</H1>

      {/* ⚠ 自定义背景图：就是上传一张图替代白色背景，没有别的参数 */}
      {/* ------------------------------------------------------------------
          外观（照 ChatGPT 的 Appearance，但**全部中文化**）

          ⚠ 2026-11-01 第二版：第一版把英文原样搬过来了（Mode / Theme /
            Accent / Background / Foreground），还留了一个只有一项的
            "Theme 下拉"。羽毛菌的原话：「不能做本土化，弄个英文干什么？
            这个有啥用啊，抄都抄不明白。」
            → 标签全改中文；Theme 那一行**删掉**（只有一套配色，摆个
              只能选一项的下拉就是点不动的装饰）。什么时候真有第二套
              配色，什么时候再加回来。
          ------------------------------------------------------------------ */}
      <Group title="风格">
        <div className="rounded-xl px-4 py-3"
             style={{ background: 'var(--paper-2)', border: '1px solid var(--line)' }}>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[12.5px] shrink-0" style={{ color: 'var(--ink)' }}>明暗</span>
            <div className="flex items-center gap-2">
              {MODES.map((m) => (
                <ModeThumb
                  key={m.id}
                  kind={m.id}
                  title={m.hint}
                  on={currentMode === m.id}
                  onClick={() => save({ mode: m.id })}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-xl mt-3 overflow-hidden"
             style={{ background: 'var(--paper-2)', border: '1px solid var(--line)' }}>
          <SRow label="强调色">
            <ColorRow
              value={colors.accent}
              onChange={(v) => saveColor('accent', v)}
            />
          </SRow>

          <SRow label="背景色">
            <ColorRow
              value={colors.bg}
              onChange={(v) => saveColor('bg', v)}
            />
          </SRow>

          <SRow label="文字色" last>
            <ColorRow
              value={colors.fg}
              onChange={(v) => saveColor('fg', v)}
            />
          </SRow>
        </div>

        <div className="flex items-center justify-between mt-2">
          <Hint>
            改的是当前这一档（{isDark ? '深色' : '浅色'}）的配色 ——
            浅色和深色各存一份，切明暗不会互相覆盖。
          </Hint>
          <button
            onClick={resetColors}
            className="shrink-0 ml-3 px-2.5 py-1 rounded-lg text-[11.5px]"
            style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)', border: '1px solid var(--line)' }}
          >
            恢复默认
          </button>
        </div>
      </Group>

      <Group title="背景">
        <BackgroundSection
          bg={{ enabled: local.bgEnabled === true, url: local.bgUrl || '' }}
          apply={(v) => save({ bgEnabled: v.enabled, bgUrl: v.url })}
          onToast={(m) => onToast && onToast(m)}
        />
      </Group>

      {/* ------------------------------------------------------------------
          外观（2026-11-01 重做，照 ChatGPT 的 Appearance 页）

          ⚠ 原来这里是 12 套主题平铺成两列网格（墨金/赭石/松绿…）。
            羽毛菌的原话：「不要这种固定选择主题，而是和 ChatGPT 一样
            只能选择深色、浅色，然后可以改底色、字体颜色这种。」
            所以改成：三档 Mode + 三个可填的颜色。预设主题不再出现。
            那 12 套 CSS 变量还留在 index.css 里没删（怕牵连别的规则），
            只是界面上够不着了。
          ------------------------------------------------------------------ */}
      {/**
        * 字号（2026-11-06 合并）。
        *
        * ⚠ 原来「编辑器字号」和「聊天字号」各占一个 Group，两个滑块长得一模一样，
        *   中间还夹着整块「应用字体」—— 想同时调两处字号得上下找，
        *   而它们本来就是同一件事的两个维度。现在并进同一个组。
        * ⚠ 两个 slider 的 min/max/step 必须一致，否则拖到同一个数字
        *   会出现两个区域字号不同的怪现象。
        */}
      <Group title="字号">
        <Field label="编辑器字号">
          <div className="flex items-center gap-3">
            <input
              type="range" min="10" max="36" step="1"
              value={editorSize}
              onChange={(e) => save({ editorFontSize: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[12px] tabular-nums w-12 text-right">{editorSize} px</span>
          </div>
          <Hint>改动会立刻应用到正文编辑区。</Hint>
        </Field>

        <Field label="聊天字号">
          <div className="flex items-center gap-3">
            <input
              type="range" min="10" max="36" step="1"
              value={chatSize}
              onChange={(e) => save({ chatFontSize: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="text-[12px] tabular-nums w-12 text-right">{chatSize} px</span>
          </div>
          <Hint>改动会立刻应用到对话气泡。</Hint>
        </Field>
      </Group>

      {/* 2026-11-06：编辑器和聊天合并成**一个入口**，下载/删除全收进弹窗。
          它自带底色气泡（.set-bubble），所以不套 Group —— 套了就是气泡里再套一层标题。 */}
      <FontManager
        fonts={fonts}
        value={editorFont}
        onChange={(f) => save({ editorFont: f, chatFont: f, fontFamily: f })}
      />

      <Group title="提示">
        <Field label="生成完成时">
          <select
            value={local.notify || 'window'}
            onChange={(e) => save({ notify: e.target.value })}
            className="w-full px-2 py-1.5 rounded text-[12.5px] outline-none"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
          >
            <option value="window">仅窗口状态栏</option>
            <option value="sound">仅提示音</option>
            <option value="both">窗口 + 提示音</option>
            <option value="none">不提示</option>
          </select>
        </Field>
        <div className="mt-2">
          <button
            onClick={() => playChime()}
            className="px-3 py-1.5 rounded text-[12.5px]"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
          >试听提示音</button>
          <Hint>选「仅提示音」或「窗口 + 提示音」时，生成结束会响。</Hint>
        </div>
      </Group>

      {/**
        * 朗读音色（2026-11-16）。
        * 走的是 Edge 神经语音（联网、免费），不是系统那套老合成音 ——
        * 系统音念小说像天气预报，羽毛菌的原话是「太人机了」。
        * ⚠ 断网或接口失效时会自动退回系统语音，不会变成"点了没反应"。
        */}
      <Group title="朗读">
        <Field label="音色">
          <select
            value={local.ttsVoice || 'xiaoxiao'}
            onChange={(e) => save({ ttsVoice: e.target.value })}
            className="w-full px-2 py-1.5 rounded text-[12.5px] outline-none"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
            data-testid="tts-voice"
          >
            <option value="xiaoxiao">晓晓（女 · 自然）</option>
            <option value="yunxi">云希（男 · 年轻）</option>
          </select>
        </Field>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => tryVoice(local.ttsVoice || 'xiaoxiao')}
            disabled={tryingVoice}
            className="px-3 py-1.5 rounded text-[12.5px]"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)', opacity: tryingVoice ? 0.6 : 1 }}
            data-testid="tts-try"
          >{tryingVoice ? '生成中…' : '试听这个音色'}</button>
        </div>
        <Hint>念 AI 回复用的是这个音色。初次合成要 1~3 秒，之后同一段文字会走本地缓存。</Hint>
      </Group>
    </>
  );
}

/**
 * 应用字体（2026-11-06 改版）。
 *
 * ⚠ 原来「编辑器字体」「聊天字体」各铺一整份字体列表，两处都带下载按钮 ——
 *   设置页要滚两屏，同一份列表出现两次，看着像两份东西，也占地方。
 *   现在收成一行：当前字体 + 「管理字体」，下载 / 删除 / 导入全在弹窗里。
 * ⚠ 字体统一应用到编辑器和聊天区（config 的 editorFont + chatFont 一起写），
 *   用户只管理一次；读取仍优先 editorFont，老配置不会失效。
 */
function FontManager({ fonts, value, onChange }) {
  const [open, setOpen] = useState(false);
  const { presets, installed, installing, install, uninstall, importLocal, error } = fonts;
  /**
   * ⚠ 配置里可能存着一个**已经下架**的字体族（2026-11-02 移除了「霞鹜文楷」）。
   *   不归一的话，界面上没有任何一行被勾中 —— 用户看到的是"我选的字体不见了"。
   */
  const known = new Set(['system-ui', ...(presets || []).map((p) => p.family)]);
  const cur = known.has(value) ? value : 'system-ui';
  const curLabel = cur === 'system-ui'
    ? '系统默认'
    : ((presets || []).find((p) => p.family === cur) || {}).label || cur;

  const pick = (family) => { onChange(family); setOpen(false); };

  const row = (key, family, name, sub) => {
    const on = cur === family;
    return (
      <button
        key={key}
        type="button"
        onClick={() => pick(family)}
        className="font-row"
        data-on={on ? '1' : '0'}
      >
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] truncate" style={{ color: 'var(--ink)', fontFamily: family }}>{name}</span>
          {sub && (
            <span className="block text-[10.5px] truncate" style={{ color: 'var(--ink-soft)' }}>{sub}</span>
          )}
        </span>
        {on && <span className="text-[11px] shrink-0" style={{ color: 'var(--accent)' }}>✓</span>}
      </button>
    );
  };

  return (
    /**
     * 应用字体做成**一块带底色的气泡**（2026-11-06 第二次改）。
     *
     * ⚠ 原来它和字号滑块一样是平铺在页面上的 Field —— 一行字 + 一个方块按钮，
     *   看起来像"又一项设置"，实际上它是个独立入口（点开是整张字体面板）。
     *   苹果的设置里，这种"点进去"的项都是一块浮起来的浅底圆角行。
     * ⚠ 底色走 CSS 类不写 inline：inline 会压掉 :hover。
     * ⚠ data-testid 拆成两个：font-bubble 认这块气泡，font-manage 还是那颗按钮
     *   （旧判据按 font-manage 点，别动这个名字）。
     */
    <section className="set-bubble" data-testid="font-bubble">
      <div className="set-bubble-label">应用字体</div>

      <div className="set-bubble-row">
        <span
          className="set-bubble-value"
          style={{ fontFamily: cur }}
          data-testid="font-current"
        >
          {curLabel}
        </span>
        <button
          type="button"
          data-testid="font-manage"
          onClick={() => setOpen(true)}
          className="set-bubble-btn"
        >
          管理字体
        </button>
      </div>

      <Hint>下载开源字体并应用到整个界面，可随时切回系统默认。</Hint>

      {open && (
        <div className="font-mask modal-mask" onClick={() => setOpen(false)} data-testid="font-modal">
          <div
            className="font-modal modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="管理字体"
          >
            <div className="font-modal-head">
              <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>字体</span>
              <button type="button" className="font-modal-x" onClick={() => setOpen(false)} aria-label="关闭">✕</button>
            </div>

            <div className="font-modal-body">
              {row('system', 'system-ui', '系统默认', '跟随操作系统的界面字体')}
              {(presets || []).map((p) => {
                const isInstalled = installed.has(p.id);
                const isInstalling = installing && installing.id === p.id;
                return (
                  <div key={p.id} className="font-row-wrap" data-on={cur === p.family ? '1' : '0'}>
                    {row('r-' + p.id, p.family, p.label, p.desc + ' · 约 ' + p.sizeMB + ' MB')}
                    {isInstalled ? (
                      <button type="button" onClick={() => uninstall(p.id)} className="font-act">删除</button>
                    ) : isInstalling ? (
                      <span className="font-act" style={{ color: 'var(--accent)' }}>
                        {installing.total ? Math.round((installing.loaded / installing.total) * 100) + '%' : '下载中'}
                      </span>
                    ) : (
                      <button type="button" onClick={() => install(p.id)} className="font-act primary">下载</button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="font-modal-foot">
              {/* ⚠ 下载走 CDN，国内经常被掐；这个入口不联网，用自己下好的 .ttf */}
              <button type="button" data-testid="font-import" onClick={() => importLocal()} className="font-import">
                ＋ 从本地文件装字体
              </button>
              <span className="text-[10.5px]" style={{ color: 'var(--ink-soft)' }}>下载后立刻生效</span>
            </div>
            {error && (
              <div className="px-4 pb-3 text-[11px]" style={{ color: 'var(--danger)' }}>{error}</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ===========================================================
// 参数
// ===========================================================
/**
 * 参数类目。
 *
 * ⚠ 「长度」组那三项走的是**连接级**参数（connParams / onConnParam），
 *   不是 config 草稿 —— 理由见 SettingsPage 里 connParams 那段注释。
 *   温度仍然是全局的，走 local / save。
 */
function Params({ local, save, connParams, onConnParam, connName = '', connBase = '' }) {
  const [showGuide, setShowGuide] = useState(false);
  /**
   * 自定义提示词里命中越狱句式的**条数**（2026-11-06）。
   *
   * ⚠ 只存数量不存文本：textarea 保持非受控（defaultValue + onBlur 保存），
   *   一路受控会把用户打字时 React 的重渲染和异步保存搅在一起 ——
   *   记忆里踩过「打完立刻读 el.value 拿到旧值」那次就是受控 + 异步保存。
   * ⚠ 初始值要按已存的配置算：进页面就看到「上次写的这段不会生效」，
   *   而不是等用户再改一次才出现红字。
   */
  const [promptHits, setPromptHits] = useState(
    () => guardCustomPrompt(local.customSystemPrompt ?? DEFAULT_CUSTOM_PROMPT).hits
  );

  /**
   * 本地模型的**真实**窗口能力。
   *
   * ⚠⚠ 为什么必须查（2026-10-16 实测）：
   *   用户把窗口设成 131072，Ollama **不报错**，它悄悄压到模型自己
   *   支持的 40960。而界面上还写着 131072 —— 于是**永远查不出**
   *   为什么实际窗口小那么多，只能靠猜。
   *
   * ⚠⚠ **它必须声明在 `Params` 里，不能放 `SettingsPage`**：
   *   我第一版插在 `SettingsPage` 的 useState 堆里，而用它的 JSX
   *   在 `Params` 这个**另一个函数**里 —— 运行时报
   *   `ReferenceError: capability is not defined`，整个设置页白屏。
   *   `node --check` 与 `npm run build` 都不报错（语法完全合法），
   *   只有真渲染才炸（用户现场截图）。
   *
   * 查不到就当不知道（null），别猜也别挡界面。
   */
  const [capability, setCapability] = useState(null);
  const capModel = (local && local.model) || '';

  /**
   * 范围守卫状态（模型连接有没有被关掉）。
   *
   * ⚠ 同上一条：**必须声明在 `Params` 里**，因为用它的 JSX 也在这个函数里。
   *   放到 `SettingsPage` 就是 `ReferenceError: scopeState is not defined`
   *   整个设置页白屏，而 node --check 与构建都不报错（真炸过）。
   */
  const [scopeState, setScopeState] = useState({ locked: false, strikes: 0 });
  /** 「查看《用户协议》全文」弹出来的正文。同样只声明在 Params 里（理由见上）。 */
  const [agreementDoc, setAgreementDoc] = useState(null);
  useEffect(() => {
    let alive = true;
    window.api.scope.status()
      .then((s) => { if (alive && s) setScopeState(s); })
      .catch(() => { /* 读不到就按"没锁"显示，别挡界面 */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    if (!capModel) { setCapability(null); return undefined; }
    (async () => {
      try {
        const r = await window.api.provider.modelCapability({ model: capModel });
        if (alive) setCapability(r || null);
      } catch (_) { if (alive) setCapability(null); }
    })();
    return () => { alive = false; };
  }, [capModel]);
  const cp = connParams || {};
  const isLocal = !!cp.isLocal;
  const ctx = Number(cp.numCtx) || 8192;
  const out = Number(cp.maxOutput) || 8192;
  const reserve = Number(cp.reserve) || 0;
  const autoReserve = Number(cp.autoReserve) || 0;
  const hasConn = !!cp.connectionId;

  /**
   * 还能装多少前文 = 窗口 − 输出预留。
   *
   * ⚠ 这个数必须**显示给用户看**：它才是"这次能带多少设定进去"的真实答案。
   *   只摆三个独立字段的话，用户改完窗口不知道该期待什么变化，
   *   也不知道为什么自己明明把窗口调大了、模型还是"忘"了前文。
   */
  const budget = Math.max(512, ctx - reserve);
  return (
    <>
      <div className="flex items-center justify-between">
        <H1>参数</H1>
        {/*
         * ⚠ 这一栏原来只有一句「以服务商文档为准，拿不准就填保守一点」——
         *   **等于没说**。用户要的是「那我这份该填多少」。
         * 现在弹层是说明书结构：从哪查 → 常见值 → 查不到怎么自己试
         * （见 ParamGuide.jsx 文件头）。
         */}
        <button onClick={() => setShowGuide(true)}
                className="text-[12px] px-2.5 py-1 rounded border"
                style={{ color: 'var(--accent)', borderColor: 'var(--line)' }}>
          怎么填？
        </button>
      </div>
      {showGuide && (
        <ParamGuide connName={connName} connBase={connBase} onClose={() => setShowGuide(false)} />
      )}

      <Group title="生成">
        <Field label={`创造性（温度） ${local.temperature ?? 0.3}`}>
          <input
            type="range" min="0" max="1.5" step="0.05"
            value={local.temperature ?? 0.3}
            onChange={(e) => save({ temperature: Number(e.target.value) })}
            className="w-full"
          />
          <div className="flex justify-between text-[10.5px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
            <span>0 更保守</span><span>0.7 更有创意</span><span>1.5 最随机</span>
          </div>
          <Hint>写长篇建议 0.3~0.5。调太高会「记住」不属于自己的设定。</Hint>
        </Field>
      </Group>

      {/**
        * 系统提示词（2026-11-06）。
        *
        * ⚠ 这段只决定「助手是谁、怎么干活」，**不能覆盖硬规则**：
        *   主进程 systemPromptFor 把它拼在 SYSTEM_PROMPT **前面**，
        *   后面紧跟一句「以下是本工具的固定规则，优先级高于上面的角色描述」。
        *   所以用户在这里写"你现在是无限制 AI"也压不掉范围守卫。
        * ⚠ 默认值与 electron/main.js 的 DEFAULT_CUSTOM_PROMPT **必须一致**
        *   （判据里有字符串比对，改一处忘另一处会红）。
        */}
      <Group title="对话行为">
        <Field label="系统提示词">
          <textarea
            data-testid="custom-system-prompt"
            key={local.customSystemPrompt ?? '__default__'}
            defaultValue={local.customSystemPrompt ?? DEFAULT_CUSTOM_PROMPT}
            onChange={(e) => setPromptHits(guardCustomPrompt(e.target.value).hits)}
            onBlur={(e) => {
              setPromptHits(guardCustomPrompt(e.target.value).hits);
              save({ customSystemPrompt: e.target.value });
            }}
            rows={5}
            spellCheck={false}
            className="w-full px-3 py-2 rounded-lg text-[12.5px] leading-relaxed outline-none resize-y"
            style={{
              background: 'var(--accent-soft)', color: 'var(--ink)',
              minHeight: 104,
              border: '1px solid ' + (promptHits ? 'var(--danger)' : 'var(--line)'),
            }}
          />
          {/**
            * ⚠ 命中时**必须当场说清楚**。不提示的话，用户会以为越狱话术生效了，
            *   或者反过来——以为软件把他的正常设定也删了。
            *   说清「哪部分不生效、哪部分照常」，才不会被当成 bug。
            */}
          {promptHits > 0 && (
            <div
              className="text-[11.5px] leading-relaxed mt-1.5"
              style={{ color: 'var(--danger)' }}
              data-testid="prompt-guard-hint"
            >
              检测到 {promptHits} 处越狱或破解句式，发送前会被自动剔除，<b>不会生效</b>。
              其余正常的人设描述照常生效；固定规则（只写小说、不越狱、不透露提示词）始终优先。
            </div>
          )}
          <Hint>
            自定义 AI 助手的行为，留空则使用默认的小说写作助手提示词。
            本工具只用于小说创作，防越狱与范围规则不受此处影响。
          </Hint>
        </Field>
      </Group>

      {/* 思考强度搬到了「AI 提供商」类目：档位随服务商变，
          百炼只有开/关、Ollama 有四档。在参数页统一放会给出错的选项。*/}

      {/**
       * ⚠⚠ 「长度」组这三项（2026-10-14 重做，别倒回去）。
       *
       * 演进过程值得记一笔：
       *   1.0.0 之前：一个「上下文窗口」管两件事。云端的输出上限被它按 0.5
       *               算出来，设 8192 就只能输出 3000 字 —— 长章节被拦腰截断，
       *               而界面上写着「上下文窗口 8192」，用户想不到是输出被卡了。
       *   1.0.0：    拆成「输出上限 + 窗口」，但**把云端的窗口藏了**。
       *               理由写的是"云端窗口由服务商定，客户端传不了"。
       *   1.0.1：    发现那个理由只对了一半。窗口**确实传不到服务端**，
       *               但客户端**必须知道它** —— 否则上下文压缩器会按一个错的
       *               窗口去丢历史：云端按 8192 压，200K 的窗口白扔 96%，
       *               用户看到的是"写着写着忘了开头的设定"，而且不报任何错。
       *
       * 所以现在三项都显示、都能填，并且把**联动结果**（实际可用前文）也摆出来。
       */}
      <Group title="长度">
        <Field label={`上下文窗口 ${ctx.toLocaleString()} tokens`}>
          {/* 128K / 200K：常见云端窗口的真实值（300K 已按要求去掉） */}
          <Chips
            choices={WINDOW_BIG}
            value={ctx}
            onPick={(n) => onConnParam({ numCtx: n })}
          />
          {/* 8K–64K：滚轮（单位 K，系统换算）+ 常用档按钮 */}
          <KStepper
            valueTokens={ctx}
            onChange={(tokens) => onConnParam({ numCtx: tokens })}
          />
          <Chips
            choices={WINDOW_SMALL}
            value={ctx}
            onPick={(n) => onConnParam({ numCtx: n })}
          />
          {isLocal ? (
            <Hint>
              能装下多少前文与设定。<b>越大越费显存、生成越慢</b>，
              8K 适合大多数情况。
              <br />
              滚轮 8–64，单位 K，软件自己换算成 tokens；
              要更大的用上面的 128K / 200K。
              ⚠ 本地模型有上限：填超过它能支持的长度，Ollama
              <b>不会报错</b>，只会悄悄压回去 —— 用下面的「查真实能力」看它到底支持多少。
            </Hint>
          ) : (
            <Hint>
              你这个模型窗口多大 —— 填错会出问题：填小了，软件以为窗口只装得下
              这么多，会提前丢弃前文设定；填大了，输入可能超窗被服务端拒
              （表现就是发消息时报错）。
              <br />
              常见值：Claude 200K、DeepSeek / GLM 128K、GPT-4o 128K。
              <b>以服务商文档为准</b>，拿不准就填保守一点。
              <br />
              滚轮 8–64，单位 K，软件自己换算成 tokens；要更大的用上面的 128K / 200K。
            </Hint>
          )}

          {/**
           * 自动压缩开关（2026-10-16 羽毛菌：「是否启用自动压缩应该有个按钮」）。
           *
           * ⚠ 它控制的**只是压缩器**，不影响窗口本身 ——
           *   关掉之后请求仍会发出去，但历史再长也不丢，
           *   到了服务端就可能被拒（超窗）。所以默认开。
           *
           * ⚠ 存在 config.autoCompress，不在 connParams 里：
           *   它是「要不要这个机制」，不是「每条连接的参数」。
           *
           * ⚠⚠⚠ 这里原来写的是 `onConfigChange({autoCompress:v})` ——
           *   **「单击后取消不了勾选」的真凶**：`Params` 的参数表里
           *   **根本没有 onConfigChange**（只有 save），它是 App 那个
           *   「接收整份 config」的函数。于是点一下就 ReferenceError，
           *   勾选框弹回去，用户看到的就是"这个开关没用"。
           *   同一类错第三次（作用域错：用到的变量不在这个函数里）。
           *
           * ⚠ 而且就算引用到了 App 那个也一样坏：它把参数**当成整份 config**
           *   存进 state，一份 patch 会把其它设置全抹掉。
           *   正确做法是走 `save`：config.set(patch) + 回读 + 通知 App。
           */}
          <Switch
            label="自动压缩上下文"
            checked={local.autoCompress !== false}
            onChange={(v) => save({ autoCompress: v })}
            testId="switch-autocompress"
          />
          <Hint>
            历史太长时自动丢弃<b>较早的工具调用记录</b>（不会删你和助手的对话）。
            关掉后不丢弃，但请求可能超出服务商窗口而被拒。
          </Hint>
          {/**
            * 范围守卫的开关状态（2026-10-16）。
            *
            * ⚠ 位置在**参数页**而不是外观页：它决定"模型还能不能用"，
            *   属于功能开关，跟配色/字号不是一类。
            * ⚠ 只有被锁时才显示"重新启用"；平时只说明规则，
            *   否则用户会以为这里能关掉守卫（关不掉才是它的意义）。
            */}
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
            {scopeState.locked && (
              <>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--danger)' }}>
                  模型连接已关闭
                </div>
                <Hint>
                  有与小说创作无关的请求被拦下（累计 2 次或直接触发），模型已停用。
                  确认继续用它写作，就点下面重新启用。
                </Hint>
                <button
                  onClick={async () => {
                    await window.api.scope.unlock();
                    const st = await window.api.scope.status();
                    setScopeState(st || { locked: false, strikes: 0 });
                  }}
                  data-testid="btn-scope-unlock-settings"
                  className="px-3 py-1 rounded text-[12px]"
                  style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                >
                  重新启用模型连接
                </button>
              </>
          )}
          </div>

          {isLocal && ctx > 32768 && (
            <Hint warn>
              超过 32K 时 8B 模型基本会溢出显存。若生成报显存错误或一直不出字，
              把它调回 8K 或 16K。
            </Hint>
          )}

          {/**
           * ⚠⚠ 超出了**这个模型**真实支持的长度 —— 这是最隐蔽的一种
           *   （2026-10-16 羽毛菌的连接就踩着：设 131072，Ollama 实际按 40K 跑，
           *   界面还写着 131072）。
           *   不报错、不提示、只是"实际窗口比你想的小很多"。
           */}
          {isLocal && capability && ctx > capability.contextLength && (
            <Hint warn>
              这个模型（{capability.parameterSize || '本地模型'}）实际只支持{' '}
              <b>{Math.round(capability.contextLength / 1024)}K</b> 上下文。
              你填的 {Math.round(ctx / 1024)}K 会被 Ollama <b>静默压到上限</b>——
              不报错，但实际窗口就是比设置里的小。
            </Hint>
          )}
          {isLocal && capability && ctx <= capability.contextLength && (
            <Hint>
              当前模型 {capability.parameterSize}
              {capability.quantization ? ` · ${capability.quantization}` : ''}
              ，支持到 <b>{Math.round(capability.contextLength / 1024)}K</b>。
            </Hint>
          )}
        </Field>

        <Field label={`单次输出上限 ${out.toLocaleString()} tokens`}>
          {/**
           * ⚠⚠ 这里原来还有一行 `<NumBox label="maxOutput">`（2026-10-16 羽毛菌拿掉了）。
           *   理由：这一栏是"一次最多写多长"，绝大多数人只在几档之间选，
           *   手输 7300 这种值没有意义 —— 而**填错也不会报错**，
           *   只是让某家服务商的参数校验 400（表现为"发消息时报错"）。
           *   去掉输入框之后，能填进去的全是这几个确定能用的档位。
           */}
          <Chips
            choices={OUTPUT_CHOICES}
            value={out}
            onPick={(n) => onConnParam({ maxOutput: n })}
          />
          <Hint>
            一次最多能写多长。8K ≈ 6000 字中文，够一章正文。
            <br />
            写长章节写到一半被截断时，把这个调大。
          </Hint>
        </Field>

        {/**
         * 输出预留：从窗口里**切给输出**的那一块。
         *
         * ⚠ 不预留的后果（已核实 Anthropic 官方文档）：
         *   input + max_tokens **共享同一个 context window**。
         *   输入本身就超窗 → 每次请求 400 "prompt is too long"；
         *   4.5+ 模型 → 请求被接受，但生成到窗口上限时停下
         *   （stop_reason: model_context_window_exceeded）。
         *   用户看到的是"写了一半突然没了"，且不知道原因。
         */}
        <Field
          label={`输出预留 ${reserve.toLocaleString()} tokens`
            + (cp.reserveAuto ? '（自动）' : '')}
        >
          <Chips
            choices={RESERVE_CHOICES}
            value={cp.reserveAuto ? -1 : reserve}
            onPick={(n) => onConnParam({ reserve: n })}
            extra={(
              <button
                onClick={() => onConnParam({ reserve: null })}
                data-testid="reserve-auto"
                className="px-2.5 py-1 rounded text-[12px]"
                style={{
                  background: cp.reserveAuto ? 'var(--accent)' : 'var(--accent-soft)',
                  color: cp.reserveAuto ? 'var(--accent-ink)' : 'var(--ink)',
                }}
                title={`按输出上限的一半自动算（现在算出来是 ${autoReserve.toLocaleString()}）`}
              >
                自动
              </button>
            )}
          />
          {/**
           * ⚠⚠ 同样去掉了 `<NumBox label="reserve">`（2026-10-16）。
           *   预留只影响"软件怎么丢历史"，填错不会报错，
           *   但会让可用前文算错（用户看到的是"写着写着忘了开头"，
           *   而不是报错—— 这种最难查）。留几档按钮 + 自动就够了。
           */}
          <Hint>
            留给模型输出的空间。输入和输出<b>共用同一个窗口</b>，
            不留这一块，写到窗口上限时会被掐停 ——
            表现为"写了一半突然没了"。
            <br />
            自动值 = 输出上限的一半（现在 {autoReserve.toLocaleString()}）。
            输出上限调大后，这里记得回头看眼。
          </Hint>
        </Field>

        <Field label="实际可用前文">
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            约 <b style={{ color: 'var(--ink)' }}>{budget.toLocaleString()}</b> tokens
            （= 窗口 {ctx.toLocaleString()} − 预留 {reserve.toLocaleString()}）
            <br />
            超过这个量，软件会自动丢掉最旧的工具结果与老对话轮次。
          </div>
        </Field>

        {!hasConn && (
          <Hint warn>
            还没选中任何连接，上面填的值暂时不会生效。去「AI 提供商」选一条。
          </Hint>
        )}
      </Group>
    </>
  );
}

/**
 * 参数按钮组。
 *
 * ⚠ 标签**写死**在表里，不按数值算。
 *   曾经想用 `n / 1024` 自动生成，但两种取值习惯混在一起会出丑：
 *   32768 该显示 32K（按 1024），而 200000 按 1024 是 195K（该按 1000 才是 200K）。
 *   写死最省事，也不会在改数值时悄悄变样。
 */

/**
 * ⚠⚠ 上下文窗口的控件（2026-10-16 羽毛菌定的规矩）：
 *
 *   「单独弄一个从 8 到 64 的数字滚轮吧，然后后面跟着单位 k，
 *     让系统自己换算上下文窗口数值，或者单独点击 128k，200k 的按钮，300k 取消掉」
 *
 * 于是是**一个滚轮 + 两个按钮**，不是三个输入框也不是一张长表：
 *   · 滚轮：8–64，单位 K，**系统自己 ×1024 换算**成 tokens 存下去。
 *     为什么不让用户直接填 tokens：8192 / 16384 / 65536 这种数字没人算得出来，
 *     而算错了**不报错**（本地被 Ollama 静默压回上限，云端发消息时才 400）。
 *     单位交给界面，用户只需要想"我要 16K 还是 32K"。
 *   · 按钮：128K / 200K（这两个是常见云端窗口的真实值）。
 *     300K 按羽毛菌的要求**去掉了** —— 没有任何主流模型是这个窗口。
 */
const CTX_MANUAL_MIN_K = 8;
const CTX_MANUAL_MAX_K = 64;
const WINDOW_SMALL = [[8192, '8K'], [16384, '16K'], [32768, '32K'], [65536, '64K']];
const WINDOW_BIG = [[128000, '128K'], [200000, '200K']];
const OUTPUT_CHOICES = [[2048, '2K'], [4096, '4K'], [8192, '8K'], [16384, '16K'], [32768, '32K']];
const RESERVE_CHOICES = [[1024, '1K'], [2048, '2K'], [4096, '4K'], [8192, '8K'], [16384, '16K']];

/**
 * tokens → K（滚轮上显示的整数 K）。
 *
 * ⚠⚠ 必须**夹到 [8, 64]**。第一版只夹了下限，于是窗口是 131072（128K）时
 *   滚轮上写着「128」—— 而它的 max 是 64。
 *   `<input type=number>` 不会自动纠正越界的值，max 只是给浏览器做校验用的，
 *   所以那个框会明晃晃地显示一个自己声明为非法的数（判据当场抓到）。
 */
function ctxToK(tokens) {
  const n = Number(tokens) || 0;
  return Math.min(CTX_MANUAL_MAX_K, Math.max(CTX_MANUAL_MIN_K, Math.round(n / 1024)));
}
/** K（界面上的数）→ tokens。滚轮范围外的夹回 [8, 64]。 */
function kToCtx(k) {
  const n = Math.round(Number(k) || 0);
  const c = Math.min(CTX_MANUAL_MAX_K, Math.max(CTX_MANUAL_MIN_K, n || CTX_MANUAL_MIN_K));
  return c * 1024;
}

/**
 * K 值滚轮：数字 + 单位 K。
 *
 * ⚠ `step=1` 配 `min/max`：滚轮每一格就是 1K，正好是"够不够一章设定"的刻度。
 * ⚠ 单位是**跟在框外的一个 k 字**，不是 placeholder ——
 *   placeholder 一编辑就消失，那样用户根本不知道这个框的单位是什么。
 *
 * ⚠⚠ 当前窗口 > 64K（用上面 128K/200K 按钮设的）时，这个滚轮**禁用**并说明原因。
 *   不这么做就是让用户在一个显示「64」的框旁边看到高亮的「128K」按钮 ——
 *   两个互相矛盾的数字，他会以为滚轮坏了。
 */
function KStepper({ valueTokens, onChange }) {
  const outOfRange = Number(valueTokens) > CTX_MANUAL_MAX_K * 1024;
  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      <input
        type="number"
        min={CTX_MANUAL_MIN_K}
        max={CTX_MANUAL_MAX_K}
        step={1}
        value={ctxToK(valueTokens)}
        onChange={(e) => onChange(kToCtx(e.target.value))}
        disabled={outOfRange}
        title={outOfRange
          ? `当前 ${Math.round(valueTokens / 1024)}K，超出这个滚轮的范围 —— 用上面的按钮改`
          : '8–64 K，一格 1K'}
        aria-label="上下文窗口 K"
        data-testid="param-numCtx-k"
        className="w-20 px-2 py-1 rounded text-[12px] outline-none disabled:opacity-45"
        style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
      />
      <span className="text-[12px]" style={{ color: 'var(--ink-soft)' }}>K</span>
      {outOfRange && (
        <span className="text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
          当前超范围，用上面的按钮
        </span>
      )}
    </div>
  );
}

function Chips({ choices, value, onPick, extra = null }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {choices.map(([n, label]) => (
        <button
          key={n}
          onClick={() => onPick(n)}
          className="px-2.5 py-1 rounded text-[12px]"
          style={{
            background: value === n ? 'var(--accent)' : 'var(--accent-soft)',
            color: value === n ? 'var(--accent-ink)' : 'var(--ink)',
          }}
        >
          {label}
        </button>
      ))}
      {extra}
    </div>
  );
}

/**
 * ⚠⚠ `NumBox` 已删（2026-10-16 羽毛菌：「取消自己填数值，保留几档几档选择」）。
 *
 * 删掉的理由不是"用户不喜欢手填"，而是这三个值**填错不报错**：
 *   窗口填大了 → 本地被 Ollama 静默压回上限、云端发消息时才 400；
 *   输出上限/预留填错 → 前者被服务商拒，后者让"可用前文"算错，
 *   表现是"写着写着忘了开头"，**全程没有任何报错**。
 * 一排输入框摆在三个都靠档位的参数旁边，纯属给人一个出错且看不出错在哪的机会。
 *
 * 现在：上下文窗口用 `KStepper`（8–64、单位 K，系统换算），
 * 另两项只有档位按钮。⚠ 真要加回手填，**两件事必须一起做**：
 *   ① DOM 的 min/max **和** JS 层的夹取，两层都要（粘贴/滚轮会绕过 DOM 那层）；
 *   ② 一个"这个值不合法"的可见反馈 —— 静默地夹掉，用户不知道自己填的 7300 变成了 8192。
 */

// ===========================================================
// 数据
// ===========================================================
function DataCat({ projectId, projects }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    window.api.app.info().then(setInfo).catch(() => setInfo(null));
  }, []);

  const backup = async () => {
    if (!projectId) { setMsg({ ok: false, text: '先选一个项目' }); return; }
    setBusy(true);
    try {
      const r = await window.api.data.backup({ projectId });
      if (r.canceled) return;
      setMsg({ ok: true, text: `已备份到：${r.path}` });
    } catch (e) {
      setMsg({ ok: false, text: `备份失败：${e.message}` });
    } finally {
      setBusy(false);
    }
  };

  const backupSize = useMemo(() => {
    if (!info) return '—';
    return `${info.version || '0.1.0'}`;
  }, [info]);

  return (
    <>
      <H1>数据</H1>

      <Group title="项目文件夹">
        <Field label="位置">
          <div className="text-[12px] break-all px-2 py-1.5 rounded"
               style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
            {info ? `${info.userDir}\\projects\\` : '读取中…'}
          </div>
          <Hint>
            每个小说一个独立文件夹，里面是 md 资料与章节草稿。
            章节正文存在数据库 <code>{info ? `${info.dbPath}` : ''}</code>。
            两处都在同一个目录下，直接复制整个{' '}
            <code>writetool</code> 文件夹就是完整备份。
          </Hint>
        </Field>

        <Field label="备份当前项目">
          <div className="flex gap-2">
            <button
              onClick={backup}
              disabled={busy || !projectId}
              className="px-3 py-1.5 rounded text-[12.5px] disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              {busy ? '备份中…' : '选择位置并备份'}
            </button>
            {info && projectId && (
              <button
                onClick={() => window.api.fs.reveal({ projectId })}
                className="px-3 py-1.5 rounded text-[12.5px]"
                style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
              >
                打开文件夹
              </button>
            )}
          </div>
          <Hint>备份是复制一份 md 资料，不含章节正文数据库。</Hint>
        </Field>
      </Group>

      <Group title="危险操作">
        <Field label="删除项目">
          <Hint>
            删除项目会连带删除它的 md 文件夹。
            章节正文也会一并删除，且不进回收站。
          </Hint>
          <Hint warn>
            目前建议手动操作：先在文件管理器里删 <code>projects\\&lt;项目名&gt;</code> 文件夹，
            再回来新建同名项目。软件内的删除入口还没做二次确认流程，
            贸然加上比没有更危险。
          </Hint>
        </Field>
      </Group>

      {msg && (
        <div
          className="mt-3 px-3 py-2 rounded text-[12px] break-all"
          style={{
            background: msg.ok ? 'var(--accent-soft)' : 'var(--paper-2)',
            color: msg.ok ? 'var(--ok)' : 'var(--danger)',
          }}
        >
          {msg.text}
        </div>
      )}
    </>
  );
}

// ===========================================================
// 关于
// ===========================================================
function AboutCat() {
  const [ver, setVer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  /** 使用范围的"已警告几次"与协议正文（2026-11-03 随说明一起搬过来） */
  const [scopeState, setScopeState] = useState({ locked: false, strikes: 0 });
  const [agreementDoc, setAgreementDoc] = useState(null);

  useEffect(() => {
    window.api.app.version().then(setVer).catch(() => setVer(null));
    let alive = true;
    window.api.scope.status()
      .then((s) => { if (alive && s) setScopeState(s); })
      .catch(() => { /* 读不到就按"没警告"显示，别挡界面 */ });
    return () => { alive = false; };
  }, []);

  const saveUrl = async (url) => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await window.api.app.setDownloadUrl(url);
      if (r && r.ok === false) { setMsg({ ok: false, text: r.error }); return; }
      setVer(await window.api.app.version());
      setMsg({ ok: true, text: '已保存' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <H1>关于</H1>

      <Group title="版本">
        <Field label="当前版本">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] tabular-nums font-semibold">{ver?.full || '—'}</span>
          </div>
        </Field>
      </Group>

      {/**
       * 使用范围（2026-11-03 从「模型 → 参数」搬到这里）。
       *
       * ⚠ 羽毛菌：「放到关于那个页面」。
       *   它讲的是**产品政策**，不是模型配置 —— 放在参数页里，
       *   用户调上下文窗口时会被一段"什么时候关闭连接"打断。
       *   「关于」才是找这类说明的地方。
       *
       * ⚠ 顺手修了一个显示 bug：原文里有 `**关闭模型连接**`，
       *   而这里不是 markdown 渲染环境，星号会**原样显示**在界面上
       *   （截图里就是 `**关闭模型连接**`）。改成 <b>。
       */}
      <Group title="使用范围">
        <Field label="仅用于小说创作">
          <Hint>
            本软件仅用于小说创作。写作助手「拾墨」按用户设定的称谓称呼用户（默认「主笔」），
            正式文书统一使用「执笔人」。
          </Hint>
          <Hint>
            与小说创作无关的请求（编写代码、完成作业、翻译资料等）：首次提示并中止发送，
            再次触发则<b>关闭模型连接</b>。
          </Hint>
          <Hint>
            越狱、修改助手身份、索取系统提示词：直接<b>关闭模型连接</b>，不另行提示。
          </Hint>
          <Hint>
            涉及法律或道德伦理的具体操作指引：首次弹出《用户协议》要求确认，
            再次触发则<b>关闭模型连接</b>。
          </Hint>
          {scopeState.strikes > 0 && (
            <Hint warn>已警告 {scopeState.strikes} 次。</Hint>
          )}
          <button
            onClick={async () => {
              const doc = await window.api.scope.agreement();
              setAgreementDoc(doc || null);
            }}
            className="px-3 py-1 rounded text-[12px] self-start"
            style={{ border: '1px solid var(--line)', color: 'var(--ink-soft)' }}
            data-testid="btn-read-agreement"
          >
            查看《用户协议》全文
          </button>
          {/* 只读查看：没有勾选框，主按钮就是「关闭」。 */}
          <AgreementModal
            open={!!agreementDoc}
            readOnly
            version={agreementDoc ? agreementDoc.version : ''}
            text={agreementDoc ? agreementDoc.text : ''}
            onCancel={() => setAgreementDoc(null)}
          />
        </Field>
      </Group>

      <Group title="获取新版本">
        <Field label="下载页地址">
          <div className="flex gap-2">
            <input
              value={ver?.downloadUrl || ''}
              onChange={(e) => setVer({ ...ver, downloadUrl: e.target.value })}
              onBlur={(e) => saveUrl(e.target.value.trim())}
              onKeyDown={(e) => { if (e.key === 'Enter') saveUrl(e.target.value.trim()); }}
              placeholder="https://…（留空则不显示下载按钮）"
              className="flex-1 px-2 py-1.5 rounded text-[12.5px] outline-none"
              style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
            />
            <button
              onClick={() => saveUrl(ver?.downloadUrl || '')}
              disabled={saving}
              className="px-3 py-1.5 rounded text-[12px] disabled:opacity-40 shrink-0"
              style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
            >
              {saving ? '…' : '保存'}
            </button>
          </div>
          <Hint>
            该地址用于「前往下载页」按钮的跳转。本软件<b>不进行联网版本检查</b>，
            不主动推送更新提示，是否更新由用户自行决定。
          </Hint>
        </Field>

        <Field label="下载">
          {ver?.downloadUrl ? (
            <button
              onClick={() => window.api.app.openExternal(ver.downloadUrl)}
              className="px-3 py-1.5 rounded text-[12.5px]"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              前往下载页 ↗
            </button>
          ) : (
            <Hint>还没填下载页地址，所以没有下载入口。</Hint>
          )}
        </Field>

        <Field label="怎么更新">
          <Hint>
            下载新版 <code>-setup.exe</code>，双击覆盖安装并选择原有安装目录。
            <b>用户数据不受影响</b>：章节、设定与项目文件存储于{' '}
            <code>%APPDATA%\writetool</code>，与安装目录相互独立；
            卸载软件不会删除数据。
          </Hint>
        </Field>
      </Group>

      {msg && (
        <div
          className="text-[12px]"
          style={{ color: msg.ok ? 'var(--ok)' : 'var(--danger)' }}
        >
          {msg.text}
        </div>
      )}
    </>
  );
}

// ===========================================================
// 作者
// ===========================================================
function AuthorCat({ local, save, setLocalDraft }) {
  return (
    <>
      <H1>作者</H1>

      <Group title="笔名">
        <Field label="笔名">
          <input
            value={local.penName || ''}
            onChange={(e) => setLocalDraft({ penName: e.target.value })}
            onBlur={(e) => save({ penName: e.target.value.trim() })}
            onKeyDown={(e) => { if (e.key === 'Enter') save({ penName: e.target.value.trim() }); }}
            placeholder="写进作品署名与设定文档里的名字"
            className="w-full px-2 py-1.5 rounded text-[12.5px] outline-none"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
          />
          <Hint>
            建议填一个不会和别的作者撞的名字。发行作品时署名就用它。
          </Hint>
        </Field>

        <Field label="一句话简介">
          <input
            value={local.authorBio || ''}
            onChange={(e) => setLocalDraft({ authorBio: e.target.value })}
            onBlur={(e) => save({ authorBio: e.target.value.trim() })}
            onKeyDown={(e) => { if (e.key === 'Enter') save({ authorBio: e.target.value.trim() }); }}
            placeholder="用一句话说清你写什么类型的作品"
            className="w-full px-2 py-1.5 rounded text-[12.5px] outline-none"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
          />
        </Field>
      </Group>

      <Group title="署名显示">
        <Field label="预览">
          <div
            className="px-3 py-4 rounded text-center"
            style={{ background: 'var(--paper-2)', border: '1px solid var(--line)' }}
          >
            <div className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
              {local.penName || '（未填笔名）'}
            </div>
            {local.authorBio && (
              <div className="text-[11.5px] mt-1" style={{ color: 'var(--ink-soft)' }}>
                {local.authorBio}
              </div>
            )}
          </div>
          <Hint>
            这是作品页/简介页的署名卡片。填好后可以在导出设定文档时
            一起带上。
          </Hint>
        </Field>
      </Group>

      <Group title="称呼">
        <Field label="拾墨怎么称呼你">
          <input
            data-testid="user-title"
            value={local.userTitle || ''}
            onChange={(e) => setLocalDraft({ userTitle: e.target.value })}
            /**
             * ⚠ 校验**不在这里做**：主进程 config:set 才是规则所在，
             *   这里只负责失焦就提交。失败会走 save() 的 catch，
             *   在顶栏显示原因（「这个称谓不能用：…」），输入框保留他打的字。
             *   在界面里再抄一份黑名单，早晚会和主进程那份长得不一样。
             */
            onBlur={(e) => save({ userTitle: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') save({ userTitle: e.target.value }); }}
            placeholder="主笔"
            className="w-full px-2 py-1.5 rounded text-[12.5px] outline-none"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
            spellCheck={false}
          />
          <Hint>
            对话里它就按这个叫你，留空就是「主笔」。
            <b>正式文书</b>（简介、序、卷首语、致读者）统一用「执笔人」，不跟随这里。
          </Hint>
        </Field>
      </Group>

      <Group title="数据在哪">
        <Field label="说明">
          <Hint>
            笔名与简介保存于<b>软件全局配置</b>，不隶属于单个项目——切换项目后仍沿用同一笔名。
            稿件正文存储于各自的项目文件夹，随项目迁移。
          </Hint>
        </Field>
      </Group>
    </>
  );
}

/**
 * 开关（两态）。⚠ 设置页原本没有可复用的开关组件，
 * 而「是否启用自动压缩」需要一个（羽毛菌：「是否启用自动压缩应该有个按钮」）。
 *
 * ⚠ 用真正的 `<input type="checkbox">` 而不是 div + onClick：
 *   键盘能 Tab 到、Space 能切、读屏软件能念出来。
 *   纯 div 的"开关"这些全都做不到。
 */
function Switch({ label, checked, onChange, testId }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none"
           style={{ color: 'var(--ink)' }}>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(!!e.target.checked)}
        style={{ width: 14, height: 14, accentColor: 'var(--accent)', cursor: 'pointer' }}
        data-testid={testId}
      />
      <span className="text-[13px]">{label}</span>
    </label>
  );
}


/**
 * Mode 缩略图：一个迷你窗口，浅色 / 深色 / 一半一半（跟随系统）。
 *
 * ⚠ 不全用 CSS 变量画 —— 缩略图要同时展示"白的长什么样"和"黑的长什么样"，
 *   跟着当前主题走就永远只能用一种颜色画，三个缩略图长得一模一样。
 */
function ModeThumb({ kind, title, on, onClick }) {
  const dark = kind === 'dark';
  const sys = kind === 'system';
  // ⚠ 深色缩略图**不能画成"纯黑底 + 亮线"**：一眼看过去像块黑板，
  //   不像界面。底色提亮到 #2a2a2a、侧栏压暗、内容线用 #555 才看得出层次。
  const line = dark ? '#555555' : '#e6e6e6';
  const panel = dark ? '#1f1f1f' : '#f2f2f2';
  const bg = dark ? '#2a2a2a' : '#ffffff';
  const sysLine = '#9a9a9a';
  return (
    <button
      type="button"
      title={title}
      data-mode={kind}
      onClick={onClick}
      className="shrink-0"
      style={{
        padding: 2,
        borderRadius: 13,
        border: '1.5px solid ' + (on ? 'var(--accent)' : 'transparent'),
        background: 'transparent',
      }}
    >
      <span
        className="relative block overflow-hidden"
        style={{
          width: 48, height: 32, borderRadius: 9,
          border: '1px solid ' + (sys ? '#cfcfcf' : line),
          background: sys
            ? 'linear-gradient(90deg, #ffffff 0 50%, #2a2a2a 50% 100%)'
            : bg,
        }}
      >
        {/* 侧栏 */}
        <span
          className="absolute block"
          style={{
            left: 0, top: 0, bottom: 0, width: 13,
            background: sys ? 'rgba(0,0,0,0.07)' : panel,
            borderRight: '1px solid ' + (sys ? 'rgba(0,0,0,0.12)' : line),
          }}
        />
        {/* 两条内容线 */}
        <span className="absolute block" style={{ left: 19, top: 9, width: 21, height: 2.5, borderRadius: 2, background: sys ? '#8c8c8c' : line }} />
        <span className="absolute block" style={{ left: 19, top: 15, width: 14, height: 2.5, borderRadius: 2, background: sys ? '#8c8c8c' : line }} />
      </span>
    </button>
  );
}

/** 设置页的一行：左标签 + 右控件，行间一条淡线（照 ChatGPT 的 Appearance） */
function SRow({ label, children, last }) {
  return (
    <div
      className="flex items-center justify-between gap-4 px-4 py-2.5"
      style={{ borderBottom: last ? 'none' : '1px solid color-mix(in srgb, var(--line) 70%, transparent)' }}
    >
      <span className="text-[12.5px] shrink-0" style={{ color: 'var(--ink)' }}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * 一个颜色：圆形色块（点开系统取色器）+ hex 文本框。
 *
 * ⚠ hex 输入用**本地草稿**，只在回车/失焦时提交。
 *   受控输入直接绑 config 的话，用户删到只剩 `#` 时会被即时判非法、
 *   值被弹回去，一个字符都打不出来。
 */
function ColorRow({ value, onChange }) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);

  const commit = () => {
    editing.current = false;
    const norm = normalizeHex(draft);
    if (norm) {
      setDraft(norm);
      if (norm !== value) onChange(norm);
    } else {
      setDraft(value);           // 非法输入还原，不静默改成别的颜色
    }
  };

  return (
    <div className="flex items-center gap-2">
      <label className="relative shrink-0 cursor-pointer" style={{ width: 22, height: 22 }}>
        <span
          className="absolute inset-0 rounded-full block"
          style={{ background: value, border: '1px solid var(--line)' }}
        />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
          style={{ width: 22, height: 22, padding: 0, border: 'none' }}
        />
      </label>
      <input
        value={draft}
        spellCheck={false}
        onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { editing.current = false; setDraft(value); e.currentTarget.blur(); }
        }}
        className="text-[12px] tabular-nums px-2 py-1 rounded-lg outline-none uppercase"
        style={{
          width: 86,
          background: 'var(--paper)',
          color: 'var(--ink)',
          border: '1px solid var(--line)',
        }}
      />
    </div>
  );
}
