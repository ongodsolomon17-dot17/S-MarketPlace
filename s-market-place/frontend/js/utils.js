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

/* ----------------------------------------------------------------------------
   Prices, stock labels and the "price slash" calculator
   ---------------------------------------------------------------------------- */

/** Percent taken off, e.g. (200000, 140000) → 30. Returns 0 when there is no real discount. */
function discountPercent(original, price) {
  original = Number(original);
  price = Number(price);
  if (!(original > 0) || !(price < original)) return 0;
  return Math.round(((original - price) / original) * 100);
}

/**
 * The price as HTML. With a price slash it shows:  ~~₦200,000.00~~  ₦140,000.00  [30% OFF]
 * Works for products and Fast Finger deals (anything with price / original_price).
 */
function priceHTML(item) {
  const price = `<strong class="price">${formatPrice(item.price)}</strong>`;
  if (!item.original_price || Number(item.original_price) <= Number(item.price)) return price;
  const percent = item.discount_percent || discountPercent(item.original_price, item.price);
  return `<span class="price-block"><span class="price-old">${formatPrice(item.original_price)}</span>${price}<span class="off-badge">${percent}% OFF</span></span>`;
}

/** The small "-30%" ribbon on a picture (empty text when there is no price slash). */
function ribbonHTML(item) {
  if (!item.original_price || Number(item.original_price) <= Number(item.price)) return "";
  return `<span class="off-ribbon">-${item.discount_percent || discountPercent(item.original_price, item.price)}%</span>`;
}

/**
 * What to say about the stock. When the trader chose to hide the quantity the server sends
 * stock = null, so we only say "In stock".
 */
function stockLabel(product) {
  if (!product.available) return "Sold out";
  return product.stock === null || product.stock === undefined ? "In stock" : `Available · ${Number(product.stock)} left`;
}

/** Seconds → "02:15:30" (or "15:30" under an hour). */
function formatCountdown(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = number => String(number).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

/*
 * The "price slash" calculator used by BOTH the product editor and the deal form.
 * Each group has three elements whose ids start with the same prefix:
 *     <prefix>-original   the original price
 *     <prefix>-percent    the percent off
 *     <prefix>-preview    a line that shows the resulting price
 */

/** Read the group and work out the selling price. Returns { price, original, percent, error }. */
function readSlash(prefix) {
  const original = Number(document.getElementById(`${prefix}-original`).value);
  const percent = Number(document.getElementById(`${prefix}-percent`).value);
  if (!(original > 0)) return { error: "Enter the original price." };
  if (!(percent >= 1 && percent <= 95)) return { error: "Enter a discount between 1% and 95%." };
  const price = Math.round(original * (100 - percent)) / 100;   // 2 decimal places
  return { price, original, percent };
}

/** Update the preview line as the trader types. */
function refreshSlashPreview(prefix) {
  const preview = document.getElementById(`${prefix}-preview`);
  const result = readSlash(prefix);
  preview.textContent = result.error
    ? "Enter the original price and the percent off to see the new price."
    : `${result.percent}% off ${formatPrice(result.original)} = ${formatPrice(result.price)}`;
}
