"use strict";
/* ============================================================================
   cart.js — the shopping cart. It lives in this browser, so visitors can shop
   without an account; an account is only needed at checkout.
   ============================================================================ */

const CART_KEY = "smpGuestCart";   // stored as { productId: quantity }

function getGuestCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || "{}"); } catch (_) { return {}; }
}

function saveGuestCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

/** Load only the products we need from the server (by id). */
async function fetchProductsByIds(ids) {
  if (!ids.length) return [];
  const data = await apiRequest(`/api/products?ids=${ids.map(encodeURIComponent).join(",")}&limit=100`);
  return data.products;
}

/**
 * Combine the saved quantities with fresh product details (price, stock, picture).
 * Also tidies the cart: quantities are trimmed to the stock left, and products
 * a trader removed are dropped.
 */
async function getCartSummary() {
  const cart = getGuestCart();
  const ids = Object.keys(cart);
  if (!ids.length) return { items: [], count: 0, subtotal: 0 };

  const products = await fetchProductsByIds(ids);
  const found = new Set();
  const items = [];
  let subtotal = 0;
  let changed = false;

  for (const product of products) {
    found.add(String(product.id));
    const wanted = Number(cart[product.id] || 0);
    const quantity = Math.min(wanted, Number(product.stock));
    if (quantity !== wanted) {
      changed = true;
      if (quantity > 0) cart[product.id] = quantity; else delete cart[product.id];
    }
    if (quantity > 0) {
      const lineTotal = Number(product.price) * quantity;
      subtotal += lineTotal;
      items.push({ ...product, quantity, line_total: lineTotal });
    }
  }
  for (const id of ids) {
    if (!found.has(id)) { delete cart[id]; changed = true; }   // the product no longer exists
  }
  if (changed) saveGuestCart(cart);
  return { items, count: items.reduce((total, item) => total + item.quantity, 0), subtotal };
}

/** Update the little number on the cart icon in the header. */
function updateCartCount(count) {
  document.getElementById("cart-count").textContent = String(count ?? 0);
}

async function refreshCartCount() {
  try { updateCartCount((await getCartSummary()).count); } catch (error) { console.error(error); }
}

/** Add one item to the cart (checks stock first) and tell the feed the shopper wants it. */
async function addToCart(id) {
  try {
    const [product] = await fetchProductsByIds([id]);
    if (!product || product.stock < 1) throw new Error("Sorry, this item is sold out.");
    const cart = getGuestCart();
    const next = Number(cart[id] || 0) + 1;
    if (next > Number(product.stock)) throw new Error(`Only ${product.stock} item(s) are currently in stock.`);
    cart[id] = next;
    saveGuestCart(cart);
    updateCartCount((await getCartSummary()).count);
    trackInteraction("cart", { product_id: Number(id) });
    showToast("Added to your cart. You can keep browsing as a guest.");
  } catch (error) {
    showToast(error.message);
  }
}

/** Change a cart line to an exact quantity (0 removes it), respecting the stock left. */
async function changeCartQuantity(id, quantity) {
  try {
    const cart = getGuestCart();
    if (quantity <= 0) {
      delete cart[id];
    } else {
      const [product] = await fetchProductsByIds([id]);
      if (!product || quantity > product.stock) throw new Error(`Only ${product?.stock ?? 0} item(s) are in stock.`);
      cart[id] = quantity;
    }
    saveGuestCart(cart);
    updateCartCount((await getCartSummary()).count);
    renderCart();
  } catch (error) {
    showToast(error.message);
  }
}

async function removeCartItem(id) {
  const cart = getGuestCart();
  delete cart[id];
  saveGuestCart(cart);
  await renderCart();
  showToast("Item removed.");
}

/** Draw the cart screen: each line, the subtotal and the checkout button. */
async function renderCart() {
  const target = document.getElementById("cart-content");
  target.innerHTML = '<p class="muted">Loading your cart…</p>';
  try {
    const cart = await getCartSummary();
    updateCartCount(cart.count);
    if (!cart.items.length) {
      target.innerHTML = `<div class="empty-state"><h2>Your cart is empty.</h2>
        <p>Browse the marketplace and add the items you love. No account is needed yet.</p>
        <button class="primary-button" type="button" data-page-link="home">Browse products</button></div>`;
      return;
    }
    const rows = cart.items.map(item => `
      <article class="cart-row">
        ${item.image
          ? `<img src="${escapeHTML(imageURL(item.image))}" alt="${escapeHTML(item.name)}" loading="lazy" onerror="this.style.display='none'">`
          : '<div class="cart-thumb">✦</div>'}
        <div class="cart-item-copy">
          <h3>${escapeHTML(item.name)}</h3>
          <p>${formatPrice(item.price)} each · ${escapeHTML(item.store_name || "Trader")}</p>
          <div class="cart-actions">
            <button class="qty-button" type="button" data-cart-quantity="${item.id}" data-quantity="${item.quantity - 1}">−</button>
            <span>${item.quantity}</span>
            <button class="qty-button" type="button" data-cart-quantity="${item.id}" data-quantity="${item.quantity + 1}">+</button>
            <button class="remove-button" type="button" data-remove-cart="${item.id}">Remove</button>
          </div>
        </div>
        <strong class="cart-line-total">${formatPrice(item.line_total)}</strong>
      </article>`).join("");
    target.innerHTML = `<div class="cart-list">${rows}</div>
      <div class="cart-summary"><span>Subtotal <strong>${formatPrice(cart.subtotal)}</strong></span>
        <button class="primary-button" id="checkout-button" type="button">Proceed to checkout</button></div>
      <p class="muted">You can shop as a guest. A buyer account is required only when you proceed to checkout. Payment is handled securely by Paystack.</p>`;
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}
