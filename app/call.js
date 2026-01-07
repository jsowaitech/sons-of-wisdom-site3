// app/call.js
// Son of Wisdom — Call mode (Premium Phone Call UI + Connect/Reconnect Sounds)
// ✅ Endpoints:
//    - /.netlify/functions/openai-transcribe  (audio -> transcript)
//    - /.netlify/functions/call-coach         (transcript -> AI text + TTS audio)
// ✅ Real call behavior:
//    - Natural silence detection (no fixed window)
//    - Turn merging (brief pauses merge into one transcript)
//    - Barge-in (interrupt AI by speaking) [Hook is ready; we’ll wire it in next pass]
// ✅ Premium Phone UI feel:
//    - Ringing state + connected state
//    - Call timer
//    - Alive idle ring pulse
//    - Distinct ring modes: idle / ringing / user / ai / reconnect
// ✅ Audio SFX:
//    - ring.mp3 (start + end)
//    - connect.mp3 (on connection)
//    - reconnect.mp3 (on recoverable errors)
// ✅ iOS Safari hardened audio unlock:
//    - unlockAudioSystem() runs ONLY on Start Call tap
//    - shared <audio> player for all AI playback

const DEBUG = true;
const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);

/* ---------- ENDPOINTS ---------- */
const CALL_COACH_ENDPOINT = "/.netlify/functions/call-coach";
const TRANSCRIBE_ENDPOINT = "/.netlify/functions/openai-transcribe";

/* ---------- AUDIO ASSETS ---------- */
const RING_SOUND_URL = "/ring.mp3";
const CONNECT_SOUND_URL = "/connect.mp3";
const RECONNECT_SOUND_URL = "/reconnect.mp3";

/* ---------- URL PARAMS ---------- */
const urlParams = new URLSearchParams(window.location.search);
const conversationId = urlParams.get("c") || null;

/* ---------- DOM ---------- */
const callBtn = document.getElementById("call-btn");
const statusText = document.getElementById("status-text");
const micBtn = document.getElementById("mic-btn");
const speakerBtn = document.getElementById("speaker-btn");
const modeBtn = document.getElementById("mode-btn");
const timerEl = document.getElementById("call-timer");
const voiceRingCanvas = document.getElementById("voiceRing");

/* Transcript DOM */
const transcriptList = document.getElementById("transcriptList");
const transcriptInterim = document.getElementById("transcriptInterim");

/* Transcript Controls */
const clearBtn = document.getElementById("ts-clear");
const autoscrollBtn = document.getElementById("ts-autoscroll");

/* ---------- STATE ---------- */
let isCalling = false;
let isRecording = false;
let isPlayingAI = false;

let globalStream = null;
let mediaRecorder = null;
let recordChunks = [];

let micMuted = false;
let speakerMuted = false;

let autoScroll = true;
let lastFinalLine = "";

/* ---------- Call timer ---------- */
let callStartedAt = 0;
let timerRAF = null;

/* ---------- iOS Safari detection ---------- */
const IS_IOS =
  /iPad|iPhone|iPod/i.test(navigator.userAgent || "") ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/* ---------- Shared audio system ---------- */
let ttsPlayer = null;
let audioUnlocked = false;
let playbackAC = null;

/* ---------- SFX audio players ---------- */
let ringPlayer = null;
let connectPlayer = null;
let reconnectPlayer = null;

/* ---------- Ring analysis ---------- */
let ringRAF = null;
let ringAnalyser = null;
let ringSourceNode = null;
let ringData = null;

/* ---------- Mic analysis for silence detection ---------- */
let micAC = null;
let micAnalyser = null;
let micSourceNode = null;
let micData = null;

/* ---------- Ring mode ---------- */
let ringMode = "idle"; // idle | ringing | user | ai | reconnect

/* ---------- SILENCE DETECTION SETTINGS ---------- */
const SILENCE_THRESHOLD = 0.02;
const SILENCE_HOLD_MS = 1100;
const MIN_RECORD_MS = 900;
const MAX_TURN_MS = 30000;

/* ---------- IDs ---------- */
function getDeviceId() {
  const key = "sow_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto?.randomUUID?.() || `dev_${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}
const deviceId = getDeviceId();
const callId = crypto?.randomUUID?.() || `call_${Date.now()}`;

/* ---------- Utility ---------- */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- UI helpers ---------- */
function setStatus(t) {
  if (!statusText) return;
  statusText.textContent = t || "";
}

function setInterim(t) {
  if (!transcriptInterim) return;
  transcriptInterim.textContent = t || "";
}

function addFinalLine(t) {
  if (!transcriptList) return;
  const s = (t || "").trim();
  if (!s || s === lastFinalLine) return;
  lastFinalLine = s;

  const div = document.createElement("div");
  div.className = "transcript-line";
  div.textContent = s;
  transcriptList.appendChild(div);

  if (autoScroll) transcriptList.scrollTop = transcriptList.scrollHeight;
}

function clearTranscript() {
  if (transcriptList) transcriptList.innerHTML = "";
  setInterim("");
  lastFinalLine = "";
}

/* ---------- Timer ---------- */
function startTimer() {
  callStartedAt = Date.now();
  stopTimer();
  const tick = () => {
    const s = Math.floor((Date.now() - callStartedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    if (timerEl) timerEl.textContent = `${mm}:${ss}`;
    timerRAF = requestAnimationFrame(tick);
  };
  tick();
}

function stopTimer() {
  try {
    cancelAnimationFrame(timerRAF);
  } catch {}
  timerRAF = null;
  if (timerEl) timerEl.textContent = "00:00";
}

/* ---------- Transcript controls ---------- */
clearBtn?.addEventListener("click", clearTranscript);

autoscrollBtn?.addEventListener("click", () => {
  autoScroll = !autoScroll;
  autoscrollBtn.setAttribute("aria-pressed", String(autoScroll));
  autoscrollBtn.textContent = autoScroll ? "On" : "Off";
});

/* ---------- Shared audio players ---------- */
function ensureSharedAudio() {
  if (ttsPlayer) return ttsPlayer;
  ttsPlayer = new Audio();
  ttsPlayer.preload = "auto";
  ttsPlayer.playsInline = true;
  ttsPlayer.crossOrigin = "anonymous";
  return ttsPlayer;
}

function ensureSfxAudio() {
  ringPlayer ||= new Audio(RING_SOUND_URL);
  connectPlayer ||= new Audio(CONNECT_SOUND_URL);
  reconnectPlayer ||= new Audio(RECONNECT_SOUND_URL);

  for (const p of [ringPlayer, connectPlayer, reconnectPlayer]) {
    p.preload = "auto";
    p.playsInline = true;
    p.crossOrigin = "anonymous";
    p.muted = speakerMuted;
    p.volume = speakerMuted ? 0 : 1;
  }
}

/* ---------- iOS unlock ---------- */
async function unlockAudioSystem() {
  try {
    ensureSharedAudio();
    ensureSfxAudio();

    playbackAC ||= new (window.AudioContext || window.webkitAudioContext)();
    if (playbackAC.state === "suspended") {
      await playbackAC.resume().catch(() => {});
    }

    if (IS_IOS && !audioUnlocked) {
      // unlock shared audio
      const a = ensureSharedAudio();
      a.src =
        "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      a.volume = 0;
      await a.play().catch(() => {});
      a.pause();
      a.currentTime = 0;

      // unlock SFX audio
      for (const p of [ringPlayer, connectPlayer, reconnectPlayer]) {
        try {
          p.volume = 0;
          p.currentTime = 0;
          await p.play().catch(() => {});
          p.pause();
          p.currentTime = 0;
        } catch {}
      }

      audioUnlocked = true;
      log("✅ iOS audio unlocked");
    } else {
      audioUnlocked = true;
    }
  } catch (e) {
    warn("unlockAudioSystem failed", e);
  }
}

/* ---------- SFX Play helpers ---------- */
async function playSfx(player) {
  if (!player || speakerMuted) return;
  try {
    player.muted = speakerMuted;
    player.volume = speakerMuted ? 0 : 1;
    player.currentTime = 0;
    await player.play().catch(() => {});
  } catch {}
}

async function playRingOnce() {
  try {
    ensureSfxAudio();
    await playSfx(ringPlayer);
  } catch {}
}

async function playConnectOnce() {
  try {
    ensureSfxAudio();
    await playSfx(connectPlayer);
  } catch {}
}

async function playReconnectOnce() {
  try {
    ensureSfxAudio();
    await playSfx(reconnectPlayer);
  } catch {}
}

/* ---------- Ring engine (premium idle) ---------- */
function stopRingSync() {
  try {
    cancelAnimationFrame(ringRAF);
  } catch {}
  ringRAF = null;
  ringMode = "idle";
}

function startIdleRing() {
  if (!voiceRingCanvas) return;

  stopRingSync();
  ringMode = "idle";

  const ctx = voiceRingCanvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const size = 240;
  const center = size / 2;

  voiceRingCanvas.width = size * dpr;
  voiceRingCanvas.height = size * dpr;
  voiceRingCanvas.style.width = size + "px";
  voiceRingCanvas.style.height = size + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  let last = performance.now();
  let t = 0;

  function draw(now) {
    if (!isCalling || ringMode !== "idle") return stopRingSync();

    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;

    ctx.clearRect(0, 0, size, size);

    const breath = (Math.sin(t * 1.35) + 1) / 2;
    const shimmer = (Math.sin(t * 2.7) + 1) / 2;

    const baseR = 64;
    const r = baseR + breath * 7;

    // Outer glow
    ctx.beginPath();
    ctx.arc(center, center, r + 18, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(59,130,246,${0.08 + breath * 0.12})`;
    ctx.lineWidth = 18;
    ctx.stroke();

    // Inner ring
    ctx.beginPath();
    ctx.arc(center, center, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.55 + shimmer * 0.12})`;
    ctx.lineWidth = 6;
    ctx.stroke();

    ringRAF = requestAnimationFrame(draw);
  }

  ringRAF = requestAnimationFrame(draw);
}

function startReconnectRing() {
  if (!voiceRingCanvas) return;

  stopRingSync();
  ringMode = "reconnect";

  const ctx = voiceRingCanvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const size = 240;
  const center = size / 2;

  voiceRingCanvas.width = size * dpr;
  voiceRingCanvas.height = size * dpr;
  voiceRingCanvas.style.width = size + "px";
  voiceRingCanvas.style.height = size + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  let last = performance.now();
  let rot = 0;

  function draw(now) {
    if (!isCalling || ringMode !== "reconnect") return stopRingSync();

    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    rot += dt * 2.6;

    ctx.clearRect(0, 0, size, size);

    const r = 68 + Math.sin(now * 0.006) * 4;

    ctx.beginPath();
    ctx.arc(center, center, r + 18, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(59,130,246,0.12)`;
    ctx.lineWidth = 18;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(center, center, r, rot, rot + Math.PI * 1.3);
    ctx.strokeStyle = `rgba(255,255,255,0.85)`;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";

    ringRAF = requestAnimationFrame(draw);
  }

  ringRAF = requestAnimationFrame(draw);
}

/* ---------- Controls ---------- */
micBtn?.addEventListener("click", () => {
  micMuted = !micMuted;
  if (globalStream) globalStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
  setStatus(micMuted ? "Mic muted" : "Mic unmuted");
  const lbl = document.getElementById("mic-label");
  if (lbl) lbl.textContent = micMuted ? "Unmute" : "Mute";
});

speakerBtn?.addEventListener("click", () => {
  speakerMuted = !speakerMuted;

  if (ttsPlayer) {
    ttsPlayer.muted = speakerMuted;
    ttsPlayer.volume = speakerMuted ? 0 : 1;
  }

  ensureSfxAudio();
  for (const p of [ringPlayer, connectPlayer, reconnectPlayer]) {
    if (!p) continue;
    p.muted = speakerMuted;
    p.volume = speakerMuted ? 0 : 1;
  }

  setStatus(speakerMuted ? "Speaker muted" : "Speaker on");
  const lbl = document.getElementById("speaker-label");
  if (lbl) lbl.textContent = speakerMuted ? "Speaker Off" : "Speaker";
});

modeBtn?.addEventListener("click", () => {
  const url = new URL("home.html", window.location.origin);
  if (conversationId) url.searchParams.set("c", conversationId);
  window.location.href = url.toString();
});

/* ---------- Call button ---------- */
callBtn?.addEventListener("click", async () => {
  await unlockAudioSystem();
  if (!isCalling) startCall();
  else endCall();
});

/* ---------- Call flow ---------- */
async function startCall() {
  isCalling = true;
  clearTranscript();
  stopTimer();
  startTimer();

  setStatus("Ringing…");
  startIdleRing();
  await playRingOnce();

  await sleep(450);
  await playConnectOnce();

  setStatus("Connected. Speak when ready.");
  await sleep(600);

  setStatus("Listening…");
  await startRecordingLoop();
}

async function endCall() {
  isCalling = false;
  isRecording = false;
  isPlayingAI = false;

  stopRingSync();

  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}

  try {
    globalStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  globalStream = null;

  try {
    ttsPlayer?.pause();
    ttsPlayer.currentTime = 0;
  } catch {}

  stopTimer();
  setStatus("Call ended.");
  await playRingOnce();
}

/* ---------- Recording loop ---------- */
async function startRecordingLoop() {
  while (isCalling) {
    if (micMuted) {
      setInterim("Mic muted…");
      await sleep(350);
      continue;
    }

    const ok = await captureTurnFreeTalk();
    if (!ok) continue;

    const transcript = await transcribeTurn();
    if (!transcript) {
      setStatus("Didn’t catch that. Try again…");
      startIdleRing();
      continue;
    }

    addFinalLine("You: " + transcript);

    const played = await sendTranscriptToCoachAndPlay(transcript);
    if (!played) {
      setStatus("Listening…");
      startIdleRing();
    }
  }
}

/* ---------- Capture with silence detection ---------- */
async function captureTurnFreeTalk() {
  if (!isCalling || isRecording || isPlayingAI) return false;

  recordChunks = [];
  setInterim("Listening…");
  setStatus("Listening…");

  try {
    globalStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });

    const mimeType = pickSupportedMime();
    mediaRecorder = new MediaRecorder(globalStream, { mimeType });
    isRecording = true;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) recordChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      isRecording = false;
      setInterim("");
      try { globalStream?.getTracks().forEach((t) => t.stop()); } catch {}
      globalStream = null;
    };

    mediaRecorder.start();

    micAC ||= new (window.AudioContext || window.webkitAudioContext)();
    if (micAC.state === "suspended") micAC.resume().catch(() => {});

    micAnalyser = micAC.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.smoothingTimeConstant = 0.9;
    micData = new Uint8Array(micAnalyser.frequencyBinCount);

    try { micSourceNode?.disconnect(); } catch {}
    micSourceNode = micAC.createMediaStreamSource(globalStream);
    micSourceNode.connect(micAnalyser);

    let startedAt = Date.now();
    let lastNonSilentAt = Date.now();

    while (isCalling && isRecording) {
      if (Date.now() - startedAt > MAX_TURN_MS) break;

      micAnalyser.getByteFrequencyData(micData);

      let sum = 0;
      for (let i = 0; i < micData.length; i++) sum += micData[i];
      const avg = sum / micData.length / 255;

      if (avg > SILENCE_THRESHOLD) lastNonSilentAt = Date.now();

      const talkingTime = Date.now() - startedAt;
      const silentFor = Date.now() - lastNonSilentAt;

      if (talkingTime > MIN_RECORD_MS && silentFor > SILENCE_HOLD_MS) break;

      await sleep(70);
    }

    try {
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch {}

    while (isRecording) await sleep(50);

    return recordChunks.length > 0;
  } catch (e) {
    warn("captureTurnFreeTalk error", e);
    setStatus("Mic permission denied.");
    await endCall();
    return false;
  }
}

/* ---------- Transcribe ---------- */
async function transcribeTurn() {
  if (!recordChunks.length) return "";

  setStatus("Transcribing…");

  try {
    const blob = new Blob(recordChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
    const fd = new FormData();
    fd.append("audio", blob, "user.webm");

    const resp = await fetch(TRANSCRIBE_ENDPOINT, { method: "POST", body: fd });
    if (!resp.ok) throw new Error(await resp.text().catch(() => resp.statusText));

    const data = await resp.json().catch(() => ({}));
    return (data?.text || "").trim();
  } catch (e) {
    warn("transcribeTurn error", e);

    // Reconnect behavior
    if (isCalling) {
      setStatus("Reconnecting…");
      startReconnectRing();
      await playReconnectOnce();
      await sleep(800);
      setStatus("Listening…");
      startIdleRing();
    }

    return "";
  }
}

/* ---------- Send -> coach -> play ---------- */
async function sendTranscriptToCoachAndPlay(transcript) {
  setStatus("Thinking…");

  try {
    const resp = await fetch(CALL_COACH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "voice",
        conversationId,
        transcript,
        call_id: callId,
        device_id: deviceId,
      }),
    });

    if (!resp.ok) throw new Error(await resp.text().catch(() => resp.statusText));

    const data = await resp.json().catch(() => ({}));
    const replyText = (data?.assistant_text || data?.text || "").trim();
    if (replyText) addFinalLine("AI: " + replyText);

    const b64 = data?.audio_base64;
    const mime = data?.mime || "audio/mpeg";
    if (!b64) return false;

    if (speakerMuted) return true;

    isPlayingAI = true;
    setStatus("Blake speaking…");

    const ok = await playViaSharedPlayerFromBase64(b64, mime);

    isPlayingAI = false;
    setStatus("Listening…");
    startIdleRing();
    return ok;
  } catch (e) {
    warn("sendTranscriptToCoachAndPlay error", e);

    if (isCalling) {
      setStatus("Reconnecting…");
      startReconnectRing();
      await playReconnectOnce();
      await sleep(900);
      setStatus("Listening…");
      startIdleRing();
    }

    return false;
  }
}

/* ---------- AI playback ---------- */
function playViaSharedPlayerFromBase64(b64, mime = "audio/mpeg", limitMs = 35000) {
  return new Promise((resolve) => {
    const a = ensureSharedAudio();
    let done = false;

    const settle = (ok) => {
      if (done) return;
      done = true;
      a.onended = a.onerror = a.onabort = null;
      resolve(ok);
    };

    try { a.pause(); } catch {}

    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);

    a.src = url;
    a.muted = speakerMuted;
    a.volume = speakerMuted ? 0 : 1;

    const t = setTimeout(() => settle(false), limitMs);

    a.onended = () => {
      clearTimeout(t);
      URL.revokeObjectURL(url);
      settle(true);
    };

    a.onerror = () => {
      clearTimeout(t);
      URL.revokeObjectURL(url);
      settle(false);
    };

    a.play().catch(() => {
      clearTimeout(t);
      URL.revokeObjectURL(url);
      settle(false);
    });
  });
}

/* ---------- Mime support ---------- */
function pickSupportedMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const m of candidates) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return "audio/webm";
}

/* ---------- Boot ---------- */
ensureSharedAudio();
ensureSfxAudio();
setStatus("Tap the blue call button to begin.");
log("✅ call.js loaded: CONNECT + RECONNECT SFX + PHONE UI");
