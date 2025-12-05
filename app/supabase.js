// app/supabase.js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- Canonical config (override allowed but validated) ----
const DEFAULT_SUPABASE_URL = "https://utqtqqvaboeibnyjgbtk.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0cXRxcXZhYm9laWJueWpnYnRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwNzg4ODUsImV4cCI6MjA3MDY1NDg4NX0.GShilY2N0FHlIl5uohZzH5UjSItDGpbQjVDltQi5kbQ";

// Allow optional window overrides, but make them safe.
const RAW_URL = (window.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim();
const RAW_KEY = (window.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY).trim();

function normalizeHttpsOrigin(maybeUrl, fallbackOrigin) {
  try {
    const u = new URL(maybeUrl);
    if (u.protocol !== "https:") throw new Error("Supabase URL must be https");
    return u.origin; // strips path/query/trailing slash
  } catch (e) {
    console.error("[supabase] Invalid SUPABASE_URL:", maybeUrl, e);
    return fallbackOrigin;
  }
}

export const SUPABASE_URL = normalizeHttpsOrigin(RAW_URL, DEFAULT_SUPABASE_URL);
export const SUPABASE_ANON_KEY = RAW_KEY;

console.log("[supabase] Using URL:", SUPABASE_URL);

// ---- Client ----
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
  },
});

// ---- Helpers (used across pages) ----
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function ensureAuthedOrRedirect(redirectTo = "auth.html") {
  const session = await getSession();
  if (!session?.user) {
    window.location.href = redirectTo;
    throw new Error("Not authenticated");
  }
  return session;
}

export async function signOutAndRedirect(redirectTo = "auth.html") {
  try {
    await supabase.auth.signOut();
  } finally {
    window.location.href = redirectTo;
  }
}
