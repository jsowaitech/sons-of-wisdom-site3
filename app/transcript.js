// app/transcript.js
// Live transcription viewer for Son of Wisdom calls.
// - Loads call transcript from call_sessions by call_id
// - Renders separate bubbles for user + AI
// - Standalone mode: Supabase Realtime INSERT subscription
// - Embed mode (?embed=1): parent (call.js) streams live text via postMessage (no realtime needed)
// PATCHED:
// ✅ Embed "ready" handshake -> parent can queue messages (prevents missing greeting)
// ✅ Embed-mode message accept is limited to parent window only (safer than "*")
// ✅ Auto-scroll is more robust and turns off when the user scrolls up

import { supabase } from "./supabase.js";

const params = new URLSearchParams(window.location.search);
const isEmbed = params.get("embed") === "1";

const els = {
  list: document.getElementById("turnList"),
  callIdLabel: document.getElementById("callIdLabel"),
  callIdInput: document.getElementById("callIdInput"),
  watchBtn: document.getElementById("watchBtn"),
  copyBtn: document.getElementById("copyBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  liveBadge: document.getElementById("liveBadge"),
  footer: document.querySelector(".ts-footer"),
  autoScrollBtn: document.getElementById("autoScrollBtn"),
  closeBtn: document.getElementById("closeBtn"),
};

let autoScrollEnabled = true;
let currentCallId = "";
let realtimeChannel = null;
const cache = []; // { role, text, ts }
let liveInterimEl = null;

/* ---------- Helpers ---------- */

function fmtTime(input) {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function scrollToBottom() {
  if (!els.list || !autoScrollEnabled) return;
  const el = els.list;
  // Use rAF so layout has settled before we force scroll
  window.requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

function setLive(isLive) {
  if (!els.liveBadge) return;
  els.liveBadge.textContent = isLive ? "LIVE" : "OFFLINE";
  els.liveBadge.classList.toggle("is-live", isLive);
}

function clearUI() {
  if (els.list) els.list.innerHTML = "";
  cache.length = 0;
  if (liveInterimEl && liveInterimEl.parentNode) {
    liveInterimEl.parentNode.removeChild(liveInterimEl);
  }
  liveInterimEl = null;
}

function updateAutoScrollUI() {
  if (!els.autoScrollBtn) return;
  els.autoScrollBtn.classList.toggle("on", autoScrollEnabled);
  els.autoScrollBtn.textContent = autoScrollEnabled
    ? "Auto scroll"
    : "Scroll locked";
}

function typeIntoElement(el, fullText) {
  const text = (fullText || "").toString();
  if (!el) return;

  if (!text.length) {
    el.textContent = "";
    return;
  }

  const minDelay = 8;
  const maxDelay = 24;
  const delay = Math.max(minDelay, Math.min(maxDelay, 1200 / text.length));

  let idx = 0;
  function step() {
    if (idx > text.length) return;
    el.textContent = text.slice(0, idx);
    if (autoScrollEnabled) scrollToBottom();
    if (idx < text.length) {
      idx += 1;
      window.setTimeout(step, delay);
    }
  }
  step();
}

function appendTurn(role, text, ts, { animate = false } = {}) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  if (!els.list) return;

  const article = document.createElement("article");
  article.className = `turn ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "meta";

  const whoSpan = document.createElement("span");
  whoSpan.className = "role";
  whoSpan.textContent = role === "assistant" ? "Blake" : "You";

  const timeSpan = document.createElement("span");
  timeSpan.className = "time";
  timeSpan.textContent = fmtTime(ts);

  meta.appendChild(whoSpan);
  meta.appendChild(timeSpan);

  const textEl = document.createElement("div");
  textEl.className = "text";

  bubble.appendChild(meta);
  bubble.appendChild(textEl);
  article.appendChild(bubble);
  els.list.appendChild(article);

  cache.push({
    role,
    text: trimmed,
    ts: ts instanceof Date ? ts.toISOString() : ts,
  });

  if (animate) typeIntoElement(textEl, trimmed);
  else textEl.textContent = trimmed;

  if (autoScrollEnabled) scrollToBottom();
}

function handleRow(row, { animate = false } = {}) {
  if (!row) return;

  // Prefer created_at; timestamp might not exist in your schema
  const ts = row.created_at || row.timestamp || new Date().toISOString();

  if (row.input_transcript)
    appendTurn("user", row.input_transcript, ts, { animate });
  if (row.ai_text) appendTurn("assistant", row.ai_text, ts, { animate });
}

/* Embed-only interim bubble */
function setLiveInterim(text, role = "user") {
  const trimmed = (text || "").trim();
  if (!els.list) return;

  if (!trimmed) {
    if (liveInterimEl && liveInterimEl.parentNode) {
      liveInterimEl.parentNode.removeChild(liveInterimEl);
    }
    liveInterimEl = null;
    return;
  }

  if (!liveInterimEl) {
    const article = document.createElement("article");
    article.className = `turn ${role} interim`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const meta = document.createElement("div");
    meta.className = "meta";

    const whoSpan = document.createElement("span");
    whoSpan.className = "role";
    whoSpan.textContent = role === "assistant" ? "Blake" : "You";

    const timeSpan = document.createElement("span");
    timeSpan.className = "time";
    timeSpan.textContent = fmtTime(new Date());

    meta.appendChild(whoSpan);
    meta.appendChild(timeSpan);

    const textEl = document.createElement("div");
    textEl.className = "text";
    textEl.textContent = trimmed;

    bubble.appendChild(meta);
    bubble.appendChild(textEl);
    article.appendChild(bubble);
    els.list.appendChild(article);

    liveInterimEl = article;
  } else {
    // If speaker changes mid-interim, swap class + label
    liveInterimEl.className = `turn ${role} interim`;
    const roleEl = liveInterimEl.querySelector(".role");
    if (roleEl) roleEl.textContent = role === "assistant" ? "Blake" : "You";
    const textEl = liveInterimEl.querySelector(".text");
    if (textEl) textEl.textContent = trimmed;
  }

  if (autoScrollEnabled) scrollToBottom();
}

/* ---------- Data: initial load + realtime ---------- */

async function loadInitial(callId) {
  clearUI();
  setLive(false);
  if (!callId) return;

  // IMPORTANT: order by created_at (your table has it; timestamp may not)
  // Also keep timestamp in select just in case, but we do not rely on it.
  const { data, error } = await supabase
    .from("call_sessions")
    .select("call_id, input_transcript, ai_text, created_at, timestamp")
    .eq("call_id", callId)
    .order("created_at", { ascending: true });

  // If schema drifted and call_id column is named differently, attempt fallback.
  if (error) {
    console.warn(
      "[transcript] error loading call_sessions (call_id):",
      error
    );

    const alt = await supabase
      .from("call_sessions")
      .select("callId, input_transcript, ai_text, created_at, timestamp")
      .eq("callId", callId)
      .order("created_at", { ascending: true });

    if (alt.error) {
      console.warn(
        "[transcript] error loading call_sessions (callId):",
        alt.error
      );
      appendTurn(
        "assistant",
        "I wasn't able to load the transcript for this call yet.",
        new Date(),
        { animate: false }
      );
      return;
    }

    (alt.data || []).forEach((row) => handleRow(row, { animate: false }));
    scrollToBottom();
    return;
  }

  (data || []).forEach((row) => handleRow(row, { animate: false }));
  scrollToBottom();
}

function subscribeRealtime(callId) {
  if (realtimeChannel) {
    realtimeChannel.unsubscribe();
    realtimeChannel = null;
  }

  if (!callId) {
    setLive(false);
    return;
  }

  // In embed mode, parent (call.js) drives live updates via postMessage.
  if (isEmbed) {
    setLive(true);
    return;
  }

  // Standalone mode: realtime inserts
  realtimeChannel = supabase
    .channel(`call_sessions_${callId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "call_sessions",
        filter: `call_id=eq.${callId}`,
      },
      (payload) => handleRow(payload.new, { animate: true })
    )
    .subscribe((status) => setLive(status === "SUBSCRIBED"));
}

async function watchCallId(callId) {
  currentCallId = callId || "";
  if (els.callIdInput) els.callIdInput.value = currentCallId;
  if (els.callIdLabel) els.callIdLabel.textContent = currentCallId || "–";

  await loadInitial(currentCallId);
  subscribeRealtime(currentCallId);
}

/* ---------- UX helpers ---------- */

function chooseStartCallId() {
  const fromQuery = params.get("call_id") || params.get("callId");
  if (fromQuery) return fromQuery;

  if (isEmbed) {
    const stored = window.localStorage.getItem("last_call_id");
    if (stored) return stored;
  }

  if (els.callIdInput && els.callIdInput.value.trim()) {
    return els.callIdInput.value.trim();
  }

  const stored = window.localStorage.getItem("last_call_id");
  return stored || "";
}

/* ---------- Event wiring ---------- */

els.watchBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  const id = (els.callIdInput?.value || "").trim();
  if (!id) return;
  watchCallId(id);
});

els.autoScrollBtn?.addEventListener("click", () => {
  autoScrollEnabled = !autoScrollEnabled;
  updateAutoScrollUI();
  if (autoScrollEnabled) scrollToBottom();
});

els.copyBtn?.addEventListener("click", () => {
  if (!cache.length) return;
  const text = cache
    .map((t) => {
      const who = t.role === "assistant" ? "Blake" : "You";
      return `[${fmtTime(t.ts)}] ${who}: ${t.text}`;
    })
    .join("\n");
  if (!text) return;
  window.navigator.clipboard?.writeText(text).catch(() => {});
});

els.downloadBtn?.addEventListener("click", () => {
  if (!cache.length) return;
  const blob = new Blob([JSON.stringify(cache, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sow-transcript-${currentCallId || "call"}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

els.closeBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  if (!isEmbed && window.close) window.close();
  else window.parent?.postMessage?.({ type: "sow-close-transcript" }, "*");
});

// 🔵 When user scrolls manually, toggle auto-scroll based on proximity to bottom
if (els.list) {
  els.list.addEventListener("scroll", () => {
    const el = els.list;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 48;

    if (nearBottom && !autoScrollEnabled) {
      autoScrollEnabled = true;
      updateAutoScrollUI();
    } else if (!nearBottom && autoScrollEnabled) {
      autoScrollEnabled = false;
      updateAutoScrollUI();
    }
  });
}

/* ---------- Embed mode: accept live postMessage from call.js ---------- */

window.addEventListener("message", (event) => {
  // In embed mode, only accept messages from our parent window
  if (isEmbed && event.source !== window.parent) return;

  const data = event.data || {};
  if (data.source && data.source !== "sow-call") return;

  const type = data.type;
  const text = data.text || "";
  const speaker = data.speaker === "assistant" ? "assistant" : "user";
  if (!type) return;

  if (isEmbed) setLive(true);

  switch (type) {
    case "clear":
      clearUI();
      break;
    case "interim":
      setLiveInterim(text, speaker);
      break;
    case "final":
      // clear interim first, then append final
      setLiveInterim("", speaker);
      appendTurn(speaker, text, new Date(), { animate: false });
      break;
    default:
      break;
  }
});

/* ---------- Boot ---------- */

if (isEmbed) {
  document.body.classList.add("embed");
  if (els.footer) els.footer.style.display = "none";
}

updateAutoScrollUI();

const startId = chooseStartCallId();
if (startId) watchCallId(startId);
else {
  clearUI();
  setLive(false);
}

// ✅ Embed ready handshake so parent can flush queued transcript events (prevents missing greeting)
if (isEmbed) {
  try {
    window.parent?.postMessage?.(
      { source: "sow-transcript", type: "ready" },
      "*"
    );
  } catch {
    // ignore
  }
}

console.log("[SOW] transcript.js ready");
