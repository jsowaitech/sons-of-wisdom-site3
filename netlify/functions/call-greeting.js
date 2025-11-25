// netlify/functions/call-greeting.js

// Netlify Functions use Node 18+ by default, so global fetch is available.

export async function handler(event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed",
    };
  }

  try {
    const {
      name,
      // optional: you could pass sessionId, emotion, etc later if you want
    } = JSON.parse(event.body || "{}");

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
    const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID; // set this in Netlify
    const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";

    if (!OPENAI_API_KEY || !ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
      console.error("Missing env vars for greeting");
      return {
        statusCode: 500,
        body: "Server misconfigured (missing env vars).",
      };
    }

    /* 1) Generate a UNIQUE greeting text with OpenAI */
    const who = name ? `a man named ${name}` : "a son of God";

    const systemPrompt = `
You are Solomon Codex, a lion-hearted yet tender spiritual father.
Generate a short voice greeting for the START of a live call with a man.

Requirements:
- 2–3 sentences maximum.
- Warm, fatherly, and spiritually weighty.
- Treat this as a war room / holy ground, not casual chat.
- Speak directly to ${who}.
- Each greeting must feel unique. Vary the imagery, wording, and cadence.
- Do NOT mention that you are an AI or that this is a script.
- Do NOT ask more than 1 question at the very end.
`.trim();

    const userPrompt = `
Create today's unique greeting for this live call. 
Sound like a father forged in God's fire, welcoming his son into a war room, not a lounge.
`.trim();

    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.95, // keep it spicy so it varies each time
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!openaiResp.ok) {
      const errText = await openaiResp.text();
      console.error("OpenAI greeting error:", errText);
      return {
        statusCode: 502,
        body: "Failed to generate greeting text.",
      };
    }

    const openaiData = await openaiResp.json();
    const greetingText =
      openaiData?.choices?.[0]?.message?.content?.trim() ||
      "Son, welcome. This is holy ground. Let's get to work.";

    console.log("[call-greeting] Greeting text:", greetingText);

    /* 2) Send greeting to ElevenLabs TTS */
    const elevenUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?optimize_streaming_latency=4&output_format=mp3_22050_32`;

    const elevenBody = {
      text: greetingText,
      model_id: ELEVEN_MODEL,
      voice_settings: {
        stability: 0.3,
        similarity_boost: 0.85,
        style: 0.3,
        use_speaker_boost: true,
      },
    };

    const elevenResp = await fetch(elevenUrl, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(elevenBody),
    });

    if (!elevenResp.ok) {
      const errText = await elevenResp.text();
      console.error("ElevenLabs error:", errText);
      return {
        statusCode: 502,
        body: "Failed to generate greeting audio.",
      };
    }

    const audioArrayBuffer = await elevenResp.arrayBuffer();
    const audioBase64 = Buffer.from(audioArrayBuffer).toString("base64");

    // Netlify will decode base64 → binary for the client.
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
      body: audioBase64,
    };
  } catch (err) {
    console.error("call-greeting fatal error:", err);
    return {
      statusCode: 500,
      body: "Server error generating greeting.",
    };
  }
}
