// netlify/functions/upload-file.js
// Son of Wisdom — File Upload (Netlify Function, Node 18+ ESM)
//
// Accepts: multipart/form-data
// - file field: "file" (required)
// - optional fields: user_id, conversation_id, device_id, page, timestamp
//
// Upload target: Supabase Storage bucket (default "uploads")
// Returns JSON: { ok, bucket, path, filename, content_type, bytes, public_url? }
//
// ENV required:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY  (or SUPABASE_SERVICE_KEY fallback)
// Optional:
// - SUPABASE_STORAGE_BUCKET (default "uploads")
// - SUPABASE_STORAGE_PUBLIC (default "true")  // if your bucket is public

import Busboy from "busboy";
import crypto from "crypto";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

function cleanFilename(name) {
  const base = String(name || "upload.bin").trim();
  // keep simple: letters numbers dots dashes underscores
  const cleaned = base.replace(/[^\w.\-]+/g, "_");
  return cleaned.slice(0, 180) || "upload.bin";
}

function extFromName(name) {
  const n = String(name || "").toLowerCase();
  const idx = n.lastIndexOf(".");
  if (idx === -1) return "";
  const ext = n.slice(idx + 1);
  if (!ext || ext.length > 10) return "";
  return ext;
}

function uuidLike() {
  try {
    return crypto.randomUUID();
  } catch {
    return `u_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

async function uploadToSupabaseStorage({
  supabaseUrl,
  serviceKey,
  bucket,
  path,
  contentType,
  buffer,
}) {
  const url = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "true",
    },
    body: buffer,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Supabase Storage upload failed ${res.status}: ${t || res.statusText}`);
  }

  // Supabase storage upload often returns JSON; sometimes empty. Treat as ok.
  const data = await res.text().catch(() => "");
  return safeJson(data);
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { ...corsHeaders, "Cache-Control": "no-store" },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || "";
  const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";

  const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "uploads";
  const STORAGE_PUBLIC = String(process.env.SUPABASE_STORAGE_PUBLIC || "true").toLowerCase() !== "false";

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        error: "Missing Supabase env vars",
        hint: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) in Netlify env.",
      }),
    };
  }

  try {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"] || "";

    if (!String(contentType).includes("multipart/form-data")) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: "Expected multipart/form-data" }),
      };
    }

    const bb = Busboy({ headers: { "content-type": contentType } });

    let fileBuffer = null;
    let filename = "upload.bin";
    let mime = "application/octet-stream";

    const fields = {};

    bb.on("field", (name, val) => {
      fields[name] = String(val || "");
    });

    bb.on("file", (fieldname, file, info) => {
      if (fieldname !== "file") {
        file.resume();
        return;
      }

      const { filename: fn, mimeType } = info || {};
      if (fn) filename = cleanFilename(fn);
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

    if (!fileBuffer || !fileBuffer.length) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({
          error: "Missing file",
          hint: "Send multipart/form-data with a file field named 'file'.",
        }),
      };
    }

    // basic safety cap (adjust if you want)
    const MAX_BYTES = 25 * 1024 * 1024; // 25MB
    if (fileBuffer.length > MAX_BYTES) {
      return {
        statusCode: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({
          error: "File too large",
          max_bytes: MAX_BYTES,
          bytes: fileBuffer.length,
        }),
      };
    }

    const userId = (fields.user_id || "anon").slice(0, 80).replace(/[^\w\-]/g, "_") || "anon";
    const convId = (fields.conversation_id || "").slice(0, 80).replace(/[^\w\-]/g, "_");
    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const id = uuidLike();

    const ext = extFromName(filename);
    const safeBase = cleanFilename(filename).replace(/\.(\w{1,10})$/, "");
    const finalName = ext ? `${safeBase}.${ext}` : safeBase;

    // Path pattern: uploads/<user>/<conversation(optional)>/<date>/<uuid>_<filename>
    const pathParts = [
      "uploads",
      userId,
      convId ? convId : null,
      stamp,
      `${id}_${finalName}`,
    ].filter(Boolean);

    const path = pathParts.map(encodeURIComponent).join("/");

    await uploadToSupabaseStorage({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SUPABASE_SERVICE_ROLE_KEY,
      bucket: BUCKET,
      path,
      contentType: mime,
      buffer: fileBuffer,
    });

    const publicUrl = STORAGE_PUBLIC
      ? `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(BUCKET)}/${path}`
      : null;

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: true,
        bucket: BUCKET,
        path,
        filename: finalName,
        content_type: mime,
        bytes: fileBuffer.length,
        public_url: publicUrl,
        received: {
          user_id: fields.user_id || null,
          conversation_id: fields.conversation_id || null,
          device_id: fields.device_id || null,
          page: fields.page || null,
          timestamp: fields.timestamp || null,
        },
        note: STORAGE_PUBLIC
          ? "public_url works only if your bucket is public"
          : "bucket is private; return a signed URL from backend if you need viewing links",
      }),
    };
  } catch (err) {
    console.error("[upload-file] error:", err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        error: "Server error",
        detail: String(err?.message || err),
        hint:
          "Check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and that the storage bucket exists (default 'uploads').",
      }),
    };
  }
};