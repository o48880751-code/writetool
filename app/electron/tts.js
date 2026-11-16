/**
 * Edge TTS —— 用微软的神经语音念中文（2026-11-16）。
 *
 * ## 为什么不用系统语音
 *
 * 之前朗读走的是 `speechSynthesis`，念出来是 Windows SAPI 那套老合成音，
 * 羽毛菌的原话是「太人机了，笑死我了」。那是十几年前的拼接式合成，
 * 和豆包/剪映那种神经网络语音确实不是一个时代的东西。
 *
 * 这里换成微软 Edge 浏览器"大声朗读"背后那套 Azure 神经语音：
 * 音色自然、中文断句正确、**免费、不需要 API key**。
 *
 * ## ⚠ 它不是官方公开 API
 *
 * 接口是社区从 Edge 浏览器里逆出来的（npm 包 `msedge-tts` 封装了协议）。
 * 微软随时可能改协议或加风控。所以：
 *   · 调用方**必须**有降级路径（退回系统语音），不能只依赖这一条
 *   · 失败要记日志，但不要弹窗 —— 朗读是锦上添花，不该打断写作
 *
 * ## 为什么要缓存
 *
 * 一条 AI 回复几百上千字，同一段文字反复点喇叭很常见。
 * 合成一次约 1~3 秒、几百 KB，不缓存就是每次都等、每次都耗流量。
 * 缓存键 = sha1(音色 + 正文)，同一段文字换音色会重新合成。
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * 可选音色。羽毛菌 2026-11-16 从四个候选里挑了两个：
 *   1 晓晓（女·自然）—— 最接近豆包那种默认女声
 *   2 云希（男·年轻）—— 念男主戏用
 * ⚠ 想加新音色只改这里：值必须和微软的 voice id 完全一致，拼错会合成失败。
 */
const VOICES = {
  xiaoxiao: { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女 · 自然）' },
  yunxi: { id: 'zh-CN-YunxiNeural', label: '云希（男 · 年轻）' },
};

const DEFAULT_VOICE = 'xiaoxiao';

/** 单次合成的超时。正常 1~3 秒，20 秒还没回来基本就是网络卡死 */
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * 语速的合法范围（百分比，负数=更慢）。
 *
 * ⚠ 超出范围要**夹住**而不是报错：这是给滑块用的，
 *   万一前端传了 -300，合成出来是一段谁也听不懂的噪音。
 * ⚠ 用百分比而不是 RATE 枚举（x-slow/slow/…）：枚举只有五档，
 *   而"再慢一点点"这种需求很常见，滑块能连续调。
 */
const RATE_MIN = -50;
const RATE_MAX = 80;

/** 把用户设置里的数字换算成 Edge TTS 要的字符串（-20 → '-20%'，0 → '+0%'） */
function rateToString(rate) {
  const n = Number(rate);
  const v = Number.isFinite(n) ? Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(n))) : 0;
  return (v >= 0 ? '+' : '') + v + '%';
}

/** ESM 模块只加载一次（主进程是 CJS，只能动态 import） */
let modPromise = null;
function loadMod() {
  if (!modPromise) {
    modPromise = import('msedge-tts').catch((e) => {
      // ⚠ 失败要清掉缓存，否则后续每次都直接拿到同一个失败结果
      modPromise = null;
      throw e;
    });
  }
  return modPromise;
}

function voiceIdOf(voice) {
  const v = VOICES[voice] || VOICES[DEFAULT_VOICE];
  return v.id;
}

/** 可选的音色列表，给设置页用 */
function listVoices() {
  return Object.keys(VOICES).map((k) => ({ key: k, label: VOICES[k].label }));
}

/**
 * 合成一段文字，返回缓存文件路径。
 *
 * @param {object} o
 *   text      要念的文字（调用方应当已经洗掉 Markdown）
 *   voice     音色 key（见 VOICES）
 *   cacheDir  缓存目录（主进程传 userData/tts-cache）
 *   timeoutMs 超时
 * @returns {{file:string, name:string, cached:boolean, bytes:number}}
 */
async function synthesize({ text, voice, rate, cacheDir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) throw new Error('没有可朗读的文字');
  if (!cacheDir) throw new Error('缺少缓存目录');

  const id = voiceIdOf(voice);
  const rateStr = rateToString(rate);
  fs.mkdirSync(cacheDir, { recursive: true });

  /**
   * ⚠ 缓存键**必须带上语速**（2026-11-16）。
   *   语速是合成时烘进音频里的（不是播放时调速），所以 -20% 和 +0%
   *   是两个完全不同的音频文件。键里不带语速的话，用户把滑块从"正常"
   *   拖到"很慢"，播出来还是旧的那段 —— 会以为滑块坏了。
   */
  const key = crypto.createHash('sha1')
    .update(id + '|' + rateStr + '\n' + clean)
    .digest('hex');
  const file = path.join(cacheDir, key + '.mp3');

  // 命中缓存：顺手挡掉"上次写到一半"的残缺文件（<1KB 基本不可能是正常音频）
  try {
    const st = fs.statSync(file);
    if (st.size > 1024) return { file, name: key + '.mp3', cached: true, bytes: st.size };
  } catch (_) { /* 不存在，往下合成 */ }

  const mod = await loadMod();
  const tts = new mod.MsEdgeTTS();
  await tts.setMetadata(id, mod.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  /**
   * ⚠ toFile 不会自己建目录，父目录必须存在（实测 ENOENT）。
   *   用一个临时子目录，合成完再把文件挪成正式缓存名 ——
   *   直接写目标文件的话，合成中途失败会留下一个残缺 mp3，
   *   下次命中"缓存"就放一段噪音。
   */
  const tmpDir = path.join(cacheDir, '_tmp-' + key);
  fs.mkdirSync(tmpDir, { recursive: true });

  let timer = null;
  try {
    const work = tts.toFile(tmpDir, clean, { rate: rateStr });
    const r = await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`语音合成超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
      }),
    ]);
    if (!r || !r.audioFilePath) throw new Error('语音合成没有返回音频');
    fs.renameSync(r.audioFilePath, file);
    const st = fs.statSync(file);
    return { file, name: key + '.mp3', cached: false, bytes: st.size };
  } finally {
    if (timer) clearTimeout(timer);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结果 */ }
  }
}

/** 清缓存（设置页可能要用）。返回删掉的文件数 */
function clearCache(cacheDir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(cacheDir)) {
      if (!f.endsWith('.mp3')) continue;
      try { fs.unlinkSync(path.join(cacheDir, f)); n += 1; } catch (_) { /* 单个失败继续 */ }
    }
  } catch (_) { /* 目录不存在就是 0 */ }
  return n;
}

module.exports = { synthesize, listVoices, clearCache, rateToString, VOICES, DEFAULT_VOICE, RATE_MIN, RATE_MAX };
