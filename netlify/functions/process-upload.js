// netlify/functions/process-upload.js
// Son of Wisdom — Process Upload (Option C)
// Downloads file from Supabase Storage, extracts text (PDF+TXT),
// chunks, embeds, stores in Supabase:
// - conversation_documents
// - conversation_document_chunks
//
// Expects JSON:
// { storage_path, filename, conversation_id, user_id, bucket? }

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import extractTextFromBuffer from "./lib/extract-text.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

// Tuning
const MAX_TEXT_CHARS = 220_000;         // cap extracted text to avoid huge bills/timeouts
const CHUNK_WORDS = 230;               // ~ chunk size
const EMBED_BATCH = 64;                // embeddings per request
const MIN_TEXT_CHARS = 20;

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

function chunkByWords(text, chunkWords = CHUNK_WORDS) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const chunks = [];
  let cur = [];

  for (const w of words) {
    cur.push(w);
    if (cur.length >= chunkWords) {
      chunks.push(cur.join(" "));
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}

async function embedBatch(openai, inputs) {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: inputs,
  });
  // returns array in same order
  return (res?.data || []).map((d) => d.embedding);
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    if (!OPENAI_API_KEY) {
      return {
        statusCode: 500,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }),
      };
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return {
        statusCode: 500,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing Supabase env vars" }),
      };
    }

    const body = safeJson(event.body);
    const {
      storage_path,
      filename,
      conversation_id,
      user_id,
      bucket = "uploads",
    } = body;

    if (!storage_path || !conversation_id || !user_id) {
      return {
        statusCode: 400,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Missing required fields",
          required: ["storage_path", "conversation_id", "user_id"],
        }),
      };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // 1) Download from storage
    const { data: fileData, error: downloadError } =
      await supabase.storage.from(bucket).download(storage_path);

    if (downloadError) {
      return {
        statusCode: 500,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Storage download failed", detail: downloadError.message }),
      };
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());

    // 2) Extract (PDF+TXT only)
    const extracted = await extractTextFromBuffer(buffer, filename || "", "");
    if (extracted.kind === "unsupported") {
      return {
        statusCode: 415,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unsupported file type (PDF + TXT only)" }),
      };
    }

    let text = String(extracted.text || "").trim();
    if (!text || text.length < MIN_TEXT_CHARS) {
      return {
        statusCode: 200,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, message: "File had no usable text" }),
      };
    }

    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

    // 3) Create doc record
    const { data: doc, error: docErr } = await supabase
      .from("conversation_documents")
      .insert({
        conversation_id,
        user_id,
        storage_bucket: bucket,
        storage_path,
        filename: filename || null,
        pages: extracted.pages || null,
        chars: text.length,
      })
      .select()
      .single();

    if (docErr) {
      return {
        statusCode: 500,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Failed to create conversation_documents", detail: docErr.message }),
      };
    }

    // 4) Chunk
    const chunks = chunkByWords(text, CHUNK_WORDS);

    // 5) Embed + insert in batches
    let inserted = 0;

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await embedBatch(openai, batch);

      const rows = batch.map((content, j) => ({
        conversation_id,
        document_id: doc.id,
        chunk_index: i + j,
        content,
        embedding: vectors[j], // must match your DB vector column type
      }));

      const { error: insErr } = await supabase
        .from("conversation_document_chunks")
        .insert(rows);

      if (insErr) {
        return {
          statusCode: 500,
          headers: { ...cors, "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "Failed inserting chunks",
            detail: insErr.message,
            inserted,
          }),
        };
      }

      inserted += rows.length;
    }

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        document_id: doc.id,
        chunks_created: inserted,
        pages: extracted.pages || null,
        chars: text.length,
      }),
    };
  } catch (err) {
    console.error("[process-upload] error:", err);
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Processing failed",
        detail: String(err?.message || err),
      }),
    };
  }
};