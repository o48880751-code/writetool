/**
 * 真机验证朗读链路（2026-11-16）。
 *
 * ## 为什么必须这么测
 *
 * 之前 `test-tts-ui.js` 用桩替换了 `tts:synth`，于是**真实的 wtts:// 协议
 * 从来没被验证过**。结果：合成明明成功（缓存里躺着 586KB 的 mp3），
 * 但 Audio 加载不了那个地址，一路降级到系统语音，用户听到的还是机读音。
 * 判据全绿、功能是坏的 —— 这就是"桩会骗你"的又一次现场。
 *
 * ## 做法
 *
 * 启动**真实打包版**（带 --remote-debugging-port），通过 CDP 在渲染进程里
 * 执行：调 tts:synth → 用返回的地址 fetch → 再用 Audio 解码。
 * 三条都过才算真的能播。
 *
 * ⚠ 用 `load()` + `canplaythrough` 判定，不用 `play()`：
 *   测试机没有音频输出设备，play() 会挂在那里既不 resolve 也不 reject，
 *   而"能不能解码出可播放的音频"才是这条链路的核心。
 *
 * 运行：node test-tts-live.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const EXE = path.join(__dirname, 'release', 'win-unpacked', 'InkScroll.exe');
const PORT = 9333;
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'livetts-'));

const CHECKS = [];
function t(name, ok, detail) {
  CHECKS.push({ name, pass: !!ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : '　' + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    require('node:http').get(url, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/** 极简 CDP 客户端：够用就行，不引第三方包 */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const waiting = new Map();
    ws.addEventListener('open', () => {
      resolve({
        evaluate(expression, timeoutMs = 40000) {
          const id = ++seq;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => { waiting.delete(id); rej(new Error('CDP 求值超时')); }, timeoutMs);
            waiting.set(id, { res, rej, timer });
            ws.send(JSON.stringify({
              id,
              method: 'Runtime.evaluate',
              params: { expression, awaitPromise: true, returnByValue: true },
            }));
          });
        },
        close() { try { ws.close(); } catch (_) { /* 忽略 */ } },
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) { w.rej(new Error(msg.error.message || 'CDP 错误')); return; }
      w.res(msg.result);
    });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
  });
}

(async () => {
  if (!fs.existsSync(EXE)) {
    console.log('找不到打包产物：' + EXE);
    process.exit(1);
  }

  console.log('启动打包版（隔离数据目录）…');
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    env: { ...process.env, WT_USERDATA: UD },
    // ⚠ 必须接住 stdio：主进程 handler 出错走的是 console.error，
    //   ignore 掉就只剩一个没有 error 字段的 {ok:false}，完全看不出原因
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childLog = [];
  child.stdout.on('data', (d) => childLog.push('[out] ' + String(d).trim()));
  child.stderr.on('data', (d) => childLog.push('[err] ' + String(d).trim()));

  let client = null;
  try {
    // 等窗口起来
    let targets = null;
    for (let i = 0; i < 25 && !targets; i += 1) {
      await sleep(700);
      try {
        const list = await httpJson(`http://127.0.0.1:${PORT}/json`);
        /**
         * ⚠ 必须挑**主窗口**（dist/index.html）。
         *   进程里同时有两个 page：启动动画 splash.html 和主窗口，
         *   splash 没有 preload → 连上它之后 `window.api` 是 undefined，
         *   所有断言会以"Cannot read properties of undefined"全红，
         *   看起来像功能坏了，其实只是连错了窗口（2026-11-16 踩）。
         */
        const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl
          && String(x.url || '').indexOf('index.html') >= 0);
        if (page) targets = page;
      } catch (_) { /* 还没起来 */ }
    }
    if (!targets) throw new Error('等不到调试端口，应用可能没起来');

    client = await cdpConnect(targets.webSocketDebuggerUrl);
    await sleep(1200);

    // ---------- 〇、先看 preload 到底暴露了什么 ----------
    console.log('\n=== 〇、preload 暴露情况 ===');
    const probe = await client.evaluate(`(function(){
      var api = window.api || {};
      return JSON.stringify({
        hasApi: !!window.api,
        hasTts: !!api.tts,
        ttsKeys: api.tts ? Object.keys(api.tts) : null,
        apiKeys: Object.keys(api).slice(0, 24),
      });
    })()`);
    const probeVal = (probe && probe.result && probe.result.value) || 'null';
    console.log('  ' + probeVal);
    try {
      const pv = JSON.parse(probeVal);
      t('preload 暴露了 tts 域', pv.hasTts === true, JSON.stringify(pv.ttsKeys));
    } catch (_) { t('preload 暴露了 tts 域', false, probeVal); }

    // ---------- 一、IPC 能合成 ----------
    console.log('\n=== 一、tts:synth 真调用 ===');
    /**
     * ⚠ preload 的 call() 已拆信封：成功直接返回 data，失败是 throw。
     *   这里判 `r.ok` 会永远 false —— 判据自己写错，看起来像产品坏了（踩过）。
     */
    const synth = await client.evaluate(`(async () => {
      try {
        const d = await window.api.tts.synth({ text: '夜枫停下脚步，灯笼往上提了提。', voice: 'xiaoxiao' });
        return { ok: !!(d && d.url), url: d && d.url, bytes: d && d.bytes, cached: d && d.cached };
      } catch (e) { return { ok: false, err: e.message }; }
    })()`);
    console.log('  原始返回:', JSON.stringify(synth && synth.result));
    const synthVal = (synth && synth.result && synth.result.value) || {};
    console.log('  ', JSON.stringify(synthVal));
    t('IPC 合成返回成功', synthVal.ok === true, synthVal.err);
    t('返回的是 wtts:// 地址', String(synthVal.url || '').indexOf('wtts://') === 0, synthVal.url);

    /**
     * ⚠ 这里**不测** `fetch('wtts://...')`（2026-11-16 实测）。
     *   自定义协议在渲染进程里受 CORS 限制，fetch 会直接失败，
     *   但 `<audio>` 走的是媒体加载通道、根本不用 fetch —— 能播就够了。
     *   加一条 fetch 断言只会制造假红，让人以为协议坏了。
     */
    // ---------- 三、Audio 真能解码 ----------
    console.log('\n=== 三、<audio> 能解码播放 ===');
    const audio = await client.evaluate(`new Promise((resolve) => {
      const a = new Audio(${JSON.stringify(synthVal.url || '')});
      let done = false;
      const finish = (o) => { if (!done) { done = true; try { a.pause(); } catch (e) {} resolve(o); } };
      a.oncanplaythrough = () => finish({ ok: true, duration: a.duration });
      a.onloadeddata = () => finish({ ok: true, duration: a.duration, via: 'loadeddata' });
      a.onerror = () => finish({ ok: false, code: a.error && a.error.code, msg: a.error && a.error.message });
      setTimeout(() => finish({ ok: false, timeout: true }), 12000);
      a.load();
    })`);
    const audioVal = (audio && audio.result && audio.result.value) || {};
    console.log('  ', JSON.stringify(audioVal));
    t('音频能解码（不是 404 / 空文件）', audioVal.ok === true, JSON.stringify(audioVal));
    t('时长大于 1 秒', (audioVal.duration || 0) > 1, String(audioVal.duration));

    // ---------- 四、缓存命中 ----------
    console.log('\n=== 四、第二次走缓存 ===');
    const again = await client.evaluate(`(async () => {
      const t0 = Date.now();
      const d = await window.api.tts.synth({ text: '夜枫停下脚步，灯笼往上提了提。', voice: 'xiaoxiao' });
      return { ok: !!(d && d.url), cached: d && d.cached, ms: Date.now() - t0 };
    })()`);
    const againVal = (again && again.result && again.result.value) || {};
    console.log('  ', JSON.stringify(againVal));
    t('第二次命中缓存', againVal.cached === true, JSON.stringify(againVal));
    t('缓存命中足够快（<200ms）', (againVal.ms || 999) < 200, String(againVal.ms) + 'ms');

  } catch (e) {
    console.log('\n执行失败：' + e.message);
    CHECKS.push({ name: '整体链路', pass: false });
  } finally {
    if (childLog.length) {
      console.log('\n=== 子进程输出（找 tts 相关）===');
      const ttsLines = childLog.filter((l) => /tts|语音|synth|msedge|Error/i.test(l));
      (ttsLines.length ? ttsLines : childLog).slice(-12).forEach((l) => console.log('  ' + l.slice(0, 300)));
    }
    if (client) client.close();
    try { child.kill(); } catch (_) { /* 已退出 */ }
    // 等进程真的退掉再删目录，否则 EBUSY
    await sleep(1200);
    try { fs.rmSync(UD, { recursive: true, force: true }); } catch (_) { /* 忽略占用 */ }
  }

  const bad = CHECKS.filter((c) => !c.pass);
  console.log(`\n========== ${CHECKS.length - bad.length}/${CHECKS.length} 通过 ==========`);
  if (bad.length) bad.forEach((b) => console.log('  ✗', b.name));
  process.exit(bad.length ? 1 : 0);
})();
