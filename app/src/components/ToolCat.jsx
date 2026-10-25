import { useEffect, useState } from 'react';
import { H1, Group, Field, Hint } from './settings-ui.jsx';

/**
 * 设置页的「工具」类目：模型能碰到你电脑的全部开关。
 *
 * ## 为什么开关默认关，而且放在设置的最显眼处
 *
 * 打开这个开关意味着：**模型可以在你的电脑上执行命令**。
 * 这不是"多一个功能"，是"把一部分控制权交给模型"，
 * 所以它得满足两条：
 *   1. 默认关 —— 装一个写作软件不等于同意这件事
 *   2. 打开的地方要说清后果 —— 措辞含糊的开关用户根本不知道自己开了什么
 *
 * ## 三层开关的关系（写在这里，因为这是最容易误解的地方）
 *
 *   总开关（这里）—— 全局，默认关
 *      ↓
 *   有没有项目 —— 终端只能跑在项目文件夹里，没项目就没有它
 *      ↓
 *   单条命令 —— 危险的那几条每次都要你点「这一次允许」
 *
 * 三层是**与**的关系，任何一层关掉就都不生效。
 * 界面上要能让用户看出自己卡在哪一层：没项目时打开总开关也没用，
 * 所以这里会直接说明，而不是让他发一条消息去试。
 */
/**
 * 联网搜索现在**只有 Serper 一家**（2026-10-16 羽毛菌：「这个 bing 没啥用，
 * 难注册不方便获取 key，可以删除」）。
 *
 * 之前是两家可选，留 Bing 的理由是"已经配好 Key 的人不该被迫换"。
 * 但实测下来那条路基本不存在 —— 微软关闭了 Bing Web Search 的新申请入口，
 * 界面上那个按钮等于**把用户引向一条走不通的路**。
 *
 * ⚠⚠ 所以这里是「删掉选项」，不是「排在后面」：
 *   只有一个选项时还摆一排按钮，点了没得换，只会让用户以为程序没反应。
 *
 * ⚠ 后端 `tools.js` 里的 searchBing **没有删**：它还在被 `test-tools.js`
 *   当"换一家服务商"的夹具用；主进程那两处已经强制走 serper，
 *   用户界面上再也走不到它。留着比删了便宜，但**不许再暴露到界面上**。
 */
const SEARCH_PROVIDER = 'serper';

export default function ToolCat({ config, onConfigChange, projectId, onToast }) {
  const [key, setKey] = useState('');
  const [keyState, setKeyState] = useState(null);
  const [savingKey, setSavingKey] = useState(false);

  useEffect(() => {
    window.api.tool.searchKeyStatus().then(setKeyState).catch(() => setKeyState(null));
  }, []);

  const enabled = !!config?.toolsEnabled;

  const toggle = async () => {
    const next = !enabled;
    await window.api.config.set({ toolsEnabled: next });
    const cfg = await window.api.config.get();
    onConfigChange(cfg);
    onToast?.(next
      ? '已打开：模型现在可以用工具了。危险命令仍会逐条问你。'
      : '已关闭：模型看不到任何工具。');
  };

  const pickProvider = async () => {
    // ⚠ 单一服务商之后这个函数只剩「把可能残留的旧值洗成 serper」一件事。
    //   不能直接删：老配置里可能存着 searchProvider:'bing'，
    //   而主进程已经不再认它 —— 界面上却显示 Serper，
    //   用户看到的是"我明明选的是 Bing"，配置与实际用的不是一家。
    if (config?.searchProvider === SEARCH_PROVIDER) return;
    await window.api.config.set({ searchProvider: SEARCH_PROVIDER });
    const cfg = await window.api.config.get();
    onConfigChange(cfg);
    onToast?.('联网搜索统一用 Serper。');
  };
  useEffect(() => { pickProvider(); /* eslint-disable-line */ }, [config?.searchProvider]);

  const saveKey = async () => {
    setSavingKey(true);
    try {
      const r = await window.api.tool.setSearchKey({ apiKey: key.trim() });
      setKeyState(await window.api.tool.searchKeyStatus());
      // ⚠ 存完必须让输入框那个 chip 重判：不然填完 Key 它还标红，
      //   用户会以为没保存成功，又去填一遍。
      window.dispatchEvent(new CustomEvent('wt:searchkey-changed'));
      setKey('');
      /**
       * ⚠⚠ 提示文案改过（2026-10-14）。
       *
       * 羽毛菌反馈「点了保存，没有任何提示」。查下来主进程返回是对的、
       * toast 也弹了，但**两个问题让用户读起来像失败**：
       *
       *   1. 原文照抄主进程的 error：
       *      「系统未提供加密凭据服务，密钥只保存在本次运行中，重启软件后需要重新填写。」
       *      一句话 30 多字，开头还带个负面词，**读起来就是报错**。
       *      而它其实是「成功了，但有个限制」。
       *   2. 主进程已经明确 `ok: true`，界面却把那句 error 摆出来当提示，
       *      用户没理由相信那是好消息。
       *
       * 改法：先说结论（成功了），再说限制，且**不**用主进程那句原文。
       * 加密不可用是**长期状态**，不该靠一条 3 秒的 toast 承载 ——
       * 下面那块常驻 Hint 才负责长期提醒。
       */
      if (r && r.ok === false) {
        onToast?.(r.error || '保存失败，请再试一次');
      } else if (r && r.encrypted === false) {
        onToast?.('已保存 ✓ 但系统没提供加密，重启后需要重填');
      } else {
        onToast?.('搜索 Key 已保存 ✓');
      }
    } catch (e) {
      onToast?.(`保存失败：${e.message}`);
    } finally {
      setSavingKey(false);
    }
  };

  return (
    <>
      {/* ⚠ 标题跟着侧栏一起改名（2026-10-14）。
          侧栏已经是「功能」，这里还是「工具」的话，
          用户点进来第一眼会觉得走错了地方。 */}
      <H1>功能</H1>

      <Group title="总开关">
        <Field label="让模型使用工具（终端 / 联网）">
          <div className="flex items-center gap-2">
            <button
              onClick={toggle}
              className="px-3.5 py-1.5 rounded text-[12.5px]"
              style={{
                background: enabled ? 'var(--accent)' : 'var(--paper-2)',
                color: enabled ? 'var(--accent-ink)' : 'var(--ink-soft)',
              }}
              data-testid="tool-master-switch"
            >
              {enabled ? '已打开' : '已关闭'}
            </button>
            <span className="text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>
              {enabled ? '模型看得见三个工具' : '模型看不见任何工具（默认）'}
            </span>
          </div>

          <Hint>
            打开后，模型可以在<b>当前项目文件夹</b>里执行命令、搜索与读取网页。
            删除、格式化、安装这类命令<b>每次都会弹窗问你</b>，
            不点「这一次允许」就不会执行。
          </Hint>

          {!enabled && (
            <Hint warn>
              默认关闭是有意的：模型能不能在你电脑上执行命令，
              是一件该由你决定的事，不是装完软件就默认生效的。
            </Hint>
          )}

          {enabled && !projectId && (
            <Hint warn>
              现在<b>还不会真的生效</b>：没有选中项目，终端就没有可运行的目录。
              先在上面选一个小说项目。
            </Hint>
          )}
        </Field>
      </Group>

      <Group title="模型能做什么">
        <Field label="三项能力">
          <div className="space-y-1.5">
            <Cap
              icon="⌘"
              name="终端"
              desc="在当前项目文件夹里执行命令（Windows 用 PowerShell）。适合查文件、数章节、跑脚本。"
              on={enabled && !!projectId}
              blocked={enabled && !projectId ? '需要先选项目' : null}
            />
            <Cap
              icon="🔍"
              name="联网搜索"
              desc="查资料、核对史实与设定。需要下面那个搜索服务的 Key。"
              on={enabled}
              blocked={enabled && keyState && !keyState.has ? '还没填搜索 Key' : null}
            />
            <Cap
              icon="📄"
              name="读取网页"
              desc="读一个具体网址的正文，转成纯文本。装完就能用，不需要 Key。"
              on={enabled}
            />
          </div>
        </Field>
      </Group>

      <Group title="联网搜索">
        <Field label="用哪家的搜索">
          <div
            className="flex items-center gap-2 text-[12.5px] px-2.5 py-1.5 rounded"
            style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
            data-testid="search-provider-fixed"
          >
            <b>Serper</b>
            <span style={{ color: 'var(--ink-soft)' }}>serper.dev 注册就送免费额度</span>
          </div>
          <Hint>
            只有这一家。以前还列过 Bing，微软已经关闭了新申请入口 ——
            留着那个选项等于把用户引向一条走不通的路，所以删掉了。
          </Hint>
        </Field>

        <Field label="Serper API Key">
          {/**
           * ⚠ 已保存标记（2026-10-14 新增）。
           *
           * 羽毛菌说「点了保存没提示」。查下来 toast 确实弹了，但：
           *   1. 3.2 秒就消失，他没看见
           *   2. 那句提示读起来像报错（照抄了主进程的 error 原文）
           *
           * toast 是**瞬时**反馈，承载不了"存没存上"这种要反复确认的事。
           * 所以这里加一个**常驻**标记：只要 keyState.has 就在，
           * 颜色跟"还没填"那态明显不同 —— 扫一眼就知道结果。
           */}
          {keyState?.has && (
            <div
              data-testid="search-key-saved-badge"
              className="mb-1.5 flex items-center gap-1.5 text-[11.5px]"
              style={{ color: 'var(--ok, #2f7d32)' }}
            >
              <span className="shrink-0">✓</span>
              <span>
                已保存
                {keyState.encrypted === false
                  ? '（本次运行有效，重启后需重填）'
                  : '，联网搜索现在可以用了'}
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveKey(); }}
              placeholder={keyState?.has ? '已保存（留空则不改动）' : '粘贴你的 Key'}
              className="flex-1 px-2 py-1.5 rounded text-[12.5px] outline-none"
              style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
              data-testid="tool-search-key"
            />
            <button
              onClick={saveKey}
              disabled={savingKey || !key.trim()}
              className="px-3 py-1.5 rounded text-[12px] disabled:opacity-40 shrink-0"
              style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
            >
              {savingKey ? '保存中…' : '保存'}
            </button>
            {keyState?.has && (
              <button
                onClick={async () => {
                  await window.api.tool.setSearchKey({ apiKey: '' });
                  setKeyState(await window.api.tool.searchKeyStatus());
                  window.dispatchEvent(new CustomEvent('wt:searchkey-changed'));
                  onToast?.('已清除搜索 Key');
                }}
                className="px-2.5 py-1.5 rounded text-[12px] shrink-0"
                style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
              >
                清除
              </button>
            )}
          </div>

          {/**
           * ⚠⚠ 加密不可用时，**独立成块**显示（2026-10-14 改）。
           *
           * 原来这条只是 Hint 的第二行，跟「不会写进配置文件」挤在一起，
           * 字号一样、颜色一样 —— 用户根本注意不到，而它决定的正是
           * 「我填的 Key 到底还算不算数」。
           *
           * 实测这台机器 `safeStorage.isEncryptionAvailable()` 就是 false：
           * Key 只在内存里，重启即丢。羽毛菌说"填了跟没填一样"——
           * 一半就是这个（另一半是提示读起来像报错）。
           *
           * 所以它必须是**独立的一行**，还要说清「现在能用 / 什么时候失效」，
           * 而不是只说"没提供加密服务"这种用户不知道怎么行动的话。
           */}
          {keyState && keyState.encrypted === false && (
            <div
              data-testid="search-key-nowrap-warning"
              className="mt-2 px-2.5 py-2 rounded text-[11.5px] leading-relaxed"
              style={{
                background: 'var(--danger-soft, #fdecec)',
                border: '1px solid var(--danger)',
                color: 'var(--danger)',
              }}
            >
              <b>⚠ 这个系统没提供加密服务，Key 重启后会失效。</b>
              <br />
              本次运行里能正常用联网搜索；关掉软件再打开就要重填一次。
              （Windows 上通常是策略禁用了凭据服务，可以找 IT 查一下。）
            </div>
          )}

          <Hint>
            Key 用系统加密存储，<b>不会写进配置文件</b>，也不会随备份导出。
          </Hint>
          <Hint>
            没填也能用另外两个工具，只是<b>搜索</b>不可用——
            模型会收到一句明确的话说明原因，不会装作"搜过了没有结果"。
          </Hint>
        </Field>
      </Group>

      <Group title="危险命令">
        <Field label="什么时候会问你">
          <Hint>
            删除、格式化、覆盖文件、安装软件、动 git 历史这类命令会被拦下来，
            弹窗给你看<b>完整命令原文</b>与它被拦的原因，由你决定。
          </Hint>
          <Hint>
            <b>每一次都问</b>，不会记住你的选择。
            代价是多点点几次；好处是你不用记得"上次我是不是同意过这个"。
          </Hint>
          <Hint>
            弹窗上点<b>不允许</b>、按 <b>Esc</b>、关掉软件，
            或者两分钟没响应 —— 四种情况都算拒绝。
          </Hint>
        </Field>
      </Group>
    </>
  );
}

/** 一项能力的开关行。被卡住时说明卡在哪，而不是只给个灰开关。 */
function Cap({ icon, name, desc, on, blocked }) {
  return (
    <div
      className="flex items-start gap-2 px-2.5 py-2 rounded"
      style={{
        background: on ? 'var(--accent-soft)' : 'var(--paper-2)',
        border: '1px solid var(--line)',
      }}
    >
      <span className="text-[13px] shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium" style={{ color: 'var(--ink)' }}>{name}</span>
          {blocked ? (
            <span className="text-[10.5px] px-1 rounded"
                  style={{ background: 'var(--paper)', color: 'var(--danger)' }}>
              {blocked}
            </span>
          ) : (
            <span className="text-[10.5px]" style={{ color: on ? 'var(--ok)' : 'var(--ink-soft)' }}>
              {on ? '可用' : '不可用'}
            </span>
          )}
        </div>
        <div className="text-[11.5px] leading-relaxed mt-0.5" style={{ color: 'var(--ink-soft)' }}>
          {desc}
        </div>
      </div>
    </div>
  );
}
