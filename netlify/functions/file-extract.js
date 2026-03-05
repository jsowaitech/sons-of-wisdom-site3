// netlify/functions/file-extract.js
// Son of Wisdom — File Extractor (PDF + TXT only)
// Node 18+ ESM
//
// Accepts: multipart/form-data
// Field: "file"
// Returns: { text, fileName, mime, pages, chars }

import Busboy from "busboy";
import extractTextFromBuffer from "./extract-text.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"] || "";

    if (!String(contentType).includes("multipart/form-data")) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: "Expected multipart/form-data" }),
      };
    }

    const bb = Busboy({ headers: { "content-type": contentType } });

    let fileBuffer = null;
    let filename = "upload";
    let mime = "application/octet-stream";

    bb.on("file", (fieldname, file, info) => {
      if (fieldname !== "file") {
        file.resume();
        return;
      }

      const { filename: fn, mimeType } = info || {};
      if (fn) filename = fn;
      if (mimeType) mime = mimeType;

      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
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

    if (!fileBuffer) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: "No file received" }),
      };
    }

    const extracted = await extractTextFromBuffer(fileBuffer, filename, mime);

    if (extracted.kind === "unsupported") {
      return {
        statusCode: 415,
        headers: cors,
        body: JSON.stringify({
          error: "Unsupported file type (PDF + TXT only)",
          mime,
          fileName: filename,
        }),
      };
    }

    if (!extracted.text) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          text: "",
          fileName: filename,
          mime,
          pages: extracted.pages,
          chars: 0,
          warning: "No readable text found",
        }),
      };
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        text: extracted.text,
        fileName: filename,
        mime,
        pages: extracted.pages,
        chars: extracted.chars,
      }),
    };
  } catch (err) {
    console.error("[file-extract] error:", err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        error: "Server error",
        detail: String(err?.message || err),
      }),
    };
  }
};