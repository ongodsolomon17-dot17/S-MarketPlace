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
  await Promise.all([subscriptionTask, loadOwnedProducts()]);
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
  await loadEarnings();
}

async function loadTraderManagement() {
  if (!currentUser || currentUser.role !== "trader") { openAuth("trader"); return; }
  await Promise.all([
    loadNotifications(document.getElementById("notifications-panel")),
    loadTraderOrders(),
    loadOwnedProducts()
  ]);
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

/** Product tile: picture, price, stock and the existing Edit action. */
function ownedProductHTML(product) {
  const quantity = product.stock > 0 ? `${product.stock} left` : "Sold out";
  const hint = product.show_quantity ? "" : " · buyers see “In stock”";
  const image = product.image ? imageURL(product.image) : "";
  return `
    <article class="owned-product-card">
      <div class="owned-product-media">
        ${image
          ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(product.name)}" loading="lazy" onerror="this.style.display='none'">`
          : '<span class="owned-product-placeholder" aria-hidden="true">＋</span>'}
        ${product.is_paused ? '<span class="paused-badge">Paused</span>' : ""}
        <span class="owned-product-stock">${escapeHTML(quantity)}</span>
      </div>
      <div class="owned-product-card-body">
        <small>${escapeHTML(product.category || "Product")}</small>
        <strong>${escapeHTML(product.name)}</strong>
        <span class="owned-product-price">${formatPrice(product.price)}</span>
        <small>${escapeHTML(hint.trim())}</small>
        <button type="button" class="outline-button" data-edit-product="${product.id}">Edit product</button>
      </div>
    </article>`;
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
  const target = document.getElementById("trader-own-products");
  const managementTarget = document.getElementById("trader-management-products");
  const productTargets = [target, managementTarget].filter(Boolean);
  const deletedPanel = document.getElementById("deleted-panel");
  productTargets.forEach(element => { element.innerHTML = '<p class="product-loading muted">Loading your products…</p>'; });
  try {
    const [products, deleted] = await Promise.all([apiRequest("/api/trader/products"), apiRequest("/api/trader/products/deleted")]);
    if (!Array.isArray(products) || !Array.isArray(deleted)) throw new Error("The products response from the server was not in the expected format.");
    ownedProducts = Object.fromEntries(products.map(product => [product.id, product]));
    const productMarkup = products.length
      ? products.map(ownedProductHTML).join("")
      : `<div class="owned-products-empty"><span class="empty-product-icon" aria-hidden="true">▧</span><h3>No products listed yet</h3><p>Your products will appear here after you add them to your shop.</p><button class="primary-button" type="button" data-open-create-panel>Add your first product</button></div>`;
    productTargets.forEach(element => { element.innerHTML = productMarkup; });
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
   Orders to fulfil
   Each row shows the buyer, a "condition" dropdown and a Save update button.
   The delivery address is tucked into a small "Delivery details" fold-out.
   ---------------------------------------------------------------------------- */
async function loadTraderOrders() {
  const target = document.getElementById("trader-orders");
  if (!target) return;
  target.innerHTML = '<p class="muted">Loading orders…</p>';
  try {
    const data = await apiRequest("/api/trader/orders");
    const summary = `<p class="muted">Total paid sales: <strong>${formatPrice(data.total_sales)}</strong></p>`;
    const orderCards = data.orders.map(line => `
      <article class="order-line compact">
        <div class="order-line-main">
          <strong>${escapeHTML(line.shipping_name)}</strong>
          <small>${escapeHTML(line.product_name)} × ${line.quantity} · Order #${line.order_id}</small>
          <details class="delivery-details">
            <summary>Delivery details</summary>
            <p>${escapeHTML(line.shipping_phone)}<br>${escapeHTML(line.shipping_address)}, ${escapeHTML(line.shipping_city)}, ${escapeHTML(line.shipping_state)}</p>
          </details>
          <small class="escrow-line">${escrowLineText(line)}</small>
        </div>
        <div class="order-line-actions">
          <select data-item-status="${line.item_id}" aria-label="Delivery condition">
            ${Object.entries(FULFILMENT).map(([key, text]) =>
              `<option value="${key}" ${key === line.fulfilment_status ? "selected" : ""} ${key === "Pending" ? "disabled" : ""}>${text}</option>`).join("")}
          </select>
          <button type="button" class="outline-button" data-update-item="${line.item_id}">Save update</button>
          ${line.escrow_status === "held" && !line.scanned ? `<button type="button" class="outline-button" data-delivery-qr="${line.item_id}">Delivery QR</button>` : ""}
          ${line.scanned && line.escrow_status === "held" ? '<span class="badge badge-paid">Package confirmed</span>' : ""}
        </div>
      </article>`);
    const toFulfil = data.orders.filter(line => line.fulfilment_status !== "Delivered");
    const fulfilled = data.orders.filter(line => line.fulfilment_status === "Delivered");
    const cardMap = new Map(data.orders.map((line, index) => [line.item_id, orderCards[index]]));
    target.innerHTML = summary + `
      <div class="order-filter-tabs" role="tablist" aria-label="Delivery orders">
        <button type="button" class="order-filter is-active" data-order-filter="fulfil">Orders to fulfil <span>${toFulfil.length}</span></button>
        <button type="button" class="order-filter" data-order-filter="fulfilled">Fulfilled <span>${fulfilled.length}</span></button>
      </div>
      <div class="trader-order-list" data-order-list="fulfil">${toFulfil.length ? toFulfil.map(line => cardMap.get(line.item_id)).join("") : '<p class="muted">No orders are waiting for fulfilment.</p>'}</div>
      <div class="trader-order-list" data-order-list="fulfilled" hidden>${fulfilled.length ? fulfilled.map(line => cardMap.get(line.item_id)).join("") : '<p class="muted">Delivered orders will appear here.</p>'}</div>`;
    showTraderOrders("fulfil");
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

function showTraderOrders(tab) {
  document.querySelectorAll("[data-order-list]").forEach(list => { list.hidden = list.dataset.orderList !== tab; });
  document.querySelectorAll("[data-order-filter]").forEach(button => button.classList.toggle("is-active", button.dataset.orderFilter === tab));
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
