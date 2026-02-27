// netlify/functions/openai-transcribe.js
// Son of Wisdom — OpenAI Transcribe proxy (Netlify Function, Node 18+)

import Busboy from "busboy";

function withTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

function normalizeMime(m) {
  const mime = String(m || "").toLowerCase();
  if (
    mime.includes("mp4") ||
    mime.includes("m4a") ||
    mime.includes("quicktime")
  ) {
    return "audio/mp4";
  }
  if (mime.includes("ogg")) return "audio/ogg";
  return mime || "audio/webm";
}

export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  const jsonHeaders = {
    ...cors,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: jsonHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Missing OPENAI_API_KEY env var" }),
    };
  }

  const MODEL =
    process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

  try {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"] || "";

    if (!String(contentType).includes("multipart/form-data")) {
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({ error: "Expected multipart/form-data" }),
      };
    }

    const bb = Busboy({ headers: { "content-type": contentType } });

    let audioBuffer = null;
    let audioFilename = "audio.webm";
    let audioMime = "audio/webm";
    let gotFileField = "";

    bb.on("file", (fieldname, file, info) => {
      if (fieldname !== "audio" && fieldname !== "file") {
        file.resume();
        return;
      }

      gotFileField = fieldname;

      const { filename, mimeType } = info || {};
      if (filename) audioFilename = filename;
      if (mimeType) audioMime = mimeType;

      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        audioBuffer = Buffer.concat(chunks);
      });
    });

    const finished = new Promise((resolve, reject) => {
      bb.on("finish", resolve);
      bb.on("error", reject);
    });

    const bodyBuf = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : Buffer.from(event.body || "", "utf8");

    bb.end(bodyBuf);
    await finished;

    if (!audioBuffer || !audioBuffer.length) {
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({
          error: "Missing audio file",
          hint: "Send multipart/form-data with 'audio' or 'file'.",
        }),
      };
    }

    // Tiny blob guard
    if (audioBuffer.length < 8000) {
      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          text: "",
          skipped: true,
          reason: "audio_too_small",
          bytes: audioBuffer.length,
        }),
      };
    }

    // Normalize MIME for Safari
    audioMime = normalizeMime(audioMime);

    const fd = new FormData();
    fd.append(
      "file",
      new Blob([audioBuffer], { type: audioMime }),
      audioFilename
    );
    fd.append("model", MODEL);

    const timeout = withTimeout(25000); // ✅ 25s hard limit

    let resp;
    try {
      resp = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: fd,
          signal: timeout.signal,
        }
      );
    } finally {
      timeout.clear();
    }

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        statusCode: resp.status,
        headers: jsonHeaders,
        body: JSON.stringify({
          error: "OpenAI transcribe failed",
          details: txt || resp.statusText,
          model: MODEL,
        }),
      };
    }

    const data = await resp.json().catch(() => ({}));

    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        text: data?.text || "",
      }),
    };
  } catch (e) {
    const msg =
      e?.name === "AbortError"
        ? "Transcription timeout"
        : String(e?.message || e);

    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({
        error: "Server error",
        details: msg,
      }),
    };
  }
};