"use strict";
/* ============================================================================
   api.js — talking to the Flask backend (Render), login token, guest "visitor id".
   ============================================================================ */

/** The signed-in user, or null for guests. Shared by all files. */
let currentUser = null;

const TOKEN_KEY = "smpAuthToken";     // the login token is kept in this browser's local storage
const VISITOR_KEY = "smpVisitorId";   // a random id so the "For you" feed can learn a guest's taste

/** A random id for this browser (created once). It never contains personal information. */
function getVisitorId() {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = "v" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch (_) {
    return "";   // storage blocked (private mode): the feed simply stays generic
  }
}

/**
 * Call the backend and return its JSON. Throws an Error whose message is safe to show the user.
 * `error.status` holds the HTTP status (401 = please sign in).
 */
async function apiRequest(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const visitorId = getVisitorId();
  if (visitorId) headers["X-Visitor-Id"] = visitorId;
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";

  const base = String(window.SMP_API_BASE_URL || "").replace(/\/$/, "");
  let response;
  try {
    response = await fetch(`${base}${url}`, { ...options, headers });
  } catch (_) {
    throw new Error("Could not reach the server. Check your connection and try again. (The server can take up to a minute to wake up.)");
  }

  let data = {};
  try { data = await response.json(); } catch (_) { /* the server sent a non-JSON page */ }
  if (!response.ok) {
    const error = new Error(data.error || "Something went wrong.");
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

/**
 * Tell the backend what the shopper just did ("view", "cart" or "category") so the
 * "For you" feed can adapt. Fire-and-forget: a failure must never disturb the shopper.
 */
function trackInteraction(kind, details = {}) {
  apiRequest("/api/interactions", { method: "POST", body: JSON.stringify({ kind, ...details }) }).catch(() => {});
}
