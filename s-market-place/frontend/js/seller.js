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
let ownedProducts = {};                 // the trader's products by id, so "Edit" can fill the form

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
  loadTraderOrders();
  await loadOwnedProducts();
}

/** One slim row: name, price, quantity left, and an Edit button. */
function ownedProductHTML(product) {
  const quantity = product.stock > 0 ? `${product.stock} left` : "Sold out";
  const hint = product.show_quantity ? "" : " · buyers see “In stock”";
  return `
    <article class="owned-product compact">
      <div class="owned-info">
        <strong>${escapeHTML(product.name)}${product.is_paused ? ' <span class="paused-badge">Paused</span>' : ""}</strong>
        <small>${formatPrice(product.price)} · ${quantity}${hint}</small>
      </div>
      <button type="button" class="outline-button" data-edit-product="${product.id}">Edit</button>
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
  const deletedPanel = document.getElementById("deleted-panel");
  target.innerHTML = '<p class="muted">Loading your products…</p>';
  try {
    const [products, deleted] = await Promise.all([apiRequest("/api/trader/products"), apiRequest("/api/trader/products/deleted")]);
    ownedProducts = Object.fromEntries(products.map(product => [product.id, product]));
    target.innerHTML = products.length
      ? products.map(ownedProductHTML).join("")
      : '<p class="muted">You have not listed products yet. Tap “+ Add product” to start.</p>';
    deletedPanel.hidden = deleted.length === 0;                      // only show the panel when there is something in it
    document.getElementById("trader-deleted-products").innerHTML = deleted.map(deletedProductHTML).join("");
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
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
  target.innerHTML = '<p class="muted">Loading orders…</p>';
  try {
    const data = await apiRequest("/api/trader/orders");
    const summary = `<p class="muted">Total paid sales: <strong>${formatPrice(data.total_sales)}</strong></p>`;
    if (!data.orders.length) {
      target.innerHTML = summary + '<p class="muted">No paid orders yet. When a buyer pays, it appears here.</p>';
      return;
    }
    target.innerHTML = summary + data.orders.map(line => `
      <article class="order-line compact">
        <div class="order-line-main">
          <strong>${escapeHTML(line.shipping_name)}</strong>
          <small>${escapeHTML(line.product_name)} × ${line.quantity} · Order #${line.order_id}</small>
          <details class="delivery-details">
            <summary>Delivery details</summary>
            <p>${escapeHTML(line.shipping_phone)}<br>${escapeHTML(line.shipping_address)}, ${escapeHTML(line.shipping_city)}, ${escapeHTML(line.shipping_state)}</p>
          </details>
        </div>
        <div class="order-line-actions">
          <select data-item-status="${line.item_id}" aria-label="Delivery condition">
            ${Object.entries(FULFILMENT).map(([key, text]) =>
              `<option value="${key}" ${key === line.fulfilment_status ? "selected" : ""} ${key === "Pending" ? "disabled" : ""}>${text}</option>`).join("")}
          </select>
          <button type="button" class="outline-button" data-update-item="${line.item_id}">Save update</button>
        </div>
      </article>`).join("");
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

/** Save the condition chosen for one order. */
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
