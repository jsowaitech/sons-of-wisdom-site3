// ========================= UPDATED app/finish-signup.js =========================
// Only intentional changes:
// 1) After link is confirmed, show a SUCCESS banner briefly ("Link confirmed...")
// 2) After password saved, use kind="success" so it pops
// Everything else is identical.
// ===============================================================================

import { supabase } from "./supabase.js";

const $ = (sel) => document.querySelector(sel);

const DEV_FALLBACK_ORIGIN = "http://127.0.0.1:5500";

function getAuthOrigin() {
  const origin = window.location.origin;
  if (origin && origin.startsWith("http")) return origin;
  return DEV_FALLBACK_ORIGIN;
}

// DOM
const titleEl = $("#finish-title");
const subEl = $("#finish-sub");
const statusEl = $("#status");
const setpwEmailLine = $("#setpw-email-line");
const setpwEmailSpan = $("#user-email");
const setpwForm = $("#set-password-form");
const setpwPassEl = $("#sp-password");
const setpwPassConfEl = $("#sp-password-confirm");
const btnSetPassword = $("#btn-set-password");
const setpwSigninLink = $("#setpw-signin-link");

const params = new URLSearchParams(window.location.search);
const from = params.get("from") || "signup";

function setStatus(message, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.style.display = message ? "block" : "none";
  statusEl.dataset.kind = kind;
}

function setCopyFromContext() {
  if (!titleEl || !subEl) return;

  if (from === "recovery") {
    titleEl.textContent = "Reset your password";
    subEl.textContent =
      "Your reset link is confirmed. Choose a new password for your account.";
  } else {
    titleEl.textContent = "Create your password";
    subEl.textContent =
      "Your email is confirmed. Choose a password for your Son of Wisdom account.";
  }
}

async function init() {
  setCopyFromContext();
  setStatus("Checking your link…", "info");

  const { data, error } = await supabase.auth.getUser();

  if (error || !data?.user) {
    console.warn("[finish-signup] no user for this link", error);
    setStatus(
      "This link is invalid or has expired. Please request a new one from the app.",
      "error"
    );
    if (btnSetPassword) btnSetPassword.disabled = true;
    if (setpwForm) setpwForm.style.opacity = "0.6";
    if (setpwSigninLink) setpwSigninLink.style.display = "block";
    return;
  }

  const email = data.user.email;
  if (email && setpwEmailSpan) {
    setpwEmailSpan.textContent = email;
    if (setpwEmailLine) setpwEmailLine.style.display = "block";
  }

  // NEW: show a noticeable success banner briefly
  setStatus("✅ Link confirmed. Create your password below.", "success");
  setTimeout(() => setStatus("", "info"), 1600);
}

setpwForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pwd = (setpwPassEl?.value || "").trim();
  const confirm = (setpwPassConfEl?.value || "").trim();

  if (!pwd || !confirm) {
    setStatus("Please enter your new password twice.", "error");
    return;
  }
  if (pwd.length < 8) {
    setStatus("Password must be at least 8 characters long.", "error");
    return;
  }
  if (pwd !== confirm) {
    setStatus("Passwords do not match.", "error");
    return;
  }

  if (btnSetPassword) btnSetPassword.disabled = true;
  setStatus("Saving your password…", "info");

  try {
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      setStatus(
        "Your session is no longer valid. Please open the email link again.",
        "error"
      );
      if (btnSetPassword) btnSetPassword.disabled = false;
      if (setpwSigninLink) setpwSigninLink.style.display = "block";
      return;
    }

    const email = userData.user.email;

    const { error } = await supabase.auth.updateUser({ password: pwd });
    if (error) {
      console.error("[finish-signup] updateUser error", error);
      setStatus(error.message || "Could not update password.", "error");
      if (btnSetPassword) btnSetPassword.disabled = false;
      return;
    }

    // NEW: use success kind so it pops
    setStatus("✅ Password saved. Redirecting you to sign in…", "success");

    await supabase.auth.signOut();

    const origin = getAuthOrigin();
    const dest = new URL("auth.html", origin);
    dest.searchParams.set("mode", "signin");
    if (email) dest.searchParams.set("email", email);
    dest.searchParams.set("password_set", "1");
    window.location.href = dest.toString();
  } catch (err) {
    console.error("[finish-signup] unexpected set-password error", err);
    setStatus("Unexpected error updating password.", "error");
    if (btnSetPassword) btnSetPassword.disabled = false;
  }
});

// boot
init().catch((err) => {
  console.error("[finish-signup] init error", err);
  setStatus("Something went wrong loading this page.", "error");
});

console.log("[finish-signup] ready");
