// netlify/functions/call-greeting.js
// Son of Wisdom — Dynamic AI greeting
// Returns JSON: { text, audio_base64, mime }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

async function openaiChat(messages, opts = {}) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: opts.temperature ?? 0.8,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI chat ${res.status}: ${t || res.statusText}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function elevenLabsTTS(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return null;

  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

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
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS ${res.status}: ${t || res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { audio_base64: buf.toString("base64"), mime: "audio/mpeg" };
}

function fallbackGreetingText() {
  return "Alright brother. I’m here with you. Tell me what’s going on today.";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const userId = (body.user_id || "").toString().trim();
    const deviceId = (body.device_id || "").toString().trim();

    const system = `You are AI Blake, a concise masculine Christian coach for Son of Wisdom.
Return a single short greeting (1–2 sentences) inviting the user to speak.
No markdown, no bullet points, plain text only.`;

    const user = `Generate a fresh greeting for call mode.
User: ${userId || "unknown"}
Device: ${deviceId || "unknown"}`;

    let text = "";
    try {
      text = await openaiChat(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { temperature: 0.9, maxTokens: 90 }
      );
    } catch (e) {
      console.error("[call-greeting] OpenAI failed:", e);
      text = fallbackGreetingText();
    }

    // TTS is best-effort; if it fails, we still return text.
    let audio = null;
    try {
      audio = await elevenLabsTTS(text);
    } catch (e) {
      console.error("[call-greeting] ElevenLabs failed:", e);
      audio = null;
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        audio_base64: audio?.audio_base64 || null,
        mime: audio?.mime || "audio/mpeg",
      }),
    };
  } catch (err) {
    console.error("[call-greeting] error:", err);
    // Even on hard failure, return fallback text so client can still transcribe.
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: fallbackGreetingText(),
        audio_base64: null,
        mime: "audio/mpeg",
      }),
    };
  }
};
