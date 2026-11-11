/**
 * 朗读 AI 回复（2026-11-11）。
 *
 * ## 范围
 *
 * 羽毛菌的原话：「朗读ai生成的内容，就跟豆包，deepseek那样啊，不是听书」。
 * 所以这里**不是**播放器（没有章节、没有倍速、没有断点续播），
 * 就是"点一下这条消息的小喇叭，它念给我听"。
 *
 * ## 为什么不能直接 speechSynthesis.speak(整段)
 *
 * Chromium 的 speak() 对单次文本长度**有内部上限**（几 KB 量级），
 * 超了会在中途静默停下 —— 没有 error、onend 也不触发，
 * 表现就是"念到一半没声了，再点也没反应"。长篇 AI 回复轻松超过这个长度。
 * 所以必须自己分句、逐句排队、靠 onend 驱动下一句。
 *
 * ## 为什么要把 Markdown 洗掉
 *
 * 消息内容是 Markdown 原文，直接念会变成
 * 「星号星号夜枫星号星号 说：竖线 名字 竖线」——
 * 用户听到的是一堆符号，不是文字。表格和代码块更是没法念，直接跳过。
 */

/** 单句上限。超过这个长度就在逗号处再切一刀，避免撞上 Chromium 的内部上限。 */
const MAX_SENTENCE = 110;

/**
 * 把 Markdown 正文洗成"适合朗读"的纯文本。
 *
 * ⚠ 表格和代码块**整块丢弃**，不是清理：念出来的
 *   「名字暗示 竖线 现在的设定」对听的人没有任何信息量，
 *   还不如跳过（用户能看到，只是不听）。
 */
export function speakableText(md) {
  let s = String(md == null ? '' : md);

  // 围栏代码块整块去掉（```lang ... ```）
  s = s.replace(/```[\s\S]*?```/g, '');
  // 行内代码保留内容、去掉反引号
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 表格：连续的竖线行整块去掉（表头 + 分隔行 + 数据行）
  s = s.replace(/^[ \t]*\|.*\|[ \t]*$/gm, '');
  // 标题标记
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  // 加粗 / 斜体 / 删除线
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  s = s.replace(/~~([^~\n]+)~~/g, '$1');
  // 列表符号（- * 1.）
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  s = s.replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
  // 引用与水平线
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');
  s = s.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');
  // 链接 [文字](地址) → 只留文字
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 收敛空白：连续空行并成一个，行尾空格去掉
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

/**
 * 分句。
 *
 * 规则刻意保守：只在**句末标点**上切，逗号不切。
 * 逗号也切的话，一句完整的话被拆成七八段，每段之间都有明显的
 * 停顿间隙（Chromium 每句之间大约 100~300ms），听起来像结巴。
 *
 * ⚠ 但超长句必须再切：模型偶尔会吐一整段没有句号的文字，
 *   那种句子不切就会撞上 speak() 的长度上限，念到一半断掉。
 */
export function splitSentences(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return [];

  // 先按句末标点切（保留标点）。中英文标点都要，
  // 换行也算一个断点 —— 段落之间本来就该停一下。
  const chunks = s.split(/(?<=[。！？!?…；;\n])/);

  /**
   * ⚠ 收尾标点要并回上一段（2026-11-11 实测）。
   *
   *   `「你来了。」他说。` 会在「。」处切开，变成
   *   `「你来了。` + `」他说。` —— 第二段以一个孤零零的后引号开头。
   *   绝大多数 TTS 会把它当标点忽略，但两段之间那段停顿是实打实的，
   *   听起来就像说话人中途卡了一下。
   *
   *   所以：只要下一段以「」』"'）)】 这类收尾符号开头，就并回前一段。
   */
  const merged = [];
  for (const raw of chunks) {
    const t = raw.replace(/\n+/g, ' ').trim();
    if (!t) continue;
    if (merged.length && /^[」』”’"')）】]/.test(t)) {
      merged[merged.length - 1] += t;
      continue;
    }
    merged.push(t);
  }

  const out = [];
  for (const t of merged) {
    if (t.length <= MAX_SENTENCE) {
      out.push(t);
      continue;
    }
    // 太长：再按逗号切，切完还超就硬切
    const parts = t.split(/(?<=[，,、：:])/);
    let buf = '';
    for (const p of parts) {
      if ((buf + p).length > MAX_SENTENCE && buf) {
        out.push(buf);
        buf = p;
      } else {
        buf += p;
      }
      while (buf.length > MAX_SENTENCE) {
        out.push(buf.slice(0, MAX_SENTENCE));
        buf = buf.slice(MAX_SENTENCE);
      }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

/**
 * 播放器：一次只念一条消息，切到别的消息会停掉当前这条。
 *
 * @param {object} opts
 *   rate  语速，默认 0.95（1.0 念小说偏快，像播报不像说话）
 *   lang  语言，默认 zh-CN（系统里那三个中文语音都是这个）
 *   onState(playingId|null)  状态变化回调，UI 靠它把图标切成"停止"
 * @returns {{ play(id,text):void, stop():void, playingId():string|null }}
 */
export function createSpeaker({ rate = 0.95, lang = 'zh-CN', onState } = {}) {
  /** 当前在播的消息 id；null = 没在播 */
  let current = null;
  /** 待播队列的下标 */
  let queue = [];
  let idx = 0;
  /**
   * 每次播放自增。`onend` 回来时对不上就说明这中间被 stop / 切歌过，
   * 必须丢弃 —— 否则上一条的残留回调会把新的一条打断。
   * 这是 speechSynthesis 用起来最容易出 bug 的地方。
   */
  let token = 0;

  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

  function emit() {
    if (typeof onState === 'function') onState(current);
  }

  function hardStop() {
    token += 1;
    queue = [];
    idx = 0;
    try { synth && synth.cancel(); } catch (_) { /* 有些环境 cancel 会抛，忽略 */ }
  }

  function speakNext(myToken) {
    if (myToken !== token) return;
    if (idx >= queue.length) {
      current = null;
      emit();
      return;
    }
    const text = queue[idx];
    idx += 1;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    u.onend = () => speakNext(myToken);
    /**
     * 单句失败不要卡死整条：跳过继续念下一句。
     *
     * ⚠ 必须**延迟**再念下一句（2026-11-11 实测）：直接紧接着调 speak()，
     *   Chromium 内部队列还在收尾，新任务会被静默丢弃 ——
     *   表现是第一句出错之后整条就哑了，而且看不出任何报错。
     *   80ms 是量出来的最小安全间隔（再小就丢）。
     */
    u.onerror = () => setTimeout(() => speakNext(myToken), 80);
    try {
      synth.speak(u);
    } catch (_) {
      speakNext(myToken);
    }
  }

  return {
    play(id, text) {
      if (!synth) return;
      // 已经在念同一条 → 再点一次就是停
      if (current === id) {
        hardStop();
        current = null;
        emit();
        return;
      }
      const sentences = splitSentences(speakableText(text));
      if (!sentences.length) return;

      hardStop();
      current = id;
      queue = sentences;
      idx = 0;
      emit();
      const myToken = token;
      /**
       * ⚠ cancel() 之后**立刻** speak() 在 Chromium 上有时不生效
       *   （内部状态还没清干净）。让出一帧再念，实测稳定。
       */
      setTimeout(() => speakNext(myToken), 60);
    },
    stop() {
      hardStop();
      if (current !== null) {
        current = null;
        emit();
      }
    },
    playingId() {
      return current;
    },
  };
}
