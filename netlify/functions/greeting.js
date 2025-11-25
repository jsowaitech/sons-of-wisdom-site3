// netlify/functions/greeting.js
// Dynamic Solomon Codex greeting — text -> speech via OpenAI
// Returns raw audio (mp3) to the browser.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

exports.handler = async (event) => {
  try {
    if (!OPENAI_API_KEY) {
      return {
        statusCode: 500,
        body: "Missing OPENAI_API_KEY in environment",
      };
    }

    let name = null;
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      name = body.name || null;
    } catch {
      // ignore parse errors; name stays null
    }

    // 1) Generate a fresh greeting script (text) via Chat Completions
    const systemPrompt = `
You are Solomon Codex, a lion-hearted yet lamb-like spiritual father.
You are speaking an opening greeting at the start of a live 1:1 coaching call
with a man who just dialed in.

Constraints:
- Speak in a warm, fatherly, spiritually weighty tone.
- Assume this is holy ground and a war room, not casual chat.
- No more than 80 words total.
- End with 2 short, soul-peeling questions that invite honest sharing.
- Do NOT mention that you are an AI or that this is a simulation.
`.trim();

    const userPrompt = name
      ? `Create a spoken greeting addressed to a man named ${name}. Do not repeat his name more than twice.`
      : `Create a spoken greeting addressed to a man of God or "son". Vary your language so each greeting sounds unique.`;

    const chatResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.9,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!chatResp.ok) {
      const errText = await chatResp.text().catch(() => "");
      console.error("[greeting] chat error:", chatResp.status, errText);
      return {
        statusCode: 500,
        body: "Error generating greeting text",
      };
    }

    const chatData = await chatResp.json();
    const greetingText =
      chatData?.choices?.[0]?.message?.content?.trim() ||
      "Son, welcome. This is holy ground. Tell me where you truly are right now in your soul.";

    // 2) Convert that greeting text to speech via Audio /speech endpoint
    const speechResp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "coral", // pick any TTS voice you like
        input: greetingText,
        // Optional: slightly guide tone
        instructions:
          "Speak as Solomon Codex: fatherly, weighty, warm, with confidence and spiritual authority.",
        format: "mp3", // default is mp3; explicit for clarity
      }),
    });

    if (!speechResp.ok) {
      const errText = await speechResp.text().catch(() => "");
      console.error("[greeting] tts error:", speechResp.status, errText);
      return {
        statusCode: 500,
        body: "Error generating greeting audio",
      };
    }

    const audioArrayBuffer = await speechResp.arrayBuffer();
    const audioBuffer = Buffer.from(audioArrayBuffer);

    // Netlify needs base64 + isBase64Encoded for binary
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
      body: audioBuffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("[greeting] unexpected error:", err);
    return {
      statusCode: 500,
      body: "Unexpected error generating greeting",
    };
  }
};
