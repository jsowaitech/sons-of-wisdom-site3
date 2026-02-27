// netlify/functions/call-greeting.js
// Son of Wisdom — Dynamic AI greeting (varied + reliable)
// Returns JSON: { text, assistant_text, audio_base64?, mime, call_id, audio_expected, audio_missing?, audio_error? }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ✅ Always prevent caching (important on edge/CDN layers)
const noStoreHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

// Supabase (REST) for logging greeting as a turn (best-effort)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  "";

const CALL_SESSIONS_TABLE = "call_sessions";
const CONVERSATION_MESSAGES_TABLE = "conversation_messages";
const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";

// --------- Utilities ----------
function safeJsonParse(str) {
  try {
    return JSON.parse(str || "{}");
  } catch {
    return {};
  }
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v || ""
  );
}

function pickUuidForHistory(userId) {
  if (!userId) return SENTINEL_UUID;
  if (isUuid(userId)) return userId;
  return SENTINEL_UUID;
}

function randomSeed() {
  return Math.random().toString(36).slice(2) + "-" + Date.now();
}

function withTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

function clampPlainText(s, maxChars = 420) {
  const clean = String(s || "")
    .replace(/[#*_>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars - 1).trim() + "…";
}

// --------- OpenAI ----------
async function openaiChat(messages, opts = {}) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: opts.temperature ?? 0.9,
    presence_penalty: opts.presence_penalty ?? 0.6,
    frequency_penalty: opts.frequency_penalty ?? 0.5,
    max_tokens: opts.maxTokens ?? 120,
  };

  if (opts.user) body.user = opts.user;

  const to = withTimeout(opts.timeoutMs ?? 20000); // ✅ hard timeout
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: to.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`OpenAI chat ${res.status}: ${t || res.statusText}`);
    }

    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  } finally {
    to.clear();
  }
}

// --------- ElevenLabs (optional) ----------
async function elevenLabsTTS(text, opts = {}) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    return { audio_base64: null, mime: "audio/mpeg", error: "Missing ELEVENLABS env vars" };
  }

  const trimmed = String(text || "").trim();
  if (!trimmed) return { audio_base64: null, mime: "audio/mpeg", error: "Empty greeting text" };

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const to = withTimeout(opts.timeoutMs ?? 22000); // ✅ hard timeout
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: trimmed,
        model_id: "eleven_turbo_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
      signal: to.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return {
        audio_base64: null,
        mime: "audio/mpeg",
        error: `ElevenLabs ${res.status}: ${t || res.statusText}`,
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return { audio_base64: buf.toString("base64"), mime: "audio/mpeg", error: null };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "ElevenLabs timeout" : String(e?.message || e);
    return { audio_base64: null, mime: "audio/mpeg", error: msg };
  } finally {
    to.clear();
  }
}

// --------- Supabase best-effort logging ----------
async function supabaseInsert(table, rows) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  const payload = Array.isArray(rows) ? rows : [rows];

  try {
    const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn("[call-greeting] Supabase insert error", table, res.status, t);
    }
  } catch (err) {
    console.warn("[call-greeting] Supabase insert failed", table, err);
  }
}

// --------- Handler ----------
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: noStoreHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: noStoreHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = safeJsonParse(event.body);

    const userIdRaw = String(body.user_id || body.userId || "").trim();
    const deviceId = String(body.device_id || body.deviceId || "").trim();
    const callId = String(body.call_id || body.callId || "").trim() || null;

    const conversationId =
      String(body.conversationId || body.conversation_id || body.c || "").trim() || null;

    const seed = randomSeed();
    const palette = [
      "warm and grounded",
      "firm and encouraging",
      "calm and confident",
      "direct but compassionate",
      "steady and brotherly",
    ];
    const style = palette[Math.floor(Math.random() * palette.length)];

    const system = `
You are AI Blake, a concise masculine Christian coach for Son of Wisdom.
Return ONE short spoken greeting (1–2 sentences).
Tone: ${style}.
Goal: invite the man to share one concrete situation he is facing right now.
Rules:
- Plain text only (no markdown)
- No bullet points
- Keep it short and natural for TTS
- Avoid repeating the exact same opener every time
`.trim();

    const user = `
Generate a fresh greeting for call mode.

Seed: ${seed}
User id: ${userIdRaw || "unknown"}
Device id: ${deviceId || "unknown"}
Conversation id: ${conversationId || "none"}
`.trim();

    // 1) Greeting text (fast + bounded)
    const rawText = await openaiChat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      {
        temperature: 0.95,
        maxTokens: 90,
        timeoutMs: 18000,
        user: deviceId || userIdRaw || "sow",
        presence_penalty: 0.7,
        frequency_penalty: 0.7,
      }
    );

    const text = clampPlainText(rawText, 360);

    // 2) TTS (optional; do not fail the greeting if TTS fails)
    const audio_expected = true;
    const ttsRes = await elevenLabsTTS(text, { timeoutMs: 22000 });

    // 3) Log (best-effort; never blocks response)
    const nowIso = new Date().toISOString();
    const userUuid = pickUuidForHistory(userIdRaw);

    if (callId) {
      supabaseInsert(CALL_SESSIONS_TABLE, {
        call_id: callId,
        user_id_uuid: userUuid,
        input_transcript: null,
        ai_text: text,
        source: "voice_greeting",
        system_event: null,
        created_at: nowIso,
        timestamp: nowIso,
      }).catch(() => {});
    }

    if (conversationId) {
      supabaseInsert(CONVERSATION_MESSAGES_TABLE, {
        conversation_id: conversationId,
        role: "assistant",
        content: text,
        source: "voice_greeting",
        call_id: callId,
        created_at: nowIso,
      }).catch(() => {});
    }

    // 4) Return (always succeeds)
    const resp = {
      text,
      assistant_text: text,
      call_id: callId,
      mime: "audio/mpeg",
      audio_expected,
    };

    if (ttsRes?.audio_base64) {
      resp.audio_base64 = ttsRes.audio_base64;
      resp.mime = ttsRes.mime || "audio/mpeg";
    } else {
      resp.audio_missing = true;
      if (ttsRes?.error) resp.audio_error = String(ttsRes.error).slice(0, 180);
    }

    return {
      statusCode: 200,
      headers: noStoreHeaders,
      body: JSON.stringify(resp),
    };
  } catch (err) {
    console.error("[call-greeting] error:", err);

    // ✅ Even on error: return a fallback greeting so iOS never hangs forever
    const fallback = "You’re talking to AI Blake. Tell me one real situation you’re facing right now—what happened?";
    return {
      statusCode: 200,
      headers: noStoreHeaders,
      body: JSON.stringify({
        text: fallback,
        assistant_text: fallback,
        mime: "audio/mpeg",
        audio_expected: true,
        audio_missing: true,
        audio_error: "Greeting function error",
      }),
    };
  }
};