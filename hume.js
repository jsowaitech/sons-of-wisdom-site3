/* =========================
   Hume Realtime (Expression Measurement API)
   - Browser WebSocket client using JSON messages (models + base64 data)
   - Streams PCM16 @16kHz mic chunks (~500ms) in real-time
   - Shows top-3 emotions live
   - Minimal global API: window.HumeRealtime { init, startTurn, handleRecorderChunk, stopTurn }
   ========================= */

(() => {
  // ---- Defaults (you override via HumeRealtime.init in main.js) ----
  const DEFAULTS = {
    enable: true,
    apiKey: "AG7G9Hcq7vktEULDNixLRgOIGHY2yk4EZnAF5cAMpUslM9idRxamOHPM7J3aLFmQ", // keep in code for dev as requested
    wssBase: "wss://api.hume.ai/v0/stream/models",
    batchMs: 500,     // ~0.5s per WS JSON message (well under 5s audio payload limit)
    targetHz: 16000,  // PCM16 target
    uiThrottleMs: 180
  };

  const S = {
    cfg: { ...DEFAULTS },
    socket: null,
    workletReady: false,
    pcmNode: null,
    srcNode: null,
    audioCtx: null,
    // batching
    pcmQueue: [],    // array of Int16Array chunks
    lastFlush: 0,
    // UI
    ui: { root: null, list: null, lastRender: 0 },
  };

  /* ---------- Emotion UI ---------- */
  function ensureUI() {
    if (S.ui.root) return;
    const root = document.createElement("div");
    root.id = "hume-panel";
    root.style.cssText =
      "position:relative;width:min(860px,92vw);margin:10px auto 0;padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#dfe8ff;font-size:13px;";
    const title = document.createElement("div");
    title.textContent = "Live Emotions";
    title.style.cssText = "opacity:.8;margin-bottom:6px;font-weight:600;";
    const list = document.createElement("div");
    list.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;";
    root.appendChild(title); root.appendChild(list);
    const anchor = document.getElementById("transcript")
      || document.getElementById("avatar-container")
      || document.body;
    anchor.insertAdjacentElement("afterend", root);
    S.ui.root = root; S.ui.list = list;
  }
  function uiBar(label, pct) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:6px;min-width:160px;";
    const name = document.createElement("div"); name.textContent = label; name.style.cssText = "min-width:82px;opacity:.9;";
    const track = document.createElement("div"); track.style.cssText = "flex:1;height:8px;background:rgba(255,255,255,.12);border-radius:6px;overflow:hidden;";
    const fill = document.createElement("div"); fill.style.cssText = `height:100%;width:${Math.round(pct*100)}%;background:#3ad67b;`;
    track.appendChild(fill);
    const val = document.createElement("div"); val.textContent = `${Math.round(pct*100)}%`; val.style.cssText = "min-width:40px;text-align:right;opacity:.85;";
    wrap.appendChild(name); wrap.appendChild(track); wrap.appendChild(val);
    return wrap;
  }
  function uiUpdateTop(pairs) {
    ensureUI();
    const now = performance.now();
    if (now - S.ui.lastRender < S.cfg.uiThrottleMs) return;
    S.ui.lastRender = now;
    S.ui.list.innerHTML = "";
    pairs.slice(0,3).forEach(e => S.ui.list.appendChild(uiBar(e.name, e.score)));
  }
  function uiClear(){ if (S.ui.list) S.ui.list.innerHTML = ""; }

  /* ---------- Emotion extraction (schema-agnostic) ---------- */
  function extractEmotions(json) {
    const out = [];
    (function walk(node){
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.emotions && Array.isArray(node.emotions)) {
        node.emotions.forEach(e=>{
          const name = e?.name || e?.label || e?.emotion || "";
          const score = typeof e?.score === "number" ? e.score :
                        typeof e?.confidence === "number" ? e.confidence :
                        (typeof e?.value === "number" ? e.value : null);
          if (name && score != null) out.push({ name, score });
        });
      }
      if (node.scores && typeof node.scores === "object" && !Array.isArray(node.scores)) {
        for (const [k,v] of Object.entries(node.scores)) if (typeof v === "number") out.push({ name:k, score:v });
      }
      for (const v of Object.values(node)) walk(v);
    })(json);
    out.sort((a,b)=>b.score-a.score);
    return out;
  }

  /* ---------- AudioWorklet: downsample to 16k PCM16 ---------- */
  async function ensureWorklet(audioCtx){
    if (S.workletReady) return true;
    if (!audioCtx?.audioWorklet) return false;
    const code = `
      class PCM16Downsampler extends AudioWorkletProcessor {
        constructor(opts){ super(); this.target = (opts?.processorOptions?.targetSampleRate)||16000; this.inRate = sampleRate; this._acc = 0; }
        process(inputs){
          const ch0 = inputs[0]?.[0];
          if (!ch0) return true;
          const ratio = this.inRate / this.target;
          let outLen = Math.ceil(ch0.length / ratio) + 8;
          const out = new Int16Array(outLen);
          let o=0;
          for (let acc=this._acc; acc < ch0.length; acc += ratio) {
            const i = acc|0; const s = Math.max(-1, Math.min(1, ch0[i]||0));
            out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this._acc = (this._acc + ch0.length) % ratio;
          if (o>0){
            const buf = out.buffer.slice(0, o*2);
            this.port.postMessage({ type: 'pcm16', buffer: buf }, [buf]);
          }
          return true;
        }
      }
      registerProcessor('pcm16-downsampler', PCM16Downsampler);`;
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try { await audioCtx.audioWorklet.addModule(url); S.workletReady = true; }
    finally { URL.revokeObjectURL(url); }
    return true;
  }

  /* ---------- WS: connect to /v0/stream/models with apiKey query ---------- */
  function wsUrl() {
    // Browser WS can’t set custom headers, so use query param per docs:
    // wss://api.hume.ai/v0/stream/models?apiKey=YOUR_KEY
    const u = new URL(S.cfg.wssBase);
    u.searchParams.set("apiKey", S.cfg.apiKey);
    return u.toString();
  }

  function openSocket(){
    if (!S.cfg.enable || !S.cfg.apiKey) return;
    if (S.socket?.readyState === 1) return;

    try { S.socket = new WebSocket(wsUrl()); } catch { return; }
    S.socket.binaryType = "arraybuffer";

    S.socket.onopen = () => {
      // No separate "start" required by docs; we’ll just stream JSON packets.
      // (Keeping the connection open improves latency and avoids re-auth.)
    };
    S.socket.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        const top = extractEmotions(data);
        if (top.length) uiUpdateTop(top);
      } catch {
        // ignore non-JSON frames
      }
    };
    S.socket.onerror = () => {};
    S.socket.onclose  = () => {};
  }

  function closeSocket(){
    try { S.socket?.close(); } catch {}
    S.socket = null;
  }

  /* ---------- Batching & send (JSON with base64) ---------- */
  function flushIfDue(force = false) {
    if (!S.socket || S.socket.readyState !== 1) return;
    const now = performance.now();
    if (!force && now - S.lastFlush < S.cfg.batchMs) return;
    S.lastFlush = now;

    if (!S.pcmQueue.length) return;

    // Concatenate queued Int16 frames into one
    let totalSamples = 0;
    S.pcmQueue.forEach(a => totalSamples += a.length);
    const merged = new Int16Array(totalSamples);
    let off = 0; for (const a of S.pcmQueue) { merged.set(a, off); off += a.length; }
    S.pcmQueue.length = 0;

    // Base64 encode
    const u8 = new Uint8Array(merged.buffer);
    let bin = "";
    for (let i=0;i<u8.length;i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);

    // Build JSON payload as per docs (models + data).
    // We include helpful metadata; server can ignore unknown fields.
    const msg = {
      models: { prosody: {} },
      data: b64,
      encoding: "pcm16",
      sample_rate: S.cfg.targetHz,
      channels: 1,
      // reset_stream: false, // set true if you need to segment contexts
    };

    try { S.socket.send(JSON.stringify(msg)); } catch {}
  }

  /* ---------- Public API ---------- */
  async function init(opts = {}) {
    S.cfg = { ...S.cfg, ...opts };
    if (S.cfg.enable) ensureUI();
  }

  // Start of a user turn: stream mic → PCM16 → batch → WS JSON
  async function startTurn(stream, audioCtx) {
    if (!S.cfg.enable) return;

    openSocket();

    S.audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ok = await ensureWorklet(S.audioCtx);
    if (!ok) return;

    S.srcNode = S.audioCtx.createMediaStreamSource(stream);
    S.pcmNode = new AudioWorkletNode(S.audioCtx, 'pcm16-downsampler', {
      processorOptions: { targetSampleRate: S.cfg.targetHz }
    });
    S.srcNode.connect(S.pcmNode);

    S.pcmNode.port.onmessage = (e) => {
      if (e.data?.type !== "pcm16") return;
      const buf = e.data.buffer;          // ArrayBuffer
      const view = new Int16Array(buf);
      // collect and flush on schedule
      S.pcmQueue.push(view);
      flushIfDue(false);
    };

    // safety flush cadence
    S.lastFlush = performance.now();
    S._flushTimer = setInterval(() => flushIfDue(true), S.cfg.batchMs);
  }

  // For parity with previous API; not used in JSON mode but kept as no-op.
  async function handleRecorderChunk(_blob) { /* no-op in JSON expression API */ }

  function stopTurn() {
    try { clearInterval(S._flushTimer); } catch {}
    flushIfDue(true);  // final flush
    if (S.pcmNode) { try { S.pcmNode.disconnect(); } catch {} S.pcmNode = null; }
    if (S.srcNode) { try { S.srcNode.disconnect(); } catch {} S.srcNode = null; }
    closeSocket();
    uiClear();
  }

  window.HumeRealtime = { init, startTurn, handleRecorderChunk, stopTurn };
})();
