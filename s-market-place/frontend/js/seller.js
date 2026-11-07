"use strict";
/* ============================================================================
   seller.js — the trader's screen.

   The screen is kept short and tidy:
     • an "+ Add product" button (the form only opens when it is tapped)
     • "Your listed products": just name, price, quantity left and an Edit button (+ a "Paused" tag)
     • "Recently deleted": deleted products with a 30-day countdown and a Restore button
     • "Orders to fulfil": the buyer, the delivery condition and a Save update button

   The SAME pop-up form is used to add a product and to edit one.
   ============================================================================ */

const NEW_CATEGORY_VALUE = "__new__";   // the "my category isn't listed" choice in the dropdown
let editingProductId = null;            // the product being edited, or null while adding a new one
let ownedProducts = {};
let traderSubscription = null;
let traderSubscriptionLoaded = false;
let traderHasEverSubscribed = false;
let subscriptionReminderShownForUser = null;
let traderSubscriptionUserId = null;

/* ----------------------------------------------------------------------------
   Category picker: choose from the list, or type a new category
   ---------------------------------------------------------------------------- */
/** Fill the dropdown with every category in the system (plus the "type it" option). */
async function loadCategoryOptions() {
  const select = document.getElementById("pe-category");
  const previous = select.value;
  try {
    const { categories } = await apiRequest("/api/categories");
    select.innerHTML = '<option value="">Choose a category…</option>'
      + categories.map(category => `<option value="${escapeHTML(category.name)}">${escapeHTML(category.name)}</option>`).join("")
      + `<option value="${NEW_CATEGORY_VALUE}">➕ My category isn't listed — I'll type it</option>`;
    select.value = previous;   // keep the choice if the list was refreshed
    toggleCustomCategory();
  } catch (error) {
    console.error(error);
  }
}

/** Show the text box only when "type it" is chosen. */
function toggleCustomCategory() {
  const select = document.getElementById("pe-category");
  const custom = document.getElementById("pe-category-custom");
  const typing = select.value === NEW_CATEGORY_VALUE;
  custom.hidden = !typing;
  custom.required = typing;
  if (typing) custom.focus();
}

/* ----------------------------------------------------------------------------
   The trader screen
   ---------------------------------------------------------------------------- */
async function loadTraderDashboard() {
  if (!currentUser || currentUser.role !== "trader") {
    showToast("Please sign in with a trader account to manage a shop.");
    openAuth("trader");
    return;
  }
  document.getElementById("dashboard-store-name").textContent = currentUser.store_name || "Your shop";
  document.getElementById("trader-profile-name").textContent =
    [currentUser.first_name, currentUser.last_name].filter(Boolean).join(" ") || "Trader account";
  document.getElementById("trader-profile-handle").textContent = currentUser.username
    ? "@" + currentUser.username
    : "";
  document.getElementById("trader-profile-avatar").innerHTML = avatarHTML(currentUser);

  const subscriptionTask = traderSubscriptionUserId === currentUser.id && traderSubscriptionLoaded
    ? Promise.resolve()
    : loadTraderSubscription();
  await Promise.all([subscriptionTask, loadOwnedProducts(), loadTraderSummary()]);
}

function openTraderCreatePanel() {
  if (!currentUser || currentUser.role !== "trader") { openAuth("trader"); return; }
  document.getElementById("trader-create-overlay").hidden = false;
}

function closeTraderCreatePanel() {
  const panel = document.getElementById("trader-create-overlay");
  if (panel) panel.hidden = true;
}

function closeTraderSubscriptionModal() {
  const overlay = document.getElementById("trader-subscription-overlay");
  if (overlay) overlay.hidden = true;
}

async function openTraderSubscriptionModal() {
  if (!currentUser || currentUser.role !== "trader") return;
  if (traderSubscriptionUserId !== currentUser.id || !traderSubscriptionLoaded) await loadTraderSubscription();
  const overlay = document.getElementById("trader-subscription-overlay");
  if (overlay) overlay.hidden = false;
}

function syncSubscriptionCrown() {
  const button = document.getElementById("header-subscription-button");
  if (!button) return;
  const trader = Boolean(currentUser && currentUser.role === "trader");
  const status = traderSubscription?.status;
  const expiry = status === "trial"
    ? traderSubscription?.trial_ends_at
    : traderSubscription?.current_period_ends_at;
  const daysLeft = expiry ? Math.ceil((Date.parse(expiry) - Date.now()) / 86400000) : null;
  const withinReminderWindow = daysLeft !== null && daysLeft <= 5;
  const expired = status === "expired" || status === "cancelled";
  button.hidden = !trader || !(withinReminderWindow || expired);
  if (button.hidden) closeTraderSubscriptionModal();
}

function maybeShowDailySubscriptionReminder() {
  if (!currentUser || currentUser.role !== "trader" || traderHasEverSubscribed) return;
  if (subscriptionReminderShownForUser === currentUser.id) return;
  subscriptionReminderShownForUser = currentUser.id;

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const key = `smpSubscriptionReminder:${currentUser.id}`;
  let lastShown = "";
  try { lastShown = localStorage.getItem(key) || ""; } catch (_) { /* show reminder if storage is unavailable */ }
  if (lastShown === today) return;
  try { localStorage.setItem(key, today); } catch (_) { /* session guard above still prevents repeat popups */ }
  const overlay = document.getElementById("trader-subscription-overlay");
  if (overlay) overlay.hidden = false;
}

async function loadTraderFinance() {
  if (!currentUser || currentUser.role !== "trader") { openAuth("trader"); return; }
  await Promise.all([loadEarnings(), loadFinanceNotifications()]);
}

async function loadTraderManagement() {
  if (!currentUser || currentUser.role !== "trader") { openAuth("trader"); return; }
  await loadTraderSummary();
}

/** The whole notifications list (More → Notifications). */
async function loadTraderNotificationsPage() {
  if (!currentUser || currentUser.role !== "trader") { openAuth("trader"); return; }
  const panel = document.getElementById("notifications-panel");
  await loadNotifications(panel, 100);
  document.getElementById("notifications-empty").hidden = !panel.hidden;
}

/** Counts for the dashboard (followers, following, messages) and the More screen tiles. */
let traderSummary = null;
async function loadTraderSummary() {
  try {
    traderSummary = await apiRequest("/api/trader/summary");
  } catch (_) { return; }
  const set = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  set("stat-followers", traderSummary.followers);
  set("stat-following", traderSummary.following);
  document.querySelectorAll("[data-tile-count]").forEach(tile => {
    const value = traderSummary[tile.dataset.tileCount] ?? 0;
    tile.textContent = value;
    tile.hidden = value === 0;
  });
  const verified = document.getElementById("dashboard-verified");
  if (verified) verified.hidden = !traderSummary.is_verified;
  if (currentUser) currentUser.is_verified = traderSummary.is_verified;
  refreshChatStatus();
}

async function loadTraderSubscription() {
  const target = document.getElementById("trader-subscription-content");
  if (!currentUser || currentUser.role !== "trader") return;
  if (traderSubscriptionUserId !== currentUser.id) {
    traderSubscriptionUserId = currentUser.id;
    traderSubscription = null;
    traderSubscriptionLoaded = false;
    traderHasEverSubscribed = false;
  }

  try {
    const {
      subscription,
      plans,
      payments_enabled: paymentsEnabled,
      has_ever_subscribed: hasEverSubscribed
    } = await apiRequest("/api/trader/subscription");
    const paymentAvailable = paymentsEnabled !== false;
    traderSubscription = subscription || null;
    traderHasEverSubscribed = Boolean(hasEverSubscribed);
    traderSubscriptionLoaded = true;
    updateTraderProIndicators();
    syncSubscriptionCrown();

    if (!subscription) {
      const statusPill = document.getElementById("trader-subscription-status");
      statusPill.textContent = "Plan unavailable";
      statusPill.classList.add("is-expired");
      target.innerHTML = '<p class="muted">No subscription record was found for this trader account.</p>';
      maybeShowDailySubscriptionReminder();
      return;
    }

    const statusLabels = {
      trial: "Free trial",
      active: "Active",
      expired: "Expired",
      cancelled: "Cancelled"
    };
    const status = statusLabels[subscription.status] || "Subscription";
    const statusPill = document.getElementById("trader-subscription-status");
    statusPill.textContent = status;
    statusPill.classList.toggle("is-expired", subscription.status === "expired" || subscription.status === "cancelled");
    statusPill.classList.toggle("is-active", subscription.status === "trial" || subscription.status === "active");
    const endDate = subscription.status === "trial"
      ? subscription.trial_ends_at
      : (subscription.current_period_ends_at || subscription.trial_ends_at);
    const endLabel = subscription.status === "trial"
      ? "Trial ends"
      : subscription.status === "active"
        ? "Paid access through"
        : "Access ended";
    const periodStillActive =
      subscription.status === "active"
      && subscription.current_period_ends_at
      && Date.parse(subscription.current_period_ends_at) > Date.now();
    const canChoosePlan = !periodStillActive;
    const selectedPlan = subscription.plan === "yearly" ? "yearly" : "monthly";

    target.innerHTML = `
      <p><strong>Status:</strong> ${status}</p>
      ${endDate ? `<p><strong>${endLabel}:</strong> ${escapeHTML(formatDate(endDate))}</p>` : ""}
      ${subscription.status === "active"
        ? `<p><strong>Auto-renew:</strong> ${subscription.auto_renew ? "On" : "Off"}</p>`
        : ""}
      ${subscription.status === "expired"
        ? '<p class="muted">Existing products can still be viewed and edited, and available payouts can still be requested. Adding products and posting Fast Finger deals require an active subscription.</p>'
        : ""}
      <div class="earn-grid">
        <div class="earn-box"><span>Monthly</span><strong>${plans.monthly ? formatPrice(plans.monthly) : "Unavailable"}</strong></div>
        <div class="earn-box"><span>Yearly</span><strong>${plans.yearly ? formatPrice(plans.yearly) : "Unavailable"}</strong></div>
      </div>

      ${!paymentAvailable
        ? '<p class="subscription-setup-note" role="status">Online subscription payments are being set up. Your marketplace owner needs to connect Paystack before you can subscribe.</p>'
        : subscription.auto_renew && periodStillActive
        ? `<p class="muted">Your subscription will renew automatically. You can turn this off and keep access until the paid period ends.</p>
           <button class="outline-button" type="button" data-subscription-renewal-off>Turn off auto-renew</button>`
        : canChoosePlan
          ? `<p class="muted">${subscription.status === "trial"
              ? "Choosing a plan starts paid access immediately."
              : "Choose a plan to restore Pro access."}</p>
             <fieldset class="subscription-choice">
               <legend>Choose a plan</legend>
               <label><input type="radio" name="trader-subscription-plan" value="monthly" ${selectedPlan === "monthly" ? "checked" : ""}> Monthly</label>
               <label><input type="radio" name="trader-subscription-plan" value="yearly" ${selectedPlan === "yearly" ? "checked" : ""}> Yearly</label>
             </fieldset>
             <label class="subscription-choice">
               <input type="checkbox" id="trader-subscription-auto-renew">
               Turn on auto-renew
             </label>
             <button class="primary-button" type="button" data-subscription-checkout>Continue to payment</button>`
          : '<p class="muted">Your paid period is still active. You can renew after it ends.</p>'}`;
    maybeShowDailySubscriptionReminder();
  } catch (error) {
    traderSubscriptionLoaded = false;
    updateTraderProIndicators();
    const statusPill = document.getElementById("trader-subscription-status");
    if (statusPill) { statusPill.textContent = "Unavailable"; statusPill.classList.add("is-expired"); }
    syncSubscriptionCrown();
    target.textContent = error.message;
  }
}

function traderHasProAccess() {
  return Boolean(traderSubscription && traderSubscription.can_add_products);
}

function updateTraderProIndicators() {
  const locked = !traderHasProAccess();
  document.querySelectorAll("[data-pro-badge]").forEach(badge => {
    badge.hidden = !locked;
  });
}

function showSubscriptionUpgrade(feature) {
  showToast("An active trial or subscription is required to " + feature + ". Choose a plan from the crown icon.");
  openTraderSubscriptionModal();
}

async function startTraderSubscriptionCheckout() {
  const button = document.querySelector("[data-subscription-checkout]");
  const selectedPlan = document.querySelector(
    'input[name="trader-subscription-plan"]:checked'
  );
  const autoRenew = document.getElementById("trader-subscription-auto-renew");

  if (!selectedPlan) {
    showToast("Choose a subscription plan first.");
    return;
  }

  const renewEnabled = Boolean(autoRenew?.checked);
  const confirmation = renewEnabled
    ? "You’ll be sent to Paystack to pay for this plan. It will renew automatically until you turn auto-renew off. Continue?"
    : "You’ll be sent to Paystack to pay for this plan. Continue?";

  if (!confirm(confirmation)) return;

  button.disabled = true;

  try {
    const result = await apiRequest("/api/trader/subscription/checkout", {
      method: "POST",
      body: JSON.stringify({
        plan: selectedPlan.value,
        auto_renew: renewEnabled
      })
    });

    window.location.href = result.checkout_url;
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

async function disableTraderSubscriptionAutoRenew() {
  const button = document.querySelector("[data-subscription-renewal-off]");

  if (!confirm("Turn off auto-renew? Your paid access will continue until its end date.")) {
    return;
  }

  button.disabled = true;

  try {
    const result = await apiRequest(
      "/api/trader/subscription/auto-renew/disable",
      { method: "POST", body: JSON.stringify({}) }
    );

    showToast(result.message);
    await loadTraderSubscription();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

/* ----------------------------------------------------------------------------
   Search + sort tools (used by the product lists and the order lists)
   Each list has a "scope"; its search text and sort choice are remembered here.
   ---------------------------------------------------------------------------- */
const listState = {};
function listStateFor(scope) {
  if (!listState[scope]) listState[scope] = { query: "", sort: "newest" };
  return listState[scope];
}

function productCode(product) { return `PRD-${product.id}`; }

/** Does `text` match every word typed (or the exact product ID, like PRD-101 / 101)? */
function matchesSearch(haystack, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(word => haystack.includes(word));
}

function filterProducts(products, query) {
  if (!query.trim()) return products;
  return products.filter(product => matchesSearch(`${product.name} ${product.category} ${productCode(product)} ${product.id}`.toLowerCase(), query));
}

function sortProducts(products, sort) {
  const list = [...products];
  const by = {
    newest: (a, b) => b.id - a.id,
    oldest: (a, b) => a.id - b.id,
    name: (a, b) => a.name.localeCompare(b.name),
    "price-high": (a, b) => b.price - a.price,
    "price-low": (a, b) => a.price - b.price,
    "stock-low": (a, b) => a.stock - b.stock
  };
  return list.sort(by[sort] || by.newest);
}

function updateListCount(scope, shown, total, noun) {
  const label = document.querySelector(`[data-list-scope="${scope}"] + [data-list-count]`);
  if (!label) return;
  const word = total === 1 ? noun : `${noun}s`;
  label.textContent = shown === total ? `${total} ${word}` : `${shown} of ${total} ${word}`;
}

function closeSortMenus() {
  document.querySelectorAll(".sort-menu").forEach(menu => { menu.hidden = true; });
  document.querySelectorAll("[data-list-sort-toggle]").forEach(button => button.setAttribute("aria-expanded", "false"));
}

function renderListScope(scope) {
  if (scope.startsWith("products")) renderOwnedProducts();
  else renderTraderOrderLists();
}

/** Clicks on search/sort controls. Returns true when the click belonged to them. */
function handleListToolClick(target) {
  const toggle = target.closest("[data-list-sort-toggle]");
  if (toggle) {
    const menu = toggle.parentElement.querySelector(".sort-menu");
    const opening = menu.hidden;
    closeSortMenus();
    menu.hidden = !opening;
    toggle.setAttribute("aria-expanded", String(opening));
    return true;
  }
  const choice = target.closest("[data-list-sort-value]");
  if (choice) {
    const tools = choice.closest("[data-list-scope]");
    const scope = tools.dataset.listScope;
    listStateFor(scope).sort = choice.dataset.listSortValue;
    tools.querySelectorAll("[data-list-sort-value]").forEach(button => button.classList.toggle("is-active", button === choice));
    tools.querySelector("[data-sort-label]").textContent = choice.textContent;
    closeSortMenus();
    renderListScope(scope);
    return true;
  }
  const clear = target.closest("[data-list-clear]");
  if (clear) {
    const tools = clear.closest("[data-list-scope]");
    const input = tools.querySelector("[data-list-search]");
    input.value = "";
    handleListSearchInput(input);
    input.focus();
    return true;
  }
  if (!target.closest(".sort-wrap")) closeSortMenus();
  return false;
}

function handleListSearchInput(input) {
  const tools = input.closest("[data-list-scope]");
  const scope = tools.dataset.listScope;
  listStateFor(scope).query = input.value;
  tools.querySelector("[data-list-clear]").hidden = input.value === "";
  renderListScope(scope);
}

/* ----------------------------------------------------------------------------
   Product tiles (dashboard), rows (listed products) and the details pop-up
   ---------------------------------------------------------------------------- */
function productStatusText(product) {
  if (product.is_paused) return "Paused · hidden from buyers";
  if (product.stock <= 0) return "Sold out · hidden from buyers";
  return "Live · buyers can see it";
}

/** Product tile: picture, price, stock. Tap it to see the details; Edit opens the editor. */
function ownedProductHTML(product) {
  const quantity = product.stock > 0 ? `${product.stock} left` : "Sold out";
  const hint = product.show_quantity ? "" : " · buyers see “In stock”";
  const image = product.image ? imageURL(product.image) : "";
  return `
    <article class="owned-product-card">
      <div class="owned-product-media" data-view-owned-product="${product.id}" role="button" tabindex="0" aria-label="View ${escapeHTML(product.name)}">
        ${image
          ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(product.name)}" loading="lazy" onerror="this.style.display='none'">`
          : '<span class="owned-product-placeholder" aria-hidden="true">＋</span>'}
        ${product.is_paused ? '<span class="paused-badge">Paused</span>' : ""}
        <span class="owned-product-stock">${escapeHTML(quantity)}</span>
      </div>
      <div class="owned-product-card-body">
        <small>${escapeHTML(product.category || "Product")}</small>
        <strong data-view-owned-product="${product.id}" role="button" tabindex="0">${escapeHTML(product.name)}</strong>
        <span class="owned-product-price">${formatPrice(product.price)}</span>
        <small>${productCode(product)}${escapeHTML(hint)}</small>
        <button type="button" class="outline-button" data-edit-product="${product.id}">Edit product</button>
      </div>
    </article>`;
}

/** A slim row for the Listed products screen. */
function listedProductRowHTML(product) {
  const image = product.image ? imageURL(product.image) : "";
  const stock = product.stock > 0 ? `${product.stock} left` : "Sold out";
  return `
    <article class="listed-product">
      <button type="button" class="listed-thumb" data-view-owned-product="${product.id}" aria-label="View ${escapeHTML(product.name)}">${image
        ? `<img src="${escapeHTML(image)}" alt="" loading="lazy" onerror="this.style.display='none'">` : "▧"}</button>
      <div class="listed-info" data-view-owned-product="${product.id}" role="button" tabindex="0">
        <strong>${escapeHTML(product.name)}</strong>
        <small>${productCode(product)} · ${formatPrice(product.price)} · ${escapeHTML(stock)}${product.is_paused ? " · Paused" : ""}</small>
      </div>
      <button type="button" class="outline-button" data-edit-product="${product.id}">Edit</button>
    </article>`;
}

const EMPTY_PRODUCTS_HTML = '<div class="owned-products-empty"><span class="empty-product-icon" aria-hidden="true">▧</span><h3>No products listed yet</h3><p>Your products will appear here after you add them to your shop.</p><button class="primary-button" type="button" data-open-create-panel>Add your first product</button></div>';

function renderProductScope(scope, target, products, htmlFor) {
  if (!target) return;
  const state = listStateFor(scope);
  const shown = sortProducts(filterProducts(products, state.query), state.sort);
  updateListCount(scope, shown.length, products.length, "product");
  if (!products.length) target.innerHTML = EMPTY_PRODUCTS_HTML;
  else if (!shown.length) target.innerHTML = `<p class="muted list-empty">No products match “${escapeHTML(state.query)}”.</p>`;
  else target.innerHTML = shown.map(htmlFor).join("");
}

function renderOwnedProducts() {
  const products = Object.values(ownedProducts);
  renderProductScope("products-account", document.getElementById("trader-own-products"), products, ownedProductHTML);
  renderProductScope("products-listed", document.getElementById("trader-management-products"), products, listedProductRowHTML);
}

function openOwnedProductDetail(id) {
  const product = ownedProducts[id];
  if (!product) return;
  const image = product.image ? imageURL(product.image) : "";
  document.getElementById("owned-detail-body").innerHTML = `
    <div class="owned-detail-media">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(product.name)}" onerror="this.style.display='none'">` : '<span aria-hidden="true">▧</span>'}</div>
    <p class="eyebrow">${escapeHTML(product.category || "Product")} · ${productCode(product)}</p>
    <h2>${escapeHTML(product.name)}</h2>
    <div class="detail-price">${priceHTML(product)}</div>
    <dl class="owned-facts">
      <div><dt>Stock</dt><dd>${product.stock}</dd></div>
      <div><dt>Buyers see</dt><dd>${product.show_quantity ? "Exact quantity" : "“In stock”"}</dd></div>
      <div class="wide"><dt>Status</dt><dd>${escapeHTML(productStatusText(product))}</dd></div>
    </dl>
    <p class="detail-description">${escapeHTML(product.description || "No description yet.")}</p>
    <div class="order-actions"><button class="primary-button" type="button" data-edit-product="${product.id}">Edit product</button>
      <button class="outline-button" type="button" data-close-owned-product>Close</button></div>`;
  document.getElementById("owned-detail-overlay").hidden = false;
}

function closeOwnedProductDetail() {
  const overlay = document.getElementById("owned-detail-overlay");
  if (overlay) overlay.hidden = true;
}

/** One row in "Recently deleted": the name, how long until it is erased for good, and a Restore button. */
function deletedProductHTML(product) {
  const days = product.days_left === 1 ? "1 day" : `${product.days_left} days`;
  return `
    <article class="owned-product compact">
      <div class="owned-info">
        <strong>${escapeHTML(product.name)}</strong>
        <small>Erased for good in ${days}</small>
      </div>
      <button type="button" class="outline-button" data-restore-product="${product.id}">Restore</button>
    </article>`;
}

/** Load the trader's live + paused products, and the products waiting out their 30 days. */
async function loadOwnedProducts() {
  const productTargets = [document.getElementById("trader-own-products"), document.getElementById("trader-management-products")].filter(Boolean);
  const deletedPanel = document.getElementById("deleted-panel");
  productTargets.forEach(element => { element.innerHTML = '<p class="product-loading muted">Loading your products…</p>'; });
  try {
    const [products, deleted] = await Promise.all([apiRequest("/api/trader/products"), apiRequest("/api/trader/products/deleted")]);
    if (!Array.isArray(products) || !Array.isArray(deleted)) throw new Error("The products response from the server was not in the expected format.");
    ownedProducts = Object.fromEntries(products.map(product => [product.id, product]));
    renderOwnedProducts();
    deletedPanel.hidden = deleted.length === 0;                      // only show the panel when there is something in it
    document.getElementById("trader-deleted-products").innerHTML = deleted.map(deletedProductHTML).join("");
  } catch (error) {
    const errorMarkup = `<div class="owned-products-error"><strong>Your products didn’t load</strong><p>${escapeHTML(error.message || "Check your connection and try again.")}</p><button class="outline-button" type="button" data-reload-owned-products>Try again</button></div>`;
    productTargets.forEach(element => { element.innerHTML = errorMarkup; });
  }
}

/** Bring a deleted product back (possible during the 30 days). */
async function restoreProduct(id) {
  try {
    const result = await apiRequest(`/api/trader/products/${id}/restore`, { method: "POST", body: JSON.stringify({}) });
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
  loadOwnedProducts();
  loadCategoryChips();
  loadHome();
}

/* ----------------------------------------------------------------------------
   The product pop-up (add / edit)
   ---------------------------------------------------------------------------- */
/** Show or hide the "original price + discount %" fields, and hide the plain price field when they are used. */
function togglePriceSlash() {
  const on = document.getElementById("pe-slash-toggle").checked;
  document.getElementById("pe-slash-fields").hidden = !on;
  document.getElementById("pe-price-field").hidden = on;
  document.getElementById("pe-price").required = !on;
  document.getElementById("pe-original").required = on;
  document.getElementById("pe-percent").required = on;
  if (on) refreshSlashPreview("pe");
}

/** Open the pop-up. Pass a product to EDIT it, or nothing to ADD a new one. */
async function openProductEditor(product = null) {
  closeTraderCreatePanel();
  if (!product && (traderSubscriptionUserId !== currentUser.id || !traderSubscriptionLoaded)) await loadTraderSubscription();
  if (!product && !traderHasProAccess()) {
    showSubscriptionUpgrade("add products");
    return;
  }
  editingProductId = product ? product.id : null;
  const byId = id => document.getElementById(id);

  byId("product-form").reset();
  byId("pe-feedback").textContent = "";
  byId("product-editor-title").textContent = product ? "Edit product" : "Add a product";
  byId("pe-save").textContent = product ? "Save changes" : "Add to my shop";
  byId("pe-lifecycle").hidden = !product;                 // Pause / Delete only exist for an existing product
  byId("pe-pause").textContent = product && product.is_paused ? "▶ Resume product" : "⏸ Pause product";
  byId("pe-paused-note").hidden = !(product && product.is_paused);
  byId("product-overlay").hidden = false;

  await loadCategoryOptions();   // fresh list, so a category another trader just created is there

  if (product) {                 // fill the form with the product's current details
    byId("pe-name").value = product.name;
    byId("pe-category").value = product.category;
    byId("pe-stock").value = product.stock;
    byId("pe-show-quantity").value = String(product.show_quantity);
    byId("pe-image").value = product.image || "";
    byId("pe-description").value = product.description || "";
    if (product.original_price) {
      byId("pe-slash-toggle").checked = true;
      byId("pe-original").value = product.original_price;
      byId("pe-percent").value = product.discount_percent;
    } else {
      byId("pe-price").value = product.price;
    }
  }
  toggleCustomCategory();
  togglePriceSlash();
}

function closeProductEditor() {
  document.getElementById("product-overlay").hidden = true;
  editingProductId = null;
}

/** Save the pop-up: create a new product, or update the one being edited. */
async function saveProduct(event) {
  event.preventDefault();
  const feedback = document.getElementById("pe-feedback");
  const saveButton = document.getElementById("pe-save");
  const byId = id => document.getElementById(id);

  // Category: the one picked from the list, or the text the trader typed.
  const picked = byId("pe-category").value;
  const category = picked === NEW_CATEGORY_VALUE ? byId("pe-category-custom").value.trim() : picked;

  // Price: either a plain price, or original price + percent off (the price slash).
  let price;
  let originalPrice = null;
  if (byId("pe-slash-toggle").checked) {
    const slash = readSlash("pe");
    if (slash.error) { feedback.textContent = slash.error; return; }
    price = slash.price;
    originalPrice = slash.original;
  } else {
    price = Number(byId("pe-price").value);
  }

  const data = {
    name: byId("pe-name").value.trim(),
    price,
    original_price: originalPrice,       // null removes an old price slash
    category,
    stock: Number(byId("pe-stock").value),
    show_quantity: byId("pe-show-quantity").value === "true",
    image: byId("pe-image").value.trim(),
    description: byId("pe-description").value.trim()
  };

  saveButton.disabled = true;
  try {
    const file = byId("pe-image-file").files[0];
    if (file) {                                             // upload the picture first, then save its link
      const body = new FormData();
      body.append("image", file);
      data.image = (await apiRequest("/api/upload-image", { method: "POST", body })).url;
    }
    const result = editingProductId
      ? await apiRequest(`/api/trader/products/${editingProductId}`, { method: "PATCH", body: JSON.stringify(data) })
      : await apiRequest("/api/trader/products", { method: "POST", body: JSON.stringify(data) });
    closeProductEditor();
    showToast(result.message);
    loadOwnedProducts();
    loadCategoryChips();          // a brand-new category should show up for shoppers
    loadHome();
    loadTraders();
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
}

/** Pause the product being edited, or resume it if it is already paused. */
async function togglePauseEditing() {
  const product = ownedProducts[editingProductId];
  if (!product) return;
  try {
    const action = product.is_paused ? "resume" : "pause";
    const result = await apiRequest(`/api/trader/products/${product.id}/${action}`, { method: "POST", body: JSON.stringify({}) });
    closeProductEditor();
    showToast(result.message);
    loadOwnedProducts();
    loadCategoryChips();
    loadHome();
  } catch (error) {
    document.getElementById("pe-feedback").textContent = error.message;
  }
}

/** Delete the product being edited. It is hidden at once and erased for good after 30 days (restorable until then). */
async function deleteEditingProduct() {
  if (!editingProductId) return;
  if (!confirm("Delete this product?\n\nIt disappears from your shop now and is erased for good, with its picture, in 30 days. You can restore it until then.")) return;
  try {
    const result = await apiRequest(`/api/trader/products/${editingProductId}`, { method: "DELETE" });
    closeProductEditor();
    showToast(result.message);
    loadOwnedProducts();
    loadCategoryChips();
    loadHome();
  } catch (error) {
    document.getElementById("pe-feedback").textContent = error.message;
  }
}

/* ----------------------------------------------------------------------------
   Orders: "to fulfil" and "fulfilled" are separate screens, each searchable and sortable.
   Every order line shows its product ID (PRD-101) so it can be found quickly.
   ---------------------------------------------------------------------------- */
let traderOrderLines = [];
let traderTotalSales = 0;

function orderLineCode(line) { return line.product_id ? `PRD-${line.product_id}` : line.deal_id ? `DEAL-${line.deal_id}` : ""; }

function orderLineHTML(line, fulfilled) {
  const paidOut = line.escrow_status === "released";
  const chip = fulfilled
    ? `<span class="badge ${paidOut ? "badge-paid" : line.escrow_status === "disputed" ? "badge-bad" : "badge-pending"}">${paidOut ? "Credited" : line.escrow_status === "disputed" ? "On hold" : "Delivered"}</span>` : "";
  const controls = fulfilled ? "" : `
          <select data-item-status="${line.item_id}" aria-label="Delivery condition">
            ${Object.entries(FULFILMENT).map(([key, text]) =>
              `<option value="${key}" ${key === line.fulfilment_status ? "selected" : ""} ${key === "Pending" ? "disabled" : ""}>${text}</option>`).join("")}
          </select>
          <button type="button" class="outline-button" data-update-item="${line.item_id}">Save update</button>`;
  return `
      <article class="order-line compact">
        <div class="order-line-main">
          <strong>${escapeHTML(line.shipping_name)}</strong>
          <small>${escapeHTML(line.product_name)} × ${line.quantity} · Order #${line.order_id}${orderLineCode(line) ? ` · ${orderLineCode(line)}` : ""}</small>
          <small>${formatPrice(line.unit_price * line.quantity)}${line.paid_at ? ` · paid ${escapeHTML(formatDate(line.paid_at))}` : ""}</small>
          <details class="delivery-details">
            <summary>Delivery details</summary>
            <p>${escapeHTML(line.shipping_phone)}<br>${escapeHTML(line.shipping_address)}, ${escapeHTML(line.shipping_city)}, ${escapeHTML(line.shipping_state)}</p>
          </details>
          <small class="escrow-line">${escrowLineText(line)}</small>
        </div>
        <div class="order-line-actions">
          ${chip}${controls}
          ${line.escrow_status === "held" && !line.scanned ? `<button type="button" class="outline-button" data-delivery-qr="${line.item_id}">Delivery QR</button>` : ""}
          ${line.scanned && line.escrow_status === "held" ? '<span class="badge badge-paid">Package confirmed</span>' : ""}
        </div>
      </article>`;
}

function filterOrderLines(lines, query) {
  if (!query.trim()) return lines;
  return lines.filter(line => matchesSearch(
    `${line.product_name} ${orderLineCode(line)} ${line.product_id || ""} order ${line.order_id} #${line.order_id} ${line.shipping_name}`.toLowerCase(), query));
}

function sortOrderLines(lines, sort) {
  const amount = line => line.unit_price * line.quantity;
  const time = line => Date.parse(line.paid_at || "") || 0;
  const by = {
    newest: (a, b) => time(b) - time(a) || b.item_id - a.item_id,
    oldest: (a, b) => time(a) - time(b) || a.item_id - b.item_id,
    product: (a, b) => a.product_name.localeCompare(b.product_name),
    "amount-high": (a, b) => amount(b) - amount(a),
    "amount-low": (a, b) => amount(a) - amount(b)
  };
  return [...lines].sort(by[sort] || by.newest);
}

function renderOrderScope(scope, target, lines, fulfilled) {
  if (!target) return;
  const state = listStateFor(scope);
  const shown = sortOrderLines(filterOrderLines(lines, state.query), state.sort);
  updateListCount(scope, shown.length, lines.length, "order");
  if (!lines.length) target.innerHTML = `<p class="muted">${fulfilled ? "Delivered orders will appear here." : "No orders are waiting for fulfilment."}</p>`;
  else if (!shown.length) target.innerHTML = `<p class="muted list-empty">No orders match “${escapeHTML(state.query)}”.</p>`;
  else target.innerHTML = `<div class="trader-order-list">${shown.map(line => orderLineHTML(line, fulfilled)).join("")}</div>`;
}

function renderTraderOrderLists() {
  renderOrderScope("orders", document.getElementById("trader-orders"), traderOrderLines.filter(line => line.fulfilment_status !== "Delivered"), false);
  renderOrderScope("fulfilled", document.getElementById("trader-fulfilled-orders"), traderOrderLines.filter(line => line.fulfilment_status === "Delivered"), true);
}

async function loadTraderOrders() {
  const targets = [document.getElementById("trader-orders"), document.getElementById("trader-fulfilled-orders")].filter(Boolean);
  targets.forEach(target => { target.innerHTML = '<p class="muted">Loading orders…</p>'; });
  try {
    const data = await apiRequest("/api/trader/orders");
    traderOrderLines = data.orders;
    traderTotalSales = data.total_sales;
    renderTraderOrderLists();
  } catch (error) {
    targets.forEach(target => { target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`; });
  }
}

/** One short line about this order's money (it is held in escrow until the buyer confirms delivery). */
function escrowLineText(line) {
  const amount = formatPrice(line.seller_amount);
  switch (line.escrow_status) {
    case "held": return `🔒 ${amount} is held in escrow. You are credited when the buyer confirms delivery.`;
    case "disputed": return `⚠ The buyer reported a problem. ${amount} stays on hold while it is reviewed.`;
    case "released": return `✓ ${amount} credited to your balance.`;
    case "refunded": return "↩ Refunded to the buyer.";
    default: return "";
  }
}

/** Save the condition chosen for one order. */
async function updateOrderLine(id) {
  const status = document.querySelector(`[data-item-status="${id}"]`).value;
  if (status === "Pending") { showToast("Choose Preparing, Shipped or Delivered first."); return; }
  try {
    const result = await apiRequest(`/api/trader/order-items/${id}`, { method: "PATCH", body: JSON.stringify({ fulfilment_status: status }) });
    showToast(result.message);
    await loadTraderOrders();
  } catch (error) {
    showToast(error.message);
  }
}
