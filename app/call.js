// app/call.js
// Son of Wisdom — Call mode (Phone-call pace + iOS-safe layout + reliable audio queue)
// Updated:
// - Rename "Speaker" toggle to "Audio" (accurate for iPhone/AirPods routing)
// - Status rendering: never claim "Speaker muted"; show "Audio muted" instead
// - Keep TTS queued while audio muted; drain on unmute
// - Preserve existing: single renderStatus, correct recorder MIME for transcription,
//   close AudioContexts on endCall, reset VAD/merge state on background.

const DEBUG = true;
const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);

/* ---------- ENDPOINTS ---------- */
const CALL_COACH_ENDPOINT = "/.netlify/functions/call-coach";
const TRANSCRIBE_ENDPOINT = "/.netlify/functions/openai-transcribe";
const CALL_GREETING_ENDPOINT = "/.netlify/functions/call-greeting";

/* ---------- TRANSCRIBE MODEL ---------- */
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

/* ---------- URL PARAMS ---------- */
const urlParams = new URLSearchParams(window.location.search);
const conversationId = urlParams.get("c") || null;

/* ---------- DOM ---------- */
const callBtn = document.getElementById("call-btn");
const statusText = document.getElementById("status-text");
const micBtn = document.getElementById("mic-btn");
const speakerBtn = document.getElementById("speaker-btn"); // (kept id)
const modeBtn = document.getElementById("mode-btn");

const transcriptList = document.getElementById("transcriptList");
const transcriptInterim = document.getElementById("transcriptInterim");

const clearBtn = document.getElementById("ts-clear");
const autoscrollBtn = document.getElementById("ts-autoscroll");

const voiceRing = document.getElementById("voiceRing");
const callTimerEl = document.getElementById("call-timer");
const callLabelEl = document.getElementById("call-label");

const audioResumeOverlay = document.getElementById("audio-resume-overlay");
const audioResumeBtn = document.getElementById("audio-resume-btn");

const debugEl = document.getElementById("call-debug");

/* ---------- STATE ---------- */
let isCalling = false;
let isRecording = false;

let micMuted = false;

// IMPORTANT: This is NOT the iPhone "speaker route".
// It's simply whether the web app is allowed to play audio (whatever route iOS chooses).
let audioMuted = false;

let autoScroll = true;
let lastFinalLine = "";

/* merge buffer */
let mergedTranscriptBuffer = "";
let mergeTimer = null;
let isMerging = false;

/* audio recording */
let globalStream = null;
let mediaRecorder = null;
let recordChunks = [];
let recordMimeType = "audio/webm";

/* VAD */
let vadAC = null;
let vadSource = null;
let vadAnalyser = null;
let vadData = null;
let vadLoopRunning = false;
let vadState = "idle";
let lastVoiceTime = 0;
let speechStartTime = 0;

/* Adaptive noise floor */
let noiseFloor = 0.012;
let lastNoiseUpdate = 0;

/* Phone-call pace tuning */
const VAD_SILENCE_MS = 1400;        // more natural (less cut-off)
const VAD_MERGE_WINDOW_MS = 1600;   // allow continued sentence
const VAD_MIN_SPEECH_MS = 420;      // ignore blips
const VAD_IDLE_TIMEOUT_MS = 30000;

/* Adaptive threshold shaping */
const NOISE_FLOOR_UPDATE_MS = 250;
const THRESHOLD_MULTIPLIER = 2.25;
const THRESHOLD_MIN = 0.018;
const THRESHOLD_MAX = 0.095;

/* VAD hysteresis (polish) */
const VAD_START_MULT = 1.10;
const VAD_CONT_MULT = 0.85;

/* Barge-in debouncing (less sensitive) */
const BARGE_MIN_HOLD_MS = 240;     // must be sustained
const BARGE_COOLDOWN_MS = 900;     // ignore early echo right after AI starts
const BARGE_EXTRA_MULT = 1.55;     // require louder than normal threshold
let bargeVoiceStart = 0;
let aiSpeechStart = 0;

/* ---------- iOS detection ---------- */
const IS_IOS =
  /iPad|iPhone|iPod/i.test(navigator.userAgent || "") ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/* ---------- Shared AI audio player + analyser ---------- */
let ttsPlayer = null;
let playbackAC = null;
let playbackAnalyser = null;
let playbackData = null;
let audioUnlocked = false;

/* playback epoch guard (prevents stale ended/error) */
let playbackEpoch = 0;

/* AI speaking flags */
let isPlayingAI = false;

/* Abort controllers */
let transcribeAbort = null;
let coachAbort = null;

/* Strict coach sequencing */
let coachSeq = 0;

/* Turn queue */
const pendingUserTurns = [];
let drainingTurns = false;

/* Greeting */
let greetingDone = false;

/* ring.mp3 */
let ringAudio = null;
let ringPlayed = false;

/* timer */
let callStartTs = 0;
let timerRAF = null;

/* Dedupe user turns */
let lastUserSentText = "";
let lastUserSentAt = 0;
const USER_TURN_DEDUPE_MS = 2200;

/* Playback queue (fixes “alternating skip”) */
const ttsQueue = [];
let ttsDraining = false;

/* Debug HUD */
let debugOn = false;

/* Status flags (fix UI inaccuracies) */
let isTranscribing = false;
let isThinking = false;
let pausedInBackground = false;
let transientStatus = "";
let transientUntil = 0;

/* ---------- Helpers ---------- */
function setStatus(t) {
  if (!statusText) return;
  statusText.textContent = t || "";
}

function setTransientStatus(t, ms = 1600) {
  transientStatus = t || "";
  transientUntil = transientStatus ? (performance.now() + ms) : 0;
  renderStatus();
}

function renderStatus() {
  // Priority order: paused > resume overlay hint > AI speaking > transcribing > thinking > merging > transient > mic muted > audio muted > default
  if (!isCalling) {
    setStatus("Tap the blue call button to begin.");
    return;
  }

  if (pausedInBackground) {
    setStatus("Paused (app in background). Tap to resume.");
    return;
  }

  // If Safari blocked playback, overlay will show; keep status helpful.
  if (!audioResumeOverlay?.hidden) {
    setStatus("Tap to resume audio.");
    return;
  }

  // AI speaking status should win even if audioMuted (still accurate: AI is replying).
  if (isPlayingAI) {
    setStatus(audioMuted ? "AI replying… (audio muted)" : "AI replying…");
    return;
  }

  if (isTranscribing) {
    setStatus("Transcribing…");
    return;
  }

  if (isThinking) {
    setStatus("Thinking…");
    return;
  }

  if (isMerging) {
    setStatus("Finishing your thought…");
    return;
  }

  const now = performance.now();
  if (transientStatus && transientUntil && now < transientUntil) {
    setStatus(transientStatus);
    return;
  }

  if (micMuted) {
    setStatus("Mic muted.");
    return;
  }

  if (audioMuted) {
    setStatus("Audio muted.");
    return;
  }

  setStatus("Listening…");
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
  mergedTranscriptBuffer = "";
  if (mergeTimer) clearTimeout(mergeTimer);
  mergeTimer = null;
  isMerging = false;
  renderStatus();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function showAudioResumeOverlay() {
  if (!audioResumeOverlay) return;
  audioResumeOverlay.hidden = false;
  renderStatus();
}

function hideAudioResumeOverlay() {
  if (!audioResumeOverlay) return;
  audioResumeOverlay.hidden = true;
  renderStatus();
}

function setDebugText(t) {
  if (!debugEl) return;
  debugEl.textContent = t || "";
}

/* ---------- Buttons ---------- */
clearBtn?.addEventListener("click", clearTranscript);

autoscrollBtn?.addEventListener("click", () => {
  autoScroll = !autoScroll;
  autoscrollBtn.setAttribute("aria-pressed", String(autoScroll));
  autoscrollBtn.textContent = autoScroll ? "On" : "Off";
});

modeBtn?.addEventListener("click", () => {
  const url = new URL("home.html", window.location.origin);
  if (conversationId) url.searchParams.set("c", conversationId);
  window.location.href = url.toString();
});

micBtn?.addEventListener("click", () => {
  micMuted = !micMuted;
  micBtn?.setAttribute("aria-pressed", String(micMuted));

  if (globalStream) globalStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));

  const lbl = document.getElementById("mic-label");
  if (lbl) lbl.textContent = micMuted ? "Unmute" : "Mute";

  renderStatus();
});

function setAudioMutedUI(muted) {
  audioMuted = !!muted;

  // Convention: aria-pressed="true" means "muted"
  speakerBtn?.setAttribute("aria-pressed", String(audioMuted));

  if (ttsPlayer) {
    ttsPlayer.muted = audioMuted;
    ttsPlayer.volume = audioMuted ? 0 : 1;
  }

  const lbl = document.getElementById("speaker-label");
  if (lbl) lbl.textContent = audioMuted ? "Audio Off" : "Audio";

  // If unmuting, resume draining queued TTS
  if (!audioMuted) drainTTSQueue();

  renderStatus();
}

speakerBtn?.addEventListener("click", () => {
  setAudioMutedUI(!audioMuted);
});

audioResumeBtn?.addEventListener("click", async () => {
  hideAudioResumeOverlay();
  await unlockAudioSystem();
  try {
    if (ttsPlayer && !audioMuted) await ttsPlayer.play().catch(() => {});
  } catch {}
});

/* Debug toggle + quick key to chat */
window.addEventListener("keydown", (e) => {
  const k = (e.key || "").toLowerCase();
  if (k === "d") {
    debugOn = !debugOn;
    if (debugEl) debugEl.hidden = !debugOn;
  }
  if (k === "c") {
    const url = new URL("home.html", window.location.origin);
    if (conversationId) url.searchParams.set("c", conversationId);
    window.location.href = url.toString();
  }
});

/* Visibility handling (iOS hardening) */
document.addEventListener("visibilitychange", async () => {
  if (!isCalling) return;

  if (document.hidden) {
    pausedInBackground = true;

    try { ttsPlayer?.pause(); } catch {}
    try { if (isRecording) await stopRecordingTurn({ discard: true }); } catch {}

    // Reset VAD/merge so we don't come back in a weird state.
    vadState = "idle";
    bargeVoiceStart = 0;
    mergedTranscriptBuffer = "";
    if (mergeTimer) clearTimeout(mergeTimer);
    mergeTimer = null;
    isMerging = false;
    setInterim("");

    renderStatus();
  } else {
    pausedInBackground = false;
    await unlockAudioSystem();
    renderStatus();
  }
});

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

/* ---------- Audio system ---------- */
function ensureSharedAudio() {
  if (ttsPlayer) return ttsPlayer;

  ttsPlayer = new Audio();
  ttsPlayer.preload = "auto";
  ttsPlayer.playsInline = true;
  ttsPlayer.crossOrigin = "anonymous";
  ttsPlayer.muted = audioMuted;
  ttsPlayer.volume = audioMuted ? 0 : 1;

  return ttsPlayer;
}

async function unlockAudioSystem() {
  try {
    ensureSharedAudio();

    playbackAC ||= new (window.AudioContext || window.webkitAudioContext)();
    if (playbackAC.state === "suspended") {
      await playbackAC.resume().catch(() => {});
    }

    if (!playbackAnalyser) {
      const src = playbackAC.createMediaElementSource(ttsPlayer);
      playbackAnalyser = playbackAC.createAnalyser();
      playbackAnalyser.fftSize = 1024;
      playbackData = new Uint8Array(playbackAnalyser.fftSize);

      src.connect(playbackAnalyser);
      playbackAnalyser.connect(playbackAC.destination);
    }

    // iOS: prime a play() once during user gesture
    if (IS_IOS && !audioUnlocked) {
      const a = ensureSharedAudio();
      a.src =
        "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      a.volume = 0;
      await a.play().catch(() => {});
      a.pause();
      a.currentTime = 0;
      audioUnlocked = true;
      log("✅ iOS audio unlocked");
    } else {
      audioUnlocked = true;
    }
  } catch (e) {
    warn("unlockAudioSystem failed", e);
  }
}

/* ---------- ring.mp3 SFX ---------- */
function ensureRingSfx() {
  if (ringAudio) return ringAudio;
  ringAudio = new Audio("ring.mp3");
  ringAudio.preload = "auto";
  ringAudio.playsInline = true;
  ringAudio.loop = false;
  ringAudio.volume = 0.65;
  return ringAudio;
}

async function playRingOnceOnConnect() {
  if (ringPlayed) return;
  ringPlayed = true;
  try {
    const r = ensureRingSfx();
    r.pause();
    r.currentTime = 0;
    r.muted = false;
    await r.play().catch(() => {});
    log("🔔 ring played");
  } catch {}
}

function stopRing() {
  try {
    if (!ringAudio) return;
    ringAudio.pause();
    ringAudio.currentTime = 0;
  } catch {}
}

/* ---------- MIME picking ---------- */
function pickSupportedMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "audio/webm";
}

function mimeToExt(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("mp4")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  return "webm";
}

/* ---------- Mic stream ---------- */
async function ensureMicStream() {
  if (globalStream) return globalStream;

  globalStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  try {
    globalStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
  } catch {}

  return globalStream;
}

/* ---------- VAD setup ---------- */
async function setupVAD() {
  if (vadAC) return;

  vadAC = new (window.AudioContext || window.webkitAudioContext)();
  if (vadAC.state === "suspended") {
    await vadAC.resume().catch(() => {});
  }

  const stream = await ensureMicStream();

  vadSource = vadAC.createMediaStreamSource(stream);
  vadAnalyser = vadAC.createAnalyser();
  vadAnalyser.fftSize = 1024;
  vadData = new Uint8Array(vadAnalyser.fftSize);

  vadSource.connect(vadAnalyser);

  noiseFloor = 0.012;
  lastNoiseUpdate = performance.now();

  log("✅ VAD ready (adaptive, phone-call pace)");
}

function rmsFromTimeDomain(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / bytes.length);
}

function getMicEnergy() {
  if (!vadAnalyser || !vadData) return 0;
  vadAnalyser.getByteTimeDomainData(vadData);
  return rmsFromTimeDomain(vadData);
}

function computeAdaptiveThreshold() {
  let thr = noiseFloor * THRESHOLD_MULTIPLIER;
  if (!Number.isFinite(thr)) thr = 0.03;
  thr = Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, thr));
  return thr;
}

function maybeUpdateNoiseFloor(energy, now) {
  if (now - lastNoiseUpdate < NOISE_FLOOR_UPDATE_MS) return;
  lastNoiseUpdate = now;

  // only learn noise floor when NOT speaking
  const capped = Math.min(energy, noiseFloor * 2.5 + 0.008); // slightly tighter to avoid runaway

  const alpha = 0.10;
  noiseFloor = noiseFloor * (1 - alpha) + capped * alpha;
  noiseFloor = Math.max(0.004, Math.min(0.055, noiseFloor));
}

/* ---------- RECORD TURN CONTROL ---------- */
async function startRecordingTurn() {
  if (isRecording) return;
  const stream = await ensureMicStream();
  const mimeType = pickSupportedMime();

  recordMimeType = mimeType;
  recordChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType });
  isRecording = true;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data?.size > 0) recordChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    isRecording = false;
  };

  mediaRecorder.start();
}

async function stopRecordingTurn({ discard = false } = {}) {
  if (!isRecording || !mediaRecorder) return;

  try {
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}

  while (isRecording) await sleep(25);
  mediaRecorder = null;

  if (discard) recordChunks = [];
}

/* ---------- Transcribe audio -> text ---------- */
async function transcribeTurn() {
  if (!recordChunks.length) return "";

  isTranscribing = true;
  renderStatus();

  try { transcribeAbort?.abort(); } catch {}
  transcribeAbort = new AbortController();

  try {
    const blob = new Blob(recordChunks, { type: recordMimeType || "audio/webm" });
    const ext = mimeToExt(recordMimeType);
    const filename = `user.${ext}`;

    const fd = new FormData();
    fd.append("file", blob, filename);
    fd.append("model", TRANSCRIBE_MODEL);
    fd.append("response_format", "json");

    const resp = await fetch(TRANSCRIBE_ENDPOINT, {
      method: "POST",
      body: fd,
      signal: transcribeAbort.signal,
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Transcribe HTTP ${resp.status}: ${t || resp.statusText}`);
    }

    const data = await resp.json().catch(() => ({}));
    const text = (data?.text || data?.transcript || data?.utterance || "").toString().trim();
    return text;
  } catch (e) {
    if (e?.name === "AbortError") return "";
    warn("transcribeTurn error", e);
    return "";
  } finally {
    transcribeAbort = null;
    isTranscribing = false;
    renderStatus();
  }
}

/* ---------- Merge logic ---------- */
function queueMergedSend(transcript) {
  if (!transcript) return;

  mergedTranscriptBuffer = mergedTranscriptBuffer
    ? `${mergedTranscriptBuffer} ${transcript}`.trim()
    : transcript.trim();

  isMerging = true;
  setInterim("…");
  renderStatus();

  if (mergeTimer) clearTimeout(mergeTimer);

  mergeTimer = setTimeout(() => {
    mergeTimer = null;

    const final = mergedTranscriptBuffer.trim();
    mergedTranscriptBuffer = "";
    isMerging = false;
    setInterim("");
    renderStatus();

    if (!final) return;
    if (!isCalling) return;

    // DEDUPE (prevents multiple AI replies from same spoken line)
    const now = Date.now();
    if (final === lastUserSentText && (now - lastUserSentAt) < USER_TURN_DEDUPE_MS) {
      log("🟡 dropped duplicate user turn:", final);
      return;
    }
    lastUserSentText = final;
    lastUserSentAt = now;

    addFinalLine("You: " + final);

    pendingUserTurns.push(final);
    drainTurnQueue();
  }, VAD_MERGE_WINDOW_MS);
}

/* ---------- Turn queue drain (prevents multi replies) ---------- */
async function drainTurnQueue() {
  if (drainingTurns) return;
  drainingTurns = true;

  try {
    while (isCalling && pendingUserTurns.length) {
      const next = pendingUserTurns.shift();
      if (!next) continue;

      await sendTranscriptToCoachAndQueueAudio(next);

      if (!isCalling) break;
    }
  } finally {
    drainingTurns = false;
  }
}

/* ---------- TTS PLAYBACK QUEUE ---------- */
async function enqueueTTS(base64, mime) {
  if (!base64) return;
  ttsQueue.push({ base64, mime: mime || "audio/mpeg" });

  // Only drain if audio is on; if muted, we keep queued for later.
  if (!audioMuted) drainTTSQueue();
}

async function drainTTSQueue() {
  if (ttsDraining) return;
  ttsDraining = true;

  try {
    while (isCalling && ttsQueue.length && !audioMuted) {
      const item = ttsQueue.shift();
      if (!item?.base64) continue;

      isPlayingAI = true;
      aiSpeechStart = performance.now();
      renderStatus();

      // While AI is speaking, stop recording and ignore VAD starts (prevents echo->double replies)
      if (isRecording) await stopRecordingTurn({ discard: true });

      const ok = await playDataUrlTTS(item.base64, item.mime);

      isPlayingAI = false;
      if (!isCalling) break;

      if (!ok) {
        // If playback failed due to gesture lock, overlay is shown by player.
        renderStatus();
      } else {
        hideAudioResumeOverlay();
        renderStatus();
      }
    }
  } finally {
    ttsDraining = false;
  }
}

/* --- event helper --- */
function waitOnce(target, event, ms = 2000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { target.removeEventListener(event, onEvt); } catch {}
      resolve(true);
    };
    const onEvt = () => finish();
    try { target.addEventListener(event, onEvt, { once: true }); } catch {}
    setTimeout(() => resolve(false), ms);
  });
}

/* --- Unskippable Safari-safe playback: epoch guard + stall watchdog --- */
async function playDataUrlTTS(b64, mime = "audio/mpeg", hardTimeoutMs = 180000) {
  const a = ensureSharedAudio();
  const myEpoch = ++playbackEpoch;

  // hard reset (Safari reliability)
  try { a.pause(); } catch {}
  try { a.removeAttribute("src"); } catch {}
  try { a.src = ""; } catch {}
  try { a.load(); } catch {}

  a.muted = audioMuted;
  a.volume = audioMuted ? 0 : 1;
  a.playsInline = true;

  const dataUrl = `data:${mime};base64,${b64}`;
  a.src = dataUrl;

  try { a.load(); } catch {}
  await waitOnce(a, "canplay", 2500);

  return new Promise((resolve) => {
    let settled = false;
    let lastT = -1;
    let lastMoveAt = performance.now();
    let stallTimer = null;
    let hardTimer = null;

    const cleanup = () => {
      a.onended = null;
      a.onerror = null;
      a.onabort = null;
      try { if (stallTimer) clearInterval(stallTimer); } catch {}
      try { if (hardTimer) clearTimeout(hardTimer); } catch {}
      stallTimer = null;
      hardTimer = null;
    };

    const settle = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };

    // Stall watchdog: if time doesn't advance while playing, retry play()
    stallTimer = setInterval(() => {
      if (myEpoch !== playbackEpoch) return; // stale playback
      if (a.paused) return;

      const t = a.currentTime || 0;
      if (t !== lastT) {
        lastT = t;
        lastMoveAt = performance.now();
      } else {
        const stalledFor = performance.now() - lastMoveAt;
        if (stalledFor > 850) {
          a.play().catch(() => {});
          lastMoveAt = performance.now();
        }
      }
    }, 250);

    hardTimer = setTimeout(() => {
      if (myEpoch !== playbackEpoch) return;
      settle(false);
    }, hardTimeoutMs);

    a.onended = () => {
      if (myEpoch !== playbackEpoch) return;
      hideAudioResumeOverlay();
      settle(true);
    };
    a.onerror = () => {
      if (myEpoch !== playbackEpoch) return;
      settle(false);
    };
    a.onabort = () => {
      if (myEpoch !== playbackEpoch) return;
      settle(false);
    };

    a.play()
      .then(() => {
        hideAudioResumeOverlay();
      })
      .catch(() => {
        // Safari gesture lock / audio lost unlock
        showAudioResumeOverlay();
        settle(false);
      });
  });
}

/* ---------- Greeting ---------- */
async function playGreetingOnce() {
  if (greetingDone) return;
  greetingDone = true;

  try {
    renderStatus();

    const resp = await fetch(CALL_GREETING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call_id: callId,
        device_id: deviceId,
        conversationId: conversationId || null,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Greeting HTTP ${resp.status}: ${t || resp.statusText}`);
    }

    const data = await resp.json().catch(() => ({}));
    if (!isCalling) return;

    const replyText = (data?.assistant_text || data?.text || "").trim();
    const b64 = data?.audio_base64;
    const mime = data?.mime || "audio/mpeg";

    if (replyText) addFinalLine("AI: " + replyText);

    stopRing();

    if (b64) await enqueueTTS(b64, mime);

    // ensure greeting plays BEFORE listening begins
    if (!audioMuted) await drainTTSQueue();

    renderStatus();
  } catch (e) {
    warn("playGreetingOnce failed", e);
    renderStatus();
  }
}

/* ---------- Send transcript -> AI ---------- */
async function sendTranscriptToCoachAndQueueAudio(transcript) {
  const text = (transcript || "").trim();
  if (!text) return false;
  if (!isCalling) return false;

  const seq = ++coachSeq;

  try { coachAbort?.abort(); } catch {}
  coachAbort = new AbortController();

  isThinking = true;
  renderStatus();

  try {
    const resp = await fetch(CALL_COACH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: coachAbort.signal,
      body: JSON.stringify({
        source: "voice",
        conversationId: conversationId || null,
        call_id: callId,
        device_id: deviceId,
        transcript: text,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Coach HTTP ${resp.status}: ${t || resp.statusText}`);
    }

    const data = await resp.json().catch(() => ({}));
    if (!isCalling) return false;
    if (seq !== coachSeq) return false; // stale

    const replyText = (data?.assistant_text || data?.text || "").trim();
    if (replyText) addFinalLine("AI: " + replyText);

    const b64 = data?.audio_base64;
    const mime = data?.mime || "audio/mpeg";

    if (b64) await enqueueTTS(b64, mime);

    return true;
  } catch (e) {
    if (e?.name === "AbortError") return false;
    warn("sendTranscriptToCoachAndQueueAudio error", e);
    setTransientStatus("Network error.", 1800);
    return false;
  } finally {
    coachAbort = null;
    isThinking = false;
    renderStatus();
  }
}

/* ---------- BARGE-IN ---------- */
function stopAIForBargeIn() {
  if (!ttsPlayer) return;
  if (!isPlayingAI) return;

  playbackEpoch++; // invalidate any pending ended/error from old src

  try { ttsPlayer.pause(); } catch {}
  try { ttsPlayer.currentTime = 0; } catch {}

  // stop pending audio in queue
  ttsQueue.length = 0;

  // cancel in-flight coach (prevents late reply)
  try { coachAbort?.abort(); } catch {}
  coachAbort = null;

  // clear merge buffer so we don't send stale partials right after barge-in
  try { if (mergeTimer) clearTimeout(mergeTimer); } catch {}
  mergeTimer = null;
  mergedTranscriptBuffer = "";
  isMerging = false;
  setInterim("");

  isPlayingAI = false;
  renderStatus();
  log("🛑 Barge-in: AI stopped");
}

/* ---------- VAD main loop ---------- */
async function startVADLoop() {
  if (vadLoopRunning) return;
  vadLoopRunning = true;

  vadState = "idle";
  lastVoiceTime = performance.now();
  speechStartTime = 0;

  renderStatus();
  setInterim("");

  const loop = async () => {
    if (!isCalling) {
      vadLoopRunning = false;
      return;
    }

    const energy = getMicEnergy();
    const now = performance.now();
    const thr = computeAdaptiveThreshold();

    // Hysteresis thresholds
    const startThr = thr * VAD_START_MULT;
    const contThr = thr * VAD_CONT_MULT;

    // If AI is speaking and audio is ON, do NOT start recording from echo.
    // We only allow a barge-in if voice is sustained and clearly louder than threshold.
    const allowVADStart = !(isPlayingAI && !audioMuted);

    if (vadState === "idle" && !micMuted) {
      if (allowVADStart) maybeUpdateNoiseFloor(energy, now);
    }

    const isVoiceStart = !micMuted && energy > startThr;
    const isVoiceCont = !micMuted && energy > contThr;

    // BARGE-IN: only when AI speaking
    if (isPlayingAI && !micMuted) {
      const canBarge = (now - aiSpeechStart) > BARGE_COOLDOWN_MS;
      const isLoudVoice = energy > (thr * BARGE_EXTRA_MULT);

      if (canBarge && isLoudVoice) {
        if (!bargeVoiceStart) bargeVoiceStart = now;
        if ((now - bargeVoiceStart) >= BARGE_MIN_HOLD_MS) {
          stopAIForBargeIn();
          bargeVoiceStart = 0;
        }
      } else {
        bargeVoiceStart = 0;
      }
    } else {
      bargeVoiceStart = 0;
    }

    if (vadState === "idle") {
      if (allowVADStart && isVoiceStart) {
        vadState = "speaking";
        speechStartTime = now;
        lastVoiceTime = now;

        stopRing();
        await startRecordingTurn();
        if (!isCalling) { vadLoopRunning = false; return; }

        setInterim("Speaking…");
        renderStatus();
      }
    } else if (vadState === "speaking") {
      if (isVoiceCont) {
        lastVoiceTime = now;
        setInterim("Speaking…");
      } else {
        const silenceFor = now - lastVoiceTime;
        const speechLen = now - speechStartTime;
        setInterim("…");

        if (silenceFor >= VAD_SILENCE_MS) {
          vadState = "idle";
          setInterim("");

          await stopRecordingTurn();
          if (!isCalling) { vadLoopRunning = false; return; }

          if (speechLen < VAD_MIN_SPEECH_MS) {
            recordChunks = [];
            renderStatus();
          } else {
            const transcript = await transcribeTurn();
            if (!isCalling) { vadLoopRunning = false; return; }

            if (!transcript) {
              setTransientStatus("Didn’t catch that. Try again…", 1400);
            } else {
              queueMergedSend(transcript);
            }
          }

          lastVoiceTime = now;
        }
      }
    }

    if (debugOn) {
      setDebugText(
        `state=${vadState}  calling=${isCalling}  rec=${isRecording}\n` +
        `AI=${isPlayingAI}  micMuted=${micMuted}  audioMuted=${audioMuted}\n` +
        `energy=${energy.toFixed(4)}  noise=${noiseFloor.toFixed(4)}  thr=${thr.toFixed(4)}\n` +
        `turnQ=${pendingUserTurns.length}  ttsQ=${ttsQueue.length}  epoch=${playbackEpoch}`
      );
    }

    requestAnimationFrame(loop);
  };

  loop();
}

/* ---------- RING CANVAS ---------- */
let ringCtx = null;
let ringRAF = null;

function setupRingCanvas() {
  if (!voiceRing) return;
  ringCtx = voiceRing.getContext("2d");
  resizeRing();
  window.addEventListener("resize", resizeRing);
}

function resizeRing() {
  if (!voiceRing) return;
  ringCtx ||= voiceRing.getContext("2d");
  if (!ringCtx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = voiceRing.getBoundingClientRect();

  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));

  voiceRing.width = Math.floor(w * dpr);
  voiceRing.height = Math.floor(h * dpr);
  ringCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function getAILevel() {
  if (!playbackAnalyser || !playbackData) return 0;
  playbackAnalyser.getByteTimeDomainData(playbackData);
  return rmsFromTimeDomain(playbackData);
}

function drawRings() {
  if (!ringCtx || !voiceRing) return;

  const rect = voiceRing.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const cx = w / 2;
  const cy = h / 2;

  ringCtx.clearRect(0, 0, w, h);

  const t = performance.now() / 1000;

  const micLevel = getMicEnergy();
  const aiLevel = getAILevel();

  const micAmp = Math.min(1, micLevel / 0.12);
  const aiAmp = Math.min(1, aiLevel / 0.12);

  const baseR = Math.min(w, h) * 0.32;

  const userPulse = baseR + micAmp * (baseR * 0.18) + Math.sin(t * 3.2) * 2;
  drawGlowRing(cx, cy, userPulse, micAmp, true);

  const aiPulse = baseR + (baseR * 0.12) + aiAmp * (baseR * 0.22) + Math.sin(t * 2.1) * 2;
  drawGlowRing(cx, cy, aiPulse, aiAmp, false);

  ringRAF = requestAnimationFrame(drawRings);
}

function drawGlowRing(cx, cy, r, amp, isUser) {
  const ctx = ringCtx;
  const glow = 12 + amp * 22;
  const line = 6 + amp * 6;

  const g = ctx.createRadialGradient(cx, cy, r - 20, cx, cy, r + 40);
  if (isUser) {
    g.addColorStop(0, `rgba(120, 170, 255, ${0.15 + amp * 0.35})`);
    g.addColorStop(1, `rgba(120, 170, 255, 0)`);
  } else {
    g.addColorStop(0, `rgba(255, 200, 120, ${0.15 + amp * 0.35})`);
    g.addColorStop(1, `rgba(255, 200, 120, 0)`);
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);

  ctx.strokeStyle = isUser
    ? `rgba(120, 170, 255, ${0.35 + amp * 0.65})`
    : `rgba(255, 200, 120, ${0.35 + amp * 0.65})`;

  ctx.lineWidth = line;
  ctx.shadowBlur = glow;
  ctx.shadowColor = isUser
    ? `rgba(120, 170, 255, ${0.55 + amp * 0.45})`
    : `rgba(255, 200, 120, ${0.55 + amp * 0.45})`;

  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = g;
  ctx.lineWidth = line * 2.2;
  ctx.globalAlpha = 0.9;
  ctx.stroke();

  ctx.restore();
}

/* ---------- Timer ---------- */
function startTimer() {
  callStartTs = performance.now();

  const tick = () => {
    if (!isCalling) return;

    const elapsed = Math.max(0, performance.now() - callStartTs);
    const s = Math.floor(elapsed / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");

    if (callTimerEl) callTimerEl.textContent = `${mm}:${ss}`;
    timerRAF = requestAnimationFrame(tick);
  };

  tick();
}

function stopTimer() {
  try { if (timerRAF) cancelAnimationFrame(timerRAF); } catch {}
  timerRAF = null;
  if (callTimerEl) callTimerEl.textContent = "00:00";
}

/* ---------- Call controls ---------- */
callBtn?.addEventListener("click", async () => {
  await unlockAudioSystem(); // must be user gesture
  if (!isCalling) startCall();
  else endCall();
});

async function startCall() {
  isCalling = true;
  pausedInBackground = false;
  hideAudioResumeOverlay();
  clearTranscript();

  callBtn?.classList.add("call-active");
  callBtn?.setAttribute("aria-pressed", "true");
  if (callLabelEl) callLabelEl.textContent = "End Call";

  pendingUserTurns.length = 0;
  drainingTurns = false;

  greetingDone = false;
  ringPlayed = false;

  lastUserSentText = "";
  lastUserSentAt = 0;

  try { transcribeAbort?.abort(); } catch {}
  try { coachAbort?.abort(); } catch {}
  transcribeAbort = null;
  coachAbort = null;

  isTranscribing = false;
  isThinking = false;
  isMerging = false;

  startTimer();
  renderStatus();

  await playRingOnceOnConnect();

  try {
    await setupVAD();
    setupRingCanvas();
    if (!ringRAF) drawRings();

    // ring -> greeting (guaranteed)
    await playGreetingOnce();

    renderStatus();
    await startVADLoop();
  } catch (e) {
    warn("startCall error", e);
    setTransientStatus("Mic permission denied.", 2200);
    endCall();
  }
}

function closeAudioContexts() {
  try { vadSource?.disconnect(); } catch {}
  try { vadAnalyser?.disconnect?.(); } catch {}
  vadSource = null;
  vadAnalyser = null;
  vadData = null;

  try { vadAC?.close?.(); } catch {}
  vadAC = null;

  // Playback context (optional but recommended to avoid iOS leaks)
  try { playbackAnalyser?.disconnect?.(); } catch {}
  playbackAnalyser = null;
  playbackData = null;

  try { playbackAC?.close?.(); } catch {}
  playbackAC = null;
}

function endCall() {
  isCalling = false;
  pausedInBackground = false;
  hideAudioResumeOverlay();

  callBtn?.classList.remove("call-active");
  callBtn?.setAttribute("aria-pressed", "false");
  if (callLabelEl) callLabelEl.textContent = "Start Call";

  stopTimer();

  try { if (mergeTimer) clearTimeout(mergeTimer); } catch {}
  mergeTimer = null;
  mergedTranscriptBuffer = "";
  isMerging = false;

  pendingUserTurns.length = 0;
  drainingTurns = false;

  ttsQueue.length = 0;
  ttsDraining = false;

  try { transcribeAbort?.abort(); } catch {}
  try { coachAbort?.abort(); } catch {}
  transcribeAbort = null;
  coachAbort = null;

  isTranscribing = false;
  isThinking = false;

  stopRing();

  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}
  mediaRecorder = null;
  isRecording = false;
  recordChunks = [];

  try { globalStream?.getTracks().forEach((t) => t.stop()); } catch {}
  globalStream = null;

  try {
    if (ttsPlayer) {
      playbackEpoch++;
      ttsPlayer.pause();
      ttsPlayer.currentTime = 0;
    }
  } catch {}
  isPlayingAI = false;

  closeAudioContexts();

  setStatus("Call ended.");
  setInterim("");
}

/* ---------- Boot ---------- */
ensureSharedAudio();
setAudioMutedUI(audioMuted); // ensure label/icon matches initial state
renderStatus();
log("✅ call.js loaded: AUDIO TOGGLE (iPhone/AirPods-safe) + STATUS FIXES + MIME-CORRECT TRANSCRIBE + QUEUED TTS WHILE MUTED + iOS RESUME OVERLAY + DEBUG HUD (D)");
