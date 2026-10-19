"use strict";
/* ============================================================================
   deals.js — FAST FINGER: short, time-limited price-slash deals.

   • Everyone can see the deals, each with a live countdown.
   • Traders can post a deal, mark it "Sold", or delete it.
   • When the countdown reaches zero the deal shows "Ended". Ended and sold deals
     stay visible for 24 hours, then the SERVER deletes them (see backend/deal_service.py).
   ============================================================================ */

let dealTimer = null;   // the 1-second ticker that updates the countdowns (runs only while this screen is open)

/* ----------------------------------------------------------------------------
   The Fast Finger screen
   ---------------------------------------------------------------------------- */
/** One deal card. `deal.status` is "live", "ended" or "sold" (decided by the server). */
function dealCardHTML(deal) {
  const live = deal.status === "live";
  const isOwner = Boolean(currentUser && currentUser.role === "trader" && currentUser.id === deal.trader_id);
  const image = imageURL(deal.image);
  const label = deal.status === "sold" ? "Sold" : "Ended";
  // The countdown element carries the exact moment it ends (browser clock), so the ticker can just subtract.
  const endsAt = Date.now() + deal.seconds_left * 1000;

  const timer = live
    ? `<span class="deal-timer" data-deal-end="${endsAt}">⏱ ${formatCountdown(deal.seconds_left)}</span>`
    : `<span class="deal-timer is-over">${label}</span>`;

  const ownerButtons = isOwner ? `
    <div class="deal-owner-actions">
      ${deal.status !== "sold" ? `<button class="outline-button" type="button" data-deal-sold="${deal.id}">Mark as sold</button>` : ""}
      <button class="remove-button" type="button" data-deal-delete="${deal.id}">Delete</button>
    </div>` : "";

  return `
    <article class="product-card deal-card is-${deal.status}">
      <div class="product-image-wrap">
        ${image
          ? `<img class="product-image" src="${escapeHTML(image)}" alt="${escapeHTML(deal.title)}" loading="lazy" onerror="this.style.display='none'">`
          : '<div class="image-placeholder">⚡<small>Fast Finger</small></div>'}
        ${ribbonHTML(deal)}
        ${live ? "" : `<span class="deal-stamp">${label}</span>`}
      </div>
      <div class="product-details">
        <p class="product-category"><button class="inline-store-link" type="button" data-open-store="${escapeHTML(deal.trader_username)}">${escapeHTML(deal.store_name || "Trader shop")}</button></p>
        <h3>${escapeHTML(deal.title)}</h3>
        <!-- two lines are visible; tapping the text shows the rest -->
        <p class="product-description" data-toggle-description>${escapeHTML(deal.description || "A limited-time price slash.")}</p>
        <div class="product-bottom">${priceHTML(deal)}</div>
        <div class="deal-timer-row">${timer}</div>
        ${ownerButtons}
      </div>
    </article>`;
}

/** Load and draw all deals, then start the countdown ticker. */
async function renderDeals() {
  const grid = document.getElementById("deals-grid");
  // Only traders see the "Post a deal" button.
  document.getElementById("deals-actions").innerHTML = currentUser && currentUser.role === "trader"
    ? '<button class="primary-button" type="button" data-open-deal-editor>⚡ Post a deal</button>'
    : "";
  grid.innerHTML = '<p class="muted">Loading deals…</p>';
  try {
    const { deals } = await apiRequest("/api/deals");
    grid.innerHTML = deals.length
      ? deals.map(dealCardHTML).join("")
      : '<div class="empty-state"><h2>No deals right now.</h2><p>Check back soon: traders post limited-time price slashes here.</p></div>';
    if (activePage === "deals") startDealTimer();   // the shopper may have left the screen while it loaded
  } catch (error) {
    grid.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

/* ----------------------------------------------------------------------------
   Countdown ticker
   ---------------------------------------------------------------------------- */
function startDealTimer() {
  stopDealTimer();
  dealTimer = setInterval(tickDeals, 1000);
}

function stopDealTimer() {
  if (dealTimer) { clearInterval(dealTimer); dealTimer = null; }
}

/** Runs every second: refresh each visible countdown, and flip a card to "Ended" when it reaches zero. */
function tickDeals() {
  const now = Date.now();
  document.querySelectorAll("[data-deal-end]").forEach(element => {
    const secondsLeft = (Number(element.dataset.dealEnd) - now) / 1000;
    if (secondsLeft > 0) {
      element.textContent = `⏱ ${formatCountdown(secondsLeft)}`;
      element.classList.toggle("is-urgent", secondsLeft < 300);   // turns red in the last 5 minutes
    } else {
      markDealEnded(element);
    }
  });
}

/** The countdown hit zero while the shopper was watching: grey the card out and stamp it "Ended". */
function markDealEnded(timerElement) {
  const card = timerElement.closest(".deal-card");
  timerElement.removeAttribute("data-deal-end");
  timerElement.classList.remove("is-urgent");
  timerElement.classList.add("is-over");
  timerElement.textContent = "Ended";
  if (!card) return;
  card.classList.replace("is-live", "is-ended");
  card.querySelector(".product-image-wrap")?.insertAdjacentHTML("beforeend", '<span class="deal-stamp">Ended</span>');
}

/* ----------------------------------------------------------------------------
   Posting, selling and deleting (traders only)
   ---------------------------------------------------------------------------- */
function openDealEditor() {
  if (!currentUser || currentUser.role !== "trader") { showToast("Only traders can post deals."); return; }
  document.getElementById("deal-form").reset();
  document.getElementById("deal-feedback").textContent = "";
  refreshSlashPreview("deal");
  document.getElementById("deal-overlay").hidden = false;
}

function closeDealEditor() {
  document.getElementById("deal-overlay").hidden = true;
}

/** Send the new deal to the server. The server works out the end time from the chosen duration. */
async function saveDeal(event) {
  event.preventDefault();
  const feedback = document.getElementById("deal-feedback");
  const byId = id => document.getElementById(id);

  const slash = readSlash("deal");   // original price + percent off → the deal price
  if (slash.error) { feedback.textContent = slash.error; return; }

  const data = {
    title: byId("deal-title").value.trim(),
    description: byId("deal-description").value.trim(),
    image: byId("deal-image").value.trim(),
    original_price: slash.original,
    price: slash.price,
    duration_minutes: Number(byId("deal-duration").value)
  };
  try {
    const file = byId("deal-image-file").files[0];
    if (file) {                                             // upload the picture first, then save its link
      const body = new FormData();
      body.append("image", file);
      data.image = (await apiRequest("/api/upload-image", { method: "POST", body })).url;
    }
    const result = await apiRequest("/api/trader/deals", { method: "POST", body: JSON.stringify(data) });
    closeDealEditor();
    showToast(result.message);
    renderDeals();
  } catch (error) {
    feedback.textContent = error.message;
  }
}

/** Mark a deal as sold (the countdown stops and the deal shows "Sold"). */
async function markDealSold(id) {
  try {
    const result = await apiRequest(`/api/trader/deals/${id}/sold`, { method: "POST", body: JSON.stringify({}) });
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
  renderDeals();
}

/** Delete a deal right away. */
async function deleteDeal(id) {
  if (!confirm("Delete this deal?")) return;
  try {
    const result = await apiRequest(`/api/trader/deals/${id}`, { method: "DELETE" });
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
  renderDeals();
}
