export default SkillCat;

import { useCallback, useEffect, useState } from 'react';
import { H1, Group, Hint } from './settings-ui.jsx';
/**
 * Skill 管理。
 *
 * ## 界面结构（2026-10-12 重做）
 *
 *     Skill 定义了 AI 的工作流程和行为规范。
 *     开关打开的 Skill 会注入到系统提示词。已开启 3 / 共 6
 *
 *     [🔍 搜索 Skill]              [已启用] [导入] [导出]
 *
 *     内置 2
 *       📦 小说写作助手          [开关]
 *          写小说时使用。当用户要写小说、创作小说…
 *          📎 references/templates.md
 *       📦 技能创建助手          [开关]
 *
 *     自定义 1
 *       ✏️ 按夜枫视角重写       [开关] [编辑] [删除]
 *
 * ## 渐进式加载的三个级别在界面上的对应
 *
 *   1. 这一页显示的 description —— 每轮对话都常驻上下文
 *   2. 点「编辑」看到的 SKILL.md 正文 —— 只在引用时加载
 *   3. 配套文件 —— 模型自己按需读
 *
 * 所以 description 的长度在这里是**要展示给用户看的**，
 * 用户能直接看出"我的技能会不会被触发"。
 *
 * ## 导入的校验为什么要严格
 *
 * 渐进式加载下 description 是模型判断要不要用这个技能的**唯一依据**。
 * 缺 description 的技能装了等于没装——用户会以为"装了但没生效"。
 * 所以导入时必须提示，不能默默装上。
 */
function SkillCat({ projectId, onToast }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [onlyOn, setOnlyOn] = useState(false);
  const [editing, setEditing] = useState(null);   // {id?, name, content}
  const [files, setFiles] = useState([]);          // 正在编辑的配套文件
  const [busyId, setBusyId] = useState(null);
  // ⚠ 「导入」那条 UI 路径已删（2026-10-16），所以 importing 这个 state 也没用了。
  //   ⚠⚠ 但 `window.api.skill.importCheck / importCommit` **两个通道必须留着** ——
  //     编辑与新建都走 importCommit，删了界面就存不进 skill。
  const [viewFile, setViewFile] = useState(null);   // {path, content}
  // 自动路由开关（2026-10-16）
  const [autoSkill, setAutoSkill] = useState(false);
  const [configReady, setConfigReady] = useState(false);

  /**
   * 读自动路由开关。
   *
   * ⚠ SkillCat 没有 config prop（ToolCat 才有），
   *   所以这里自己走 window.api.config 读一次。
   *   ⚠ configReady 是硬要求：config 没读回来之前按钮保持 disabled，
   *   否则用户可能在配置还没加载时就点了开关，
   *   把一个**基于默认值**的 false 写成 true —— 看着像"打开了"，
   *   但主进程那边读到的可能是另一个值。
   */
  useEffect(() => {
    window.api.config.get()
      .then((c) => { setAutoSkill(!!c?.autoSkill); })
      .catch(() => setAutoSkill(false))
      .finally(() => setConfigReady(true));
  }, []);

  const toggleAutoSkill = async () => {
    if (!configReady) return;
    const next = !autoSkill;
    // ⚠ 先设本地状态，让按钮立刻响应 —— 但失败要回滚。
    //   直接等 IPC 回来会让本地模型的用户觉得"点了没反应"。
    setAutoSkill(next);
    try {
      await window.api.config.set({ autoSkill: next });
      onToast?.(next
        ? '已打开自动挑选：发消息时会先判断该用哪些 Skill。'
        : '已关闭：Skill 要自己 @ 勾选。');
    } catch (e) {
      setAutoSkill(!next);      // 回滚，不能让界面显示与实际配置不一致
      onToast?.('开关没能保存：' + (e?.message || e));
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ls = await window.api.skill.listAll({ projectId }) || [];
      // ⚠ 配套文件清单要一并取，否则列表上不会出现 📎 标签，
      //   用户根本不知道这个技能还有 references/ 下的东西。
      //   逐个取而不是让主进程一次返回全部内容——
      //   配套文件可能几百 KB，一次全过 IPC 会卡住设置页。
      const withFiles = await Promise.all(ls.map(async (sk) => {
        try {
          return { ...sk, __files: await window.api.skill.files({ id: sk.id }) || [] };
        } catch (_) {
          return { ...sk, __files: [] };
        }
      }));
      setList(withFiles);
    } catch (e) {
      onToast?.(`读取技能失败：${e.message}`);
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, onToast]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (sk) => {
    setBusyId(sk.id);
    try {
      await window.api.skill.setEnabled({ id: sk.id, enabled: !sk.enabled });
      await load();
    } catch (e) {
      onToast?.(`操作失败：${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = async (sk) => {
    setEditing({ id: sk.id, name: sk.name, content: sk.prompt_content || '' });
    try {
      setFiles(await window.api.skill.files({ id: sk.id }) || []);
    } catch (_) {
      setFiles([]);
    }
  };

  const startCreate = () => {
    setEditing({ id: null, name: '', content: TEMPLATE_SKILL_MD });
    setFiles([]);
  };

  /** 保存编辑（新建或改已有）。走 importCommit —— 它会校验 frontmatter。 */
  const commit = async () => {
    const content = editing.content;
    if (!content.trim()) { onToast?.('内容不能为空'); return; }
    setBusyId(editing.id || '__new__');
    try {
      // 名字优先取 frontmatter 里的 name，那是这个技能真正的标识
      const check = await window.api.skill.importCheck(content);
      const name = check.name || editing.name.trim();
      if (!name) {
        onToast?.('缺名称。SKILL.md 的 frontmatter 里要有 name，或者在上面填一个。');
        return;
      }

      if (editing.id) {
        await window.api.skill.update({
          id: editing.id, name, promptContent: content,
        });
        // 配套文件有增删，分别处理
        for (const f of files) {
          if (f.__del) await window.api.skill.deleteFile({ id: editing.id, path: f.path });
          else if (f.content != null) {
            await window.api.skill.saveFile({
              id: editing.id, path: f.path, content: f.content, kind: f.kind,
            });
          }
        }
        onToast?.('已保存');
      } else {
        const r = await window.api.skill.importCommit({
          content, name, projectId,
          files: files.filter((f) => !f.__del).map((f) => ({
            path: f.path, kind: f.kind, content: f.content || '',
          })),
        });
        // ⚠ 校验不过也存了，但要把问题说清楚——
        //   硬拦的话用户存不了半成品草稿，那是合理用法。
        const bad = (r.files || []).filter((f) => !f.ok);
        if (bad.length) {
          const detail = bad.map((f) => `${f.path}（${f.error}）`).join('；');
          onToast?.(`已创建，但 ${bad.length} 个配套文件没存上：${detail}`, 5000);
        } else if (check.warnings && check.warnings.length) {
          onToast?.(`已创建。${check.warnings[0]}`, 5000);
        } else {
          onToast?.('已创建');
        }
      }
      setEditing(null);
      await load();
    } catch (e) {
      onToast?.(`保存失败：${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  /* ⚠⚠⚠ 原来这里有 doImportCheck / doImportCommit（2026-10-16 删）。
     ⚠ 它们和 `commit` 走的是同一个 `window.api.skill.importCommit`，
     而那条通道**必须留着** —— 编辑与新建都用它（见上面 commit 的注释）。
     ⚠ 只删了「导入」这条 UI 路径：产品方向改为用户自己蒸馏 skill，
     没有广场就没有"导入别人的"这条路径了。 */

  const remove = async (sk) => {
    if (!window.confirm(`删除技能「${sk.name}」？\n\n这一步不可撤销。`)) return;
    setBusyId(sk.id);
    try {
      await window.api.skill.remove({ id: sk.id });
      onToast?.(`已删除「${sk.name}」`);
      await load();
    } catch (e) {
      onToast?.(`删除失败：${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const doExport = async (sk) => {
    try {
      const r = await window.api.skill.export({ id: sk.id });
      const files = (r.files || []).map((f) => `\n\n<!-- ===== ${f.path} =====\n${f.content}`);
      const text = r.content + files.join('');
      await navigator.clipboard.writeText(text);
      onToast?.(`「${sk.name}」已复制到剪贴板，可以直接贴到别的工具里`);
    } catch (e) {
      onToast?.(`导出失败：${e.message}`);
    }
  };

  const openFile = async (sk, p) => {
    try {
      const f = await window.api.skill.file({ id: sk.id, path: p });
      setViewFile({ ...f });
    } catch (e) {
      onToast?.(`读取失败：${e.message}`);
    }
  };

  // ---------------- 过滤与分组 ----------------
  const kw = q.trim().toLowerCase();
  const filtered = list.filter((sk) => {
    if (onlyOn && !sk.enabled) return false;
    if (!kw) return true;
    return (sk.name || '').toLowerCase().includes(kw)
      || (sk.prompt_content || '').toLowerCase().includes(kw);
  });

  const builtin = filtered.filter((s) => s.type === 'built-in');
  const mine = filtered.filter((s) => s.type !== 'built-in');
  const onCount = list.filter((s) => s.enabled).length;

  /** 从 SKILL.md 里抠出 description 给列表显示 */
  const descOf = (sk) => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(sk.prompt_content || '');
    if (!m) return { d: '', ok: false };
    const dm = /^description:\s*(.*)$/m.exec(m[1]);
    return { d: dm ? dm[1].trim() : '', ok: !!dm };
  };

  /**
   * 编辑器：正文 + 配套文件。
   *
   * ⚠ 定义刻意放在 renderRow **之前**：renderRow 在编辑态会
   *   `return renderEditor(sk)`，两者都是组件体里的 const 箭头函数，
   *   没有声明提升。实际不会崩（renderRow 只在 return 的 JSX 里被调用，
   *   那时 renderEditor 早初始化完了），但把被依赖的写在依赖它的前面，
   *   才是永远成立的那种写法 —— test-tdz.js 照这条判据扫。
   */
  const renderEditor = (sk) => (
    <div key={sk.id} className="p-3 border-b"
         style={{ borderColor: 'var(--line)', background: 'var(--accent-soft)' }}>
      <input
        value={editing.name}
        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
        placeholder="显示名（SKILL.md 里的 name 优先）"
        className="w-full px-2 py-1.5 rounded text-[12.5px] outline-none mb-1.5"
        style={{ background: 'var(--paper)', color: 'var(--ink)' }}
        disabled={!!editing.id}
      />
      <textarea
        value={editing.content}
        onChange={(e) => setEditing({ ...editing, content: e.target.value })}
        rows={12}
        className="w-full px-2 py-1.5 rounded text-[12px] outline-none resize-y font-mono"
        style={{ background: 'var(--paper)', color: 'var(--ink)', lineHeight: 1.6 }}
      />
      <SkillFilesEditor files={files} setFiles={setFiles} />

      <div className="flex gap-2 justify-end mt-2">
        <button
          onClick={() => { setEditing(null); setFiles([]); }}
          className="px-2.5 py-1 rounded text-[12px]"
          style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
        >
          取消
        </button>
        <button
          onClick={commit}
          disabled={busyId != null}
          className="px-3 py-1 rounded text-[12px] disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
        >
          保存
        </button>
      </div>
    </div>
  );

  const renderRow = (sk) => {
    const on = !!sk.enabled;
    const isEditing = editing && editing.id === sk.id;
    const isBuiltin = sk.type === 'built-in';
    const { d, ok: hasDesc } = descOf(sk);
    const fileList = sk.__files || [];
    // 目录式 Skill（有 SKILL.md 或配套文件）才该有 description；
    // 单条提示词技能天生没有，走的是另一套（@ 引用即全文）。
    const isDirectorySkill = fileList.length > 0
      || /\r?\n---\r?\n/.test(sk.prompt_content || '')
      || (sk.prompt_content || '').startsWith('---');

    if (isEditing) return renderEditor(sk);

    return (
      <div
        key={sk.id}
        className="px-3 py-2 border-b"
        style={{
          borderColor: 'var(--line)',
          opacity: busyId === sk.id ? 0.5 : 1,
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[12px] shrink-0">{isBuiltin ? '📦' : '✏️'}</span>
          <span className="text-[12.5px] font-medium truncate flex-1"
                style={{ color: on ? 'var(--ink)' : 'var(--ink-soft)' }}>
            {sk.name}
          </span>

          {/* 开关 */}
          <button
            onClick={() => toggle(sk)}
            className="w-9 h-5 rounded-full relative shrink-0 transition-colors"
            style={{
              background: on ? 'var(--accent)' : 'var(--paper-2)',
              border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
            }}
            title={on ? '点一下停用' : '点一下启用'}
          >
            <span
              className="absolute w-3.5 h-3.5 rounded-full transition-all"
              style={{
                background: on ? '#fff' : 'var(--ink-soft)',
                left: on ? '18px' : '2px',
                top: '2px',
              }}
            />
          </button>

          <button
            onClick={() => startEdit(sk)}
            className="w-6 h-6 rounded text-[11px] shrink-0"
            style={{ color: 'var(--ink-soft)' }}
            title="编辑"
          >
            ✎
          </button>
          <button
            onClick={() => doExport(sk)}
            className="w-6 h-6 rounded text-[11px] shrink-0"
            style={{ color: 'var(--ink-soft)' }}
            title="导出到剪贴板"
          >
            ⇩
          </button>
          {/* ⚠ 内置不给删：它每次启动都会补回来 */}
          {!isBuiltin && (
            <button
              onClick={() => remove(sk)}
              className="w-6 h-6 rounded text-[11px] shrink-0"
              style={{ color: 'var(--danger)' }}
              title="删除"
            >
              🗑
            </button>
          )}
        </div>

        {/* ⚠ 警告只对「本来应该有 description 却没写」的技能。
            单条提示词技能（没有 frontmatter）不该被标红——
            它们是另一种形态：正文就是全部，靠 @ 引用使用，
            不参与「模型看 description 决定要不要自动触发」那套机制。
            把它们和"漏写了 description 的目录式 Skill"混在一起报，
            界面上三条正常工作的技能全变红，用户会去修不该修的东西。 */}
        {!hasDesc && isDirectorySkill && (
          <div className="text-[11px] mt-1 flex items-center gap-1"
               style={{ color: 'var(--danger)' }}>
            ⚠ 有 SKILL.md 却没有 description，这个技能不会被自动触发，只能手动 @
          </div>
        )}
        {/* ⚠ 没有 description 就显示提示词本身。
            否则单条提示词技能在列表里只有个名字，
            用户不知道它到底干什么，也就不知道该不该开着。 */}
        {(d || !isDirectorySkill) && (
          <div className="text-[11px] mt-1 line-clamp-2"
               style={{ color: 'var(--ink-soft)' }} title={d || sk.prompt_content}>
            {d || sk.prompt_content}
          </div>
        )}

        {/* 配套文件 */}
        {fileList.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mt-1.5">
            {fileList.map((f) => (
              <button
                key={f.path}
                onClick={() => openFile(sk, f.path)}
                className="text-[10.5px] px-1.5 py-0.5 rounded"
                style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
                title={`${f.size} 字，点击查看`}
              >
                📎 {f.path}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };


  // ---------------- 渲染 ----------------
  const inEditor = !!editing;

  return (
    <>
      <H1>Skill</H1>

      <Hint>
        Skill 定义了 AI 的工作流程和行为规范。
        开关打开的 Skill 会注入到系统提示词。
        {' '}已开启 <b>{onCount}</b> / 共 {list.length}
      </Hint>

      {/* ---- 自动路由开关（2026-10-16 新增）----
       *
       * ⚠ 位置在 Hint 之后、工具条之前：它是对整页的全局设置，
       *   不该藏在列表里某一条上。
       *
       * ⚠ 默认关着，而且这一段必须把「关着会怎样」说清楚：
       *   开着会多一次模型调用（本地 8B 约 0.2 秒，云端按服务商算），
       *   而且在用户看不到的地方发生。默认关是给他一个选择，不是替他做主。
       */}
      <div
        className="rounded-lg px-3 py-2.5 my-3"
        style={{ border: '1px solid var(--line)', background: 'var(--paper-2)' }}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px]" style={{ color: 'var(--ink)' }}>
              自动挑选 Skill
            </div>
            <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
              {autoSkill
                ? '已开。发消息前会先判断该用哪些 Skill，你不用手动 @。'
                : '关着。每次要用的 Skill 都要自己在输入框上方 @ 勾选。'}
            </div>
          </div>
          <button
            onClick={toggleAutoSkill}
            disabled={!configReady}
            className="px-2.5 py-1 rounded text-[12px] shrink-0 disabled:opacity-50"
            style={{
              background: autoSkill ? 'var(--accent)' : 'var(--paper)',
              color: autoSkill ? 'var(--accent-ink)' : 'var(--ink-soft)',
              border: '1px solid var(--line)',
            }}
          >
            {autoSkill ? '已开' : '开启'}
          </button>
        </div>
        {autoSkill && (
          <div className="text-[11px] mt-1.5" style={{ color: 'var(--ink-soft)' }}>
            手动 @ 的优先。你勾过的不会被自动结果覆盖。
          </div>
        )}
      </div>

      {/* ---- 工具条 ---- */}
      <div className="flex gap-2 items-center my-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 Skill"
          className="flex-1 px-2.5 py-1.5 rounded text-[12.5px] outline-none"
          style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}
        />
        <button
          onClick={() => setOnlyOn(!onlyOn)}
          className="px-2.5 py-1.5 rounded text-[12px] shrink-0"
          style={{
            background: onlyOn ? 'var(--accent)' : 'var(--paper-2)',
            color: onlyOn ? 'var(--accent-ink)' : 'var(--ink-soft)',
          }}
        >
          只看已启用
        </button>
        {/* ⚠⚠⚠ 这里原来有**两个**按钮：「导入」（粘贴别人的 SKILL.md）和
            「＋ 新建」（自己写）。2026-10-16 羽毛菌：「这个 skill 里面的导入和新建
            感觉功能重合了，保留一个就行」。

            ⚠ 它们的终点是同一个 `commit`（都校验 frontmatter、都要存 references），
              所以功能上真的重合 —— 用户想粘贴一份 SKILL.md，
              在「＋ 新建」的编辑器里粘贴**一样能存**。
            ⚠⚠ 保留「＋ 新建」而不是「导入」，是因为产品方向变了：
              **Skill 广场暂缓**（2026-10-16：「需要租服务器，目前暂不开发，
              还是通过用户自己蒸馏 skill 保存吧」），
              没有广场就没有"导入别人的"这条路径，
              剩下的就是**用户自己写、自己存** —— 一个入口就够。

            ⚠ 顺带删掉了 startImport / 导入区 JSX / ImportCheckPanel，
              但 **`importCommit` 这个 IPC 留着**：编辑与新建都走它，删了界面就存不了。*/}
        <button
          onClick={startCreate}
          data-testid="skill-create"
          className="px-2.5 py-1.5 rounded text-[12px] shrink-0"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
        >
          ＋ 新建
        </button>
      </div>

      {/* ⚠⚠ 原「导入区」已删除（2026-10-16，理由见上面那两个按钮的注释）。
          ⚠ 新建编辑器里本来就能粘贴整份 SKILL.md，导入能力没有丢。*/}

      {/* ---- 新建区 ---- */}
      {editing && !editing.id && (
        <div className="mb-3">
          {renderEditor({ id: '__new__' })}
        </div>
      )}

      {/* ---- 列表 ---- */}
      {loading ? <Hint>读取中…</Hint> : (
        <>
          {builtin.length > 0 && (
            <Group title={`内置 ${builtin.length}`}>
              {builtin.map(renderRow)}
            </Group>
          )}
          {mine.length > 0 && (
            <Group title={`自定义 ${mine.length}`}>
              {mine.map(renderRow)}
            </Group>
          )}
          {filtered.length === 0 && (
            <Hint>
              {/* ⚠ 空态文案原来写「点『＋ 新建』写一个，或『导入』别人的」——
              「导入」按钮 2026-10-16 已删，留在文案里就成了**指向不存在的入口**。
              ⚠ 顺带把产品方向写进去：Skill 广场暂缓（要租服务器），
              技能靠**用户自己蒸馏**存到本机。 */}
              {kw ? `没有匹配「${kw}」的技能。` : '还没有技能。点「＋ 新建」写一个 —— 蒸馏好之后它就存在这台机器上，随时能带进对话。'}
            </Hint>
          )}
        </>
      )}

      {/* ---- 查看配套文件 ---- */}
      {viewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center"
             style={{ background: 'rgba(0,0,0,0.4)' }}
             onClick={() => setViewFile(null)}
        >
          <div
            className="max-w-2xl w-full max-h-[70vh] overflow-auto p-4 rounded-lg"
            style={{ background: 'var(--paper)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center mb-2">
              <span className="text-[12.5px] font-medium flex-1">{viewFile.path}</span>
              <button
                onClick={() => setViewFile(null)}
                className="text-[14px]"
                style={{ color: 'var(--ink-soft)' }}
              >
                ✕
              </button>
            </div>
            <pre
              className="text-[12px] whitespace-pre-wrap"
              style={{ color: 'var(--ink)', lineHeight: 1.7 }}
            >
              {viewFile.content}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

/** 配套文件编辑器。加、删、改都在这里。 */
function SkillFilesEditor({ files, setFiles }) {
  const add = () => {
    setFiles([...files, { path: 'references/new.md', kind: 'reference', content: '' }]);
  };
  const edit = (i, patch) => {
    const next = [...files];
    next[i] = { ...next[i], ...patch };
    setFiles(next);
  };
  const del = (i) => {
    const f = files[i];
    // 已存在的要标 __del（保存时才真删），
    // 本轮还没存过的直接从数组去掉——否则界面上还留着一行空白
    setFiles(f.__del
      ? files.filter((_, k) => k !== i)
      : files.map((x, k) => (k === i ? { ...x, __del: true } : x)));
  };

  if (files.length === 0) {
    return (
      <div className="mt-2">
        <button
          onClick={add}
          className="text-[11px] px-2 py-0.5 rounded"
          style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
        >
          ＋ 加一个配套文件
        </button>
        <div className="text-[10.5px] mt-1" style={{ color: 'var(--ink-soft)' }}>
          配套文件不会自动进上下文。模型需要时自己去读——
          所以要在正文里写清「什么时候读哪个」。
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="text-[11px] mb-1" style={{ color: 'var(--ink-soft)' }}>
        配套文件
      </div>
      {files.map((f, i) => (
        <div key={i} className="mb-1.5">
          <div className="flex gap-1.5 items-center">
            <input
              value={f.path}
              onChange={(e) => edit(i, { path: e.target.value })}
              placeholder="references/xxx.md"
              className="flex-1 px-2 py-1 rounded text-[11.5px] outline-none font-mono"
              style={{ background: 'var(--paper)', color: 'var(--ink)' }}
              disabled={!!f.__del}
            />
            <button
              onClick={() => del(i)}
              className="text-[12px] px-1 shrink-0"
              style={{ color: 'var(--danger)' }}
              title="删除这个文件"
            >
              ✕
            </button>
          </div>
          <textarea
            value={f.content || ''}
            onChange={(e) => edit(i, { content: e.target.value })}
            rows={3}
            placeholder="文件内容"
            className="w-full px-2 py-1 rounded text-[11.5px] outline-none resize-y mt-1 font-mono"
            style={{ background: 'var(--paper)', color: 'var(--ink)' }}
            disabled={!!f.__del}
          />
        </div>
      ))}
      <button
        onClick={add}
        className="text-[11px] px-2 py-0.5 rounded"
        style={{ background: 'var(--paper-2)', color: 'var(--ink-soft)' }}
      >
        ＋ 再加一个
      </button>
    </div>
  );
}


/** 新建时的 SKILL.md 骨架 */
const TEMPLATE_SKILL_MD = `---
name: my-skill
description: 什么时候该用它。写清触发场景和关键词，宁滥勿缺——模型容易不触发。
---

# 技能标题

这个技能做什么，为什么这么做。

## 工作流程

### Step 1: [步骤名]
[做什么]

### Step 2: [步骤名]
[做什么]

## 重要规则
- [规则]（说清原因，比只写"必须"有效）

## 配套文件
- \`references/xxx.md\` —— 什么时候读它
`;