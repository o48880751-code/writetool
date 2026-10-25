import { useCallback, useEffect, useMemo, useState } from 'react';
import ParamGuide from './ParamGuide.jsx';
import AgreementModal from './AgreementModal.jsx';
import { BackgroundSection } from './Background.jsx';
import { THEMES } from '../themes.js';
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
const THEME_SWATCH = {
  gold: ['#faf9f7', '#8b6f47', '#1f2328'],
  ochre: ['#fbf6ef', '#a8642a', '#2b1d14'],
  moss: ['#f4f8f2', '#5b8c51', '#1f2b1e'],
  ink: ['#eef2f7', '#3c5a91', '#141a24'],
  slate: ['#eff4f4', '#4a7378', '#172225'],
  plum: ['#f8f3f8', '#82508c', '#2a1c2e'],
  night: ['#191919', '#c9a86a', '#e8e6e3'],
  'night-ink': ['#141821', '#7d9fd4', '#e2e6ef'],
  'night-moss': ['#151a16', '#7fb07a', '#dfe6de'],
  contrast: ['#000000', '#ffffff', '#ffffff'],
};

export default function SettingsPage({
  config, onConfigChange, onClose, projectId, projects,
  /** 轻提示。设置页自己不发 toast，交给 App 统一显示 */
  onToast,
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

  const save = useCallback(async (patch) => {
    setLocal((l) => ({ ...l, ...patch }));
    await window.api.config.set(patch);
    const cfg = await window.api.config.get();
    onConfigChange(cfg);
    setSaveMsg('已保存');
    setTimeout(() => setSaveMsg(''), 1500);
  }, [onConfigChange]);

  return (
    <div className="absolute inset-0 z-40 flex flex-col" style={{ background: 'var(--paper)' }}>
      {/* ---- 顶栏：返回键 + 标题 + 保存提示 ---- */}
      <div
        className="shrink-0 h-11 flex items-center gap-3 px-4 border-b"
        style={{ borderColor: 'var(--line)' }}
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
              className="flex items-center gap-2 px-2.5 py-2 rounded text-[12.5px] text-left"
              style={{
                background: cat === c.key ? 'var(--paper)' : 'transparent',
                color: cat === c.key ? 'var(--ink)' : 'var(--ink-soft)',
                fontWeight: cat === c.key ? 600 : 400,
              }}
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
          <div className="max-w-2xl px-6 py-5">
            {cat === 'appearance' && <Appearance local={local} save={save} onToast={onToast} />}
            {cat === 'provider' && (
              <ProviderCat onToast={onToast} onConfigChange={onConfigChange} />
            )}
            {cat === 'skill' && (
              <SkillCat projectId={projectId} onToast={onToast} />
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
function Appearance({ local, save, onToast }) {
  const fonts = useFonts();
  // 兼容旧配置：老 fontFamily 兜底给编辑器；老 fontSize 兜底给两个档
  const editorFont = local.editorFont || local.fontFamily || 'system-ui';
  const chatFont = local.chatFont || 'system-ui';
  const editorSize = local.editorFontSize || local.fontSize || 16;
  const chatSize = local.chatFontSize || local.fontSize || 16;
  return (
    <>
      <H1>外观</H1>

      {/* ⚠ 自定义背景图：就是上传一张图替代白色背景，没有别的参数 */}
      <Group title="背景">
        <BackgroundSection
          bg={{ enabled: local.bgEnabled === true, url: local.bgUrl || '' }}
          apply={(v) => save({ bgEnabled: v.enabled, bgUrl: v.url })}
          onToast={(m) => onToast && onToast(m)}
        />
      </Group>

      <Group title="配色主题">
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((t) => {
            const on = local.theme === t.id;
            const sw = THEME_SWATCH[t.id] || ['#fff', '#888', '#000'];
            return (
              <button
                key={t.id}
                onClick={() => save({ theme: t.id })}
                className="flex items-center gap-2 p-2 rounded border text-left"
                style={{
                  borderColor: on ? 'var(--accent)' : 'var(--line)',
                  background: on ? 'var(--accent-soft)' : 'var(--paper)',
                }}
              >
                {/* 三块预览色：纸/墨金/文字 */}
                <span className="flex shrink-0 rounded overflow-hidden" style={{ border: '1px solid var(--line)' }}>
                  {sw.map((c, i) => (
                    <span key={i} style={{ width: 14, height: 22, background: c, display: 'block' }} />
                  ))}
                </span>
                <span className="text-[12.5px]" style={{ color: 'var(--ink)' }}>{t.name}</span>
                {on && <span className="text-[11px] ml-auto" style={{ color: 'var(--accent)' }}>✓</span>}
              </button>
            );
          })}
        </div>
      </Group>

      <Group title="编辑器">
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

        <FontPicker
          label="编辑器字体"
          value={editorFont}
          onChange={(f) => save({ editorFont: f, fontFamily: f })}
          presetState={fonts}
        />
      </Group>

      <Group title="聊天">
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

        <FontPicker
          label="聊天字体"
          value={chatFont}
          onChange={(f) => save({ chatFont: f })}
          presetState={fonts}
        />
      </Group>

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
    </>
  );
}

/**
 * 字体选择器：系统默认 + 每个开源字体一行。
 * 未下载的显示「下载」（首次需联网，约数 MB，存到本机后离线也能用），
 * 已下载的显示「删除」，下载中显示进度百分比。选中行高亮 + 对勾。
 */
function FontPicker({ label, value, onChange, presetState }) {
  const { presets, installed, installing, install, uninstall, error } = presetState;
  const row = (key, family, name, sub) => {
    const on = value === family;
    return (
      <button
        key={key}
        onClick={() => onChange(family)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded border text-left"
        style={{
          borderColor: on ? 'var(--accent)' : 'var(--line)',
          background: on ? 'var(--accent-soft)' : 'var(--paper)',
        }}
      >
        <span className="flex-1">
          <span className="text-[12.5px] block" style={{ color: 'var(--ink)', fontFamily: family }}>{name}</span>
          {sub && <span className="block text-[10.5px]" style={{ color: 'var(--ink-soft)' }}>{sub}</span>}
        </span>
        {on && <span className="text-[11px]" style={{ color: 'var(--accent)' }}>✓</span>}
      </button>
    );
  };
  return (
    <Field label={label}>
      <div className="space-y-1.5">
        {row('system', 'system-ui', '系统默认', '跟随操作系统的界面字体')}
        {(presets || []).map((p) => {
          const isInstalled = installed.has(p.id);
          const isInstalling = installing && installing.id === p.id;
          const on = value === p.family;
          return (
            <div
              key={p.id}
              className="flex items-center gap-2 px-3 py-2 rounded border"
              style={{
                borderColor: on ? 'var(--accent)' : 'var(--line)',
                background: on ? 'var(--accent-soft)' : 'var(--paper)',
              }}
            >
              <button onClick={() => onChange(p.family)} className="flex-1 text-left">
                <span className="text-[12.5px] block" style={{ color: 'var(--ink)', fontFamily: p.family }}>{p.label}</span>
                <span className="block text-[10.5px]" style={{ color: 'var(--ink-soft)' }}>
                  {p.desc} · 约 {p.sizeMB} MB
                </span>
              </button>
              {isInstalled ? (
                <button
                  onClick={() => uninstall(p.id)}
                  className="px-2 py-1 rounded text-[11px] shrink-0"
                  style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
                >删除</button>
              ) : isInstalling ? (
                <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--accent)' }}>
                  {installing.total ? Math.round((installing.loaded / installing.total) * 100) + '%' : '下载中'}
                </span>
              ) : (
                <button
                  onClick={() => install(p.id)}
                  className="px-2 py-1 rounded text-[11px] shrink-0"
                  style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                >下载</button>
              )}
            </div>
          );
        })}
      </div>
      {error && <Hint warn>{error}</Hint>}
      <Hint>开源字体首次需联网下载（存到本机，之后离线也能用）。下载后立刻生效，选「系统默认」可还原。</Hint>
    </Field>
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
         *   表在 ParamGuide.jsx 里，每家都标了 [已核实] / [待核实]：
         *   标「待核实」不是心虚，是不骗人 —— 上下文长度与最大输出
         *   是服务商随时会改的参数。
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
            {scopeState.locked ? (
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
            ) : (
              <>
                <div className="text-[13px] font-semibold">使用范围</div>
                <Hint>
                  这个工具只用于小说创作，<b>任何时候只称呼你为「老板」</b>。
                  与写作无关的请求（写代码、做作业、翻译资料…）
                  第一次会提示并不发送，第二次会**关闭模型连接**；
                  越狱 / 改身份 / 要提示词这类直接关闭；
                  涉及法律或道德伦理的具体做法，第一次会弹《用户协议》让你确认，
                  第二次关闭模型连接。
                  {scopeState.strikes > 0 ? `（已警告 ${scopeState.strikes} 次）` : ''}
                </Hint>
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
                {/* 只读查看：没有勾选框，主按钮就是「关闭」。
                    ⚠ 用同一个组件而不是再写一个，是为了协议正文只显示一处。 */}
                <AgreementModal
                  open={!!agreementDoc}
                  readOnly
                  version={agreementDoc ? agreementDoc.version : ''}
                  text={agreementDoc ? agreementDoc.text : ''}
                  onCancel={() => setAgreementDoc(null)}
                />
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

  useEffect(() => {
    window.api.app.version().then(setVer).catch(() => setVer(null));
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
          <Hint>
            版本号规则：<b>每次更新第三位加 1</b>。
          </Hint>
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
            填了之后，下面的「前往下载」按钮会打开这个网址。
            软件**不会自己联网检查版本**——有新版本时它不会打扰你，
            由你自己决定什么时候去下载。
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
            下载新的 <code>-setup.exe</code> 双击覆盖安装，选原来同一个目录即可。
            <b>用户数据不会丢</b>：章节、设定、项目文件都在{' '}
            <code>%APPDATA%\writetool</code> 下，与安装目录分离；
            卸载也不会删数据。
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

      <Group title="数据在哪">
        <Field label="说明">
          <Hint>
            笔名与简介存在<b>软件配置</b>里（全局），不是某个项目的——
            换项目写别的书，笔名一般也是同一个。
            稿子本身存在项目文件夹里，随项目走。
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
