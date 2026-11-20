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
  await Promise.all([loadTraderSummary(), loadNotifications(document.getElementById("management-notifications-panel"), 3), loadChatSettings()]);
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

  if (!(await confirmDanger({ title: "Continue to payment?", message: confirmation, tone: "warn" }))) return;

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

  if (!(await confirmDanger({ title: "Turn off auto-renew?", message: "Your paid access will continue until its end date.", tone: "warn" }))) {
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
  if (!(await confirmDanger({ title: "Delete this product?", message: "It disappears from your shop now and is erased for good, with its picture, in 30 days. You can restore it until then.", confirmLabel: "Continue" }))) return;
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

/* Stage of one order line: To pack -> Ready to ship -> Shipped, or "Issues" while the buyer's report is open. */
const ORDER_TABS = [["pack", "To pack"], ["ready", "Ready to ship"], ["shipped", "Shipped"], ["issues", "Issues"]];
const STAGE_LABEL = { pack: "To pack", ready: "Ready to ship", shipped: "Shipped", issues: "Issue" };
let ordersTab = "";

function orderStage(line) {
  if (line.escrow_status === "disputed") return "issues";
  if (line.fulfilment_status === "Processing") return "ready";
  if (line.fulfilment_status === "Shipped") return "shipped";
  return "pack";
}

function shortPersonName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  return parts[0] || "Buyer";
}

function paidAgoText(value) {
  const time = Date.parse(value || "");
  if (!time) return "";
  const minutes = Math.max(1, Math.round((Date.now() - time) / 60000));
  if (minutes < 60) return `Paid ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Paid ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `Paid ${Math.round(hours / 24)} days ago`;
}

function isLateOrder(line) {
  const time = Date.parse(line.paid_at || "");
  return orderStage(line) === "pack" && time && Date.now() - time > 24 * 3600 * 1000;
}

function orderThumbHTML(line) {
  const image = line.product_image || line.image ? imageURL(line.product_image || line.image) : "";
  if (image) return `<span class="ticket-thumb"><img src="${escapeHTML(image)}" alt="" loading="lazy"></span>`;
  return `<span class="ticket-thumb ph-${Math.abs(Number(line.product_id || line.deal_id || 0)) % 4}" aria-hidden="true">${escapeHTML((line.product_name || "?").slice(0, 1).toUpperCase())}</span>`;
}

/** The main button for a line: pack it, ship it, or show the delivery QR. */
function orderPrimaryHTML(line, inSheet) {
  const close = inSheet ? " data-order-sheet-close" : "";
  if (line.fulfilment_status === "Delivered") return "";
  if (line.fulfilment_status === "Shipped") {
    if (line.escrow_status === "held" && !line.scanned) return `<button type="button" class="primary-button" data-delivery-qr="${line.item_id}"${close}>Delivery QR</button>`;
    return line.scanned && line.escrow_status === "held" ? '<span class="badge badge-paid">Package confirmed</span>' : "";
  }
  const packing = line.fulfilment_status !== "Processing";
  return `<button type="button" class="primary-button${packing ? "" : " is-ship"}" data-order-advance="${line.item_id}" data-next-status="${packing ? "Processing" : "Shipped"}">${packing ? "Mark as packed" : "Mark as shipped"}</button>`;
}

function orderLineHTML(line, fulfilled) {
  const stage = orderStage(line);
  const late = isLateOrder(line);
  const paidOut = line.escrow_status === "released";
  const pill = fulfilled
    ? `<span class="stage-pill ${paidOut ? "stage-shipped" : line.escrow_status === "disputed" ? "stage-issues" : "stage-ready"}">${paidOut ? "Credited" : line.escrow_status === "disputed" ? "On hold" : "Delivered"}</span>`
    : `<span class="stage-pill stage-${stage}">${STAGE_LABEL[stage]}</span>`;
  const place = [line.shipping_city, line.shipping_state].filter(Boolean).join(", ");
  return `
      <article class="order-line compact order-ticket${late ? " is-late" : ""}" data-order-details="${line.item_id}" tabindex="0" aria-label="Order ${line.order_id}, ${escapeHTML(line.product_name)}. Open details">
        <header class="ticket-head"><strong>Order #${line.order_id} · ${escapeHTML(shortPersonName(line.shipping_name))}</strong>${pill}</header>
        <div class="ticket-body">
          ${orderThumbHTML(line)}
          <div class="ticket-info">
            <strong>${escapeHTML(line.product_name)} × ${line.quantity}</strong>
            ${orderLineCode(line) ? `<small>${escapeHTML(orderLineCode(line))}</small>` : ""}
            <span class="ticket-earn">You earn ${formatPrice(line.seller_amount)}</span>
          </div>
        </div>
        <p class="ticket-meta">${place ? `<span>📍 ${escapeHTML(place)}</span>` : ""}<span class="${late ? "late" : ""}">${escapeHTML(paidAgoText(line.paid_at))}</span></p>
        <div class="ticket-actions">${fulfilled ? "" : orderPrimaryHTML(line, false)}<button type="button" class="icon-action" data-order-message="${line.item_id}" aria-label="Message the buyer" title="Message the buyer">💬</button><button type="button" class="outline-button" data-order-details="${line.item_id}">Details</button></div>
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

function orderTabsHTML(counts, active) {
  return `<div class="order-tabs" role="tablist" aria-label="Order stage">${ORDER_TABS.map(([key, label]) =>
    `<button type="button" role="tab" class="order-tab" aria-selected="${key === active}" data-order-tab="${key}">${label}<span class="order-tab-count">${counts[key]}</span></button>`).join("")}</div>`;
}

function renderOrderScope(scope, target, lines, fulfilled) {
  if (!target) return;
  const state = listStateFor(scope);
  const shown = sortOrderLines(filterOrderLines(lines, state.query), state.sort);
  updateListCount(scope, shown.length, lines.length, "order");
  let tabsBar = null;
  if (!fulfilled) {
    tabsBar = document.getElementById("trader-order-tabs");
    if (!tabsBar) {
      tabsBar = document.createElement("div");
      tabsBar.id = "trader-order-tabs";
      const tools = target.parentElement && target.parentElement.querySelector(".list-tools");
      if (tools) tools.before(tabsBar); else target.before(tabsBar);
    }
  }
  if (!lines.length) {
    if (tabsBar) tabsBar.innerHTML = "";
    target.innerHTML = `<p class="muted">${fulfilled ? "Delivered orders will appear here." : "No orders are waiting for fulfilment."}</p>`;
    return;
  }
  let visible = shown;
  if (!fulfilled) {
    const counts = { pack: 0, ready: 0, shipped: 0, issues: 0 };
    shown.forEach(line => { counts[orderStage(line)] += 1; });
    if (!ordersTab) ordersTab = ORDER_TABS.map(t => t[0]).find(key => counts[key] > 0) || "pack";
    tabsBar.innerHTML = orderTabsHTML(counts, ordersTab);
    visible = shown.filter(line => orderStage(line) === ordersTab);
  }
  if (!shown.length) target.innerHTML = `<p class="muted list-empty">No orders match “${escapeHTML(state.query)}”.</p>`;
  else if (!visible.length) target.innerHTML = '<p class="muted list-empty">Nothing in this stage right now.</p>';
  else target.innerHTML = `<div class="trader-order-list">${visible.map(line => orderLineHTML(line, fulfilled)).join("")}</div>`;
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


/* ----------------------------------------------------------------------------
   Buyer chat setting (More tab): the built-in chat, or the trader's own chat link.
   API contract the backend must provide (and VALIDATE again on the server):
     GET /api/trader/chat-settings  ->  { mode: "system" | "external", url: "https://..." }
     PUT /api/trader/chat-settings  <-  { mode, url }      (url only when mode is "external")
   The public shop payload (GET /api/shops/<username>) then carries chat_mode and chat_url.
   ---------------------------------------------------------------------------- */
function chatModeValue() { return document.querySelector('input[name="chat-mode"]:checked')?.value || "system"; }

function syncChatModeUI() {
  const field = document.getElementById("chat-link-field");
  if (field) field.hidden = chatModeValue() !== "external";
}

function setChatFeedback(text, isError = false) {
  const el = document.getElementById("chat-feedback");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-error", Boolean(isError));
}

async function loadChatSettings() {
  if (!document.getElementById("chat-settings-panel")) return;
  setChatFeedback("");
  try {
    const settings = await apiRequest("/api/trader/chat-settings");
    const mode = settings.mode === "external" ? "external" : "system";
    const radio = document.querySelector(`input[name="chat-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    const input = document.getElementById("chat-url-input");
    if (input) input.value = mode === "external" ? String(settings.url || "") : "";
  } catch (_) {
    setChatFeedback("Chat settings could not be loaded yet.", true);
  }
  syncChatModeUI();
}

async function saveChatSettings() {
  const mode = chatModeValue();
  const payload = { mode };
  if (mode === "external") {
    const check = validateChatLink(document.getElementById("chat-url-input").value);
    if (!check.ok) { setChatFeedback(check.error, true); return; }
    payload.url = check.url;
  }
  const sure = await confirmDanger({ title: "Change your buyer chat?", message: mode === "external" ? "Buyers who tap Message on your shop will be sent to this link. Only continue if the link is yours." : "Buyers will use the built-in S-Market Place chat.", tone: "warn" });
  if (!sure) return;
  const pin = await requirePin("Enter your PIN to change your buyer chat.");
  if (pin === null) return;
  if (pin) payload.pin = pin;
  const button = document.getElementById("chat-save-button");
  button.disabled = true;
  try {
    const result = await apiRequest("/api/trader/chat-settings", { method: "PUT", body: JSON.stringify(payload) });
    setChatFeedback(result.message || "Chat setting saved.");
    showToast(result.message || "Chat setting saved.");
  } catch (error) {
    setChatFeedback(error.message, true);
  }
  button.disabled = false;
}

document.addEventListener("change", event => { if (event.target.name === "chat-mode") { syncChatModeUI(); setChatFeedback(""); } });
document.addEventListener("click", event => { if (event.target.closest?.("#chat-save-button")) saveChatSettings(); });


/* ----------------------------------------------------------------------------
   Order details sheet: progress steps, items, who to deliver to, payment, main action.
   ---------------------------------------------------------------------------- */
let openOrderItemId = null;

function orderStepsHTML(line) {
  const done = line.fulfilment_status === "Delivered" ? 4 : line.fulfilment_status === "Shipped" ? 3 : line.fulfilment_status === "Processing" ? 2 : 1;
  return `<ol class="order-steps" style="--fill:${Math.min(100, (done - 1) * 33.4)}%">${["Paid", "Packed", "Shipped", "Delivered"].map((label, i) => {
    const n = i + 1;
    return `<li class="${n <= done ? "is-done" : n === done + 1 ? "is-current" : ""}"><span class="step-dot">${n <= done ? "✓" : n}</span><span class="step-label">${label}</span></li>`;
  }).join("")}</ol>`;
}

function orderSheetHTML(line) {
  const address = [line.shipping_address, line.shipping_city, line.shipping_state].filter(Boolean).join(", ");
  const phone = String(line.shipping_phone || "");
  const telHref = phone.replace(/[^\d+]/g, "");
  const total = formatPrice(line.unit_price * line.quantity);
  const primary = orderPrimaryHTML(line, true);
  const markDelivered = line.fulfilment_status === "Shipped" && line.escrow_status === "held" && !line.scanned
    ? `<button type="button" class="outline-button" data-order-advance="${line.item_id}" data-next-status="Delivered">Mark as delivered</button>` : "";
  return `
    <header class="sheet-head">
      <button type="button" class="management-back-button" data-order-sheet-close aria-label="Close order details">←</button>
      <div><p class="eyebrow">Order #${line.order_id}</p><h2 id="order-sheet-title">Order details</h2></div>
    </header>
    ${orderStepsHTML(line)}
    <div class="sheet-scroll">
      <section class="sheet-card"><h3>Items</h3>
        <div class="ticket-body">${orderThumbHTML(line)}<div class="ticket-info">
          <strong>${escapeHTML(line.product_name)} × ${line.quantity}</strong>
          <small>${escapeHTML(orderLineCode(line))}${orderLineCode(line) ? " · " : ""}${formatPrice(line.unit_price)} each</small>
          <span class="ticket-earn">You earn ${formatPrice(line.seller_amount)}</span></div></div>
      </section>
      <section class="sheet-card"><h3>Deliver to</h3>
        <dl class="sheet-rows">
          <div><dt>Buyer</dt><dd>${escapeHTML(line.shipping_name)}</dd></div>
          <div><dt>Phone</dt><dd>${escapeHTML(phone)}</dd></div>
          <div><dt>Address</dt><dd>${escapeHTML(address)}</dd></div>
        </dl>
        <div class="sheet-two">
          ${telHref ? `<a class="outline-button" href="tel:${escapeHTML(telHref)}">📞 Call buyer</a>` : ""}
          <button type="button" class="outline-button" data-copy-address="${escapeHTML(address)}">⧉ Copy address</button>
          <button type="button" class="outline-button sheet-wide" data-order-message="${line.item_id}">💬 Message buyer · they can’t reply</button>
        </div>
      </section>
      ${line.fulfilment_status === "Delivered" ? "" : `<section class="sheet-card"><h3>Order status</h3>
        <div class="status-row">
          <select id="order-status-select" aria-label="Order status">
            <option value="Pending" ${line.fulfilment_status === "Pending" ? "selected" : ""} disabled>Waiting to be packed</option>
            <option value="Processing" ${line.fulfilment_status === "Processing" ? "selected" : ""}>Packed · ready to ship</option>
            <option value="Shipped" ${line.fulfilment_status === "Shipped" ? "selected" : ""}>Shipped</option>
            <option value="Delivered">Delivered</option>
          </select>
          <button type="button" class="outline-button" data-order-status-save="${line.item_id}">Update</button>
        </div></section>`}
      <section class="sheet-card"><h3>Payment</h3>
        <dl class="sheet-rows">
          <div><dt>Order total</dt><dd>${total}</dd></div>
          ${line.paid_at ? `<div><dt>Paid</dt><dd>${escapeHTML(formatDate(line.paid_at))}</dd></div>` : ""}
        </dl>
        ${escrowLineText(line) ? `<p class="sheet-note">${escrowLineText(line)}</p>` : ""}
      </section>
    </div>
    ${primary || markDelivered ? `<footer class="sheet-foot">${primary}${markDelivered}</footer>` : ""}`;
}

function ensureOrderSheet() {
  let sheet = document.getElementById("order-sheet");
  if (sheet) return sheet;
  sheet = document.createElement("div");
  sheet.id = "order-sheet";
  sheet.className = "order-sheet";
  sheet.hidden = true;
  sheet.innerHTML = '<div class="order-sheet-backdrop" data-order-sheet-close></div><section class="order-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="order-sheet-title"></section>';
  document.body.appendChild(sheet);
  return sheet;
}

function renderOrderSheet() {
  const line = traderOrderLines.find(item => item.item_id === openOrderItemId);
  const sheet = document.getElementById("order-sheet");
  if (!line || !sheet) { closeOrderSheet(); return; }
  sheet.querySelector(".order-sheet-panel").innerHTML = orderSheetHTML(line);
}

function openOrderSheet(itemId) {
  if (!traderOrderLines.some(item => item.item_id === itemId)) return;
  openOrderItemId = itemId;
  const sheet = ensureOrderSheet();
  renderOrderSheet();
  sheet.hidden = false;
  document.body.classList.add("sheet-open");
  sheet.querySelector("[data-order-sheet-close].management-back-button")?.focus();
}

function closeOrderSheet() {
  const sheet = document.getElementById("order-sheet");
  if (sheet) sheet.hidden = true;
  openOrderItemId = null;
  document.body.classList.remove("sheet-open");
}

/** Move one order line forward (packed -> shipped -> delivered). */
async function advanceOrderLine(id, status, button) {
  if (status === "Delivered" && !(await confirmDanger({ title: "Mark as delivered?", message: "Only do this once the buyer has really received the package. Your payment is released after the buyer confirms.", tone: "warn" }))) return;
  if (button) button.disabled = true;
  try {
    const result = await apiRequest(`/api/trader/order-items/${id}`, { method: "PATCH", body: JSON.stringify({ fulfilment_status: status }) });
    showToast(result.message);
    await loadTraderOrders();
    if (openOrderItemId) renderOrderSheet();
  } catch (error) {
    showToast(error.message);
    if (button) button.disabled = false;
  }
}

async function copyOrderAddress(text) {
  try { await navigator.clipboard.writeText(text); showToast("Address copied."); }
  catch (_) {
    const box = document.createElement("textarea");
    box.value = text; box.setAttribute("readonly", ""); box.style.position = "fixed"; box.style.opacity = "0";
    document.body.appendChild(box); box.select();
    try { document.execCommand("copy"); showToast("Address copied."); } catch (__) { showToast("Could not copy. Please copy it by hand."); }
    box.remove();
  }
}

document.addEventListener("click", event => {
  const target = event.target;
  if (!target.closest) return;
  const tab = target.closest("[data-order-tab]");
  if (tab) { ordersTab = tab.dataset.orderTab; renderTraderOrderLists(); return; }
  const statusSave = target.closest("[data-order-status-save]");
  if (statusSave) {
    const id = Number(statusSave.dataset.orderStatusSave);
    const line = traderOrderLines.find(item => item.item_id === id);
    const status = document.getElementById("order-status-select")?.value;
    if (!line || !status || status === "Pending" || status === line.fulfilment_status) { showToast("Choose a new status first."); return; }
    advanceOrderLine(id, status, statusSave);
    return;
  }
  const advance = target.closest("[data-order-advance]");
  if (advance) { advanceOrderLine(Number(advance.dataset.orderAdvance), advance.dataset.nextStatus, advance); return; }
  if (target.closest("[data-order-sheet-close]")) { closeOrderSheet(); return; }
  const copy = target.closest("[data-copy-address]");
  if (copy) { copyOrderAddress(copy.dataset.copyAddress); return; }
  const details = target.closest("[data-order-details]");
  if (details) {
    const control = target.closest("button, a");
    if (control && !control.hasAttribute("data-order-details")) return;   // QR / other buttons do their own thing
    openOrderSheet(Number(details.dataset.orderDetails));
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && openOrderItemId) closeOrderSheet();
  if ((event.key === "Enter" || event.key === " ") && event.target.matches?.("article[data-order-details]")) { event.preventDefault(); openOrderSheet(Number(event.target.dataset.orderDetails)); }
});
