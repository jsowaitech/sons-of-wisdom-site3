// netlify/functions/deepgram-token.js
export async function handler(event) {
  try {
    if (event.httpMethod !== "GET") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing DEEPGRAM_API_KEY env var" }),
      };
    }

    // Optional: ttl via query param, bounded
    const url = new URL(event.rawUrl || "https://x.local/?");
    let ttl = Number(url.searchParams.get("ttl") || "30");
    if (!Number.isFinite(ttl)) ttl = 30;
    ttl = Math.max(1, Math.min(3600, ttl)); // Deepgram allows 1..3600

    const resp = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        "Authorization": `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: ttl }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        statusCode: resp.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Deepgram token request failed", details: txt }),
      };
    }

    const data = await resp.json().catch(() => ({}));
    const access_token = data.access_token || "";
    const expires_in = data.expires_in ?? null;

    if (!access_token) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Deepgram token missing access_token" }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // keep it cache-safe
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ access_token, expires_in }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server error", details: String(e?.message || e) }),
    };
  }
}
