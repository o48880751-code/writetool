import { useState, useEffect, useRef } from 'react';
import { layoutTitle } from '../title-layout.mjs';

/**
 * 小说封面生成（2026-11-02）。
 *
 * ## 为什么分两步走
 *
 * 1. 模型只画**画面**（提示词里明确禁字，并要求下方留白）。
 * 2. 书名/笔名由这里的 Canvas 叠上去。
 *
 * 扩散模型写中文标题基本是乱码 —— 见过太多"封面"上糊着一团像字的色块。
 * 所以宁可多一步合成：字是清晰的、可改字号的、换画风不用重画。
 *
 * ⚠⚠ 图必须先转成 **data URL** 再进 Canvas。
 *   直接用 `wtfile://` 的图属于跨源，画上去会让画布"被污染"，
 *   之后 `toDataURL()` 抛 SecurityError —— 表现是"生成成功但存不下来"。
 */

const W = 1024;
const H = 1536;

// 排版逻辑在 title-layout.mjs（纯函数，判据能直接喂假 ctx 测"有没有丢字"）

/** 把底图 + 书名 + 笔名合成一张 PNG（data URL） */
function composeCover(imgSrc, { title, author, styleKey }) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        const ctx = cv.getContext('2d');

        // ---- 底图：cover 方式铺满 ----
        const scale = Math.max(W / img.width, H / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);

        /**
         * ---- 下方：虚化 + 压暗，而不是一条纯黑带 ----
         *
         * ⚠⚠ 之前为了盖住模型乱画的字，把下方 45% 涂成近乎实心的黑（0.965）——
         *   字是盖住了，但整张图像"图片 + 黑底字幕条"，羽毛菌的原话是"太单调了"。
         *   参考图（那些免费 AI 封面）里没有一个是这么干的。
         *
         * 现在改成：**把下方那块重画一遍、模糊掉，再叠一层浅渐变**。
         *   · 模型残留的字被虚化到看不清（不是硬盖，不会出现黑条）
         *   · 画面本身的色调还在，过渡像景深虚化，是有意为之的观感
         */
        /**
         * ---- 底部只压一层**很浅**的渐变，不模糊、不压黑条 ----
         *
         * ⚠⚠ 2026-11-02 第三次改。之前为了让模型写的字看不清，
         *   把下方做成"重画一份模糊图 + 渐变压暗" —— 字是糊掉了，
         *   但整张封面变成"上半清楚、下半模糊"，羽毛菌直接否了：
         *   「不要这种上半清楚下半模糊的」。
         *
         * 参考的那些免费 AI 封面，全都是**整张图保持清晰**，靠文字自身的
         * 描边和投影读出来。所以这里也照做：只留一层很淡的压暗（最深 0.55），
         * 作用仅仅是让白字在亮背景上不刺眼，画面该清楚的地方还是清楚的。
         *
         * ⚠ 那"模型乱写字"怎么办？—— 不用模糊去盖，而是从一开始就不让它写
         *   （见 cover-prompt.js 的禁字规则 + 把书名从提示词里剔除 + 反向提示词）。
         *   盖是治标，禁是治本。
         */
        const g = ctx.createLinearGradient(0, H * 0.58, 0, H);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.55, 'rgba(0,0,0,0.22)');
        g.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = g;
        ctx.fillRect(0, H * 0.58, W, H * 0.42);

        /**
         * 字体按画风挑：楷体有书卷气，黑体适合都市/玄幻，圆体适合二次元。
         * ⚠ 只用 **Windows 自带**的几款（微软雅黑/宋体/楷体/黑体）——
         *   项目里那 4 款开源字体要用户自己下载，没装就会静默回退，
         *   而"回退成什么样"不该由用户的字体设置决定封面长什么样。
         */
        const SERIF = '"KaiTi", "STKaiti", "SimSun", "Songti SC", serif';
        const SANS = '"Microsoft YaHei", "PingFang SC", "Heiti SC", sans-serif';
        const ROUND = '"YouYuan", "ZCOOL KuaiLe", "Microsoft YaHei", sans-serif';
        const FONT_TITLE = styleKey === 'ink' || styleKey === 'xianxia' ? SERIF
          : styleKey === 'anime' ? ROUND : SANS;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';

        // ---- 书名：渐变填充 + 描边 ----
        /**
         * ⚠⚠ 书名**一个字都不能丢**，也**不能溢出**。
         *   上一版固定最多 2 行、缩到 70 就停手，然后截断补「…」——
         *   羽毛菌那张 18 字的书名因此排成了乱糟糟的两行。
         *   现在改成"从大到小试字号，第一个整串放得下的就用它"，最多允许 3 行。
         */
        const { size, lines } = layoutTitle(
          ctx,
          title,
          (s) => `700 ${s}px ${FONT_TITLE}`,
          { width: W - 150, max: 128, min: 54, step: 6, maxLines: 3 },
        );

        const lh = size * 1.14;
        const authorSize = 44;
        const blockH = lines.length * lh + 40 + authorSize;
        let y = H - 104 - blockH + size;   // 从底部往上排

        // （字距已经在上面测行宽之前设过了，这里不再重复设 —— 重复设也只会跟着 size 走）

        /**
         * ⚠ 顺序：**先描边、后填充**。
         *   反过来的话，粗描边会把字心吃掉一圈，看起来"字瘦了一圈"。
         */
        for (const line of lines) {
          ctx.save();
          ctx.lineJoin = 'round';
          ctx.miterLimit = 2;
          ctx.strokeStyle = 'rgba(0,0,0,0.82)';
          ctx.lineWidth = Math.max(8, size * 0.085);
          ctx.strokeText(line, W / 2, y);

          // 白 → 淡色 的竖向渐变，比纯白有层次
          const tg = ctx.createLinearGradient(0, y - size * 0.8, 0, y + size * 0.15);
          tg.addColorStop(0, '#ffffff');
          tg.addColorStop(1, styleKey === 'ink' || styleKey === 'xianxia'
            ? '#ffe9c2' : '#dceaff');
          ctx.fillStyle = tg;
          ctx.fillText(line, W / 2, y);
          ctx.restore();
          y += lh;
        }

        // ---- 作者 ----
        if (author) {
          try { ctx.letterSpacing = '6px'; } catch (_) { /* 同上 */ }
          ctx.font = `500 ${authorSize}px ${SANS}`;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = 'rgba(0,0,0,0.75)';
          ctx.lineWidth = 7;
          ctx.strokeText(author, W / 2, y + 30);
          ctx.fillStyle = 'rgba(255,255,255,0.94)';
          ctx.fillText(author, W / 2, y + 30);
          try { ctx.letterSpacing = '0px'; } catch (_) { /* 同上 */ }
        }

        resolve(cv.toDataURL('image/png'));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('底图没能加载（可能被缓存或协议拦了）'));
    img.src = imgSrc;
  });
}

export default function CoverModal({ projectId, projectName, penName, onClose, onSaved, onToast }) {
  const [styles, setStyles] = useState([]);
  const [genres, setGenres] = useState([]);
  /** 风格预设（提示词模板，不锁画风） */
  const [templates, setTemplates] = useState([]);
  const [template, setTemplate] = useState('');
  /**
   * 方案 B 开关：允许 AI 直接把书名写进画面。
   * ⚠ 默认关 = 方案 A（干净底图 + 软件叠字），文字 100% 准确。
   */
  const [burnTitle, setBurnTitle] = useState(false);
  const [subtitle, setSubtitle] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [style, setStyle] = useState('xianxia');
  const [genre, setGenre] = useState('');
  const [scene, setScene] = useState('');
  const [title, setTitle] = useState(projectName || '');
  const [author, setAuthor] = useState(penName || '');
  /** 最终喂给生图模型的那段画面描述。可以自己写，也可以让文字模型写。 */
  const [promptText, setPromptText] = useState('');
  /** 'llm' | 'template' | 'user' —— 用来告诉用户"这段是谁写的" */
  const [promptSource, setPromptSource] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [finalUrl, setFinalUrl] = useState('');
  const [finalPath, setFinalPath] = useState('');
  /** 当前生图模型（用来提示"它爱不爱写字"） */
  const [imgModel, setImgModel] = useState('');
  const savedRef = useRef('');

  useEffect(() => {
    window.api.image.styles()
      .then((r) => {
        setStyles((r && r.styles) || []);
        setGenres((r && r.genres) || []);
        setTemplates((r && r.templates) || []);
      })
      .catch(() => { setStyles([]); setGenres([]); setTemplates([]); });
    window.api.image.get()
      .then((c) => setImgModel((c && c.effectiveModel) || ''))
      .catch(() => setImgModel(''));
  }, []);

  /**
   * 草稿暂存（2026-11-02）。
   *
   * 羽毛菌：「这个页面太容易误触返回了，刚输入的词又要重新输入」。
   * 直接原因是遮罩层绑了 `onClick=onClose` —— 点卡片外面任何地方都算关闭。
   * 已经去掉那个绑定；这里再加一层保险：**表单内容存进 sessionStorage**，
   * 万一还是关掉了（误按 Esc、窗口重载），下次打开原样回来。
   *
   * ⚠ 按项目分开存：A 书填了一半的封面词，不该出现在 B 书的弹层里。
   * ⚠ 用 sessionStorage 不用 localStorage：这是"这次没做完的活"，
   *   不是长期设置，关掉软件就该清掉。
   */
  const DRAFT_KEY = `cover-draft:${projectId}`;

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return;
      if (typeof d.title === 'string' && d.title) setTitle(d.title);
      if (typeof d.author === 'string') setAuthor(d.author);
      if (typeof d.genre === 'string') setGenre(d.genre);
      if (typeof d.style === 'string' && d.style) setStyle(d.style);
      if (typeof d.scene === 'string') setScene(d.scene);
      if (typeof d.promptText === 'string') setPromptText(d.promptText);
      if (typeof d.promptSource === 'string') setPromptSource(d.promptSource);
    } catch (_) { /* 坏数据就当没有 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        title, author, genre, style, scene, promptText, promptSource,
      }));
    } catch (_) { /* 存不下就算了，不能因此让弹层崩掉 */ }
  }, [DRAFT_KEY, title, author, genre, style, scene, promptText, promptSource]);

  /**
   * 把风格预设填进提示词框。
   *
   * ⚠ 只填**创作内容**（构图/氛围 + 当前画风），不填结构约束
   *   （"留标题位""别画字""把书名写出来"）——
   *   那些由主进程在生成前统一追加：开关一翻就跟着变，
   *   而写死在框里的话，用户改开关时文字就对不上了。
   * ⚠ 填完标 `template`：只有它还是"模板原样"时，换画风才会自动重填。
   *   用户一旦手动改过（`user`），就再也不碰他的字。
   */
  const fillFromTemplate = (tplKey, styleKey) => {
    const tpl = templates.find((t) => t.key === tplKey);
    const st = styles.find((s) => s.key === styleKey);
    if (!tpl) { setPromptText(''); setPromptSource(''); return; }
    const positive = [tpl.positive, st ? st.tail : ''].filter(Boolean).join('；');
    setPromptText([
      '正向提示词：',
      `${positive}。`,
      '',
      '负面提示词：',
      tpl.negative,
    ].join('\n'));
    setPromptSource('template');
  };

  /** 换画风：只有提示词还是模板原样时才跟着重填 */
  const pickStyle = (key) => {
    setStyle(key);
    if (template && promptSource === 'template') fillFromTemplate(template, key);
  };

  const pickTemplate = (key) => {
    setTemplate(key);
    if (!key) { setPromptText(''); setPromptSource(''); return; }
    fillFromTemplate(key, style);
  };

  /**
   * 让**文字模型**写提示词（五要素 → 一段画面描述）。
   *
   * ⚠ 用户写不出提示词才是常态，这一步是这功能"覆盖面"的来源：
   *   他只要填书名 + 选个风格，剩下的交给模型。
   * ⚠ 失败不抛到界面：主进程会退回模板并带 `note`，这里只负责把它显示出来。
   */
  const composeByAI = async () => {
    setBusy('prompt');
    setErr('');
    setNote('');
    try {
      const r = await window.api.image.composePrompt({
        projectId,
        name: title.trim(),
        author: author.trim(),
        genre,
        style,
        scene: scene.trim(),
      });
      setPromptText(r.prompt || '');
      setPromptSource(r.source || '');
      if (r.note) setNote(r.note);
      if (r.source === 'llm') onToast && onToast('提示词写好了，可以再手改');
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  };

  /** 画图 → 读成 dataURL → 叠字 → 存盘 */
  const generate = async () => {
    if (!title.trim()) { setErr('书名是必填的 —— 封面上总得印个名字'); return; }
    setBusy('prompt');
    setErr('');
    setNote('');
    setFinalUrl('');
    try {
      /**
       * ⚠ 提示词为空时**自动让文字模型写一段**，不让用户先点一次"AI 写"。
       *   多一步点击，大多数人就会卡在"提示词"这一栏不知道填什么 ——
       *   而那正是这个功能要解决的问题。
       */
      const extraArgs = {
        template,
        titleMode: burnTitle ? 'burn' : 'blank',
        subtitle: subtitle.trim(),
        // ⚠ 空格也要能拆：输入框里写的是「重生 逆袭」，只按逗号拆会得到一个元素
        tags: tagsInput.split(/[\s·|,，、]+/).map((t) => t.trim()).filter(Boolean),
      };

      let p = promptText.trim();
      if (!p) {
        const r = await window.api.image.composePrompt({
          projectId,
          name: title.trim(),
          author: author.trim(),
          genre,
          style,
          scene: scene.trim(),
          ...extraArgs,
        });
        p = String(r.prompt || '').trim();
        setPromptText(p);
        setPromptSource(r.source || '');
        if (r.note) setNote(r.note);
      }
      if (!p) throw new Error('提示词是空的，没法画');

      setBusy('draw');
      const made = await window.api.image.cover({
        projectId, style, genre, prompt: p, ...extraArgs,
      });

      /**
       * ⚠⚠ 方案 B（AI 已经画了字）**绝不能再叠一次**：
       *   再叠就是"模型写的标题 + 我们叠的标题"两个，正是之前反复出的问题。
       *   所以这条分支直接用底图当成品，不经过 Canvas。
       */
      if (burnTitle) {
        savedRef.current = made.path;
        setFinalPath(made.path);
        setFinalUrl(`${made.url}?t=${Date.now()}`);
        if (made.sizeNote) setNote(made.sizeNote);
        onToast && onToast(`封面画好了（AI 排版）· ${made.model} · ${(made.ms / 1000).toFixed(1)} 秒`);
        return;
      }

      const { dataUrl } = await window.api.image.readAsDataUrl({ projectId, path: made.path });
      setBusy('compose');
      // ⚠ 把画风传下去：字体要按画风挑（楷体 vs 黑体 vs 圆体），
      //   不传的话永远只能用一套黑体，所有封面长得一个样。
      const png = await composeCover(dataUrl, { title, author, styleKey: style });
      const saved = await window.api.image.saveCover({ projectId, dataUrl: png });
      savedRef.current = saved.path;
      setFinalPath(saved.path);
      // ⚠ 加时间戳参数：同名文件（同秒重画）不该被缓存吃住
      setFinalUrl(`${saved.url}?t=${Date.now()}`);
      if (made.sizeNote) setNote(made.sizeNote);
      onToast && onToast(`封面画好了 · ${made.model} · ${(made.ms / 1000).toFixed(1)} 秒`);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  };

  const setAsCover = async () => {
    if (!finalPath) return;
    setBusy('apply');
    try {
      await window.api.project.setCover({ id: projectId, coverPath: finalPath });
      onSaved && onSaved(finalPath);
      onToast && onToast('已设为书架封面');
      onClose && onClose();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  };

  const LABEL = { fontSize: 12.5, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 6 };

  /**
   * ⚠⚠ 标签必须**渲染成文字**。
   *
   * 第一版写的是 `<div style={label('书名')} />` —— `label()` 返回的是**样式对象**，
   * 于是三行标签全是空 div，界面上三个输入框一个名字都没有。
   * 用户的反馈是「这个可以不填又是什么？」：他看到三个光秃秃的框，
   * 只能靠 placeholder 猜，而 placeholder 恰恰在填过之后就看不见了。
   * 判据也漏了这条 —— 只查了输入框在不在、值对不对，没查"它有没有标签"。
   */
  const Label = ({ children, mt }) => (
    <div style={mt ? { ...LABEL, marginTop: mt } : LABEL}>{children}</div>
  );

  /**
   * ⚠⚠ 遮罩层**不绑 onClick**（2026-11-02 羽毛菌：
   *   「这个页面太容易误触返回了，刚输入的词又要重新输入」）。
   *
   *   之前写的是 `onClick={onClose}` —— 点卡片外面任何地方都算关闭，
   *   而这个弹层左边全是输入框，稍微点偏一点东西就没了。
   *   现在只有左上角那个「← 返回」能关。**唯一的出口**。
   *
   * ⚠ 注释放在 `return (` **外面**：写在里面会变成
   *   `return ( {…} <div/> )`，那是两个表达式并列，直接语法错误。
   */
  return (
    <div
      className="modal-mask fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      data-testid="cover-modal"
    >
      <div
        className="modal-card rounded-2xl overflow-hidden flex"
        style={{ background: 'var(--paper)', border: '1px solid var(--line)', width: 760, maxHeight: '86vh' }}
      >
        {/* ---------- 左：设置 ---------- */}
        <div className="flex-1 min-w-0 p-6 overflow-y-auto">
          <button
            type="button"
            data-testid="cover-back"
            onClick={onClose}
            className="flex items-center gap-1 text-[12px] mb-3 px-2 py-1 -ml-2 rounded-md"
            style={{ background: 'transparent', border: 'none', color: 'var(--ink-soft)', cursor: 'pointer' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--ink) 7%, transparent)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            title="返回主界面（这是唯一的返回方式，点别处不会关）"
          >
            <span style={{ fontSize: 13 }}>←</span> 返回
          </button>

          <div className="text-[16px] font-semibold mb-1">生成封面</div>
          <div className="text-[11.5px] mb-3 leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            模型只画画面，书名和笔名由软件叠上去 —— 这样字是清楚的，换画风也不用重打书名。
          </div>

          {/**
            * ⚠ 这一条是"说清楚，而不是假装能解决"。
            *   Qwen-Image 的官方卖点就是擅长渲染中文，所以它**特别爱**在画面里
            *   自己写标题。提示词里已经禁字、反向词也压了，但那只降低概率，
            *   不是开关。与其让用户以为是软件坏了，不如直接告诉他换哪个模型。
            */}
          {/qwen-image/i.test(imgModel) && (
            <div className="text-[11px] mb-3 px-3 py-2 rounded-lg leading-relaxed"
                 style={{ background: 'color-mix(in srgb, var(--ink) 5%, transparent)', color: 'var(--ink-soft)' }}>
              当前用的是 <b style={{ color: 'var(--ink)' }}>{imgModel}</b>，它很擅长渲染中文，
              所以容易在画面里<b style={{ color: 'var(--ink)' }}>自己多写一个标题</b>。
              提示词已经禁过了，但只能降低概率。要是反复出现，
              去 设置 → AI 提供商 → 封面生图 换成 <b style={{ color: 'var(--ink)' }}>Seedream</b>，出图更干净。
            </div>
          )}

          <Label>画风</Label>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {styles.map((s) => {
              const on = s.key === style;
              return (
                <button
                  key={s.key}
                  type="button"
                  data-testid={`cover-style-${s.key}`}
                  onClick={() => pickStyle(s.key)}
                  className="px-3 py-1.5 rounded-lg text-[12px]"
                  style={{
                    background: on ? 'var(--accent)' : 'var(--paper-2)',
                    color: on ? 'var(--accent-ink)' : 'var(--ink-soft)',
                    fontWeight: on ? 600 : 400,
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          {/**
           * 五要素：书名（必填）/ 作者 / 题材 / 风格（必填）/ 画面。
           * 填得越多，文字模型写出来的画面描述越准 —— 这也是"两个模型协同"的入口。
           */}
          {/* ---------- 风格预设（只填提示词，不锁画风） ---------- */}
          <Label mt={4}>风格预设</Label>
          <div className="flex items-center gap-2">
            <select
              data-testid="cover-template"
              value={template}
              onChange={(e) => pickTemplate(e.target.value)}
              style={{ ...inputStyle(), cursor: 'pointer', flex: 1 }}
            >
              <option value="">不用预设（自己写）</option>
              {templates.map((t) => (
                <option key={t.key} value={t.key}>{t.label} · {t.desc}</option>
              ))}
            </select>
          </div>
          <div className="text-[10.5px] mt-1.5 leading-snug" style={{ color: 'var(--ink-soft)', opacity: 0.8 }}>
            选中会把一套正向 + 反向提示词填进下面的框里，随便改。它只影响构图和氛围，不锁画风。
          </div>

          <Label>书名 <span style={{ color: 'var(--danger)' }}>*</span></Label>
          <input
            data-testid="cover-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="必填 —— 会印在封面上"
            style={inputStyle()}
            spellCheck={false}
          />

          <Label mt={12}>作者</Label>
          <input
            data-testid="cover-author"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="印在书名下方，不想署名就留空"
            style={inputStyle()}
            spellCheck={false}
          />

          <Label mt={12}>题材</Label>
          <select
            data-testid="cover-genre"
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            style={{ ...inputStyle(), cursor: 'pointer' }}
          >
            <option value="">不指定</option>
            {genres.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>

          <Label mt={12}>画面</Label>
          <input
            data-testid="cover-scene"
            value={scene}
            onChange={(e) => setScene(e.target.value)}
            placeholder="想画什么就写一句，比如「雪原上的孤城，暴风雪」"
            style={inputStyle()}
            spellCheck={false}
          />
          <div className="text-[10.5px] mt-1.5 leading-snug" style={{ color: 'var(--ink-soft)', opacity: 0.75 }}>
            留空的话，会按这本书的简介来画。填得越多，AI 写得越准。
          </div>

          {/* ---------- 方案 B 开关 ---------- */}
          <div className="mt-4 rounded-xl px-3 py-2.5"
               style={{ background: 'color-mix(in srgb, var(--ink) 4%, transparent)' }}>
            <label className="flex items-center gap-2 cursor-pointer" style={{ margin: 0 }}>
              <input
                type="checkbox"
                data-testid="cover-burn-title"
                checked={burnTitle}
                onChange={(e) => { setBurnTitle(e.target.checked); setNote(''); }}
                style={{ width: 14, height: 14, accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
              <span className="text-[12.5px]" style={{ color: 'var(--ink)', fontWeight: 600 }}>
                AI 生成封面文字
              </span>
            </label>
            <div className="text-[10.5px] mt-1 leading-snug" style={{ color: 'var(--ink-soft)' }}>
              {burnTitle
                ? '开启：让 AI 直接把书名（和下面的副标题、标签）画进画面，一键出成品。⚠ 可能出现错别字，靠随机。'
                : '关闭：AI 只画干净底图，书名由软件叠上去 —— 文字 100% 准确，字体特效可换。'}
            </div>

            {burnTitle && (
              <>
                <Label mt={10}>副标题（会画进画面，可不填）</Label>
                <input
                  data-testid="cover-subtitle"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  placeholder="比如：重生那年夏天"
                  style={inputStyle()}
                  spellCheck={false}
                />
                <Label mt={10}>卖点标签（最多 3 个，用空格或逗号隔开）</Label>
                <input
                  data-testid="cover-tags"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="重生 逆袭 爽文"
                  style={inputStyle()}
                  spellCheck={false}
                />
              </>
            )}
          </div>

          {/* ---------- 提示词：可以让 AI 写，也可以自己改 ---------- */}
          <div className="flex items-center justify-between" style={{ marginTop: 14, marginBottom: 6 }}>
            <div style={{ ...LABEL, marginBottom: 0 }}>
              提示词
              {promptSource === 'llm' && (
                <span style={{ fontWeight: 400, marginLeft: 6, color: 'var(--accent)' }}>· AI 写的</span>
              )}
              {promptSource === 'template' && (
                <span style={{ fontWeight: 400, marginLeft: 6, color: 'var(--ink-soft)' }}>· 模板拼的</span>
              )}
            </div>
            <button
              type="button"
              data-testid="cover-compose"
              onClick={composeByAI}
              disabled={!!busy || !title.trim()}
              className="text-[11.5px] px-2 py-1 rounded-md"
              style={{
                background: 'var(--paper-2)', color: 'var(--ink-soft)',
                border: '1px solid color-mix(in srgb, var(--ink) 12%, transparent)',
                cursor: busy || !title.trim() ? 'default' : 'pointer',
                opacity: busy || !title.trim() ? 0.5 : 1,
              }}
              title="让已经连上的文字模型，按上面的信息写一段画面描述"
            >
              {busy === 'prompt' ? '正在写…' : '✨ AI 帮我写'}
            </button>
          </div>
          <textarea
            data-testid="cover-prompt"
            value={promptText}
            onChange={(e) => { setPromptText(e.target.value); setPromptSource('user'); }}
            placeholder="留空即可 —— 生成时会自动让 AI 按上面的信息写一段。也可以自己写。"
            rows={3}
            style={{ ...inputStyle(), resize: 'vertical', lineHeight: 1.55 }}
            spellCheck={false}
          />
          {note && (
            <div className="text-[10.5px] mt-1.5 leading-snug" style={{ color: 'var(--ink-soft)' }}>
              {note}
            </div>
          )}

          {err && (
            <div className="text-[11.5px] mt-4 px-3 py-2 rounded-lg leading-relaxed"
                 style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', color: 'var(--danger)' }}>
              {err}
            </div>
          )}

          <div className="flex items-center gap-2 mt-5">
            <button
              type="button"
              data-testid="cover-generate"
              onClick={generate}
              disabled={!!busy}
              className="px-4 py-2 rounded-lg text-[12.5px] font-medium"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none', cursor: busy ? 'default' : 'pointer' }}
            >
              {busy === 'prompt' ? 'AI 正在写提示词…'
                : busy === 'draw' ? '正在画…（可能要半分钟）'
                  : busy === 'compose' ? '正在叠字…'
                    : finalUrl ? '重画一张' : '生成封面'}
            </button>
            {/* ⚠ 这里刻意**不再放「取消」**：返回只有左上角那个箭头一个入口，
                两个出口会让人以为"随便点哪都能退"，而那正是容易丢内容的原因。 */}
          </div>
        </div>

        {/* ---------- 右：预览 ---------- */}
        <div className="w-[290px] shrink-0 p-6 flex flex-col items-center"
             style={{ background: 'var(--paper-2)' }}>
          <div
            className="rounded-xl overflow-hidden flex items-center justify-center"
            style={{
              width: 200, height: 300,
              background: 'color-mix(in srgb, var(--ink) 6%, transparent)',
              border: '1px solid var(--line)',
            }}
          >
            {finalUrl ? (
              <img src={finalUrl} alt="封面预览" data-testid="cover-preview"
                   style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span className="text-[11.5px]" style={{ color: 'var(--ink-soft)' }}>还没有封面</span>
            )}
          </div>

          <button
            type="button"
            data-testid="cover-apply"
            onClick={setAsCover}
            disabled={!finalUrl || !!busy}
            className="mt-4 w-full px-3 py-2 rounded-lg text-[12.5px] font-medium"
            style={{
              background: finalUrl ? 'var(--accent)' : 'color-mix(in srgb, var(--ink) 8%, transparent)',
              color: finalUrl ? 'var(--accent-ink)' : 'var(--ink-soft)',
              border: 'none',
              cursor: finalUrl && !busy ? 'pointer' : 'default',
            }}
          >
            {busy === 'apply' ? '设置中…' : '设为书架封面'}
          </button>
          <div className="text-[10.5px] mt-2 text-center leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            会存到这本书的 <code>_assets/</code> 里，<br />跟项目一起备份
          </div>
        </div>
      </div>
    </div>
  );
}

function inputStyle() {
  return {
    width: '100%',
    background: 'var(--paper-2)',
    border: '1px solid color-mix(in srgb, var(--ink) 12%, transparent)',
    color: 'var(--ink)',
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 12.5,
    outline: 'none',
  };
}
