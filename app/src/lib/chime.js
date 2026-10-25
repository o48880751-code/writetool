/**
 * 生成完成提示音。
 *
 * 用 Web Audio API 实时合成，不依赖任何外部音频文件——
 * 省去「找免费音效 / 打包资源」的麻烦，也免授权问题。
 * 两段上行短音（660Hz → 880Hz），指数衰减收尾，避免「啪」的爆音。
 */

let ctx = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  // AudioContext 常因自动播放策略处于 suspended，播之前 resume
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** 播放一次完成提示音 */
export function playChime() {
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  const beep = (start, freq, dur) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  };
  beep(now, 660, 0.18);
  beep(now + 0.16, 880, 0.30);
}
