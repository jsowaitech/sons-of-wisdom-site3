// app/call.js
// Son of Wisdom — Call mode (Phone-call pace)
// Free Talk + Frontend Adaptive VAD + Barge-in (debounced) + Turn Merge + Premium Rings + ring.mp3 once
//
// Endpoints:
//   - /.netlify/functions/openai-transcribe  (audio -> transcript)
//   - /.netlify/functions/call-coach         (transcript -> AI text + TTS audio)
//
// Key behavior:
//   - Records ONLY when user speaks
//   - Ends a turn after “phone-call” silence pacing (slower than before)
//   - Merges turns if user pauses briefly and continues
//   - Barge-in only triggers on sustained, clearly-above-noise speech (less sensitive)
//   - ring.mp3 plays once on connect, never overlaps AI playback
//   - User ring reacts to mic energy; AI ring reacts to playback energy
//   - iOS Safari hardened (unlock on Start Call tap; single shared audio player)

const DEBUG = true;
const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);

/* ---------- ENDPOINTS ---------- */
const CALL_COACH_ENDPOINT = "/.netlify/functions/call-coach";
const TRANSCRIBE_ENDPOINT = "/.netlify/functions/openai-transcribe";

/* ---------- TRANSCRIBE MODEL ---------- */
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
// const TRANSCRIBE_MODEL = "whisper-1";

/* ---------- URL PARAMS ---------- */
const urlParams = new URLSearchParams(window.location.search);
const conversationId = urlParams.get("c") || null;

/* ---------- DOM ---------- */
const callBtn = document.getElementById("call-btn");
const statusText = document.getElementById("status-text");
const micBtn = document.getElementById("mic-btn");
const speakerBtn = document.getElementById("speaker-btn");
const modeBtn = document.getElementById("mode-btn");

const transcriptList = document.getElementById("transcriptList");
const transcriptInterim = document.getElementById("transcriptInterim");

const clearBtn = document.getElementById("ts-clear");
const autoscrollBtn = document.getElementById("ts-autoscroll");

const voiceRing = document.getElementById("voiceRing");

/* ---------- STATE ---------- */
let isCalling = false;
let isRecording = false;
let isPlayingAI = false;

let micMuted = false;
let speakerMuted = false;

let autoScroll = true;
let lastFinalLine = "";

/* merge buffer */
let mergedTranscriptBuffer = "";
let mergeTimer = null;

/* audio recording */
let globalStream = null;
let mediaRecorder = null;
let recordChunks = [];

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
let noiseFloor = 0.01;
let noiseSamples = 0;
let lastNoiseUpdate = 0;

/* ---------- PHONE-CALL PACE (tuned) ---------- */
// Ends turn slower (prevents cutting user off)
const VAD_SILENCE_MS = 1500;          // was ~850 (too aggressive)
const VAD_MIN_SPEECH_MS = 320;        // ignore tiny blips
const VAD_MERGE_WINDOW_MS = 1700;     // pause window to merge (more natural)
const VAD_IDLE_TIMEOUT_MS = 25000;    // keep loop alive

// Require sustained silence before stopping (hangover)
const VAD_STOP_CONFIRM_FRAMES = 12;   // ~12 frames of silence after VAD_SILENCE_MS

/* Adaptive threshold shaping */
const NOISE_FLOOR_UPDATE_MS = 250;
const THRESHOLD_MULTIPLIER = 2.4;     // baseline * multiplier => "voice"
const THRESHOLD_MIN = 0.018;
const THRESHOLD_MAX = 0.085;

/* ---------- BARGE-IN (debounced, less sensitive) ---------- */
const BARGE_IN_HOLD_MS = 180;         // must hold speech this long
const BARGE_IN_MULTIPLIER = 3.4;      // stricter than VAD
const BARGE_IN_MIN_ENERGY = 0.030;    // absolute floor
const BARGE_IN_AI_GRACE_MS = 300;     // ignore first ms of AI playback

let bargeInStart = 0;
let lastAIPlayStartedAt = 0;

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

/* Playback cancel hook (for barge-in + end call) */
let cancelPlaybackNow = null;

/* Abort controllers (for endCall safety) */
let transcribeAbort = null;
let coachAbort = null;

/* ---------- Call SFX: ring.mp3 ---------- */
let ringAudio = null;
let ringPlayed = false;

/* ---------- Helpers ---------- */
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
  mergedTranscriptBuffer = "";
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  if (globalStream) {
    globalStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
  }

  const lbl = document.getElementById("mic-label");
  if (lbl) lbl.textContent = micMuted ? "Unmute" : "Mute";

  setStatus(micMuted ? "Mic muted." : "Mic unmuted.");
});

speakerBtn?.addEventListener("click", () => {
  speakerMuted = !speakerMuted;

  if (ttsPlayer) {
    ttsPlayer.muted = speakerMuted;
    ttsPlayer.volume = speakerMuted ? 0 : 1;
  }

  const lbl = document.getElementById("speaker-label");
  if (lbl) lbl.textContent = speakerMuted ? "Speaker Off" : "Speaker";

  setStatus(speakerMuted ? "Speaker muted." : "Speaker on.");
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
  ttsPlayer.muted = speakerMuted;
  ttsPlayer.volume = speakerMuted ? 0 : 1;

  return ttsPlayer;
}

async function unlockAudioSystem() {
  try {
    ensureSharedAudio();

    playbackAC ||= new (window.AudioContext || window.webkitAudioContext)();
    if (playbackAC.state === "suspended") {
      await playbackAC.resume().catch(() => {});
    }

    // Setup playback analyser once (AI ring)
    if (!playbackAnalyser) {
      const src = playbackAC.createMediaElementSource(ttsPlayer);
      playbackAnalyser = playbackAC.createAnalyser();
      playbackAnalyser.fftSize = 1024;
      playbackData = new Uint8Array(playbackAnalyser.fftSize);

      src.connect(playbackAnalyser);
      playbackAnalyser.connect(playbackAC.destination);
    }

    // iOS gesture unlock
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

/* ---------- ring.mp3 SFX (plays ONCE) ---------- */
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

/* ---------- Mic stream ---------- */
async function ensureMicStream() {
  if (globalStream) return globalStream;

  globalStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  // apply mute immediately if needed
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

  // reset adaptive stats
  noiseFloor = 0.01;
  noiseSamples = 0;
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

function getAILevel() {
  if (!playbackAnalyser || !playbackData) return 0;
  playbackAnalyser.getByteTimeDomainData(playbackData);
  return rmsFromTimeDomain(playbackData);
}

function computeAdaptiveThreshold() {
  let thr = noiseFloor * THRESHOLD_MULTIPLIER;
  if (!Number.isFinite(thr)) thr = 0.03;
  thr = Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, thr));
  return thr;
}

function maybeUpdateNoiseFloor(energy, now) {
  // update baseline only periodically and only while not speaking / not recording
  if (now - lastNoiseUpdate < NOISE_FLOOR_UPDATE_MS) return;
  lastNoiseUpdate = now;

  // ignore spikes
  const capped = Math.min(energy, noiseFloor * 3 + 0.01);

  if (noiseSamples < 1) {
    noiseFloor = capped;
    noiseSamples = 1;
    return;
  }

  const alpha = 0.10;
  noiseFloor = noiseFloor * (1 - alpha) + capped * alpha;
  noiseSamples += 1;

  noiseFloor = Math.max(0.004, Math.min(0.05, noiseFloor));
}

/* ---------- Playback cancellation ---------- */
function cancelAnyPlayback() {
  try {
    if (typeof cancelPlaybackNow === "function") cancelPlaybackNow("cancel");
  } catch {}
  cancelPlaybackNow = null;
}

/* ---------- BARGE-IN (debounced) ---------- */
function stopAIPlaybackForBargeIn() {
  if (!ttsPlayer) return;
  if (!isPlayingAI) return;

  try {
    cancelAnyPlayback(); // resolves playback promise immediately

    ttsPlayer.pause();
    ttsPlayer.currentTime = 0;
  } catch {}

  isPlayingAI = false;
  setStatus("Listening…");
  log("🛑 Barge-in: AI stopped");
}

/* ---------- RECORD TURN CONTROL ---------- */
async function startRecordingTurn() {
  if (isRecording) return;
  const stream = await ensureMicStream();
  const mimeType = pickSupportedMime();

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

async function stopRecordingTurn() {
  if (!isRecording || !mediaRecorder) return;

  try {
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}

  while (isRecording) await sleep(25);

  mediaRecorder = null;
}

/* ---------- Transcribe audio -> text ---------- */
async function transcribeTurn() {
  if (!recordChunks.length) return "";

  setStatus("Transcribing…");

  try { transcribeAbort?.abort(); } catch {}
  transcribeAbort = new AbortController();

  try {
    const blob = new Blob(recordChunks, { type: "audio/webm" });

    const fd = new FormData();
    fd.append("file", blob, "user.webm");
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
    return (data?.text || data?.transcript || data?.utterance || "").toString().trim();
  } catch (e) {
    if (e?.name === "AbortError") return "";
    warn("transcribeTurn error", e);
    return "";
  } finally {
    transcribeAbort = null;
  }
}

/* ---------- Merge logic ---------- */
function queueMergedSend(transcript) {
  if (!transcript) return;

  mergedTranscriptBuffer = mergedTranscriptBuffer
    ? `${mergedTranscriptBuffer} ${transcript}`.trim()
    : transcript.trim();

  setInterim("Paused… (merging)");

  if (mergeTimer) clearTimeout(mergeTimer);

  mergeTimer = setTimeout(async () => {
    mergeTimer = null;

    const final = mergedTranscriptBuffer.trim();
    mergedTranscriptBuffer = "";
    setInterim("");

    if (!final) return;
    if (!isCalling) return;

    addFinalLine("You: " + final);
    await sendTranscriptToCoachAndPlay(final);
  }, VAD_MERGE_WINDOW_MS);
}

/* ---------- Send transcript -> AI -> play ---------- */
async function sendTranscriptToCoachAndPlay(transcript) {
  const text = (transcript || "").trim();
  if (!text) return false;
  if (!isCalling) return false;

  setStatus("Thinking…");

  try { coachAbort?.abort(); } catch {}
  coachAbort = new AbortController();

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

    const replyText = (data?.assistant_text || data?.text || "").trim();
    if (replyText) addFinalLine("AI: " + replyText);

    const b64 = data?.audio_base64;
    const mime = data?.mime || "audio/mpeg";

    if (!b64) {
      setStatus("No audio reply returned.");
      return false;
    }

    if (speakerMuted) {
      setStatus("Listening…");
      return true;
    }

    // Ensure ring never overlaps AI speaking
    stopRing();

    // If something is still playing, cancel it (prevents “skip”/stale playback states)
    cancelAnyPlayback();

    // Play AI
    isPlayingAI = true;
    setStatus("AI replying…");
    lastAIPlayStartedAt = performance.now();
    bargeInStart = 0;

    const ok = await playViaSharedPlayerFromBase64(b64, mime);

    isPlayingAI = false;
    if (!isCalling) return ok;

    setStatus("Listening…");
    return ok;
  } catch (e) {
    if (e?.name === "AbortError") return false;
    warn("sendTranscriptToCoachAndPlay error", e);
    isPlayingAI = false;
    if (isCalling) setStatus("Network error.");
    return false;
  } finally {
    coachAbort = null;
  }
}

/* ---------- Playback base64 (cancelable) ---------- */
function playViaSharedPlayerFromBase64(b64, mime = "audio/mpeg", limitMs = 35000) {
  return new Promise((resolve) => {
    const a = ensureSharedAudio();
    let done = false;

    const blobUrl = (() => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: mime });
      return URL.createObjectURL(blob);
    })();

    const cleanup = () => {
      try { URL.revokeObjectURL(blobUrl); } catch {}
      a.onended = a.onerror = a.onabort = null;
      cancelPlaybackNow = null;
    };

    const settle = (ok) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(ok);
    };

    cancelPlaybackNow = () => {
      try { a.pause(); } catch {}
      try { a.currentTime = 0; } catch {}
      settle(true);
    };

    try { a.pause(); } catch {}
    a.src = blobUrl;
    a.muted = speakerMuted;
    a.volume = speakerMuted ? 0 : 1;

    a.onerror = () => settle(false);
    a.onabort = () => settle(false);

    const t = setTimeout(() => settle(false), limitMs);

    a.onended = () => {
      clearTimeout(t);
      settle(true);
    };

    a.play().catch(() => {
      clearTimeout(t);
      settle(false);
    });
  });
}

/* ---------- RINGS (premium) ---------- */
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
  const rect = voiceRing.getBoundingClientRect();
  voiceRing.width = Math.floor(rect.width * devicePixelRatio);
  voiceRing.height = Math.floor(rect.height * devicePixelRatio);
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

function drawRings() {
  if (!ringCtx || !voiceRing) return;

  const w = voiceRing.width;
  const h = voiceRing.height;
  const cx = w / 2;
  const cy = h / 2;

  ringCtx.clearRect(0, 0, w, h);

  const t = performance.now() / 1000;

  const micLevel = getMicEnergy();
  const aiLevel = getAILevel();

  const micAmp = Math.min(1, micLevel / 0.12);
  const aiAmp = Math.min(1, aiLevel / 0.12);

  const baseR = Math.min(w, h) * 0.32;

  // USER ring
  const userPulse = baseR + micAmp * (baseR * 0.18) + Math.sin(t * 3.2) * 2;
  drawGlowRing(cx, cy, userPulse, micAmp, true);

  // AI ring
  const aiPulse = baseR + (baseR * 0.12) + aiAmp * (baseR * 0.22) + Math.sin(t * 2.1) * 2;
  drawGlowRing(cx, cy, aiPulse, aiAmp, false);

  ringRAF = requestAnimationFrame(drawRings);
}

/* ---------- VAD main loop ---------- */
async function startVADLoop() {
  if (vadLoopRunning) return;
  vadLoopRunning = true;

  let silenceFrames = 0;

  vadState = "idle";
  lastVoiceTime = performance.now();
  speechStartTime = 0;

  setStatus("Listening…");
  setInterim("");

  const loop = async () => {
    if (!isCalling) {
      vadLoopRunning = false;
      return;
    }

    const energy = getMicEnergy();
    const now = performance.now();

    // Update noise floor only while idle (not speaking) and not muted
    if (vadState === "idle" && !micMuted) {
      maybeUpdateNoiseFloor(energy, now);
    }

    const threshold = computeAdaptiveThreshold();
    const isVoice = !micMuted && energy > threshold;

    // --- BARGE-IN debounce (less sensitive) ---
    if (isPlayingAI) {
      const sinceAI = now - lastAIPlayStartedAt;

      const bargeThreshold = Math.max(
        BARGE_IN_MIN_ENERGY,
        noiseFloor * BARGE_IN_MULTIPLIER
      );

      const bargeVoice = !micMuted && energy > bargeThreshold;

      if (sinceAI < BARGE_IN_AI_GRACE_MS) {
        bargeInStart = 0;
      } else if (bargeVoice) {
        if (!bargeInStart) bargeInStart = now;
        if (now - bargeInStart >= BARGE_IN_HOLD_MS) {
          bargeInStart = 0;
          stopAIPlaybackForBargeIn();
        }
      } else {
        bargeInStart = 0;
      }
    } else {
      bargeInStart = 0;
    }

    if (vadState === "idle") {
      if (isVoice) {
        vadState = "speaking";
        speechStartTime = now;
        lastVoiceTime = now;
        silenceFrames = 0;

        // Stop ring once user begins speaking
        stopRing();

        await startRecordingTurn();
        if (!isCalling) { vadLoopRunning = false; return; }

        setStatus("Listening…");
        setInterim("Speaking…");
      } else {
        if (now - lastVoiceTime > VAD_IDLE_TIMEOUT_MS) {
          lastVoiceTime = now;
        }
      }
    } else if (vadState === "speaking") {
      if (isVoice) {
        lastVoiceTime = now;
        silenceFrames = 0;
        setInterim("Speaking…");
      } else {
        const silenceFor = now - lastVoiceTime;
        const speechLen = now - speechStartTime;

        setInterim("…");

        // Hangover stop confirmation:
        // only start counting frames AFTER we cross the main silence window
        if (silenceFor >= VAD_SILENCE_MS) silenceFrames++;
        else silenceFrames = 0;

        if (silenceFrames >= VAD_STOP_CONFIRM_FRAMES) {
          silenceFrames = 0;
          vadState = "idle";
          setInterim("");

          await stopRecordingTurn();
          if (!isCalling) { vadLoopRunning = false; return; }

          if (speechLen < VAD_MIN_SPEECH_MS) {
            recordChunks = [];
            setStatus("Listening…");
          } else {
            const transcript = await transcribeTurn();
            if (!isCalling) { vadLoopRunning = false; return; }

            if (!transcript) {
              setStatus("Didn’t catch that. Try again…");
            } else {
              queueMergedSend(transcript);
            }
          }

          lastVoiceTime = now;
        }
      }
    }

    requestAnimationFrame(loop);
  };

  loop();
}

/* ---------- Call controls ---------- */
callBtn?.addEventListener("click", async () => {
  await unlockAudioSystem();
  if (!isCalling) startCall();
  else endCall();
});

async function startCall() {
  isCalling = true;
  clearTranscript();
  setStatus("Connecting…");

  // reset controllers/timers
  try { transcribeAbort?.abort(); } catch {}
  try { coachAbort?.abort(); } catch {}
  transcribeAbort = null;
  coachAbort = null;

  // cancel playback and ring overlap
  cancelAnyPlayback();
  stopRing();

  ringPlayed = false;
  await playRingOnceOnConnect();

  try {
    await setupVAD();

    if (!voiceRing) warn("voiceRing canvas not found — rings disabled");
    setupRingCanvas();
    if (!ringRAF) drawRings();

    setStatus("Listening…");
    await startVADLoop();
  } catch (e) {
    warn("startCall error", e);
    setStatus("Mic permission denied.");
    endCall();
  }
}

function endCall() {
  isCalling = false;

  // stop merge
  try { if (mergeTimer) clearTimeout(mergeTimer); } catch {}
  mergeTimer = null;
  mergedTranscriptBuffer = "";

  // abort network
  try { transcribeAbort?.abort(); } catch {}
  try { coachAbort?.abort(); } catch {}
  transcribeAbort = null;
  coachAbort = null;

  // stop ring
  stopRing();

  // stop recording
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}
  mediaRecorder = null;
  isRecording = false;
  recordChunks = [];

  // stop mic stream
  try { globalStream?.getTracks().forEach((t) => t.stop()); } catch {}
  globalStream = null;

  // stop AI playback (and resolve promise)
  try { cancelAnyPlayback(); } catch {}
  try {
    if (ttsPlayer) {
      ttsPlayer.pause();
      ttsPlayer.currentTime = 0;
    }
  } catch {}
  isPlayingAI = false;

  setStatus("Call ended.");
  setInterim("");
}

/* ---------- Boot ---------- */
ensureSharedAudio();
setStatus("Tap the blue call button to begin.");
log("✅ call.js loaded: PHONE-CALL PACE + ADAPTIVE VAD + MERGE + DEBOUNCED BARGE-IN + RING + PREMIUM RINGS");
