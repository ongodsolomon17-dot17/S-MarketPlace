"use strict";
/* ============================================================================
   utils.js — small helpers used by every other file.
   (Scripts are loaded in order by index.html: utils → api → navigation → cart →
    products → auth → seller → orders → main.)
   ============================================================================ */

let toastTimeout;

/** Escape text before putting it into HTML, so user-written text can never inject code. */
function escapeHTML(value) {
  const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, char => replacements[char]);
}

/** Show prices in Nigerian naira, e.g. ₦12,500.00 */
function formatPrice(value) {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 2 })
    .format(Number(value || 0));
}

/** Show a date/time from the server in a friendly way. */
function formatDate(value) {
  return value ? new Date(value).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }) : "";
}

/** Show a short message at the bottom of the screen after an action. */
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

/** Turn a stored image value into a usable URL (uploaded https links, or files kept in /images). */
function imageURL(value) {
  if (!value) return "";
  return value.startsWith("http") ? value : `/images/${value.replace(/^images\//, "")}`;
}
