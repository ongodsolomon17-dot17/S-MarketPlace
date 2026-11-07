"use strict";
/* ============================================================================
   community.js — shop pages, Follow, buyer ratings, the Verified badge and the chat link.

   • A shop page shows the trader's stats, star rating and (if the superadmin gave it) a Verified badge.
   • Anyone signed in can follow a shop.
   • A buyer can rate a trader once per item, after confirming they received it.
   • "Message" opens YOUR chat app once its address is set in config.js (SMP_CHAT_URL).
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Small pieces used in several places
   ---------------------------------------------------------------------------- */
function verifiedBadgeHTML(isVerified, compact = false) {
  if (!isVerified) return "";
  return `<span class="verified-badge${compact ? " compact" : ""}" title="Verified trader">✔${compact ? "" : " Verified"}</span>`;
}

function starsText(value) {
  const filled = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
  return "★".repeat(filled) + "☆".repeat(5 - filled);
}

function ratingSummaryHTML(rating, count) {
  if (!count) return '<span class="rating-line muted">No ratings yet</span>';
  return `<span class="rating-line"><span class="stars" aria-hidden="true">${starsText(rating)}</span> <strong>${Number(rating).toFixed(1)}</strong> <small>(${count} rating${count === 1 ? "" : "s"})</small></span>`;
}

/* ----------------------------------------------------------------------------
   Chat link (your existing chat app plugs in here)
   ---------------------------------------------------------------------------- */
function chatURL(params = {}) {
  const base = String(window.SMP_CHAT_URL || "").trim();
  if (!/^https?:\/\//i.test(base)) return "";
  try {
    const url = new URL(base);
    Object.entries(params).forEach(([key, value]) => { if (value) url.searchParams.set(key, value); });
    return url.toString();
  } catch (_) { return ""; }
}

function chatIsReady() { return Boolean(chatURL()); }

/** Open the chat app (optionally straight to a conversation with one trader). */
function openChat(withUsername = "") {
  if (!chatIsReady()) { showToast("Chat is coming soon."); return; }
  if (!currentUser) { showToast("Please log in to send a message."); openAuth("login"); return; }
  const url = chatURL({ with: withUsername, from: currentUser.username });
  window.open(url, "_blank", "noopener");
}

function refreshChatStatus() {
  const label = document.getElementById("chat-status");
  if (label) label.textContent = chatIsReady() ? "Open chat" : "Coming soon";
}

/* ----------------------------------------------------------------------------
   A trader's public shop page
   ---------------------------------------------------------------------------- */
function storeProfileHTML(shop) {
  const initial = escapeHTML((shop.store_name || shop.username || "S").slice(0, 1).toUpperCase());
  const avatar = shop.profile_image
    ? `<img src="${escapeHTML(shop.profile_image)}" alt="" class="avatar-image">`
    : initial;
  const joined = shop.joined ? `Joined ${escapeHTML(new Date(shop.joined).toLocaleDateString(undefined, { month: "short", year: "numeric" }))}` : "";
  const actions = shop.is_mine
    ? '<p class="store-own-note">This is how buyers see your shop.</p>'
    : `<button type="button" class="${shop.following ? "outline-button" : "primary-button"}" data-follow-shop="${escapeHTML(shop.username)}" data-following="${shop.following}">${shop.following ? "Following ✓" : "Follow"}</button>
       <button type="button" class="outline-button" data-message-trader="${escapeHTML(shop.username)}">Message${chatIsReady() ? "" : " · Soon"}</button>
       <button type="button" class="outline-button" data-share-shop="${escapeHTML(shop.username)}">Share</button>`;
  return `
    <div class="store-cover" aria-hidden="true"></div>
    <div class="store-card">
      <div class="store-avatar" aria-hidden="true">${avatar}</div>
      <div class="store-head">
        <h1>${escapeHTML(shop.store_name)}</h1>
        ${verifiedBadgeHTML(shop.is_verified)}
        <p class="store-handle">@${escapeHTML(shop.username)}${joined ? ` · ${joined}` : ""}</p>
        ${ratingSummaryHTML(shop.rating, shop.rating_count)}
      </div>
      <p class="store-bio">${escapeHTML(shop.store_description || "Explore the products listed by this trader.")}</p>
      <div class="store-stats">
        <div><strong>${shop.products}</strong><span>Products</span></div>
        <div><strong id="shop-followers">${shop.followers}</strong><span>Followers</span></div>
        <div><strong>${shop.sold}</strong><span>Sold</span></div>
      </div>
      <div class="store-actions">${actions}</div>
      <p class="store-trust">${shop.is_verified
        ? "✔ Verified by S-Market Place. Payments are held in escrow until you confirm delivery."
        : "Payments are held in escrow until you confirm delivery. Ratings come only from buyers who received their orders."}</p>
    </div>`;
}

/** Open one trader's public shop page. `backTo` is the screen the arrow returns to. */
async function openStore(username, backTo = "home") {
  if (!username) return;
  showPage("store");
  const back = document.querySelector("#page-store .page-back-button");
  if (back) back.dataset.pageLink = backTo;
  const profile = document.getElementById("store-profile");
  const grid = document.getElementById("store-products");
  const reviews = document.getElementById("store-reviews");
  profile.innerHTML = '<p class="muted">Loading this shop…</p>';
  grid.innerHTML = "";
  reviews.hidden = true;
  try {
    const [{ shop }, { products }] = await Promise.all([
      apiRequest(`/api/shops/${encodeURIComponent(username)}`),
      apiRequest(`/api/products?trader=${encodeURIComponent(username)}&limit=100`)
    ]);
    profile.innerHTML = storeProfileHTML(shop);
    grid.innerHTML = products.length ? products.map(productCardHTML).join("") : '<p class="muted">This trader has no items on sale right now.</p>';
    if (shop.rating_count) loadShopReviews(username);
  } catch (error) {
    profile.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

function openMyStore() {
  if (currentUser?.username) openStore(currentUser.username, "trader-management");
}

async function loadShopReviews(username) {
  const panel = document.getElementById("store-reviews");
  const list = document.getElementById("store-reviews-list");
  try {
    const { reviews } = await apiRequest(`/api/shops/${encodeURIComponent(username)}/reviews?limit=10`);
    panel.hidden = reviews.length === 0;
    list.innerHTML = reviews.map(review => `
      <article class="review-row">
        <div class="review-top"><span class="stars" aria-label="${review.stars} out of 5">${starsText(review.stars)}</span><small>${escapeHTML(review.buyer)} · ${escapeHTML(formatDate(review.created_at))}</small></div>
        ${review.comment ? `<p>${escapeHTML(review.comment)}</p>` : ""}
        <small class="muted">${escapeHTML(review.product_name)}</small>
      </article>`).join("");
  } catch (_) { panel.hidden = true; }
}

/* ----------------------------------------------------------------------------
   Follow / unfollow, share
   ---------------------------------------------------------------------------- */
async function toggleFollowShop(button) {
  if (!currentUser) { showToast("Log in to follow shops."); openAuth("login"); return; }
  const username = button.dataset.followShop;
  const following = button.dataset.following === "true";
  button.disabled = true;
  try {
    const result = await apiRequest(`/api/shops/${encodeURIComponent(username)}/follow`, { method: following ? "DELETE" : "POST", body: JSON.stringify({}) });
    button.dataset.following = String(result.following);
    button.textContent = result.following ? "Following ✓" : "Follow";
    button.className = result.following ? "outline-button" : "primary-button";
    const count = document.getElementById("shop-followers");
    if (count) count.textContent = result.followers;
  } catch (error) {
    showToast(error.message);
  }
  button.disabled = false;
}

async function shareShop(username) {
  const url = `${window.location.origin}${window.location.pathname}?shop=${encodeURIComponent(username)}`;
  try {
    if (navigator.share) { await navigator.share({ title: "S-Market Place shop", url }); return; }
    await navigator.clipboard.writeText(url);
    showToast("Shop link copied.");
  } catch (_) { /* the person closed the share sheet */ }
}

/* ----------------------------------------------------------------------------
   Rating a trader (buyer, after confirming delivery)
   ---------------------------------------------------------------------------- */
let ratingItemId = null;
let ratingStars = 0;

function paintRatingStars() {
  document.querySelectorAll("#star-picker [data-star]").forEach(star => {
    const on = Number(star.dataset.star) <= ratingStars;
    star.classList.toggle("is-on", on);
    star.setAttribute("aria-checked", String(Number(star.dataset.star) === ratingStars));
  });
}

function openRating(itemId) {
  const item = orderItems[itemId];
  if (!item) return;
  ratingItemId = String(itemId);
  ratingStars = 0;
  paintRatingStars();
  document.getElementById("rating-subtitle").textContent = `${item.name} · ${item.store_name || "trader"}`;
  document.getElementById("rating-comment").value = "";
  document.getElementById("rating-feedback").textContent = "";
  document.getElementById("rating-overlay").hidden = false;
}

function closeRating() { document.getElementById("rating-overlay").hidden = true; }

async function submitRating() {
  const feedback = document.getElementById("rating-feedback");
  if (!ratingStars) { feedback.textContent = "Tap a star to choose your rating."; return; }
  const button = document.querySelector("[data-submit-rating]");
  button.disabled = true;
  try {
    const result = await apiRequest(`/api/orders/items/${ratingItemId}/rating`, {
      method: "POST", body: JSON.stringify({ stars: ratingStars, comment: document.getElementById("rating-comment").value.trim() })
    });
    showToast(result.message);
    closeRating();
    renderOrders();
  } catch (error) {
    feedback.textContent = error.message;
  }
  button.disabled = false;
}
