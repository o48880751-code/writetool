export default ProviderCat;

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { H1, Group, Field, Hint, StatusDot } from './settings-ui.jsx';

/**
 * AI 提供商：多连接。
 *
 * ## 结构
 *
 * 左栏是**你自己建的连接**，右栏是选中那条的详情：
 *
 *   ┌────────────┬──────────────────────────┐
 *   │ 连接        │  名称                      │
 *   │  ● 硅基流动 │  API 地址                  │
 *   │  ○ 公司代理 │  API 格式  [OpenAI|兼容]   │
 *   │  ＋新建连接 │  API Key                   │
 *   │            │  模型  [获取模型列表]      │
 *   │            │                    [保存]  │
 *   └────────────┴──────────────────────────┘
 *
 * ## 2026-10-13 第三次改：进屏就是"当前连接"，只有主动断开才回选择态
 *
 * 羽毛菌连着提了四件事，都指向同一个病根——**界面把"有哪些连接"当成了主语，
 * 把"我正在用哪条"当成了宾语**：
 *
 *   1. 「保存并测试成功后没有弹窗，我怎么知道它是否成功」
 *      → 反馈只有一行会消失的 toast。必须给一个**要手动关掉**的结果窗口。
 *   2. 「重新进入设置之后就需要重新连接」
 *      → 进设置页 `load()` 写的是 `pickId || selIdRef || ls[0].id`：
 *        自动选中列表第一条。选中 ≠ 激活，而主进程发请求用的是
 *        `config.activeConnectionId`——**界面上看着在用 A，实际发往 B**。
 *   3. 「进来后直接跳到本地接入选项什么鬼」
 *      → 同上那条 `ls[0].id`：库里最早那条恰好是 Ollama。
 *        而且"第一条"这个选择本身就是随机的（取决于建连接的顺序），
 *        不该由程序替用户决定。
 *   4. 「万一电脑不支持本地就用不了该软件」
 *      → 新建页把"自定义"排最前、"本地"排最后，中间夹着云端。
 *        轻薄本用户第一眼看到的是要装 Ollama 的选项。
 *
 * 现在的结构（也是这一版的判据）：
 *
 *   有正在使用的连接 → 主区是「当前连接」卡片（地址 / 模型 / 实时状态）
 *                      点「编辑」才进表单；点「断开连接」才回选择页
 *   没有正在使用     → 主区是「选一条 / 新建」，云端排最前且标推荐
 *
 * ⚠ 「断开连接」不是「删除连接」：地址、密钥、模型全留着，
 *   再点一下卡片就切回来。删连接会连密钥一起丢，那是另一回事
 *   （左栏每行后面的 ✕）。
 *
 * ## 为什么「API 格式」是必选项而不是自动判断
 *
 * 有服务商会同时提供 OpenAI 兼容与 Anthropic 兼容两个端点，
 * 同一个地址下选哪个协议会决定请求打到哪个路径、body 长什么样。
 * 自动猜只能靠"试一次看报什么错"，用户看到的是一次莫名其妙的 404。
 *
 * 三个协议的真实差异在 electron/provider.js 的文件头与 PROTOCOLS 里，
 * **这里不写死任何一家的地址**——全从 provider:capabilities 拿。
 */
function ProviderCat({ onToast, onConfigChange }) {
  const [caps, setCaps] = useState(null);
  const [list, setList] = useState([]);
  const [activeId, setActiveId] = useState(null);   // 正在使用的那条（= config.activeConnectionId）
  const [selId, setSelId] = useState(null);
  const [draft, setDraft] = useState(null);      // 正在编辑的那条（null = 看卡片 / 选择页）
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [probe, setProbe] = useState(null);      // {ok, error, models}
  const [probing, setProbing] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyMsg, setKeyMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null);        // 当前连接的实时状态（进设置页自动探测一次）
  const [liveBusy, setLiveBusy] = useState(false);
  const [result, setResult] = useState(null);    // 保存结果弹窗（成功/失败都要手动关）

  /**
   * 把主进程最新的 config 拉回来交给上层。
   *
   * ⚠⚠ 这个回调是必需的，不是"锦上添花"（2026-10-15 线上故障）。
   *
   * `provider:activate` 会在主进程里把 config 的 model / base / engine
   * **同步成新连接的值**（见那边第 1265 行附近的注释），但渲染进程这份
   * React state 不会自己变。而 App 发消息时带的就是 `config.model`。
   *
   * 于是：切了连接，界面还拿着上一条连接的模型名发请求 ——
   *   切到硅基流动 → 400 `{"code":20012,"message":"Model does not exist"}`
   *   切到本地 Ollama → 404 `model 'Qwen/Qwen3-8B' not found`
   * 而两条连接里存的模型名其实都是对的，用户怎么看都看不出问题在哪。
   *
   * 主进程侧已经改成"不再认界面传上来的 model"（那是根因），
   * 这里是第二道保险：让设置页显示的也确实是最新值，
   * 否则用户在界面上看到的模型名跟真正在用的对不上。
   */
  const notifyConfigChanged = useCallback(async () => {
    if (!onConfigChange) return;
    try {
      const cfg = await window.api.config.get();
      onConfigChange(cfg);
    } catch (_) {
      // 刷新失败不该挡住「已切到 XX」这个反馈，更不能拦下切换本身
    }
  }, [onConfigChange]);

  // ⚠ 用 ref 读当前选中项，而不是把 selId 放进 useCallback 依赖。
  //   依赖里有 selId 时，load 每改一次选中项就产生新的函数引用，
  //   而任何依赖 load 的 effect 都会跟着重跑——变成"选一次连接就重取一遍列表"。
  //   选中项只是**读取**偏好，不该影响取数。
  const selIdRef = useRef(null);
  selIdRef.current = selId;

  /**
   * 取连接列表 + 当前正在用哪条。
   *
   * ⚠⚠ **不再自动选中 ls[0]**（2026-10-13 改）。
   *   原来这行是 `pickId || selIdRef.current || (ls[0]||{}).id || null`，
   *   看着无害，实际造成两个用户可见的错误：
   *     - 进设置页落在列表第一条（羽毛菌的库里那条恰好是 Ollama）
   *     - 更糟：选中态 ≠ 激活态。主进程发请求只认 activeConnectionId，
   *       界面上高亮着 A、实际发往 B，且两边都不提示。
   *   现在只认"正在使用的那条"；没有就老实显示"还没在用哪条"。
   *
   * ⚠⚠ **自动选中的不能塞进 draft**（截图脚本当场抓到的）。
   *   第一版只把 `ls[0]` 换成了 activeId，却仍然 setDraft(found)——
   *   于是 draft 永远非空，三态里的"卡片"那一支**永远不会出现**，
   *   每次进设置看到的还是表单（正是羽毛菌要改掉的那个画面）。
   *   现在 draft 只在**用户主动要编辑**时才有值（opts.form）。
   *
   * @param {string|object} [opts] 传字符串 = 旧的 pickId（并打开表单）
   * @param {string} [opts.pickId] 打开表单时编辑哪条
   * @param {boolean} [opts.form] 是否进入编辑表单。默认 false（= 看卡片）
   */
  const load = useCallback(async (opts = {}) => {
    const o = typeof opts === 'string' ? { pickId: opts, form: true } : (opts || {});
    try {
      const [ls0, cfg0] = await Promise.all([
        window.api.provider.listConnections() || [],
        window.api.config.get().catch(() => ({})),
      ]);
      let ls = ls0;
      let act = cfg0 && cfg0.activeConnectionId ? cfg0.activeConnectionId : null;

      /**
       * 一次性认领（迁移用）。
       *
       * 老库里有一条就绪连接、但 activeConnectionId 是空的（多半是首启 seed 的
       * Ollama，或上一版从没调过 activate）。这时直接判"未连接"太粗暴——
       * 用户明明已经配好一条了，界面却让他重配一遍。
       *
       * ⚠ 只在**恰好一条就绪连接**时认领：多于一条说明用户自己挑过，
       *   程序替谁挑都是猜，猜错比"让他点一下"更糟。
       */
      if (!act && ls.length) {
        const ready = ls.filter((c) => c.base && (c.hasKey || !c.needKey));
        if (ready.length === 1) {
          try {
            await window.api.provider.activate({ id: ready[0].id });
            act = ready[0].id;
            // 认领也是一次激活 —— 主进程的 config.model 已经跟着变了，
            // 上面那次 config.get 的结果作废，要重新交给上层。
            await notifyConfigChanged();
          } catch (_) { /* 认领失败也不挡界面 */ }
        }
      }

      setList(ls);
      setActiveId(act);
      const id = o.form ? (o.pickId || selIdRef.current || null) : null;
      setSelId(id);
      const found = id ? ls.find((c) => c.id === id) : null;
      setDraft(found ? { ...found } : null);
      return { list: ls, activeId: act };
    } catch (e) {
      onToast?.(`读取连接失败：${e.message}`);
      setList([]);
      setDraft(null);
      return { list: [], activeId: null };
    } finally {
      setLoading(false);
    }
  }, [onToast, notifyConfigChanged]);

  /**
   * 服务商量表。
   *
   * ⚠ 这一段是 2026-10-12 补的：上一版**从没调用过 provider:capabilities**，
   *   于是 caps 永远是 null，界面上「思考强度」对每一家都显示
   *   「这家服务商不提供思考强度开关」——包括明明支持四档的 Ollama。
   *   测试查不到这类问题（它不报错、接口也在），只有把两边接起来才行。
   */
  useEffect(() => {
    window.api.provider.capabilities()
      .then((c) => setCaps(c))
      .catch((e) => onToast?.(`读不到服务商量表：${e.message}`));
  }, [onToast]);

  /** 正在使用的那条（严格按 activeConnectionId，不猜） */
  const activeConn = useMemo(
    () => list.find((c) => c.id === activeId) || null,
    [list, activeId],
  );

  /** 该条连接的量表信息（本地/云、思考形态、说明） */
  const preset = useMemo(() => {
    const key = draft ? draft.providerKey : (activeConn && activeConn.providerKey);
    if (!caps || !key) return null;
    return (caps.providers || []).find((p) => p.key === key) || null;
  }, [caps, draft, activeConn]);

  /** ★ 思考档位跟着服务商走。拿不到档位的服务商只给开关。 */
  const thinkUI = useMemo(() => {
    const style = preset?.think?.style;
    if (style === 'levels') {
      return {
        levels: ['off', 'low', 'medium', 'high'],
        note: preset.think.note,
      };
    }
    if (style === 'boolean') {
      // 布尔型：硬给四档就是骗用户——medium 与 high 发过去完全一样
      return { levels: ['off', 'on'], note: preset.think.note };
    }
    if (style === 'model-only') {
      // 靠模型名区分：没有"强度"这个概念
      return { levels: null, note: preset.think.note };
    }
    return { levels: null, note: preset?.think?.note };
  }, [preset]);

  /**
   * 探测"正在使用的那条"，拿真实状态。
   *
   * ⚠ 这是"连接有记忆"的另一半：不只是"记住上次选了谁"，
   *   而是**进设置页就告诉你它现在通不通**。否则那个「已连接」徽章
   *   就是一句没依据的话——它现在能连上，不代表关机三天后还能连上。
   */
  const checkLive = useCallback(async (cid) => {
    if (!cid) return;
    setLiveBusy(true);
    setLive({ cid, at: Date.now(), ok: null });   // ok=null = 还在测
    try {
      const r = await window.api.provider.probe({ id: cid });
      setLive({ cid, at: Date.now(), ...r });
    } catch (e) {
      setLive({ cid, at: Date.now(), ok: false, error: e.message });
    } finally {
      setLiveBusy(false);
    }
  }, []);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // 进屏/切连接后自动测一次当前连接。activeId 变 = 该重新确认了。
  useEffect(() => {
    if (!loading && activeId) checkLive(activeId);
    else if (!activeId) setLive(null);
  }, [loading, activeId, checkLive]);

  /** 切换正在使用的连接。模型跟着连接走（见主进程 provider:activate 的注释）。 */
  const switchTo = async (c) => {
    try {
      const r = await window.api.provider.activate({ id: c.id });
      if (!r.ok) { onToast?.(r.error || '切换失败'); return; }
      // ⚠ 顺序要紧：先让上层拿到新 config，再显示「已切到」。
      //   反过来的话用户看到提示的那一瞬间，App 手里还是旧模型名。
      await notifyConfigChanged();
      setActiveId(c.id);
      setSelId(c.id);
      setDraft(null);          // 回卡片态，不留在表单里
      setProbe(null);
      onToast?.(`已切到「${c.name}」`);
    } catch (e) {
      onToast?.(`切换失败：${e.message}`);
    }
  };

  /** 进这条的编辑表单 */
  const edit = (c) => {
    setSelId(c.id);
    setDraft({ ...c });
    setProbe(null);
    setKeyInput('');
    setKeyMsg(null);
    setLive(null);
  };

  /**
   * 断开连接。
   *
   * ⚠ 不是删除。连接、地址、密钥都留着，只是"不再用"。
   *   这是羽毛菌明确要的语义：「除非用户主动断开连接，
   *   应该是要一直保持连接的」——断开才是那个开关。
   */
  const disconnect = async () => {
    if (!window.confirm(
      `断开「${(activeConn || {}).name || '当前连接'}」？\n\n`
      + '连接本身、地址和密钥都会留着，之后点一下卡片就能接回来。'
    )) return;
    try {
      await window.api.provider.disconnect();
      setActiveId('');
      setLive(null);
      setSelId(null);
      setDraft(null);
      setProbe(null);
      onToast?.('已断开。现在可以选一条或新建');
    } catch (e) {
      onToast?.(`断开失败：${e.message}`);
    }
  };

  /**
   * 进入"选一条 / 新建"态。
   *
   * ⚠ 注意它**不动 activeId**：主动断开与"只是看一眼其它选项"是两件事，
   *   只有前者才改变正在用哪条。
   */
  const startCreate = () => {
    setDraft(null);
    setSelId(null);
    setProbe(null);
    setKeyInput('');
    setKeyMsg(null);
  };

  /**
   * 按模板建一条连接。
   *
   * ⚠ **选完才落库**，不是点「＋新建连接」就建一条空的。
   *   先建的话，用户改主意就会在库里留一条「新连接 / 地址为空」的垃圾，
   *   而他没有明显的地方去清理它。
   */
  const createByPreset = async (providerKey) => {
    setCreating(true);
    try {
      const c = await window.api.provider.createConnection({
        providerKey,
        protocol: undefined,   // 交给主进程按量表取
      });
      // form:true —— 刚建的那条要直接能填（地址/密钥/模型），落在卡片上没意义
      await load({ pickId: c.id, form: true });
      onToast?.(`已加「${c.name}」。填好密钥后点「保存并测试」。`);
    } catch (e) {
      onToast?.(`新建失败：${e.message}`);
    } finally {
      setCreating(false);
    }
  };

  const remove = async (c) => {
    if (!window.confirm(`删除连接「${c.name}」？\n\n它的 API 密钥也会一并删除。\n删除 ≠ 断开：只是不用它的话，断开就行。`)) return;
    try {
      const r = await window.api.provider.deleteConnection({ id: c.id });
      if (!r.ok) { onToast?.(r.error); return; }
      setLive(null);
      await load();
      onToast?.(`已删除「${c.name}」`);
    } catch (e) {
      onToast?.(`删除失败：${e.message}`);
    }
  };

  /**
   * 获取模型列表。
   *
   * ⚠ 用表单里**当前的**地址与密钥去测，不是已保存的那条：
   *   用户刚填完地址就想知道对不对，让他先保存再测是反的。
   */
  const fetchModels = async () => {
    setProbing(true);
    try {
      const r = await window.api.provider.probe({
        id: draft.id,
        base: draft.base,
        model: draft.model,
        apiKey: keyInput || undefined,
      });
      setProbe(r);
      if (r.ok) {
        const n = (r.models || []).length;
        onToast?.(n
          ? `连接成功，找到 ${n} 个模型`
          : '连接成功，但服务端没有返回模型列表。可以手动填模型名。');
      }
    } catch (e) {
      setProbe({ ok: false, error: e.message });
    } finally {
      setProbing(false);
    }
  };

  /**
   * 保存并测试。
   *
   * ⚠ 保存前先探一次，而且**探测失败也允许保存**：
   *   用户可能正在把地址改对，或者服务暂时不可达。
   *   硬拦下来的话，他就永远改不了这条连接——
   *   地址填错 → 保存不了 → 改不了 → 死锁。
   *   提示他失败原因、让他继续改才对。
   *
   * ⚠⚠ 成功之后**弹一个要手动关的窗口**，不是 toast（2026-10-13）。
   *   羽毛菌的原话：「保存并测试成功后没有弹窗，我怎么知道它是否成功」。
   *   toast 会自己消失、在屏幕角落、还可能被下一次提示顶掉——
   *   而"我这次到底连上没有"是必须给出答案的问题。
   *   窗口里给的是证据：哪个地址、哪个模型、耗时多少、返回几个模型。
   *
   * ⚠ 测通就**激活**它。不激活的话，用户明明刚测好一条，
   *   回聊天区发消息却还是发往旧连接——那正是他说的"要重新连接"。
   */
  const save = async () => {
    setBusy(true);
    try {
      let r = null;
      try {
        r = await window.api.provider.probe({
          id: draft.id,
          base: draft.base,
          model: draft.model,
          apiKey: keyInput || undefined,
        });
        setProbe(r);
      } catch (_) { /* 探测失败不拦保存 */ }

      // 密钥单独存（单向，不回显）
      if (keyInput.trim()) {
        const kr = await window.api.provider.setKey(keyInput.trim(), draft.id);
        if (!kr.ok) {
          setResult({ ok: false, title: '密钥没存住', detail: kr.error || '未知原因', conn: draft });
          return;
        }
        setKeyInput('');
        setKeyMsg(kr.encrypted ? '密钥已保存（系统加密）' : '密钥已保存（本次运行有效）');
      }

      await window.api.provider.updateConnection({
        id: draft.id,
        name: draft.name,
        protocol: draft.protocol,
        providerKey: draft.providerKey,
        base: draft.base,
        model: draft.model,
        needKey: draft.needKey,
      });

      const ok = !!(r && r.ok);
      // 测通了才激活。测不通仍可保存，但**不抢**用户当前正在用的连接——
      // 半路抢走正在写作的对话所用的模型，比不激活更糟。
      if (ok) {
        try {
          await window.api.provider.activate({ id: draft.id });
          await notifyConfigChanged();
        } catch (_) { /* 不挡保存 */ }
      } else if (draft.id === activeId) {
        // ⚠ 没测通但改的正是当前在用的那条 → 主进程的
        //   provider:updateConnection 已经把 config.model 同步成新值了，
        //   这里也要让上层跟上，否则界面显示的模型名是新的、
        //   App 手里的还是旧的，两个数字对不上。
        await notifyConfigChanged();
      }

      await load({ pickId: draft.id });
      setActiveId(ok ? draft.id : activeId);
      setLive(ok ? { cid: draft.id, at: Date.now(), ...r } : null);
      // 保存完回到卡片态：用户接下来关心的是"成了没有"，不是继续改表单
      setDraft(null);
      setResult({
        ok,
        conn: draft,
        probe: r,
        latencyMs: r && r.latencyMs,
        modelCount: (r && r.models && r.models.length) || 0,
      });
    } catch (e) {
      setResult({ ok: false, title: '保存失败', detail: e.message, conn: draft });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 切换协议。
   *
   * ⚠ 换了协议要一起换 providerKey：量表是按协议分的
   *   （custom-openai / custom-anthropic 是两个不同的项），
   *   只改 protocol 会让「思考强度」那栏按错误的服务商显示档位。
   *   地址也一起清空 —— 三个协议的地址形态不同，留着旧的只会让人误以为还在用。
   */
  const setProtocol = (proto) => {
    const p = (caps?.providers || []).find(
      (x) => x.protocol === proto && x.key.startsWith('custom-')
    );
    setDraft((d) => ({
      ...d,
      protocol: proto,
      providerKey: p ? p.key : `custom-${proto === 'anthropic' ? 'anthropic' : 'openai'}`,
      base: '',
      model: '',
    }));
    setProbe(null);
  };

  /**
   * 是不是本地连接。
   *
   * ⚠ 先查量表（vLLM 是本地但协议是 openai，只看 protocol 会把它
   *   归到「自定义接入」里），量表还没回来时退回 protocol 判据。
   */
  function isLocal(c) {
    const p = (caps?.providers || []).find((x) => x.key === c.providerKey);
    if (p) return !!p.isLocal;
    return c.protocol === 'ollama';
  }

  /** 自定义接入（custom-*）：地址是用户自己从文档抄的 */
  function isCustom(c) {
    return String(c.providerKey || '').startsWith('custom-');
  }

  /**
   * 左栏分组，顺序与新建页一致（云端 → 自定义 → 本地）。
   *
   * ⚠ 原来只有「自定义接入 / 本地」两组，把所有云端都叫"自定义接入"——
   *   用户存了 DeepSeek，列表里却显示在"自定义接入"下面，
   *   与他刚做的操作对不上。
   */
  const groups = [
    { label: '☁️ 云端 API', items: list.filter((c) => !isLocal(c) && !isCustom(c)) },
    { label: '✍️ 自定义接入', items: list.filter((c) => !isLocal(c) && isCustom(c)) },
    { label: '🏠 本地大模型', items: list.filter((c) => isLocal(c)) },
  ];

  const models = probe?.ok ? (probe.models || []) : [];
  const modelsInUse = draft?.model ? [draft.model] : [];
  const showAll = models.filter((m) => !modelsInUse.includes(m));

  /**
   * 主区该显示什么——**三态，不是两态**：
   *
   *   draft 非空 → 编辑表单（用户主动点了 ✎ 或保存完正在改）
   *   有 active → 「当前连接」卡片（默认进屏就是它）
   *   都没有   → 选一条 / 新建
   *
   * ⚠ 原来的 `picking = !loading && !draft` 把"有正在使用的连接"和
   *   "一条都没有"混成同一个画面，于是每次进设置页都像从零开始——
   *   这正是「重新进入设置之后就需要重新连接」的观感来源。
   */
  const picking = !loading && !draft && !activeConn;
  const showCard = !loading && !draft && !!activeConn;

  return (
    <>
      <H1>AI 提供商</H1>

      <div className="flex gap-3">
        {/* ---------- 左：连接列表（只有用户自己建的） ---------- */}
        <div className="w-[190px] shrink-0">
          {loading && (
            <div className="text-[11px] px-1" style={{ color: 'var(--ink-soft)' }}>
              读取中…
            </div>
          )}

          {!loading && list.length === 0 && (
            <div className="text-[11px] px-2 py-1 leading-relaxed"
                 style={{ color: 'var(--ink-soft)' }}>
              还没有连接。
              <br />
              点下面「新建连接」加一条。
            </div>
          )}

          {/* ⚠ 有连接但没在用任何一条时要说明白，否则用户以为白装了 */}
          {!loading && list.length > 0 && !activeId && !draft && (
            <div className="text-[11px] px-2 py-1.5 mb-2 leading-relaxed rounded"
                 style={{ background: 'var(--accent-soft)', color: 'var(--ink-soft)' }}>
              现在没有在用任何连接。
              <br />
              点下面任意一条切过去，或新建一条。
            </div>
          )}

          {!loading && groups.map((g) => (
            g.items.length === 0 ? null : (
              <div key={g.label} className="mb-3">
                <div className="text-[11px] px-1 mb-1" style={{ color: 'var(--ink-soft)' }}>
                  {g.label}
                </div>
                {g.items.map((c) => {
                  const on = c.id === activeId;        // 正在用的
                  const editing = c.id === (draft && draft.id);
                  return (
                    <div
                      key={c.id}
                      data-conn={c.id}
                      className="flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer"
                      style={{
                        background: editing ? 'var(--accent-soft)'
                          : on ? 'var(--paper-2)' : 'transparent',
                        border: editing ? '1px solid var(--accent)'
                          : on ? '1px solid var(--line)' : '1px solid transparent',
                      }}
                      onClick={() => (editing ? switchTo(c) : edit(c))}
                      title={on ? '正在使用。点一下切到这条' : '点一下编辑这条连接'}
                    >
                      <span className="text-[12px] truncate flex-1"
                            style={{ color: on || editing ? 'var(--ink)' : 'var(--ink-soft)' }}>
                        {on ? '▸ ' : ''}{c.name}
                      </span>
                      {/* ⚠ 状态点的含义要说清楚：绿=能发请求（地址齐了/不需要密钥），红=还缺 */}
                      <span
                        title={c.base ? (c.hasKey || !c.needKey ? '已就绪' : '缺 API 密钥') : '还没填地址'}
                        style={{
                          color: c.base && (c.hasKey || !c.needKey) ? 'var(--ok)' : 'var(--danger)',
                          fontSize: '9px',
                        }}
                      >
                        ●
                      </span>
                      {on ? (
                        <span className="text-[10px]" style={{ color: 'var(--ink-soft)' }}>
                          在用
                        </span>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); switchTo(c); }}
                          className="text-[10px]"
                          style={{ color: 'var(--ink-soft)' }}
                          title="切到这条连接"
                        >
                          切
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); remove(c); }}
                        className="text-[11px] opacity-40 hover:opacity-100"
                        style={{ color: 'var(--danger)' }}
                        title="删除这条连接（连密钥一起删；只是不用请点「断开连接」）"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )
          ))}

          <button
            onClick={startCreate}
            disabled={creating}
            className="w-full px-2 py-1.5 rounded text-[12px] disabled:opacity-40"
            style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
          >
            ＋ 新建连接
          </button>
        </div>

        {/* ---------- 右：当前连接卡片 / 选服务商 / 详情 ---------- */}
        <div className="flex-1 min-w-0">
          {loading && <Hint>正在读取连接…</Hint>}

          {showCard && (
            <ActiveCard
              conn={activeConn}
              preset={preset}
              thinkUI={thinkUI}
              live={live}
              liveBusy={liveBusy}
              onEdit={() => edit(activeConn)}
              onRemove={() => remove(activeConn)}
              onDisconnect={disconnect}
              onRecheck={() => checkLive(activeConn.id)}
            />
          )}

          {picking && (
            <ProviderPicker
              caps={caps}
              busy={creating}
              onPick={createByPreset}
              hasSaved={list.length > 0}
            />
          )}

          {!loading && draft && (
            <>
              <Group title="连接">
                <Field label="名称">
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    className="w-full px-2 py-1.5 rounded text-[12.5px] outline-none"
                    style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
                  />
                  <Hint>自己看得懂就行。切连接时会按这个名字显示。</Hint>
                </Field>

                <Field label="API 地址">
                  <input
                    value={draft.base}
                    onChange={(e) => setDraft({ ...draft, base: e.target.value })}
                    placeholder={preset?.base || 'https://api.siliconflow.cn/v1'}
                    className="w-full px-2 py-1.5 rounded text-[12.5px] outline-none"
                    style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
                  />
                  <Hint>
                    {preset?.help
                      || '照服务商文档给的接口地址填。多数是 https://xxx/v1，'
                       + '少数（如智谱）是 /api/paas/v4。'}
                  </Hint>
                </Field>

                <Field label="API 格式">
                  <div className="flex gap-1.5">
                    {[
                      { k: 'openai', label: 'OpenAI 兼容' },
                      { k: 'anthropic', label: 'Anthropic 兼容' },
                      { k: 'ollama', label: 'Ollama' },
                    ].map((f) => {
                      const on = draft.protocol === f.k;
                      return (
                        <button
                          key={f.k}
                          onClick={() => setProtocol(f.k)}
                          className="px-2.5 py-1 rounded text-[12px]"
                          style={{
                            background: on ? 'var(--accent)' : 'var(--paper-2)',
                            color: on ? 'var(--accent-ink)' : 'var(--ink-soft)',
                            fontWeight: on ? 600 : 400,
                          }}
                        >
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                  <Hint>
                    ⚠ 选错了症状是 404 或「找不到 chat/completions」。
                    三个格式的请求地址不同：OpenAI 是
                    <code> /v1/chat/completions</code>，Anthropic 是
                    <code> /v1/messages</code>，Ollama 是 <code>/api/chat</code>。
                    切换会清空地址——按你的服务商文档重填。
                  </Hint>
                </Field>

                {/* 密钥。不需要密钥的连接（本地）不显示 */}
                {draft.needKey && (
                  <Field label="API Key">
                    <div className="flex gap-2">
                      <input
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        type="password"
                        placeholder={draft.hasKey ? '已保存（不回显）' : '在你服务商处获取'}
                        className="flex-1 px-2 py-1.5 rounded text-[12.5px] outline-none"
                        style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
                      />
                    </div>
                    {keyMsg && (
                      <div className="text-[11px] mt-1" style={{ color: 'var(--ink-soft)' }}>
                        {keyMsg}
                      </div>
                    )}
                    <Hint>
                      密钥用系统凭据加密后存在本机，不写进配置文件，
                      日志与截图里不会出现它。
                      {preset?.keyUrl && (
                        <>
                          {' '}
                          <a href={preset.keyUrl} target="_blank" rel="noreferrer"
                             style={{ color: 'var(--accent)' }}>
                            去{preset.name}取密钥 ↗
                          </a>
                        </>
                      )}
                    </Hint>
                  </Field>
                )}
              </Group>

              {/* ---- 模型 ---- */}
              <Group title="模型">
                <Field label="使用中的模型">
                  <div className="flex gap-2">
                    <input
                      value={draft.model}
                      onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                      placeholder="模型名，如 deepseek-ai/DeepSeek-V3"
                      className="flex-1 px-2 py-1.5 rounded text-[12.5px] outline-none"
                      style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
                    />
                    <button
                      onClick={fetchModels}
                      disabled={probing || !draft.base}
                      className="px-3 py-1.5 rounded text-[12px] disabled:opacity-40 shrink-0"
                      style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
                    >
                      {probing ? '获取中…' : '获取模型列表'}
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5 mt-1.5">
                    <StatusDot ok={probe?.ok} busy={probing} />
                    <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                      {probing ? '正在连接…'
                        : !probe ? '还没测过。填好地址和密钥后点右边「获取模型列表」。'
                          : probe.ok
                            ? `连接成功${probe.version ? `（服务端 v${probe.version}）` : ''}`
                              + (models.length ? `，${models.length} 个模型可用` : '')
                            : probe.error}
                    </span>
                  </div>

                  {showAll.length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-2">
                      {showAll.map((m) => (
                        <button
                          key={m}
                          onClick={() => setDraft({ ...draft, model: m })}
                          className="px-2 py-0.5 rounded text-[11px]"
                          style={{
                            background: 'var(--paper-2)',
                            color: 'var(--ink-soft)',
                          }}
                          title="点一下填进上面的输入框"
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  )}
                  <Hint>
                    {models.length === 0
                      ? '模型名各家不通用，填错了会报错。可以先填一个常见的试，测不通再改。'
                      : '点上面的模型名填进输入框。模型会变，这里列的是服务端此刻返回的。'}
                  </Hint>
                </Field>
              </Group>

              {/* ---- 思考强度：只有"默认档位"还留在这里 ----
                  每一轮的档位在聊天输入框旁边随手切（跟着对话记住）。
                  这里设的是**新建对话时的起点** —— 两件事，不是重复入口。 */}
              <Group title="思考强度">
                <Field label="新对话的默认档位">
                  {thinkUI.levels ? (
                    <div className="flex gap-1.5">
                      {thinkUI.levels.map((v) => {
                        return (
                          <ThinkButton key={v} value={v} />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-[12px] px-2 py-1.5 rounded"
                         style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}>
                      这家服务商不提供思考强度开关
                    </div>
                  )}
                  <Hint>
                    具体每一轮用多少，在<b>聊天输入框旁边</b>随手切——档位跟着那条对话记住。
                    这里设的是<b>新建对话时的起点</b>：简单修改和搭框架会在同一条对话里交替发生，
                    所以终点由聊天框决定，起点由这里决定。
                  </Hint>
                  {thinkUI.note && <Hint><b>{thinkUI.note}</b></Hint>}
                </Field>
              </Group>

              <div className="flex justify-end mt-4">
                <button
                  onClick={save}
                  disabled={busy || !draft.base}
                  className="px-5 py-2 rounded text-[12.5px] disabled:opacity-40"
                  style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                >
                  {busy ? '保存并测试中…' : '保存并测试'}
                </button>
              </div>
              {/* ⚠ 文案必须说清"保存时会测一次"。
                  save() 里确实是先 probe 再落库（探测失败也允许保存，
                  见那个函数的注释），按钮上不写"测试"的话，
                  用户会以为测不出来是自己没点到某个按钮。 */}
              {!draft.base
                ? <Hint>先填 API 地址才能保存。</Hint>
                : <Hint>保存后会<b>弹一个结果窗口</b>告诉你成没成——
                    连上了会直接把它设为正在用的连接。
                    测不通也照样保存，你可以先存下来再慢慢改。</Hint>}
            </>
          )}
        </div>
      </div>

      {result && (
        <SaveResult
          data={result}
          onClose={() => setResult(null)}
          onBack={() => {
            const c = result.conn;
            setResult(null);
            if (c && list.some((x) => x.id === c.id)) edit(c);
          }}
        />
      )}
    </>
  );
}

/**
 * 「当前连接」卡片 —— 设置页的默认画面。
 *
 * ## 为什么是卡片而不是表单
 *
 * 用户问的「重新进入设置之后就需要重新连接」，本质是**每次进来都在做配置动作**。
 * 而 95% 的时间他只是想知道"现在用的是哪条、还通不通"。
 * 卡片把这件事回答完，配置收进「编辑」里——**默认界面该对应默认问题**。
 *
 * ## 状态徽章必须有依据
 *
 * 「已连接」三个字不是配置里读出来的，是**刚才真的发了一次请求**。
 * live.ok === true 才显示绿标；false 显示红色原因；null（还在测）显示"正在检查"。
 * 拿不到依据就不给结论——一个永远绿的徽章比没有徽章更糟。
 */
function ActiveCard({
  conn, preset, thinkUI, live, liveBusy,
  onEdit, onRemove, onDisconnect, onRecheck,
}) {
  if (!conn) return null;
  const host = (conn.base || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const local = !!(preset && preset.isLocal);

  const badge = () => {
    if (live && live.ok === null) {
      return { text: '正在检查…', color: 'var(--ink-soft)', pulse: true };
    }
    if (live && live.ok) {
      const ms = live.latencyMs != null ? ` · ${live.latencyMs}ms` : '';
      const n = (live.models || []).length;
      return {
        text: `已连接${ms}${n ? ` · ${n} 个模型` : ''}`,
        color: 'var(--ok)', pulse: false,
      };
    }
    if (live && live.ok === false) {
      return { text: '连不上', color: 'var(--danger)', pulse: false };
    }
    return { text: '还没检查', color: 'var(--ink-soft)', pulse: false };
  };
  const b = badge();

  return (
    <div
      data-testid="active-card"
      className="rounded-xl p-4"
      style={{ background: 'var(--paper)', border: '1px solid var(--line)' }}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-[15px] shrink-0">{local ? '🏠' : '🌐'}</span>
        <span className="text-[14px] font-semibold truncate min-w-0">{host || '（还没填地址）'}</span>
        <span
          data-testid="active-badge"
          className="text-[11px] px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap"
          style={{
            color: b.color,
            background: 'var(--paper-2)',
            animation: b.pulse ? 'pulse 1s ease-in-out infinite' : 'none',
          }}
        >
          {b.text}
        </span>
        <span className="flex-1" />
        <button
          onClick={onRecheck}
          disabled={liveBusy}
          className="text-[12px] px-2.5 py-1 rounded disabled:opacity-40 shrink-0 whitespace-nowrap"
          style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
          title="重新测一次"
        >
          {liveBusy ? '检查中…' : '⟳ 检查'}
        </button>
      </div>

      <div className="h-px my-3" style={{ background: 'var(--line)' }} />

      <div className="flex items-center gap-2 text-[12.5px] flex-wrap">
        <span style={{ color: 'var(--ink-soft)' }}>正在用的模型</span>
        <span className="font-medium" style={{ color: conn.model ? 'var(--ink)' : 'var(--danger)' }}>
          {conn.model || '还没选模型'}
        </span>
        <span style={{ color: 'var(--ink-soft)' }}>·</span>
        <span style={{ color: 'var(--ink-soft)' }}>
          {conn.needKey
            ? (conn.hasKey ? '密钥已存' : '缺 API 密钥')
            : '本地连接，不需要密钥'}
        </span>
        {thinkUI.levels && (
          <>
            <span style={{ color: 'var(--ink-soft)' }}>·</span>
            <span style={{ color: 'var(--ink-soft)' }}>
              思考强度{thinkUI.levels.length === 2 ? '支持开关' : `支持 ${thinkUI.levels.length} 档`}
            </span>
          </>
        )}
      </div>

      {live && live.ok === false && (
        <div className="mt-2.5 text-[12px] leading-relaxed px-3 py-2 rounded"
             style={{ background: 'var(--paper-2)', color: 'var(--danger)' }}>
          {live.error}
          <div style={{ color: 'var(--ink-soft)' }} className="mt-1">
            地址或密钥可能变了。点「编辑」改完再点「保存并测试」。
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={onEdit}
          data-testid="btn-edit-active"
          className="px-3.5 py-1.5 rounded text-[12px] whitespace-nowrap"
          style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
        >
          ✎ 编辑
        </button>
        <button
          onClick={onRemove}
          className="px-3.5 py-1.5 rounded text-[12px] whitespace-nowrap"
          style={{ background: 'transparent', color: 'var(--ink-soft)' }}
          title="彻底删掉这条连接，密钥一起删"
        >
          删除
        </button>
        <button
          onClick={onDisconnect}
          data-testid="btn-disconnect"
          className="px-3.5 py-1.5 rounded text-[12px] whitespace-nowrap"
          style={{ background: 'var(--paper-2)', color: 'var(--danger)' }}
          title="不再用这条。连接、地址、密钥都留着，之后点一下卡片就能接回来"
        >
          ⏻ 断开连接
        </button>
      </div>
    </div>
  );
}

/**
 * 「保存并测试」的结果窗口。
 *
 * ⚠ 必须手动关。这是羽毛菌点名要的东西：
 *   「保存并测试成功后没有弹窗，我怎么知道它是否成功」。
 *   toast 会自己消失、在角落、还可能被下一条提示顶掉——
 *   它回答不了"我这次到底成没成"。
 *
 * ⚠ 成功窗口里给的是**证据**不是结论：地址、模型、耗时、返回几个模型。
 *   一句"连接正常"用户没法判断这句话是不是真的。
 *
 * ⚠ 失败时明确写"你的改动已经存下来了"——探测失败也允许保存是刻意的
 *   （见 save 的注释），不说清楚他会以为白改了、于是不敢再试。
 */
function SaveResult({ data, onClose, onBack }) {
  const ok = !!data.ok;
  const c = data.conn || {};
  const host = (c.base || '').replace(/^https?:\/\//, '');
  const n = data.modelCount || 0;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      // 点遮罩不关：这是结果通知，不是菜单。误点就没了等于没做。
      role="dialog"
      aria-modal="true"
      aria-label="保存结果"
      data-testid="save-result"
    >
      <div
        className="rounded-xl shadow-2xl p-5"
        style={{
          background: 'var(--paper)',
          width: 440,
          maxWidth: '92vw',
          border: '1px solid var(--line)',
        }}
      >
        <div className="flex items-center gap-2.5">
          <span className="text-[18px]">{ok ? '✅' : '❌'}</span>
          <span className="text-[15px] font-semibold"
                style={{ color: ok ? 'var(--ok)' : 'var(--danger)' }}>
            {ok ? '连接正常' : (data.title || '连不上')}
          </span>
        </div>

        {ok ? (
          <>
            <div className="mt-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--ink)' }}>
              <div><span style={{ color: 'var(--ink-soft)' }}>服务商　</span>{c.name || '—'}</div>
              <div className="truncate">
                <span style={{ color: 'var(--ink-soft)' }}>地址　　</span>{host || '—'}
              </div>
              <div className="truncate">
                <span style={{ color: 'var(--ink-soft)' }}>模型　　</span>{c.model || '（未填）'}
              </div>
              <div>
                <span style={{ color: 'var(--ink-soft)' }}>实测　　</span>
                {data.latencyMs != null ? `${data.latencyMs} ms` : '已连通'}
                {n ? ` · 服务端返回 ${n} 个模型` : ''}
              </div>
            </div>
            <div className="mt-3 text-[12px] leading-relaxed px-3 py-2 rounded"
                 style={{ background: 'var(--accent-soft)', color: 'var(--ink-soft)' }}>
              已设为<b style={{ color: 'var(--ink)' }}>正在使用的连接</b>，
              回到聊天直接就能写。以后每次进设置都还是它，
              直到你自己点「断开连接」。
            </div>
            <div className="flex justify-end mt-4">
              <button
                onClick={onClose}
                data-testid="btn-result-ok"
                className="px-5 py-2 rounded text-[12.5px]"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
              >
                知道了
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-3 text-[12.5px] leading-relaxed break-words"
                 style={{ color: 'var(--danger)' }}>
              {data.detail || data.probe?.error || '未知原因'}
            </div>
            <div className="mt-3 text-[12px] leading-relaxed px-3 py-2 rounded"
                 style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}>
              常见原因：地址少了或多了路径（如 /v1）、密钥过期或粘进了空格、
              API 格式选错（OpenAI / Anthropic / Ollama 三者路径不同）。
            </div>
            <div className="mt-2 text-[12px] leading-relaxed px-3 py-2 rounded"
                 style={{ background: 'var(--accent-soft)', color: 'var(--ink-soft)' }}>
              你刚才的改动<b style={{ color: 'var(--ink)' }}>已经存下来了</b>，
              改完再点一次「保存并测试」就行。
            </div>
            <div className="flex justify-end mt-4">
              <button
                onClick={ onBack || onClose }
                data-testid="btn-result-back"
                className="px-5 py-2 rounded text-[12.5px]"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
              >
                回去改
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 选一条 / 新建连接。
 *
 * ## 分组顺序 = 推荐顺序（2026-10-13 改）
 *
 * 羽毛菌：「万一电脑不支持本地就用不了该软件吗，也会有轻薄本用户
 * 没有显卡需要调用云端大模型的，进来之后应该是一个已保存的界面」。
 *
 * 原来排的是「自定义 → 云端 → 本地」，理由是"主力用户拿自己的地址接"。
 * 那个判断在 10-12 是对的，10-13 不成立了：**现在进设置页的多数是第一次用**，
 * 顺序决定了他看到的第一印象，而排在最后的「本地大模型」，
 * 对没有独显的轻薄本是"看着能选、选了才发现跑不动"。
 *
 * 于是改成：
 *   云端 API（推荐）→ 自定义（按文档填地址）→ 本地大模型（需要本机环境）
 *
 * 本地那组不删（装了 Ollama 的人确实需要），但要说清代价。
 *
 * ⚠ 用 function 声明而不是 const 箭头：ProviderCat 在渲染期直接引用它，
 *   声明在后也不会有 TDZ（声明提升）。这条有测试钉住。
 */
function ProviderPicker({ caps, busy, onPick, hasSaved }) {
  if (!caps) {
    return (
      <>
        <Group title="新建连接">
          <Hint>读不到服务商量表（见下方错误提示）。仍然可以新建一条自己填地址的连接。</Hint>
          <button
            onClick={() => onPick('custom-openai')}
            disabled={busy}
            className="px-3 py-1.5 rounded text-[12px] mt-2 disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            新建（自己填地址）
          </button>
        </Group>
      </>
    );
  }

  const all = caps.providers || [];
  const customs = all.filter((p) => String(p.key).startsWith('custom-'));
  const locals = all.filter((p) => p.isLocal && !String(p.key).startsWith('custom-'));
  const clouds = all.filter((p) => !p.isLocal && !String(p.key).startsWith('custom-'));

  return (
    <Group title={hasSaved ? '换一条 / 新建' : '新建连接'}>
      <Hint>
        选一个服务商，地址与协议会自动填好；也可以选「自定义」直接填文档给的地址。
        选完随时能改。
      </Hint>

      <PickerGroup title="☁️ 云端 API（推荐）" items={clouds} busy={busy} onPick={onPick}
                   hint="不用装任何东西，按量付费。填个密钥就能用。" />
      <PickerGroup title="✍️ 自定义（按文档填地址）" items={customs} busy={busy} onPick={onPick}
                   hint="公司内网代理、自建服务、中转站走这条。" />
      <PickerGroup
        title="🏠 本地大模型（需要本机环境）"
        items={locals}
        busy={busy}
        onPick={onPick}
        hint="⚠ 要先在本机装好 Ollama 或 vLLM 并运行它。模型跑在你自己的机器上，
              吃内存吃显存——轻薄本或没独显的机器会很吃力，不确定就别选这条。"
      />
    </Group>
  );
}

function PickerGroup({ title, items, busy, onPick, hint }) {
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <div className="text-[11px] mb-1.5" style={{ color: 'var(--ink-soft)' }}>{title}</div>
      <div className="flex gap-1.5 flex-wrap">
        {items.map((p) => (
          <button
            key={p.key}
            data-preset={p.key}
            disabled={busy}
            onClick={() => onPick(p.key)}
            title={p.base || '自己填地址'}
            className="px-2.5 py-1.5 rounded text-[12px] text-left disabled:opacity-40"
            style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
          >
            {p.name}
            {p.base && (
              <span className="block text-[10px] truncate"
                    style={{ color: 'var(--ink-soft)', maxWidth: '190px' }}>
                {p.base.replace(/^https?:\/\//, '')}
              </span>
            )}
          </button>
        ))}
      </div>
      {hint && (
        <div className="text-[11px] mt-1.5 leading-relaxed"
             style={{ color: 'var(--ink-soft)', maxWidth: 460 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * 思考强度的档位按钮。
 *
 * ⚠ 抽出来是因为有个真问题：档位要写回设置，
 *   而设置现在跟着连接走。放在 ProviderCat 内联写容易漏掉
 *   「切换连接后档位没跟着重置」——那会让用户给 Ollama 设的
 *   「高」留在百炼上，而百炼只有开/关。
 *
 * 用 `function` 声明而不是 const 箭头函数：ProviderCat 在渲染期
 * 直接引用它，声明在后也不会有 TDZ（声明提升）。这条有测试钉住。
 */
function ThinkButton({ value }) {
  const [level, setLevel] = useState(null);
  useEffect(() => {
    window.api.config.get().then((c) => setLevel(c.thinkLevel || 'off'))
      .catch(() => setLevel('off'));
  }, []);
  const on = (level || 'off') === value;
  return (
    <button
      onClick={() => {
        setLevel(value);
        window.api.config.set({ thinkLevel: value }).catch(() => {});
      }}
      className="px-3 py-1.5 rounded text-[12px]"
      style={{
        background: on ? 'var(--accent)' : 'var(--paper-2)',
        color: on ? 'var(--accent-ink)' : 'var(--ink-soft)',
        fontWeight: on ? 600 : 400,
      }}
    >
      {value === 'off' ? '关闭' : value === 'on' ? '开启'
        : { low: '低', medium: '中', high: '高' }[value] || value}
    </button>
  );
}
