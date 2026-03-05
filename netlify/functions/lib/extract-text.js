// netlify/functions/lib/extract-text.js
// Shared extractor used by BOTH file-extract endpoint and process-upload
// PDF + TXT only

import pdf from "pdf-parse";

function isPdf(filename = "", mime = "") {
  const fn = String(filename).toLowerCase();
  const m = String(mime).toLowerCase();
  return m.includes("pdf") || fn.endsWith(".pdf");
}

function isTxt(filename = "", mime = "") {
  const fn = String(filename).toLowerCase();
  const m = String(mime).toLowerCase();
  return m.startsWith("text/") || fn.endsWith(".txt");
}

export default async function extractTextFromBuffer(buffer, filename = "", mime = "") {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { text: "", pages: null, chars: 0, kind: "none" };
  }

  // PDF
  if (isPdf(filename, mime)) {
    const data = await pdf(buffer);
    const text = String(data?.text || "").trim();
    return {
      text,
      pages: data?.numpages || null,
      chars: text.length,
      kind: "pdf",
    };
  }

  // TXT
  if (isTxt(filename, mime)) {
    const text = buffer.toString("utf8").trim();
    return { text, pages: null, chars: text.length, kind: "txt" };
  }

  return { text: "", pages: null, chars: 0, kind: "unsupported" };
}