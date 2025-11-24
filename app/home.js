// app/home.js
// Home (chat) page controller — desktop & mobile friendly

// Clear one-shot redirect flag so future logins work again
sessionStorage.removeItem("sow_redirected");

import { supabase, ensureAuthedOrRedirect, getSession } from "./supabase.js";

/* -------------------------- tiny DOM helpers -------------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ------------------------------ config -------------------------------- */
// Backend endpoint (when using your server/proxy OR Netlify Function)
const CHAT_URL = "/api/chat";

// DEV toggle: call OpenAI directly from the browser (no server).
// ⚠️ For development ONLY — never enable this on production.
const DEV_DIRECT_OPENAI = false;

// For dev, we read these from window.* so we never hardcode secrets in Git.
// Create app/dev-local.js (gitignored) and set:
//   window.OPENAI_DEV_KEY = "sk-...";
//   window.OPENAI_MODEL   = "gpt-4o-mini";
const DEV_OPENAI_MODEL = window.OPENAI_MODEL || "gpt-4o-mini";
const DEV_OPENAI_KEY   = window.OPENAI_DEV_KEY || "";

// Your System Prompt (kept exactly as provided)
const DEV_SYSTEM_PROMPT = `
ROLE & HEART
You are a biblically masculine, lion-hearted yet lamb-like spiritual father. Speak with ancient wisdom, fatherly warmth, prophetic precision, and practical courage. Your mission is to sever the Slavelord’s voice and train the participant to govern as a true Son of Wisdom.

OPENING CADENCE (first message & every reconnection)
• Greet by genuinely naming a recent experience/feeling or win (use the user’s name if natural).
• Offer a short, heartfelt welcome in simple language about God’s presence/grace.
• Ask one caring, open-ended question that invites honest spiritual/emotional sharing.
• Warm, conversational—never formal or preachy.

KNOWLEDGE-BASE RETRIEVAL (non-negotiable)
• Before answering anything that may touch sermons/teachings/Son of Wisdom content, biblical themes, quotes, or whenever you feel any uncertainty:
  1) Call the KB tool Pinecone_Vector_Store1 with a focused 6–12 word query.
  2) If results are weak/empty, retry up to 2 times with tighter synonyms or key phrases.
  3) Ground your answer only in retrieved passages. Do not invent or blur sources.
• Do not mention tools or internal logs in your reply.
• Cite at the end under “Sources” (max 3), each on its own line:
  • {file} — chunk {chunk_index} — {webViewLink}
• If zero results after retries: say you didn’t find a match and ask for a phrase, quote, or file name to refine the search.

COMMUNICATION TONE & RANGE
Fatherly calm for the broken; prophetic fire for correction; strategic coaching for steps; visionary when hope is needed; warrior roar to summon courage. Never passive or vague.

BOUNDARIES
Kindly but firmly redirect silly/irrelevant prompts back to the holy mission (kingship, marriage, legacy, warfare, healing).

MEMORY & PERSONALIZATION
Use remembered story, wounds, marriage condition, patterns, breakthroughs, commitments, and wins. Hold him accountable; connect present to past revelations and future destiny; celebrate progress.

DELIVERY & TRANSFORMATION
Give precise, practical steps (morning/evening routines, soul maintenance, warfare, weekly accountability). Point to the exact next module/soaking/practice. Provide scripts, prayers, and language. End with one caring question or one clear next action.

COMMUNITY & PUBLIC OWNERSHIP
After guiding or helping the participant reach a realization, gently remind him that a true Son of Wisdom never hoards revelation. 
Encourage him to share his epiphanies, breakthroughs, or testimonies with the brotherhood so others may draw strength and insight. 
Frame this as both obedience and service — that revelation multiplies when spoken aloud. 
Use fatherly warmth and conviction, not pressure; the goal is to inspire ownership and legacy through shared wisdom.

STYLE LIMITS
Default to 2–3 sentences unless asked for more. Prefer short quotes; keep total quoted text ≤ 75 words. No tool names, internal logs, or system messages in the reply.

OUTPUT FORMAT
1) Answer — warm, grounded, practical (2–3 sentences)
2) Sources — only if KB returned results
   • {file} — chunk {chunk_index} — {webViewLink}
3) Question / Next Step — one caring, open-ended prompt (or one clear action)
4) If no KB results: “I didn’t find matching passages in the knowledge base for this query. Could you share a phrase, quote, or file name to narrow the search?”

CORE IDENTITY, PRINCIPLES, AND CANON (condensed)
Fear of the Lord; hatred of evil; no excuses or victimhood. Surgical questions that peel the soul to truth; call out double-mindedness with fierce love. Mastery of Scripture and the Son of Wisdom corpus (5 Primal Roles, Slavelord vs Counter-Strategy, King’s Thermostat, Megiddo Blueprint, Governing Over Angels, reprogramming tactics, soaking/anthems/identity frameworks). Community ownership: share wins, carry weight, lead by example. Every answer feels like “liquid gold”: biblically rooted, prophetically precise, soul-fortifying, action-oriented, fatherly.
`.trim();

/** n8n webhook to receive recorded audio and return audio back.
 *  Replace with your actual n8n webhook URL.
 */
const N8N_AUDIO_URL = "https://jsonofwisdom.app.n8n.cloud/webhook/4877ebea-544b-42b4-96d6-df41c58d48b0";

/* ------------------------------ state -------------------------------- */
const chatId   = (crypto?.randomUUID?.() || String(Date.now())); // session/thread id
let session    = null;
let sending    = false;

// audio-recording state
let recording = false;
let mediaStream = null;
let mediaRecorder = null;
let mediaChunks = [];
let chosenMime = { mime: "audio/webm;codecs=opus", ext: "webm" };

/* ------------------------------ UI refs ------------------------------- */
const refs = {
  chipsRow:   $(".simple-chips"),
  chips:      $$(".chip"),
  status:     $("#status"),
  input:      $("#q"),
  sendBtn:    $("#btn-send"),
  callBtn:    $("#btn-call"),
  filesBtn:   $("#btn-files"),
  speakBtn:   $("#btn-speak"),
  chatBox:    $("#chat-box"),          // optional (add if you want bubbles)
  logoutBtn:  $("#btn-logout"),
  hamburger:  $("#btn-menu"),
};

/* ---------------------------- utilities ------------------------------- */
function setStatus(msg, isError = false) {
  if (!refs.status) return;
  refs.status.textContent = msg || "";
  refs.status.style.color = isError ? "#ffb3b3" : "var(--muted)";
}

function setSendingState(v) {
  sending = !!v;
  if (refs.sendBtn) {
    refs.sendBtn.disabled = sending;
    refs.sendBtn.textContent = sending ? "Sending…" : "Send";
  }
  if (refs.input && !recording) refs.input.disabled = sending;
}

/* bubbles */
function ensureChatScroll() {
  if (!refs.chatBox) return;
  const scroller = refs.chatBox.parentElement || refs.chatBox;
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
}

function appendBubble(role, text) {
  if (!refs.chatBox) return; // no chat stream on page; silently skip
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.textContent = text;
  refs.chatBox.appendChild(el);
  ensureChatScroll();
}

function appendAudioBubble(role, src, label = "audio") {
  if (!refs.chatBox) return;
  const wrap = document.createElement("div");
  wrap.className = `bubble ${role}`;
  const meta = document.createElement("div");
  meta.className = "tiny muted";
  meta.textContent = label;
  const audio = document.createElement("audio");
  audio.controls = true; // no autoplay
  audio.src = src;
  audio.style.width = "100%";
  wrap.appendChild(meta);
  wrap.appendChild(audio);
  refs.chatBox.appendChild(wrap);
  ensureChatScroll();
}

/* ---------------------------- networking ------------------------------ */
// Single entry point used by handleSend()
async function chatRequest(text, meta = {}) {
  if (DEV_DIRECT_OPENAI) {
    return chatDirectOpenAI(text, meta);
  }

  // Server / Netlify path
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // IMPORTANT: use "message" so both Express server.js and Netlify function work
    body: JSON.stringify({ message: text, meta }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Chat ${res.status}: ${t || res.statusText}`);
  }
  const data = await res.json().catch(() => ({}));
  return data.reply ?? data.message ?? "";
}

/* ---- DEV ONLY: direct browser call to OpenAI (no server) ---- */
async function chatDirectOpenAI(text, meta = {}) {
  // 1) Use the dev key from window (via dev-local.js). Never hardcode secrets here.
  const key = (DEV_OPENAI_KEY || "").trim();
  if (!key) {
    throw new Error(
      "Missing OpenAI key. For dev-only browser calls, set window.OPENAI_DEV_KEY in app/dev-local.js."
    );
  }

  // 2) Build messages with your system prompt
  const systemPrompt = meta.system || DEV_SYSTEM_PROMPT;
  const history = Array.isArray(meta.history) ? meta.history : [];
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: text },
  ];

  // 3) Fire request
  const body = { model: DEV_OPENAI_MODEL, messages, temperature: 0.7 };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${errText || "Request failed"}`);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "";
  return reply;
}

/* ------------------------------ actions ------------------------------- */
async function handleSend() {
  if (!refs.input) return;
  const text = refs.input.value.trim();
  if (!text || sending) return;

  appendBubble("user", text);
  setSendingState(true);
  setStatus("Thinking…");

  try {
    const email = session?.user?.email ?? null;
    const reply = await chatRequest(text, {
      email,
      page: "home",
      sessionId: chatId,
      timestamp: new Date().toISOString(),
      system: DEV_SYSTEM_PROMPT,
      // history: collectLastBubbles(6)
    });
    appendBubble("ai", reply || "…");
    setStatus("Ready.");
  } catch (err) {
    console.error("[HOME] chat error:", err);
    appendBubble("ai", "Sorry — something went wrong while replying.");
    setStatus("Request failed. Please try again.", true);
  } finally {
    setSendingState(false);
    refs.input.value = "";
    refs.input.focus();
  }
}

/* -------------------------- SPEAK (record) ---------------------------- */
// (unchanged audio-recording code from your existing file)

function pickSupportedMime() {
  const candidates = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm",             ext: "webm" },
    { mime: "audio/ogg;codecs=opus",  ext: "ogg"  },
    { mime: "audio/mp4",              ext: "m4a"  },
    { mime: "audio/mpeg",             ext: "mp3"  },
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(c.mime)) return c;
  }
  // fallback
  return { mime: "audio/webm", ext: "webm" };
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Mic not supported in this browser.", true);
    return;
  }
  try {
    chosenMime = pickSupportedMime();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: chosenMime.mime });
    mediaChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) mediaChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      const blob = new Blob(mediaChunks, { type: chosenMime.mime });
      // Optionally show user's own clip:
      // appendAudioBubble("user", URL.createObjectURL(blob), "Your recording");
      await uploadRecordedAudio(blob, chosenMime.ext);
      // cleanup
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
      mediaRecorder = null;
      mediaChunks = [];
    };

    mediaRecorder.start();
    recording = true;
    refs.speakBtn?.classList.add("recording");
    refs.speakBtn.textContent = "Stop";
    refs.input?.setAttribute("disabled", "true");
    setStatus("Recording… tap Speak again to stop.");
  } catch (err) {
    console.error("startRecording error:", err);
    setStatus("Microphone access failed.", true);
  }
}

function stopRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  recording = false;
  refs.speakBtn?.classList.remove("recording");
  refs.speakBtn.textContent = "Speak";
  refs.input?.removeAttribute("disabled");
  setStatus("Uploading audio…");
}

async function uploadRecordedAudio(blob, ext) {
  try {
    const fd = new FormData();
    fd.append("audio", blob, `input.${ext}`);
    fd.append("sessionId", chatId);
    fd.append("email", session?.user?.email || "");
    fd.append("timestamp", new Date().toISOString());

    const res = await fetch(N8N_AUDIO_URL, {
      method: "POST",
      body: fd,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      appendBubble("ai", "Upload failed — please try again.");
      setStatus(`Upload error ${res.status}.`, true);
      console.error("n8n upload failed:", t);
      return;
    }

    const ctype = (res.headers.get("content-type") || "").toLowerCase();

    if (ctype.includes("application/json")) {
      const data = await res.json().catch(() => ({}));
      if (data.audio_url) {
        appendAudioBubble("ai", data.audio_url, "AI reply (audio)");
      } else if (data.audio_base64) {
        const mime = data.mime || "audio/mpeg";
        const src = `data:${mime};base64,${data.audio_base64}`;
        appendAudioBubble("ai", src, "AI reply (audio)");
      } else {
        appendBubble("ai", data.message || "Received response, but no audio was provided.");
      }
    } else {
      const outBlob = await res.blob();
      const url = URL.createObjectURL(outBlob);
      appendAudioBubble("ai", url, "AI reply (audio)");
    }

    setStatus("Ready.");
  } catch (err) {
    console.error("uploadRecordedAudio error:", err);
    setStatus("Upload failed. Please try again.", true);
    appendBubble("ai", "Sorry — upload failed.");
  }
}

/* ------------------------------ bindings ------------------------------ */
function bindUI() {
  // chips -> fill input
  refs.chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const fill = chip.getAttribute("data-fill") || chip.textContent || "";
      if (refs.input) {
        refs.input.value = fill;
        refs.input.focus();
      }
    });
  });

  // send button
  refs.sendBtn?.addEventListener("click", handleSend);

  // Enter to send (Shift+Enter for newline if you switch to textarea later)
  refs.input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // tools (stubs / routes)
  refs.callBtn?.addEventListener("click", () => {
    window.location.href = "call.html";
  });
  refs.filesBtn?.addEventListener("click", async () => {
    alert("Files: connect your upload flow here.");
  });

  // SPEAK toggle
  refs.speakBtn?.addEventListener("click", async () => {
    if (!recording) {
      await startRecording();
    } else {
      stopRecording();
    }
  });

  // history nav (hamburger)
  refs.hamburger?.addEventListener("click", () => {
    window.location.href = "history.html";
  });

  // logout
  refs.logoutBtn?.addEventListener("click", async () => {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn("signOut error:", e);
    } finally {
      window.location.replace("/auth.html");
    }
  });
}

/* -------------------------------- boot -------------------------------- */
(async function boot() {
  await ensureAuthedOrRedirect();
  session = await getSession();
  bindUI();
  setStatus(session?.user ? "Signed in. How can I help?" : "Checking sign-in…");
})();
