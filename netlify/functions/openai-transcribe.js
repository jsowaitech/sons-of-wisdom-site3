// netlify/functions/openai-transcribe.js
import busboy from "busboy";

export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...cors, "Cache-Control": "no-store" }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing OPENAI_API_KEY env var" }),
    };
  }

  try {
    const contentType = event.headers["content-type"] || event.headers["Content-Type"];
    if (!contentType?.includes("multipart/form-data")) {
      return {
        statusCode: 400,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Expected multipart/form-data" }),
      };
    }

    const bb = busboy({ headers: { "content-type": contentType } });

    let audioBuffer = null;
    let audioFilename = "audio.webm";
    let audioMime = "audio/webm";

    bb.on("file", (_name, file, info) => {
      const { filename, mimeType } = info;
      audioFilename = filename || audioFilename;
      audioMime = mimeType || audioMime;

      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        audioBuffer = Buffer.concat(chunks);
      });
    });

    const finish = new Promise((resolve, reject) => {
      bb.on("finish", resolve);
      bb.on("error", reject);
    });

    bb.end(event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body);

    await finish;

    if (!audioBuffer || !audioBuffer.length) {
      return {
        statusCode: 400,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing audio file" }),
      };
    }

    const fd = new FormData();
    fd.append("file", new Blob([audioBuffer], { type: audioMime }), audioFilename);
    fd.append("model", "gpt-4o-mini-transcribe");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        statusCode: resp.status,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "OpenAI transcribe failed", details: txt || resp.statusText }),
      };
    }

    const data = await resp.json();

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ text: data.text || "" }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server error", details: String(e?.message || e) }),
    };
  }
};
