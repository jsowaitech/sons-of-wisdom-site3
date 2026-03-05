// netlify/functions/process-upload.js
// Son of Wisdom — Process Uploaded File -> Extract text -> Chunk -> Embed -> Store in Supabase
// Node 18+ ESM (Netlify Functions)
//
// Accepts: application/json POST
// {
//   storage_path: "uploads/<user>/<conv>/<date>/<uuid>_<filename>",
//   filename: "my.pdf",
//   content_type?: "application/pdf" | "text/plain" | ...,
//   bytes?: number,
//   conversation_id: "<uuid>",
//   user_id: "<uuid or string>",
//   bucket?: "uploads" (default)
// }
//
// Supports: PDF + TXT only (per your requirement)
//
// Writes:
// - conversation_documents (one row per uploaded doc)
// - conversation_document_chunks (many rows w/ embeddings)
//
// ENV required:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// - OPENAI_API_KEY
// Optional:
// - OPENAI_EMBED_MODEL (default text-embedding-3-small)

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import pdf from "pdf-parse";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const noStoreHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function safeJsonParse(s, fallback = {}) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return fallback;
  }
}

function isPdf(filename = "", mime = "") {
  const n = String(filename).toLowerCase();
  const m = String(mime).toLowerCase();
  return m.includes("pdf") || n.endsWith(".pdf");
}

function isTxt(filename = "", mime = "") {
  const n = String(filename).toLowerCase();
  const m = String(mime).toLowerCase();
  return m.startsWith("text/") || n.endsWith(".txt");
}

function normalizeWhitespace(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Chunking (simple + stable):
 * - Aim ~900 tokens/chunk, overlap ~120 tokens
 * Uses tiktoken if available, otherwise falls back to word-based.
 */
async function chunkTextTokenAware(text, { targetTokens = 900, overlapTokens = 120 } = {}) {
  const clean = normalizeWhitespace(text);
  if (!clean) return { chunks: [], tokenCounts: [] };

  let enc = null;
  try {
    // tiktoken is ESM; in some Netlify bundles it may fail. We gracefully fallback.
    const mod = await import("tiktoken");
    const { get_encoding } = mod;
    enc = get_encoding("cl100k_base");
  } catch {
    enc = null;
  }

  if (!enc) {
    // Fallback: word chunks (roughly)
    const words = clean.split(/\s+/).filter(Boolean);
    const approxWordsPerChunk = 650; // ~900 tokens-ish for normal English
    const approxOverlap = 90;

    const chunks = [];
    const tokenCounts = [];
    for (let i = 0; i < words.length; i += Math.max(1, approxWordsPerChunk - approxOverlap)) {
      const slice = words.slice(i, i + approxWordsPerChunk).join(" ");
      if (slice.trim()) {
        chunks.push(slice);
        tokenCounts.push(slice.split(/\s+/).length);
      }
    }
    return { chunks, tokenCounts };
  }

  const tokens = enc.encode(clean);
  const chunks = [];
  const tokenCounts = [];

  let i = 0;
  while (i < tokens.length) {
    const end = Math.min(tokens.length, i + targetTokens);
    const windowTokens = tokens.slice(i, end);
    const chunk = enc.decode(windowTokens);
    const trimmed = chunk.trim();
    if (trimmed) {
      chunks.push(trimmed);
      tokenCounts.push(windowTokens.length);
    }
    if (end >= tokens.length) break;
    i = Math.max(0, end - overlapTokens);
  }

  try {
    enc.free?.();
  } catch {}

  return { chunks, tokenCounts };
}

async function extractTextFromBuffer(buffer, filename, mime) {
  if (isPdf(filename, mime)) {
    const data = await pdf(buffer);
    const t = data?.text || "";
    return { text: normalizeWhitespace(t), pages: data?.numpages || null };
  }

  if (isTxt(filename, mime)) {
    const t = buffer.toString("utf8");
    return { text: normalizeWhitespace(t), pages: null };
  }

  return { text: "", pages: null };
}

async function createEmbedding(input) {
  const res = await openai.embeddings.create({
    model: OPENAI_EMBED_MODEL,
    input: String(input || "").slice(0, 8000),
  });
  return res?.data?.[0]?.embedding || null;
}

async function insertChunksBatch(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from("conversation_document_chunks").insert(rows);
  if (error) throw error;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...corsHeaders, "Cache-Control": "no-store" }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: noStoreHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      statusCode: 500,
      headers: noStoreHeaders,
      body: JSON.stringify({
        error: "Missing Supabase env vars",
        hint: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify env.",
      }),
    };
  }

  if (!OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: noStoreHeaders,
      body: JSON.stringify({
        error: "Missing OpenAI env vars",
        hint: "Set OPENAI_API_KEY in Netlify env.",
      }),
    };
  }

  try {
    const body = safeJsonParse(event.body, {});
    const bucket = String(body.bucket || "uploads");
    const storage_path = String(body.storage_path || "").trim();
    const filename = String(body.filename || "").trim();
    const content_type = String(body.content_type || "").trim();
    const conversation_id = body.conversation_id || body.conversationId || null;
    const user_id = body.user_id || body.userId || null;

    if (!storage_path) {
      return {
        statusCode: 400,
        headers: noStoreHeaders,
        body: JSON.stringify({ error: "Missing storage_path" }),
      };
    }

    if (!conversation_id) {
      return {
        statusCode: 400,
        headers: noStoreHeaders,
        body: JSON.stringify({ error: "Missing conversation_id" }),
      };
    }

    // PDF + TXT only
    const allowPdf = isPdf(filename, content_type);
    const allowTxt = isTxt(filename, content_type);

    if (!allowPdf && !allowTxt) {
      return {
        statusCode: 415,
        headers: noStoreHeaders,
        body: JSON.stringify({
          error: "Unsupported file type. Only PDF + TXT are supported.",
          filename,
          content_type,
        }),
      };
    }

    // Download from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from(bucket)
      .download(storage_path);

    if (downloadError) {
      return {
        statusCode: 500,
        headers: noStoreHeaders,
        body: JSON.stringify({
          error: "Supabase download failed",
          detail: downloadError.message || String(downloadError),
          bucket,
          storage_path,
        }),
      };
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());

    // Extract
    const { text, pages } = await extractTextFromBuffer(buffer, filename, content_type);

    if (!text || text.length < 20) {
      return {
        statusCode: 200,
        headers: noStoreHeaders,
        body: JSON.stringify({
          ok: true,
          message: "File had no usable text",
          chars: (text || "").length,
          pages: pages || null,
        }),
      };
    }

    // Create conversation_documents row
    const { data: doc, error: docErr } = await supabase
      .from("conversation_documents")
      .insert({
        conversation_id,
        user_id,
        storage_bucket: bucket,
        storage_path,
        filename: filename || "upload",
        content_type: content_type || (allowPdf ? "application/pdf" : "text/plain"),
        bytes: typeof body.bytes === "number" ? body.bytes : buffer.length,
      })
      .select()
      .single();

    if (docErr || !doc?.id) {
      throw docErr || new Error("Failed to create conversation_documents row");
    }

    // Chunk
    const { chunks, tokenCounts } = await chunkTextTokenAware(text, {
      targetTokens: 900,
      overlapTokens: 120,
    });

    // Embed + insert chunks
    const BATCH_SIZE = 20;
    let batch = [];
    let created = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const token_count = tokenCounts?.[i] ?? null;

      // Create embedding
      const embedding = await createEmbedding(chunk);
      if (!embedding) continue;

      batch.push({
        conversation_id,
        document_id: doc.id,
        chunk_index: i,
        content: chunk,
        token_count,
        embedding,
      });

      if (batch.length >= BATCH_SIZE) {
        await insertChunksBatch(batch);
        created += batch.length;
        batch = [];
      }
    }

    if (batch.length) {
      await insertChunksBatch(batch);
      created += batch.length;
    }

    return {
      statusCode: 200,
      headers: noStoreHeaders,
      body: JSON.stringify({
        ok: true,
        document_id: doc.id,
        chunks_created: created,
        chunks_total: chunks.length,
        pages: pages || null,
        chars: text.length,
        bucket,
        storage_path,
        filename,
      }),
    };
  } catch (err) {
    console.error("[process-upload] error:", err);
    return {
      statusCode: 500,
      headers: noStoreHeaders,
      body: JSON.stringify({
        error: "Processing failed",
        detail: String(err?.message || err),
      }),
    };
  }
};