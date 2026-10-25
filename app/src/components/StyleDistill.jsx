/**
 * 文风蒸馏：读一批原文 → 学出文风 → 生成一个可挂载的 skill。
 *
 * ## 它不是「资料蒸馏」
 *
 * 资料蒸馏（DistillPanel）抽的是「有什么」（设定条目 → 设定库）。
 * 这里学的是「怎么写」（句长、对白、标点、修辞习惯 → skill）。
 * 羽毛菌的原话：「你现在的这个蒸馏功能不对」—— 他要的是后者。
 *
 * ## 流程为什么是三步而不是一把梭
 *
 * 10 万字中文 ≈ 13 万 token，128K 窗口扣掉系统提示与输出预留就装不下，
 * 一把梭稳定失败。后端走 map-reduce（分块提取 → 汇总），
 * 这里让用户看到进度，才不像卡死。
 *
 * ⚠ **10 万字上限在界面上就要说清**：超了按钮直接禁用并告诉他差多少字，
 *   而不是点下去等后端报错。
 */
import React, { useState, useRef } from 'react';

const MAX_CHARS = 20000;    // 与 main.js 的 DISTILL_MAX_CHARS 一致：单次 2 万，靠多次累积

/** 把文件树压成 {path, name} 列表（只取文件） */
function flatFiles(tree, prefix = '', out = []) {
  for (const n of (tree && tree.children) || []) {
    if (n.type === 'file') out.push({ path: prefix + n.name, name: n.name });
    else if (n.children) flatFiles(n, prefix + n.name + '/', out);
  }
  return out;
}

/**
 * ⚠⚠⚠ JSX 里**绝不能裸写块注释**（2026-10-15 现场事故）。
 *
 * 我在标题下面写了一段"说明为什么警告要放这里"的长注释，结果
 * **整段被当成正文渲染了出来** —— 用户看到界面上明明白白写着
 * 「羽毛菌指定要放的一句（2026-10-15）：…」，直接问
 * 「你怎么把这些话放进来了」。
 *
 * 原因：JSX 的 children 里，块注释的写法就是**文本**。
 * 要写成注释，必须包在花括号里，而且开头**只能两个星号**；
 * 三个星号（花括号加块注释起手式）照样被当文本。
 *
 * 所以规矩是：解释性长注释写在 **JSX 之外的 JS 位置**（组件体上方），
 * JSX 里最多留一行花括号注释。
 *
 * ⚠⚠ 顺带一个同源的坑，比上面那个还阴：
 *   **注释里不能出现块注释的结束符**（两个星号加一个斜杠）。
 *   为了举例子我把它写进了注释里，构建器读到它就认为注释结束了，
 *   剩下的行当成代码 → `Unexpected token`，整个文件构建失败。
 *   我连踩两次。要举例就用纯文字描述，比如「星号星号斜杠」。
 */

export default function StyleDistill({ projectId, tree, onClose, onToast }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]);       // 已选文件 path
  const [pasted, setPasted] = useState('');        // 手贴的正文
  const [uploaded, setUploaded] = useState([]);     // 上传的 txt/md/docx
  const [busy, setBusy] = useState(null);          // 进度文案
  const [result, setResult] = useState(null);      // {skillMd, stats}
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const taRef = useRef(null);

  const files = flatFiles(tree);
  const chars = pasted.length;
  const over = chars > MAX_CHARS;

  /** 弹系统文件选择框读 txt/md/docx（docx 由主进程自己解 zip） */
  const pick = async () => {
    try {
      const r = await window.api.style.pickFiles();
      if (Array.isArray(r) && r.length) {
        setUploaded((prev) => {
          const byPath = new Map(prev.map((x) => [x.path, x]));
          for (const f of r) byPath.set(f.path, f);   // 同路径覆盖，不重复堆
          return [...byPath.values()];
        });
      }
    } catch (e) {
      setErr('选择文件失败：' + e.message);
    }
  };

  const toggle = (p) => setPicked((prev) =>
    prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);

  /** 读选中文件 + 手贴正文 */
  const collect = async () => {
    const parts = [];
    for (const p of picked) {
      try {
        const r = await window.api.fs.read({ projectId, path: p });
        if (r && r.content) parts.push(`《${p}》\n${r.content}`);
      } catch (_) { /* 读不到就跳过，不中断 */ }
    }
    for (const u of uploaded) {
      if (u.content) parts.push(`《${u.name}》\n${u.content}`);
    }
    if (pasted.trim()) parts.push(pasted);
    return parts.join('\n\n');
  };

  const run = async () => {
    setErr('');
    setResult(null);
    setSaved(null);
    setBusy('正在读取选中的文件…');
    let body;
    try {
      body = await collect();
    } catch (e) {
      setErr(`读取失败：${e.message}`);
      setBusy(null);
      return;
    }
    if (!body.trim()) { setErr('先选一个文件，或者把正文贴进下面的框里。'); setBusy(null); return; }
    if (body.length > MAX_CHARS) {
      setErr(`一共 ${body.length} 字，超过 ${MAX_CHARS} 字上限，请去掉 ${body.length - MAX_CHARS} 字。`);
      setBusy(null);
      return;
    }
    setBusy(`正在学风格（${body.length} 字，要分几遍读，可能要一两分钟）…`);
    try {
      const r = await window.api.style.distill({ name, text: body });
      if (!r || !r.ok) { setErr((r && r.error) || '蒸馏失败。'); setBusy(null); return; }
      setResult(r);
      setBusy(null);
    } catch (e) {
      setErr(e.message);
      setBusy(null);
    }
  };

  const save = async () => {
    if (!result) return;
    try {
      const r = await window.api.style.distillSave({ name, skillMd: result.skillMd });
      if (!r || !r.ok) { setErr((r && r.error) || '保存失败。'); return; }
      setSaved(r.skill);
      onToast && onToast(r.merged
        ? `已合并进「${r.skill.name}」（第 N 次蒸馏，它变得更完整了）`
        : `已存进你的自定义技能：${r.skill.name}`);
    } catch (e) {
      setErr(`保存失败：${e.message}`);
    }
  };

  const shown = showAll ? files : files.slice(0, 8);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6"
         style={{ background: 'rgba(0,0,0,.3)' }} onClick={onClose}>
      <div className="rounded-lg w-full max-w-2xl my-4"
           style={{ background: 'var(--paper)', border: '1px solid var(--line)' }}
           onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center justify-between px-4 py-2.5"
             style={{ borderBottom: '1px solid var(--line)' }}>
          <div>
            <div className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>📖 文风蒸馏</div>
            <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
              读原文学它怎么写，产出成一个能挂载的文风技能（存进你的自定义技能）
            </div>
            <div className="text-[11px] mt-1 leading-relaxed"
                 style={{ color: 'var(--danger)', opacity: 0.85 }}>
              ⚠ 建议连接<strong>云端大模型</strong>进行蒸馏。使用本地模型蒸馏造成损失概不负责。
            </div>
          </div>
          <button onClick={onClose} className="text-[12px] px-2 py-1 rounded"
                  style={{ color: 'var(--ink-soft)' }}>关闭</button>
        </div>

        <div className="px-4 py-3 space-y-3" style={{ maxHeight: '70vh', overflowY: 'auto' }}>

          {err && (
            <div className="text-[12px] px-2.5 py-2 rounded"
                 style={{ background: 'rgba(180,35,24,.08)', color: 'var(--danger)' }}>{err}</div>
          )}
          {busy && (
            <div className="text-[12px] px-2.5 py-2 rounded"
                 style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}>
              ⏳ {busy}
            </div>
          )}

          <div>
            <div className="text-[12px] mb-1" style={{ color: 'var(--ink)' }}>
              这个风格叫什么
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="不填就叫「未命名风格」"
              className="w-full px-2.5 py-1.5 rounded text-[13px] outline-none"
              style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }}
            />
          </div>

          <div>
            <div className="text-[12px] mb-1" style={{ color: 'var(--ink)' }}>
              ① 选要学的原文（项目 {picked.length} + 上传 {uploaded.length}）
            </div>
            {/* ⚠ 上传 txt/md/docx —— 羽毛菌：「直接上传txt、docx，md更好吧，复制两」。
                docx 由主进程自己解 zip（项目零第三方依赖），实测跨 run 拼接与表格单元格都取到。 */}
            <div className="flex items-center gap-2 mb-1">
              <button onClick={pick}
                      className="text-[12px] px-2.5 py-1 rounded border"
                      style={{ color: 'var(--accent)', borderColor: 'var(--line)' }}>
                上传 txt / md / docx
              </button>
              <span className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>
                也可以直接用下面的框粘贴
              </span>
            </div>
            {uploaded.map((u) => (
              <div key={u.path} className="flex items-center gap-2 text-[12.5px] py-0.5"
                   style={{ color: u.error ? 'var(--danger)' : 'var(--ink)' }}>
                <span className="truncate">{u.name}</span>
                {u.error
                  ? <span style={{ color: 'var(--danger)' }}>⚠ {u.error}</span>
                  : <span style={{ color: 'var(--ink-soft)' }}>
                      {u.kind === 'docx' ? 'Word ' : ''}{u.chars} 字
                    </span>}
                <button onClick={() => setUploaded((p2) => p2.filter((x) => x.path !== u.path))}
                        className="text-[11px] ml-auto" style={{ color: 'var(--ink-soft)' }}>移除</button>
              </div>
            ))}
            {files.length === 0
              ? <div className="text-[12px]" style={{ color: 'var(--ink-soft)' }}>
                  项目里还没有文件。可以直接把正文贴到下面第 ② 步。
                </div>
              : <>
                {shown.map((f) => (
                  <label key={f.path} className="flex items-center gap-2 py-0.5 cursor-pointer text-[13px]"
                         style={{ color: 'var(--ink)' }}>
                    <input type="checkbox" checked={picked.includes(f.path)}
                           onChange={() => toggle(f.path)} />
                    <span className="truncate">{f.path}</span>
                  </label>
                ))}
                {files.length > 8 && (
                  <button className="text-[11.5px] mt-1" style={{ color: 'var(--accent)' }}
                          onClick={() => setShowAll(!showAll)}>
                    {showAll ? '收起' : `还有 ${files.length - 8} 个…`}
                  </button>
                )}
              </>}
          </div>

          <div>
            <div className="text-[12px] mb-1 flex items-baseline justify-between"
                 style={{ color: 'var(--ink)' }}>
              <span>② 或直接贴正文（限 {MAX_CHARS / 10000} 万字）</span>
              <span style={{ color: over ? 'var(--danger)' : 'var(--ink-soft)' }}>
                {chars} / {MAX_CHARS}{over ? `（超了 ${chars - MAX_CHARS} 字）` : ''}
              </span>
            </div>
            <textarea
              ref={taRef}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={5}
              placeholder="把小说正文贴进来"
              className="w-full px-2.5 py-1.5 rounded text-[13px] outline-none resize-y leading-relaxed"
              style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line)' }}
            />
          </div>

          <button
            onClick={run}
            disabled={!!busy || over}
            className="w-full py-2 rounded text-[13px] disabled:opacity-40"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {busy ? '正在学…' : '开始蒸馏'}
          </button>

          {result && (
            <div className="space-y-2">
              <div className="text-[12px]" style={{ color: 'var(--ink-soft)' }}>
                读了 {result.stats.chars} 字 / {result.stats.chunks} 段
                {result.stats.chunksSampled && '（超上限，已均匀抽样）'}
                {result.stats.chunksFailed.length > 0
                  && `　⚠ 第 ${result.stats.chunksFailed.join('、')} 段没读到`}
              </div>
              <pre className="text-[12px] leading-relaxed p-2.5 rounded whitespace-pre-wrap"
                   style={{ background: 'var(--paper-2, #f5f6f8)', color: 'var(--ink)',
                            border: '1px solid var(--line)', maxHeight: '240px', overflowY: 'auto' }}>
                {result.skillMd}
              </pre>
              {saved ? (
                <div className="text-[12.5px]" style={{ color: 'var(--ink)' }}>
                  ✓ 已存进「{saved.name}」，可在 @技能 里挂上它。
                  {result.stats && (
                    <span style={{ color: 'var(--ink-soft)' }}>
                      　下次用**同一个名字**再蒸馏，会自动合并进这一份而不是新建。
                    </span>
                  )}
                </div>
              ) : (
                <button onClick={save} className="w-full py-2 rounded text-[13px]"
                        style={{ background: 'var(--accent)', color: '#fff' }}>
                  存进我的自定义技能
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}