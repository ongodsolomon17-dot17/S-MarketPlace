"use strict";
/* ============================================================================
   cart.js — the shopping cart. It lives in this browser, so visitors can shop
   without an account; an account is only needed at checkout.

   The cart is stored as { key: quantity }. A key is either
       "12"  → product number 12
       "d5"  → Fast Finger deal number 5   (the "d" tells them apart)
   ============================================================================ */

const CART_KEY = "smpGuestCart";
const DEAL_PREFIX = "d";

/** True for a Fast Finger deal key such as "d5". */
function isDealKey(key) {
  return String(key).startsWith(DEAL_PREFIX);
}

function dealKey(dealId) {
  return DEAL_PREFIX + dealId;
}

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

/** Load only the Fast Finger deals we need (by id). */
async function fetchDealsByIds(ids) {
  if (!ids.length) return [];
  const data = await apiRequest(`/api/deals?ids=${ids.map(encodeURIComponent).join(",")}`);
  return data.deals;
}

/**
 * Combine the saved quantities with fresh details from the server (price, stock, picture, deal status).
 * Also tidies the cart: quantities are trimmed to what is left, and anything that can no longer
 * be bought (product removed, deal ended or sold out) is dropped.
 */
async function getCartSummary() {
  const cart = getGuestCart();
  const keys = Object.keys(cart);
  if (!keys.length) return { items: [], count: 0, subtotal: 0, endedDeals: 0 };

  const productIds = keys.filter(key => !isDealKey(key));
  const dealIds = keys.filter(isDealKey).map(key => key.slice(DEAL_PREFIX.length));
  const [products, deals] = await Promise.all([fetchProductsByIds(productIds), fetchDealsByIds(dealIds)]);

  const found = new Set();
  const items = [];
  let subtotal = 0;
  let changed = false;
  let endedDeals = 0;

  // --- products
  for (const product of products) {
    const key = String(product.id);
    found.add(key);
    const wanted = Number(cart[key] || 0);
    // stock is null when the trader hides the quantity: the server checks the real limit at checkout.
    const limit = !product.available ? 0 : (product.stock === null ? Infinity : Number(product.stock));
    const quantity = Math.min(wanted, limit);
    if (quantity !== wanted) {
      changed = true;
      if (quantity > 0) cart[key] = quantity; else delete cart[key];
    }
    if (quantity > 0) {
      const lineTotal = Number(product.price) * quantity;
      subtotal += lineTotal;
      items.push({ ...product, key, kind: "product", quantity, line_total: lineTotal });
    }
  }

  // --- Fast Finger deals (only while live and not sold out)
  for (const deal of deals) {
    const key = dealKey(deal.id);
    found.add(key);
    const wanted = Number(cart[key] || 0);
    const buyable = deal.status === "live" && Number(deal.quantity) > 0;
    const quantity = buyable ? Math.min(wanted, Number(deal.quantity)) : 0;
    if (!buyable) endedDeals += 1;
    if (quantity !== wanted) {
      changed = true;
      if (quantity > 0) cart[key] = quantity; else delete cart[key];
    }
    if (quantity > 0) {
      const lineTotal = Number(deal.price) * quantity;
      subtotal += lineTotal;
      items.push({
        key, kind: "deal", id: deal.id, name: deal.title, price: deal.price, original_price: deal.original_price,
        discount_percent: deal.discount_percent, image: deal.image, store_name: deal.store_name,
        ends_at: deal.ends_at, quantity, line_total: lineTotal
      });
    }
  }

  // --- anything the server no longer returns was deleted
  for (const key of keys) {
    if (!found.has(key)) {
      delete cart[key];
      changed = true;
      if (isDealKey(key)) endedDeals += 1;
    }
  }
  if (changed) saveGuestCart(cart);
  return { items, count: items.reduce((total, item) => total + item.quantity, 0), subtotal, endedDeals };
}

/** Update the little number on the cart icon in the header. */
function updateCartCount(count) {
  document.getElementById("cart-count").textContent = String(count ?? 0);
}

async function refreshCartCount() {
  try { updateCartCount((await getCartSummary()).count); } catch (error) { console.error(error); }
}

/** Add one product to the cart (checks stock first) and tell the feed the shopper wants it. */
async function addToCart(id) {
  try {
    const [product] = await fetchProductsByIds([id]);
    if (!product || !product.available) throw new Error("Sorry, this item is sold out.");
    const cart = getGuestCart();
    const next = Number(cart[id] || 0) + 1;
    if (product.stock !== null && next > Number(product.stock)) throw new Error(`Only ${product.stock} item(s) are currently in stock.`);
    cart[id] = next;
    saveGuestCart(cart);
    updateCartCount((await getCartSummary()).count);
    trackInteraction("cart", { product_id: Number(id) });
    showToast("Added to your cart. You can keep browsing as a guest.");
  } catch (error) {
    showToast(error.message);
  }
}

/** Add one Fast Finger deal to the cart (only while it is live and has some left). */
async function addDealToCart(id) {
  try {
    const [deal] = await fetchDealsByIds([id]);
    if (!deal || deal.status !== "live" || Number(deal.quantity) < 1) throw new Error("Sorry, this deal has ended or sold out.");
    const key = dealKey(id);
    const cart = getGuestCart();
    const next = Number(cart[key] || 0) + 1;
    if (next > Number(deal.quantity)) throw new Error(`Only ${deal.quantity} left at this deal price.`);
    cart[key] = next;
    saveGuestCart(cart);
    updateCartCount((await getCartSummary()).count);
    showToast("Deal added to your cart. Check out before the countdown ends!");
  } catch (error) {
    showToast(error.message);
  }
}

/** Change a cart line to an exact quantity (0 removes it), respecting what is left. `key` is a product id or "d<dealId>". */
async function changeCartQuantity(key, quantity) {
  try {
    const cart = getGuestCart();
    if (quantity <= 0) {
      delete cart[key];
    } else if (isDealKey(key)) {
      const [deal] = await fetchDealsByIds([key.slice(DEAL_PREFIX.length)]);
      if (!deal || deal.status !== "live" || Number(deal.quantity) < 1) throw new Error("Sorry, this deal has ended or sold out.");
      if (quantity > Number(deal.quantity)) throw new Error(`Only ${deal.quantity} left at this deal price.`);
      cart[key] = quantity;
    } else {
      const [product] = await fetchProductsByIds([key]);
      if (!product || !product.available) throw new Error("Sorry, this item is sold out.");
      if (product.stock !== null && quantity > product.stock) throw new Error(`Only ${product.stock} item(s) are in stock.`);
      cart[key] = quantity;
    }
    saveGuestCart(cart);
    updateCartCount((await getCartSummary()).count);
    renderCart();
  } catch (error) {
    showToast(error.message);
  }
}

async function removeCartItem(key) {
  const cart = getGuestCart();
  delete cart[key];
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
    if (cart.endedDeals) showToast("A Fast Finger deal in your cart ended or sold out, so it was removed.");
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
          ${item.kind === "deal" ? `<span class="cart-deal-tag">⚡ Fast Finger deal · ends ${escapeHTML(formatDate(item.ends_at))}</span>` : ""}
          <div class="cart-actions">
            <button class="qty-button" type="button" data-cart-quantity="${item.key}" data-quantity="${item.quantity - 1}">−</button>
            <span>${item.quantity}</span>
            <button class="qty-button" type="button" data-cart-quantity="${item.key}" data-quantity="${item.quantity + 1}">+</button>
            <button class="remove-button" type="button" data-remove-cart="${item.key}">Remove</button>
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
