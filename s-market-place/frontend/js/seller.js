"use strict";
/* ============================================================================
   seller.js — the trader's screen. It opens on the ADD-ITEM form; below it are
   the trader's listed products and the paid orders waiting to be shipped.
   ============================================================================ */

const NEW_CATEGORY_VALUE = "__new__";   // the "my category isn't listed" choice in the dropdown

/* ----------------------------------------------------------------------------
   Category picker: choose from the list, or type a new category
   ---------------------------------------------------------------------------- */
/** Fill the dropdown with every category in the system (plus the "type it in" option). */
async function loadCategoryOptions() {
  const select = document.getElementById("new-product-category");
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
  const select = document.getElementById("new-product-category");
  const custom = document.getElementById("new-product-category-custom");
  const typing = select.value === NEW_CATEGORY_VALUE;
  custom.hidden = !typing;
  custom.required = typing;
  if (typing) custom.focus();
}

/* ----------------------------------------------------------------------------
   Dashboard
   ---------------------------------------------------------------------------- */
/** Open the trader screen: add-item form first, then products and orders. */
async function loadTraderDashboard() {
  if (!currentUser || currentUser.role !== "trader") {
    showToast("Please sign in with a trader account to manage a shop.");
    openAuth("trader");
    return;
  }
  document.getElementById("dashboard-store-name").textContent = currentUser.store_name || "Your shop";
  const target = document.getElementById("trader-own-products");
  target.innerHTML = '<p class="muted">Loading your products…</p>';
  loadCategoryOptions();
  loadTraderOrders();
  try {
    const products = await apiRequest("/api/trader/products");
    target.innerHTML = products.length ? products.map(ownedProductHTML).join("") : '<p class="muted">You have not listed products yet.</p>';
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

/** One row in "Your listed products" with price and stock you can edit. */
function ownedProductHTML(product) {
  return `
    <article class="owned-product">
      <div class="owned-product-main">
        <strong>${escapeHTML(product.name)}</strong>
        <small>${escapeHTML(product.category)} · Current price: ${formatPrice(product.price)}</small>
        <label>Price (₦) <input class="price-edit-input" type="number" min="0" step="0.01" value="${Number(product.price)}" data-price-value="${product.id}" aria-label="Price for ${escapeHTML(product.name)}"></label>
        <label>Stock <input class="stock-edit-input" type="number" min="0" step="1" value="${Number(product.stock)}" data-stock-value="${product.id}" aria-label="Stock quantity for ${escapeHTML(product.name)}"></label>
      </div>
      <div class="owned-product-actions">
        <button type="button" class="outline-button" data-save-product="${product.id}">Save price & stock</button>
        <button type="button" class="remove-button" data-delete-product="${product.id}">Delete</button>
      </div>
    </article>`;
}

/** Add a new product to the trader's shop. */
async function submitProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.getElementById("product-feedback");
  const byId = id => document.getElementById(id);

  // The category is either one picked from the list or the text the trader typed.
  const picked = byId("new-product-category").value;
  const category = picked === NEW_CATEGORY_VALUE ? byId("new-product-category-custom").value.trim() : picked;

  const data = {
    name: byId("new-product-name").value.trim(),
    price: Number(byId("new-product-price").value),
    category,
    stock: Number(byId("new-product-stock").value),
    image: byId("new-product-image").value.trim(),
    description: byId("new-product-description").value.trim()
  };
  try {
    const imageFile = byId("new-product-image-file").files[0];
    if (imageFile) {                                             // upload the picture first, then save its link
      const body = new FormData();
      body.append("image", imageFile);
      data.image = (await apiRequest("/api/upload-image", { method: "POST", body })).url;
    }
    const result = await apiRequest("/api/trader/products", { method: "POST", body: JSON.stringify(data) });
    feedback.textContent = result.message;
    form.reset();
    toggleCustomCategory();
    await loadTraderDashboard();
    loadCategoryChips();            // a brand-new category should show up for shoppers
    loadHome();
    loadTraders();
    showToast(result.message);
  } catch (error) {
    feedback.textContent = error.message;
  }
}

/** Save the price and stock typed in a product row. */
async function saveOwnedProduct(id) {
  const price = Number(document.querySelector(`[data-price-value="${id}"]`).value);
  const stock = Number(document.querySelector(`[data-stock-value="${id}"]`).value);
  if (!Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
    showToast("Enter a valid non-negative price and whole-number stock quantity.");
    return;
  }
  try {
    const result = await apiRequest(`/api/trader/products/${id}`, { method: "PATCH", body: JSON.stringify({ price, stock }) });
    showToast(result.message);
    await loadTraderDashboard();
    loadHome();
  } catch (error) {
    showToast(error.message);
  }
}

/** Delete a product (the backend hides it instead if it already has orders). */
async function deleteOwnedProduct(id) {
  if (!confirm("Remove this product from your shop?")) return;
  try {
    const result = await apiRequest(`/api/trader/products/${id}`, { method: "DELETE" });
    await loadTraderDashboard();
    loadCategoryChips();
    loadHome();
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
}

/* ----------------------------------------------------------------------------
   Orders to fulfil
   ---------------------------------------------------------------------------- */
/** Paid order lines for this trader, with the buyer's delivery details and a status control. */
async function loadTraderOrders() {
  const target = document.getElementById("trader-orders");
  if (!target) return;
  target.innerHTML = '<p class="muted">Loading orders…</p>';
  try {
    const data = await apiRequest("/api/trader/orders");
    const summary = `<p class="muted">Total paid sales: <strong>${formatPrice(data.total_sales)}</strong></p>`;
    if (!data.orders.length) {
      target.innerHTML = summary + '<p class="muted">No paid orders yet. When a buyer pays, the delivery details appear here.</p>';
      return;
    }
    target.innerHTML = summary + data.orders.map(line => `
      <article class="order-line">
        <div>
          <strong>${escapeHTML(line.product_name)} × ${line.quantity}</strong>
          <small>Order #${line.order_id} · paid ${escapeHTML(formatDate(line.paid_at))} · ${formatPrice(line.unit_price * line.quantity)}</small>
          <small>Deliver to: ${escapeHTML(line.shipping_name)} · ${escapeHTML(line.shipping_phone)}<br>${escapeHTML(line.shipping_address)}, ${escapeHTML(line.shipping_city)}, ${escapeHTML(line.shipping_state)}</small>
        </div>
        <div class="order-line-actions">
          <select data-item-status="${line.item_id}" aria-label="Delivery status">
            ${Object.entries(FULFILMENT).map(([key, text]) =>
              `<option value="${key}" ${key === line.fulfilment_status ? "selected" : ""} ${key === "Pending" ? "disabled" : ""}>${text}</option>`).join("")}
          </select>
          <button type="button" class="outline-button" data-update-item="${line.item_id}">Update</button>
        </div>
      </article>`).join("");
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

/** Save the delivery status chosen for one order line. */
async function updateOrderLine(id) {
  const status = document.querySelector(`[data-item-status="${id}"]`).value;
  if (status === "Pending") { showToast("Choose Preparing, Shipped or Delivered first."); return; }
  try {
    const result = await apiRequest(`/api/trader/order-items/${id}`, { method: "PATCH", body: JSON.stringify({ fulfilment_status: status }) });
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
}
