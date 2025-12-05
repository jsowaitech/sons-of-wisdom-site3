// app/supabase.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL =
  window.SUPABASE_URL || "https://utqtqqvaboeibnyjgbtk.supabase.co";

const SUPABASE_ANON_KEY =
  window.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0cXRxcXZhYm9laWJueWpnYnRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwNzg4ODUsImV4cCI6MjA3MDY1NDg4NX0.GShilY2N0FHlIl5uohZzH5UjSItDGpbQjVDltQi5kbQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
  },
});

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
