"use strict";
/* ============================================================================
   orders.js — buying: the delivery form, paying with Paystack, and "My orders".
   ============================================================================ */

/* How each order status and delivery status is labelled (and coloured) on screen. */
const ORDER_STATUS = {
  "Awaiting payment": ["Awaiting payment", "badge-pending"],
  "Paid": ["Paid", "badge-paid"],
  "Cancelled": ["Cancelled", "badge-bad"],
  "Expired": ["Expired", "badge-bad"],
  "Refund needed": ["Refund pending", "badge-bad"]
};
const FULFILMENT = { "Pending": "Waiting for trader", "Processing": "Preparing", "Shipped": "Shipped", "Delivered": "Delivered" };

/* ----------------------------------------------------------------------------
   Checkout
   ---------------------------------------------------------------------------- */
/** Show the delivery form (with the order total) before sending the buyer to Paystack. */
async function openCheckout() {
  if (!currentUser || currentUser.role !== "buyer") return;
  try {
    const cart = await getCartSummary();
    updateCartCount(cart.count);
    if (!cart.items.length) {
      showToast("Your cart is empty or its items are no longer available.");
      await renderCart();
      return;
    }
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("smpShipping") || "{}"); } catch (_) { /* nothing saved yet */ }
    const fill = (id, value) => { document.getElementById(id).value = value || ""; };
    fill("ship-name", saved.name || `${currentUser.first_name} ${currentUser.last_name}`);
    fill("ship-phone", saved.phone || currentUser.phone);
    fill("ship-address", saved.address);
    fill("ship-city", saved.city);
    fill("ship-state", saved.state);
    document.getElementById("checkout-total").textContent = formatPrice(cart.subtotal);
    document.getElementById("checkout-feedback").textContent = "";
    document.getElementById("checkout-submit").disabled = false;
    document.getElementById("checkout-overlay").hidden = false;
  } catch (error) {
    showToast(error.message);
  }
}

/** Reserve the items, create the order, then send the buyer to Paystack's payment page. */
async function submitCheckout(event) {
  event.preventDefault();
  const feedback = document.getElementById("checkout-feedback");
  const button = document.getElementById("checkout-submit");
  const value = id => document.getElementById(id).value.trim();
  const shipping = {
    name: value("ship-name"), phone: value("ship-phone"), address: value("ship-address"),
    city: value("ship-city"), state: value("ship-state")
  };
  const items = Object.entries(getGuestCart()).map(([id, quantity]) => ({ product_id: Number(id), quantity: Number(quantity) }));

  button.disabled = true;
  feedback.textContent = "Reserving your items…";
  try {
    const result = await apiRequest("/api/checkout", { method: "POST", body: JSON.stringify({ items, shipping }) });
    if (!/^https:\/\//.test(result.authorization_url || "")) {
      throw new Error("The payment page could not be opened. Please try again from My orders.");
    }
    try { localStorage.setItem("smpShipping", JSON.stringify(shipping)); } catch (_) { /* remembering the address is optional */ }
    saveGuestCart({});                 // the items now belong to the order
    updateCartCount(0);
    feedback.textContent = "Redirecting to Paystack…";
    window.location.href = result.authorization_url;
  } catch (error) {
    button.disabled = false;
    if (error.status === 401) {        // the login expired while they were on the form
      document.getElementById("checkout-overlay").hidden = true;
      window.checkoutPending = true;
      openAuth("login");
      document.getElementById("auth-feedback").textContent = "Your session expired. Please log in to continue checkout.";
    } else {
      feedback.textContent = error.message;
      await refreshCartCount();
    }
  }
}

/** Paystack sent the buyer back with a payment reference: ask the server to confirm it, then show the result. */
async function confirmPayment(reference) {
  if (!currentUser || currentUser.role !== "buyer") {
    try { sessionStorage.setItem("smpPendingReference", reference); } catch (_) { /* ignore */ }
    showToast("Please log in to your buyer account to confirm your payment.");
    openAuth("login");
    return;
  }
  try { sessionStorage.removeItem("smpPendingReference"); } catch (_) { /* ignore */ }
  showPage("orders");
  try {
    const result = await apiRequest("/api/orders/verify", { method: "POST", body: JSON.stringify({ reference }) });
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
  renderOrders();
  loadHome();
}

/* ----------------------------------------------------------------------------
   My orders
   ---------------------------------------------------------------------------- */
/** One order card: items, total, delivery address and (if unpaid) Pay now / Cancel. */
function orderCardHTML(order) {
  const [label, css] = ORDER_STATUS[order.status] || [order.status, ""];
  const unpaid = order.status === "Awaiting payment";
  const items = order.items.map(item => `
    <li><span>${escapeHTML(item.name)} × ${item.quantity} <small>· ${escapeHTML(item.store_name)}</small></span>
      <span>${order.status === "Paid" ? `<span class="badge">${escapeHTML(FULFILMENT[item.fulfilment_status] || item.fulfilment_status)}</span> ` : ""}${formatPrice(item.unit_price * item.quantity)}</span></li>`).join("");
  return `
    <article class="order-card">
      <div class="order-head"><h3>Order #${order.id}</h3><span class="badge ${css}">${escapeHTML(label)}</span></div>
      <ul class="order-items">${items}</ul>
      <p class="order-meta"><strong>Total ${formatPrice(order.total)}</strong> · placed ${escapeHTML(formatDate(order.created_at))}<br>
        Deliver to: ${escapeHTML(order.shipping_name)}, ${escapeHTML(order.shipping_address)}, ${escapeHTML(order.shipping_city)}, ${escapeHTML(order.shipping_state)}
        ${unpaid && order.expires_at ? `<br>Your items are held until ${escapeHTML(formatDate(order.expires_at))}.` : ""}
        ${order.status === "Refund needed" ? "<br>Your payment arrived after the items sold out. It will be refunded." : ""}</p>
      ${unpaid ? `<div class="order-actions">
        <button class="primary-button" type="button" data-pay-order="${order.id}">Pay now</button>
        <button class="outline-button" type="button" data-cancel-order="${order.id}">Cancel order</button></div>` : ""}
    </article>`;
}

/** Draw the buyer's order history. */
async function renderOrders() {
  const target = document.getElementById("orders-content");
  if (!currentUser || currentUser.role !== "buyer") {
    target.innerHTML = '<div class="empty-state"><h2>Log in to see your orders.</h2><p>Orders belong to buyer accounts.</p><button class="primary-button" type="button" data-open-auth="login">Log in</button></div>';
    return;
  }
  target.innerHTML = '<p class="muted">Loading your orders…</p>';
  try {
    const orders = await apiRequest("/api/orders");
    target.innerHTML = orders.length
      ? orders.map(orderCardHTML).join("")
      : '<div class="empty-state"><h2>No orders yet.</h2><p>When you check out, your orders and their delivery progress will appear here.</p><button class="primary-button" type="button" data-page-link="home">Browse products</button></div>';
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

/** Go back to Paystack for an unpaid order that is still being held. */
async function payOrder(id) {
  try {
    const result = await apiRequest(`/api/orders/${id}/pay`, { method: "POST", body: JSON.stringify({}) });
    if (!/^https:\/\//.test(result.authorization_url || "")) throw new Error("The payment page could not be opened.");
    window.location.href = result.authorization_url;
  } catch (error) {
    showToast(error.message);
    renderOrders();
  }
}

/** Cancel an unpaid order so its items go back on sale. */
async function cancelOrder(id) {
  if (!confirm("Cancel this unpaid order? The items will go back on sale.")) return;
  try {
    const result = await apiRequest(`/api/orders/${id}/cancel`, { method: "POST", body: JSON.stringify({}) });
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
  renderOrders();
  loadHome();
}
