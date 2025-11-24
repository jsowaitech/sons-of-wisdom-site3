// netlify/functions/chat.js
// Server-side chat endpoint for Son of Wisdom (Netlify Functions)

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    const { text, message, meta } = JSON.parse(event.body || "{}");
    const userMessage = message || text;
    if (!userMessage) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "message/text is required" }),
      };
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      console.error("[chat] Missing OPENAI_API_KEY");
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Server not configured" }),
      };
    }

    const systemPrompt =
      "You are the Son of Wisdom AI Coach. Be warm, concise, and practical. Offer 1–3 actionable suggestions.";

    const openaiResp = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.7,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
      }
    );

    if (!openaiResp.ok) {
      const errText = await openaiResp.text().catch(() => "");
      console.error("[chat] OpenAI error", openaiResp.status, errText);
      return {
        statusCode: openaiResp.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "OpenAI error", detail: errText }),
      };
    }

    const data = await openaiResp.json();
    const reply =
      data?.choices?.[0]?.message?.content?.trim() || "…";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply, meta: meta || null }),
    };
  } catch (err) {
    console.error("[chat] Unexpected error", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server error" }),
    };
  }
};
