// app/history.js
// Conversation history page controller

import { supabase, ensureAuthedOrRedirect } from "./supabase.js";

const $ = (s, r = document) => r.querySelector(s);

// Main list container (support either #list or #conversation-list)
const listEl =
  $("#list") ||
  $("#conversation-list") ||
  (() => {
    const div = document.createElement("div");
    div.id = "list";
    document.body.appendChild(div);
    return div;
  })();

// Query params
const params   = new URLSearchParams(window.location.search);
const returnTo = params.get("returnTo") || "home.html";

// --- helpers -----------------------------------------------------------

function initialFromEmail(email = "") {
  const c = (email || "?").trim()[0] || "?";
  return c.toUpperCase();
}

function convUrl(id) {
  const q = new URLSearchParams({ c: id }).toString();
  return `./home.html?${q}`;
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  });
}

async function getConvosFromSupabase(userId) {
  if (!userId) return [];

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[HISTORY] Error loading conversations:", error);
    return [];
  }

  return (data || []).map((r) => ({
    id: r.id,
    title: r.title || "Untitled",
    updated_at: r.updated_at || r.created_at || new Date().toISOString(),
  }));
}

function renderConvos(convos) {
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!convos || convos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "conv-item empty";
    empty.textContent = "No conversations yet. Tap “New Conversation” to start.";
    listEl.appendChild(empty);
    return;
  }

  for (const c of convos) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "conv-item";
    el.innerHTML = `
      <div class="title">${c.title || "Untitled"}</div>
      <div class="date tiny muted">${formatDate(c.updated_at)}</div>
    `;
    el.addEventListener("click", () => {
      window.location.href = convUrl(c.id);
    });
    listEl.appendChild(el);
  }
}

async function createConversation(userId, email) {
  if (!userId) return null;

  const title = "New Conversation";
  try {
    const { data, error } = await supabase
      .from("conversations")
      .insert([{ user_id: userId, title }])
      .select("id")
      .single();

    if (error) throw error;
    return data.id;
  } catch (e) {
    console.error("[HISTORY] Failed to create conversation:", e);
    return null;
  }
}

// --- event bindings ----------------------------------------------------

$("#btn-close")?.addEventListener("click", () => {
  const dest = decodeURIComponent(returnTo);
  window.location.href = dest.match(/\.html/)
    ? dest
    : "home.html";
});

$("#btn-settings")?.addEventListener("click", () => {
  alert("Settings coming soon.");
});

$("#btn-new")?.addEventListener("click", async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const id = await createConversation(user?.id, user?.email);
  if (id) {
    window.location.href = convUrl(id);
  }
});

// --- boot --------------------------------------------------------------

(async function boot() {
  await ensureAuthedOrRedirect();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Render bottom user row if present
  const nameEl   = $("#user-name");
  const avatarEl = $("#avatar");

  if (nameEl) {
    nameEl.textContent =
      user?.user_metadata?.full_name || user?.email || "You";
  }
  if (avatarEl) {
    avatarEl.textContent = initialFromEmail(user?.email);
  }

  const convos = await getConvosFromSupabase(user?.id);
  renderConvos(convos);
})();
