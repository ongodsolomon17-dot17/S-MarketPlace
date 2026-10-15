"use strict";
let toastTimeout;
let currentUser = null;
let activeAuthRole = "buyer";

/* Purpose: escape dynamic text before inserting it into HTML. */
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
/* Purpose: format all marketplace prices in Nigerian naira. */
function formatPrice(value) {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 2 }).format(Number(value || 0));
}
/* Purpose: show a short message after a user action. */
function showToast(message) {
  const toast = document.getElementById("toast"); toast.textContent = message; toast.classList.add("is-visible");
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}
/* Purpose: request JSON from Flask and show backend validation errors clearly. */
async function apiRequest(url, options = {}) {
  const token = localStorage.getItem("smpAuthToken");
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const base = String(window.SMP_API_BASE_URL || "").replace(/\/$/, "");
  let response;
  try { response = await fetch(`${base}${url}`, { ...options, headers }); }
  catch (_) { throw new Error("Could not reach the server. Check your connection and try again. (The server can take up to a minute to wake up.)"); }
  let data = {}; try { data = await response.json(); } catch (_) { /* the server sent a non-JSON error page */ }
  if (!response.ok) { const error = new Error(data.error || "Something went wrong."); error.status = response.status; error.data = data; throw error; }
  return data;
}
/* Purpose: keep guest cart contents on this device so cross-domain hosting does not depend on cookies. */
function getGuestCart() { try { return JSON.parse(localStorage.getItem("smpGuestCart") || "{}"); } catch (_) { return {}; } }
function saveGuestCart(cart) { localStorage.setItem("smpGuestCart", JSON.stringify(cart)); }
/* Purpose: turn a stored image value into a usable URL (uploaded https links, or files kept in /images). */
function imageURL(value) {
  if (!value) return "";
  return value.startsWith("http") ? value : `/images/${value.replace(/^images\//, "")}`;
}
/* Purpose: fetch current details for specific products only (the cart no longer downloads the whole catalogue). */
async function fetchProductsByIds(ids) {
  if (!ids.length) return [];
  const data = await apiRequest(`/api/products?ids=${ids.map(encodeURIComponent).join(",")}&limit=100`);
  return data.products;
}
/* Purpose: fetch current product details and build a cart summary from the browser's saved quantities. */
async function getCartSummary() {
  const cart = getGuestCart(); const ids = Object.keys(cart);
  if (!ids.length) return { items: [], count: 0, subtotal: 0 };
  const products = await fetchProductsByIds(ids); let subtotal = 0; const items = []; const found = new Set(); let changed = false;
  for (const p of products) {
    found.add(String(p.id)); const wanted = Number(cart[p.id] || 0); const quantity = Math.min(wanted, Number(p.stock));
    if (quantity !== wanted) { changed = true; if (quantity > 0) cart[p.id] = quantity; else delete cart[p.id]; }
    if (quantity > 0) { const line_total = Number(p.price) * quantity; subtotal += line_total; items.push({ ...p, quantity, line_total }); }
  }
  for (const id of ids) if (!found.has(id)) { delete cart[id]; changed = true; }   /* product was removed by its trader */
  if (changed) saveGuestCart(cart);
  return { items, count: items.reduce((n, i) => n + i.quantity, 0), subtotal };
}
/* Purpose: switch between app sections without reloading the whole website. */
function showPage(name) {
  document.querySelectorAll(".page-panel").forEach(panel => { const active = panel.dataset.page === name; panel.hidden = !active; panel.classList.toggle("is-active", active); });
  document.querySelectorAll("[data-page-link]").forEach(link => link.classList.toggle("is-current", link.dataset.pageLink === name));
  if (name === "cart") renderCart(); if (name === "orders") renderOrders(); if (name === "account") renderAccount(); if (name === "trader-dashboard") loadTraderDashboard();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
/* Purpose: create a safe product card from product information returned by Flask. */
function productCardHTML(p) {
  const available = Boolean(p.available); const image = imageURL(p.image);
  return `<article class="product-card"><div class="product-image-wrap"><span class="availability ${available ? "" : "sold-out"}">${available ? `Available · ${Number(p.stock)} left` : "Sold out"}</span>${image ? `<img class="product-image" src="${escapeHTML(image)}" alt="${escapeHTML(p.name)}" loading="lazy" onerror="this.style.display='none'">` : `<div class="image-placeholder">✦<small>Fragrance</small></div>`}<button class="add-button" type="button" data-add-to-cart="${p.id}" aria-label="Add ${escapeHTML(p.name)} to cart" ${available ? "" : "disabled"}>+</button></div><div class="product-details"><p class="product-category">${escapeHTML(p.category)} · <button class="inline-store-link" type="button" data-open-store="${escapeHTML(p.trader_username || "")}">${escapeHTML(p.store_name || "Trader shop")}</button></p><h3>${escapeHTML(p.name)}</h3><p class="product-description">${escapeHTML(p.description || "A fragrance waiting to be discovered.")}</p><div class="product-bottom"><strong class="price">${formatPrice(p.price)}</strong><button class="small-add" type="button" data-add-to-cart="${p.id}" ${available ? "" : "disabled"}>${available ? "Add to bag" : "Sold out"}</button></div></div></article>`;
}
/* Purpose: load products matching the chosen category or search text, 24 at a time. */
const PAGE_SIZE = 24; let productOffset = 0;
async function loadProducts(appendMode) {
  const append = appendMode === true;   /* event listeners pass an Event object, which must not count as "append" */
  const target = document.getElementById("market-products"); const more = document.getElementById("load-more-button");
  const q = document.getElementById("market-search").value.trim(); const category = document.getElementById("category-filter").value;
  if (!append) { productOffset = 0; target.innerHTML = '<p class="muted">Finding fragrances…</p>'; more.hidden = true; }
  try {
    const data = await apiRequest(`/api/products?category=${encodeURIComponent(category)}&q=${encodeURIComponent(q)}&limit=${PAGE_SIZE}&offset=${productOffset}`);
    const html = data.products.map(productCardHTML).join("");
    if (append) target.insertAdjacentHTML("beforeend", html); else target.innerHTML = html || '<p class="muted">No fragrances matched your search. Try another name or category.</p>';
    productOffset += data.products.length; more.hidden = !data.has_more;
  } catch (e) { if (append) showToast(e.message); else target.innerHTML = `<p class="muted">${escapeHTML(e.message)}</p>`; }
}
/* Purpose: find trader shops by shop name, username, or first name. */
async function loadTraders() {
  const q = document.getElementById("market-search").value.trim(); const target = document.getElementById("trader-results");
  try { const traders = await apiRequest(`/api/traders?q=${encodeURIComponent(q)}`); target.innerHTML = traders.length ? traders.map(t => `<article class="trader-card"><div class="trader-avatar">${t.profile_image ? `<img src="${escapeHTML(t.profile_image)}" alt="" class="avatar-image">` : escapeHTML((t.store_name || t.first_name || "T").slice(0,1).toUpperCase())}</div><div class="trader-card-copy"><h4>${escapeHTML(t.store_name || `${t.first_name} ${t.last_name}`)}</h4><p>@${escapeHTML(t.username)} · ${t.product_count} listed item(s)</p><small>${escapeHTML(t.store_description || "Browse this trader's fragrance collection.")}</small></div><button type="button" class="outline-button" data-open-store="${escapeHTML(t.username)}">Visit shop →</button></article>`).join("") : '<p class="muted">No trader shops matched that search yet.</p>'; }
  catch (e) { target.innerHTML = `<p class="muted">${escapeHTML(e.message)}</p>`; }
}
/* Purpose: open one trader's public storefront and display only their products. */
async function openStore(username) {
  if (!username) return; showPage("store"); document.getElementById("store-products").innerHTML = '<p class="muted">Loading this shop…</p>';
  try { const traders = await apiRequest(`/api/traders?q=${encodeURIComponent(username)}`); const trader = traders.find(t => t.username === username); const { products } = await apiRequest(`/api/products?trader=${encodeURIComponent(username)}&limit=100`);
    document.getElementById("store-title").textContent = trader?.store_name || `${username}'s shop`; document.getElementById("store-description").textContent = trader?.store_description || "Explore the products listed by this trader.";
    document.getElementById("store-products").innerHTML = products.length ? products.map(productCardHTML).join("") : '<p class="muted">This trader has not listed products yet.</p>';
  } catch (e) { document.getElementById("store-products").innerHTML = `<p class="muted">${escapeHTML(e.message)}</p>`; }
}
/* Purpose: add a product to the visitor's cart without requiring registration. */
async function addToCart(id) {
  try {
    const [product] = await fetchProductsByIds([id]);
    if (!product || product.stock < 1) throw new Error("Sorry, this perfume is sold out.");
    const cart = getGuestCart(); const next = Number(cart[id] || 0) + 1;
    if (next > Number(product.stock)) throw new Error(`Only ${product.stock} item(s) are currently in stock.`);
    cart[id] = next; saveGuestCart(cart); const summary = await getCartSummary(); updateCartCount(summary.count); showToast("Added to your cart. You can keep browsing as a guest.");
  } catch (e) { showToast(e.message); }
}
/* Purpose: update the cart quantity badge displayed in the site header. */
function updateCartCount(count) { document.getElementById("cart-count").textContent = String(count ?? 0); }
/* Purpose: restore the guest cart from local storage on page load. */
async function refreshCartCount() { try { const cart = await getCartSummary(); updateCartCount(cart.count); } catch (e) { console.error(e); } }
/* Purpose: render guest cart quantities, subtotal and the protected checkout action. */
async function renderCart() {
  const target = document.getElementById("cart-content"); target.innerHTML = '<p class="muted">Loading your cart…</p>';
  try { const cart = await getCartSummary(); updateCartCount(cart.count);
    if (!cart.items.length) { target.innerHTML = '<div class="empty-state"><h2>Your cart is empty.</h2><p>Browse the marketplace and add the fragrances you love. No account is needed yet.</p><button class="primary-button" type="button" data-page-link="home">Browse fragrances</button></div>'; return; }
    const rows = cart.items.map(i => `<article class="cart-row">${i.image ? `<img src="${escapeHTML(imageURL(i.image))}" alt="${escapeHTML(i.name)}" loading="lazy" onerror="this.style.display='none'">` : '<div class="cart-thumb">✦</div>'}<div class="cart-item-copy"><h3>${escapeHTML(i.name)}</h3><p>${formatPrice(i.price)} each · ${escapeHTML(i.store_name || "Trader")}</p><div class="cart-actions"><button class="qty-button" type="button" data-cart-quantity="${i.id}" data-quantity="${i.quantity-1}">−</button><span>${i.quantity}</span><button class="qty-button" type="button" data-cart-quantity="${i.id}" data-quantity="${i.quantity+1}">+</button><button class="remove-button" type="button" data-remove-cart="${i.id}">Remove</button></div></div><strong class="cart-line-total">${formatPrice(i.line_total)}</strong></article>`).join("");
    target.innerHTML = `<div class="cart-list">${rows}</div><div class="cart-summary"><span>Subtotal <strong>${formatPrice(cart.subtotal)}</strong></span><button class="primary-button" id="checkout-button" type="button">Proceed to checkout</button></div><p class="muted">You can shop as a guest. A buyer account is required only when you proceed to checkout. Payment is handled securely by Paystack.</p>`;
  } catch (e) { target.innerHTML = `<p class="muted">${escapeHTML(e.message)}</p>`; }
}
/* Purpose: adjust a saved cart quantity and enforce the latest listed stock count. */
async function changeCartQuantity(id, quantity) {
  try {
    const cart = getGuestCart();
    if (quantity <= 0) delete cart[id];
    else { const [p] = await fetchProductsByIds([id]); if (!p || quantity > p.stock) throw new Error(`Only ${p?.stock ?? 0} item(s) are in stock.`); cart[id] = quantity; }
    saveGuestCart(cart); const summary = await getCartSummary(); updateCartCount(summary.count); renderCart();
  } catch (e) { showToast(e.message); }
}
/* Purpose: remove a selected item from the local guest cart. */
async function removeCartItem(id) { const cart = getGuestCart(); delete cart[id]; saveGuestCart(cart); await renderCart(); showToast("Item removed."); }
/* Purpose: open the account panel showing actions suitable for the signed-in role. */
function renderAccount() {
  const target = document.getElementById("account-content");
  if (!currentUser) { target.innerHTML = `<h2>Welcome, fragrance lover.</h2><p>You can browse and add products without an account. Create a buyer account when you are ready to check out, or join as a trader to open a shop.</p><div class="hero-actions"><button class="primary-button" type="button" data-open-auth="buyer">Create buyer account</button><button class="outline-button" type="button" data-open-auth="trader">Create trader account</button><button class="text-button" type="button" data-open-auth="login">Log in</button></div>`; return; }
  const trader = currentUser.role === "trader";
  target.innerHTML = `<div class="profile-summary">${currentUser.profile_image ? `<img src="${escapeHTML(currentUser.profile_image)}" alt="Profile picture" class="profile-picture">` : `<div class="account-avatar">${escapeHTML(currentUser.first_name.slice(0,1).toUpperCase())}</div>`}<div><h2>Welcome back, ${escapeHTML(currentUser.first_name)}.</h2><p><strong>${trader ? "Trader account" : "Buyer account"}</strong> · @${escapeHTML(currentUser.username)}</p></div></div><form id="profile-edit-form" class="panel-form"><h3>Edit your profile</h3><label for="edit-first-name">First name</label><input id="edit-first-name" name="first_name" value="${escapeHTML(currentUser.first_name)}" minlength="2" required><label for="edit-last-name">Last name</label><input id="edit-last-name" name="last_name" value="${escapeHTML(currentUser.last_name)}" minlength="2" required><label for="edit-email">Email</label><input id="edit-email" name="email" type="email" value="${escapeHTML(currentUser.email)}" required><label for="edit-phone">Phone number</label><input id="edit-phone" name="phone" value="${escapeHTML(currentUser.phone || "")}">${trader ? `<label for="edit-store-name">Shop name</label><input id="edit-store-name" name="store_name" value="${escapeHTML(currentUser.store_name || "")}" required><label for="edit-store-description">Shop description</label><textarea id="edit-store-description" name="store_description" rows="3">${escapeHTML(currentUser.store_description || "")}</textarea>` : ""}<label for="profile-picture-file">Profile picture</label><input id="profile-picture-file" type="file" accept="image/png,image/jpeg,image/webp"><button class="primary-button" type="submit">Save profile changes</button><p id="profile-feedback" class="form-feedback" role="status"></p></form><form id="password-form" class="panel-form"><h3>Change password</h3><label for="current-password">Current password</label><input id="current-password" type="password" autocomplete="current-password" required><label for="new-password">New password (minimum 8 characters)</label><input id="new-password" type="password" minlength="8" autocomplete="new-password" required><button class="primary-button" type="submit">Change password</button><p id="password-feedback" class="form-feedback" role="status"></p></form><div class="hero-actions">${trader ? '<button class="primary-button" type="button" data-page-link="trader-dashboard">Manage my shop</button>' : '<button class="primary-button" type="button" data-page-link="orders">My orders</button><button class="outline-button" type="button" data-page-link="cart">Go to cart</button>'}<button class="outline-button" type="button" id="logout-button">Sign out</button></div>`;
  document.getElementById("profile-edit-form").addEventListener("submit", saveProfile); document.getElementById("password-form").addEventListener("submit", changePassword);
}
/* Purpose: upload a selected image to Cloudinary and save editable profile fields in Neon. */
async function saveProfile(event) {
  event.preventDefault(); const form=event.currentTarget; const feedback=document.getElementById("profile-feedback"); const payload=Object.fromEntries(new FormData(form).entries()); delete payload.undefined;
  delete payload.first_name; payload.first_name=document.getElementById("edit-first-name").value.trim(); payload.last_name=document.getElementById("edit-last-name").value.trim();
  const file=document.getElementById("profile-picture-file").files[0];
  try {
    const result=await apiRequest("/api/profile/edit",{method:"PATCH",body:JSON.stringify(payload)}); currentUser=result.user;
    if(file){const body=new FormData(); body.append("image",file); const uploaded=await apiRequest("/api/upload-image",{method:"POST",body}); const updated=await apiRequest("/api/profile/image",{method:"PATCH",body:JSON.stringify({profile_image:uploaded.url})}); currentUser=updated.user;}
    renderAccount(); updateHeaderAccount(); showToast("Profile saved successfully.");
  } catch(e) { feedback.textContent=e.message; }
}
/* Purpose: open the welcome choices, then optionally show a buyer/trader signup or login form. */
function openAuth(role = "choices") {
  document.getElementById("auth-overlay").hidden = false; document.getElementById("auth-form-wrap").hidden = true; document.getElementById("role-choices").hidden = false;
  document.getElementById("auth-feedback").textContent = ""; activeAuthRole = role;
  if (role === "login") showAuthForm("login", "buyer");
  else if (role === "buyer" || role === "trader") showAuthForm("signup", role);
  else document.getElementById("auth-title").textContent = "How would you like to continue?";
}
/* Purpose: configure the account form for signup or login and selected role. */
function showAuthForm(mode, role) {
  activeAuthRole = role; document.getElementById("role-choices").hidden = true; document.getElementById("auth-form-wrap").hidden = false;
  document.getElementById("auth-mode").value = mode; document.getElementById("auth-role").value = role;
  const signup = mode === "signup"; document.getElementById("signup-fields").hidden = !signup; document.getElementById("login-fields").hidden = signup;
  document.querySelectorAll("#signup-fields input").forEach(input => { input.disabled = !signup; });
  document.querySelectorAll("#login-fields input").forEach(input => { input.disabled = signup; });
  document.getElementById("auth-password-label").hidden = !signup; document.getElementById("auth-password").hidden = !signup; document.getElementById("auth-password").required = signup;
  document.getElementById("login-password").required = !signup; document.getElementById("login-identity").required = !signup;
  document.getElementById("store-name-field").hidden = !(signup && role === "trader"); document.getElementById("auth-store-name").required = signup && role === "trader";
  document.getElementById("signup-tab").classList.toggle("active", signup); document.getElementById("login-tab").classList.toggle("active", !signup);
  document.getElementById("auth-title").textContent = signup ? (role === "trader" ? "Create your trader account" : "Create your buyer account") : "Welcome back";
  document.getElementById("auth-submit").textContent = signup ? (role === "trader" ? "Create trader account" : "Create buyer account") : "Log in";
  document.getElementById("auth-feedback").textContent = "";
}
/* Purpose: close the account modal so visitors can continue browsing freely. */
function closeAuth() { document.getElementById("auth-overlay").hidden = true; try { sessionStorage.setItem("smpWelcomeSeen", "yes"); } catch (_) {} }
/* Purpose: submit buyer/trader registration or login details to Flask. */
async function submitAuth(event) {
  event.preventDefault(); const mode = document.getElementById("auth-mode").value; const feedback = document.getElementById("auth-feedback"); const submit = document.getElementById("auth-submit");
  const value = id => document.getElementById(id).value.trim(); let payload;
  if (mode === "signup") payload = { role: activeAuthRole, first_name: value("auth-first"), last_name: value("auth-last"), username: value("auth-username"), email: value("auth-email"), phone: value("auth-phone"), password: document.getElementById("auth-password").value, store_name: value("auth-store-name") };
  else payload = { identity: value("login-identity"), password: document.getElementById("login-password").value };
  submit.disabled = true; feedback.textContent = "Please wait…";
  try { const result = await apiRequest(mode === "signup" ? "/api/register" : "/api/login", { method: "POST", body: JSON.stringify(payload) }); currentUser = result.user; if (result.token) localStorage.setItem("smpAuthToken", result.token); closeAuth(); updateHeaderAccount(); renderAccount(); showToast(result.message); if (currentUser.role === "trader") showPage("trader-dashboard"); else if (sessionStorage.getItem("smpPendingReference")) { await confirmPayment(sessionStorage.getItem("smpPendingReference")); } else if (window.checkoutPending) { window.checkoutPending = false; await openCheckout(); } }
  catch (e) { feedback.textContent = e.message; }
  finally { submit.disabled = false; }
}
/* Purpose: keep the header button consistent with the current signed-in account. */
function updateHeaderAccount() { document.getElementById("header-account-button").textContent = currentUser ? `${currentUser.first_name} · ${currentUser.role[0].toUpperCase()}${currentUser.role.slice(1)}` : "Sign in / Join"; }
/* Purpose: load the signed-in trader's products into their management dashboard. */
async function loadTraderDashboard() {
  if (!currentUser || currentUser.role !== "trader") { showToast("Please sign in with a trader account to manage a shop."); openAuth("trader"); return; }
  document.getElementById("dashboard-store-name").textContent = currentUser.store_name || "Your shop"; const target = document.getElementById("trader-own-products"); target.innerHTML = '<p class="muted">Loading your products…</p>';
  loadTraderOrders(); try { const products = await apiRequest("/api/trader/products"); target.innerHTML = products.length ? products.map(p => `<article class="owned-product"><div class="owned-product-main"><strong>${escapeHTML(p.name)}</strong><small>Current price: ${formatPrice(p.price)}</small><label>Price (₦) <input class="price-edit-input" type="number" min="0" step="0.01" value="${Number(p.price)}" data-price-value="${p.id}" aria-label="Price for ${escapeHTML(p.name)}"></label><label>Stock <input class="stock-edit-input" type="number" min="0" step="1" value="${Number(p.stock)}" data-stock-value="${p.id}" aria-label="Stock quantity for ${escapeHTML(p.name)}"></label></div><div class="owned-product-actions"><button type="button" class="outline-button" data-save-product="${p.id}">Save price & stock</button><button type="button" class="remove-button" data-delete-product="${p.id}">Delete</button></div></article>`).join("") : '<p class="muted">You have not listed products yet.</p>'; }
  catch (e) { target.innerHTML = `<p class="muted">${escapeHTML(e.message)}</p>`; }
}
/* Purpose: submit a new product to the signed-in trader's own shop. */
async function submitProduct(event) {
  event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form).entries()); data.price = Number(data.price); data.stock = Number(data.stock); const feedback = document.getElementById("product-feedback");
  try { const imageFile = document.getElementById("new-product-image-file")?.files[0]; if (imageFile) { const body = new FormData(); body.append("image", imageFile); const uploaded = await apiRequest("/api/upload-image", { method: "POST", body }); data.image = uploaded.url; } const result = await apiRequest("/api/trader/products", { method: "POST", body: JSON.stringify(data) }); feedback.textContent = result.message; form.reset(); await loadTraderDashboard(); await loadProducts(); await loadTraders(); showToast(result.message); }
  catch (e) { feedback.textContent = e.message; }
}
/* Purpose: format an ISO date for display. */
function formatDate(value) { return value ? new Date(value).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" }) : ""; }
const ORDER_STATUS = { "Awaiting payment": ["Awaiting payment", "badge-pending"], "Paid": ["Paid", "badge-paid"], "Cancelled": ["Cancelled", "badge-bad"], "Expired": ["Expired", "badge-bad"], "Refund needed": ["Refund pending", "badge-bad"] };
const FULFILMENT = { "Pending": "Waiting for trader", "Processing": "Preparing", "Shipped": "Shipped", "Delivered": "Delivered" };

/* Purpose: show the delivery form (with the order total) before sending the buyer to Paystack. */
async function openCheckout() {
  if (!currentUser || currentUser.role !== "buyer") return;
  try {
    const cart = await getCartSummary(); updateCartCount(cart.count);
    if (!cart.items.length) { showToast("Your cart is empty or its items are no longer available."); await renderCart(); return; }
    let saved = {}; try { saved = JSON.parse(localStorage.getItem("smpShipping") || "{}"); } catch (_) {}
    const set = (id, value) => { document.getElementById(id).value = value || ""; };
    set("ship-name", saved.name || `${currentUser.first_name} ${currentUser.last_name}`); set("ship-phone", saved.phone || currentUser.phone); set("ship-address", saved.address); set("ship-city", saved.city); set("ship-state", saved.state);
    document.getElementById("checkout-total").textContent = formatPrice(cart.subtotal); document.getElementById("checkout-feedback").textContent = ""; document.getElementById("checkout-submit").disabled = false;
    document.getElementById("checkout-overlay").hidden = false;
  } catch (e) { showToast(e.message); }
}
/* Purpose: reserve the items, create the order, then redirect the buyer to Paystack to pay. */
async function submitCheckout(event) {
  event.preventDefault(); const feedback = document.getElementById("checkout-feedback"); const button = document.getElementById("checkout-submit");
  const value = id => document.getElementById(id).value.trim();
  const shipping = { name: value("ship-name"), phone: value("ship-phone"), address: value("ship-address"), city: value("ship-city"), state: value("ship-state") };
  const items = Object.entries(getGuestCart()).map(([product_id, quantity]) => ({ product_id: Number(product_id), quantity: Number(quantity) }));
  button.disabled = true; feedback.textContent = "Reserving your items…";
  try {
    const result = await apiRequest("/api/checkout", { method: "POST", body: JSON.stringify({ items, shipping }) });
    if (!/^https:\/\//.test(result.authorization_url || "")) throw new Error("The payment page could not be opened. Please try again from My orders.");
    try { localStorage.setItem("smpShipping", JSON.stringify(shipping)); } catch (_) {}
    saveGuestCart({}); updateCartCount(0); feedback.textContent = "Redirecting to Paystack…"; window.location.href = result.authorization_url;
  } catch (e) {
    button.disabled = false;
    if (e.status === 401) { document.getElementById("checkout-overlay").hidden = true; window.checkoutPending = true; openAuth("login"); document.getElementById("auth-feedback").textContent = "Your session expired. Please log in to continue checkout."; }
    else { feedback.textContent = e.message; await refreshCartCount(); }
  }
}
/* Purpose: when Paystack sends the buyer back, ask the server to confirm the payment and show the result. */
async function confirmPayment(reference) {
  if (!currentUser || currentUser.role !== "buyer") {
    try { sessionStorage.setItem("smpPendingReference", reference); } catch (_) {}
    showToast("Please log in to your buyer account to confirm your payment."); openAuth("login"); return;
  }
  try { sessionStorage.removeItem("smpPendingReference"); } catch (_) {}
  showPage("orders");
  try { const result = await apiRequest("/api/orders/verify", { method: "POST", body: JSON.stringify({ reference }) }); showToast(result.message); }
  catch (e) { showToast(e.message); }
  renderOrders(); loadProducts();
}
/* Purpose: build one order card for the buyer's order history. */
function orderCardHTML(o) {
  const [label, css] = ORDER_STATUS[o.status] || [o.status, ""]; const unpaid = o.status === "Awaiting payment";
  const items = o.items.map(i => `<li><span>${escapeHTML(i.name)} × ${i.quantity} <small>· ${escapeHTML(i.store_name)}</small></span><span>${o.status === "Paid" ? `<span class="badge">${escapeHTML(FULFILMENT[i.fulfilment_status] || i.fulfilment_status)}</span> ` : ""}${formatPrice(i.unit_price * i.quantity)}</span></li>`).join("");
  return `<article class="order-card"><div class="order-head"><h3>Order #${o.id}</h3><span class="badge ${css}">${escapeHTML(label)}</span></div><ul class="order-items">${items}</ul><p class="order-meta"><strong>Total ${formatPrice(o.total)}</strong> · placed ${escapeHTML(formatDate(o.created_at))}<br>Deliver to: ${escapeHTML(o.shipping_name)}, ${escapeHTML(o.shipping_address)}, ${escapeHTML(o.shipping_city)}, ${escapeHTML(o.shipping_state)}${unpaid && o.expires_at ? `<br>Your items are held until ${escapeHTML(formatDate(o.expires_at))}.` : ""}${o.status === "Refund needed" ? "<br>Your payment arrived after the items sold out. It will be refunded." : ""}</p>${unpaid ? `<div class="order-actions"><button class="primary-button" type="button" data-pay-order="${o.id}">Pay now</button><button class="outline-button" type="button" data-cancel-order="${o.id}">Cancel order</button></div>` : ""}</article>`;
}
/* Purpose: show the signed-in buyer's orders, payment status and delivery progress. */
async function renderOrders() {
  const target = document.getElementById("orders-content");
  if (!currentUser || currentUser.role !== "buyer") { target.innerHTML = '<div class="empty-state"><h2>Log in to see your orders.</h2><p>Orders belong to buyer accounts.</p><button class="primary-button" type="button" data-open-auth="login">Log in</button></div>'; return; }
  target.innerHTML = '<p class="muted">Loading your orders…</p>';
  try {
    const orders = await apiRequest("/api/orders");
    target.innerHTML = orders.length ? orders.map(orderCardHTML).join("") : '<div class="empty-state"><h2>No orders yet.</h2><p>When you check out, your orders and their delivery progress will appear here.</p><button class="primary-button" type="button" data-page-link="home">Browse fragrances</button></div>';
  } catch (e) { target.innerHTML = `<p class="muted">${escapeHTML(e.message)}</p>`; }
}
/* Purpose: send the buyer to Paystack again for an unpaid order that is still being held. */
async function payOrder(id) {
  try { const result = await apiRequest(`/api/orders/${id}/pay`, { method: "POST", body: JSON.stringify({}) }); if (!/^https:\/\//.test(result.authorization_url || "")) throw new Error("The payment page could not be opened."); window.location.href = result.authorization_url; }
  catch (e) { showToast(e.message); renderOrders(); }
}
/* Purpose: cancel an unpaid order so its items go back on sale. */
async function cancelOrder(id) {
  if (!confirm("Cancel this unpaid order? The items will go back on sale.")) return;
  try { const result = await apiRequest(`/api/orders/${id}/cancel`, { method: "POST", body: JSON.stringify({}) }); showToast(result.message); } catch (e) { showToast(e.message); }
  renderOrders(); loadProducts();
}
/* Purpose: show a trader the paid order lines for their products, with delivery details and a status control. */
async function loadTraderOrders() {
  const target = document.getElementById("trader-orders"); if (!target) return;
  target.innerHTML = '<p class="muted">Loading orders…</p>';
  try {
    const data = await apiRequest("/api/trader/orders");
    const summary = `<p class="muted">Total paid sales: <strong>${formatPrice(data.total_sales)}</strong></p>`;
    if (!data.orders.length) { target.innerHTML = summary + '<p class="muted">No paid orders yet. When a buyer pays, the delivery details appear here.</p>'; return; }
    target.innerHTML = summary + data.orders.map(o => `<article class="order-line"><div><strong>${escapeHTML(o.product_name)} × ${o.quantity}</strong><small>Order #${o.order_id} · paid ${escapeHTML(formatDate(o.paid_at))} · ${formatPrice(o.unit_price * o.quantity)}</small><small>Deliver to: ${escapeHTML(o.shipping_name)} · ${escapeHTML(o.shipping_phone)}<br>${escapeHTML(o.shipping_address)}, ${escapeHTML(o.shipping_city)}, ${escapeHTML(o.shipping_state)}</small></div><div class="order-line-actions"><select data-item-status="${o.item_id}" aria-label="Delivery status">${Object.entries(FULFILMENT).map(([key, text]) => `<option value="${key}" ${key === o.fulfilment_status ? "selected" : ""} ${key === "Pending" ? "disabled" : ""}>${text}</option>`).join("")}</select><button type="button" class="outline-button" data-update-item="${o.item_id}">Update</button></div></article>`).join("");
  } catch (e) { target.innerHTML = `<p class="muted">${escapeHTML(e.message)}</p>`; }
}
/* Purpose: change the signed-in user's password; the server returns a fresh token for this device. */
async function changePassword(event) {
  event.preventDefault(); const form = event.currentTarget; const feedback = document.getElementById("password-feedback");
  try {
    const result = await apiRequest("/api/profile/password", { method: "POST", body: JSON.stringify({ current_password: document.getElementById("current-password").value, new_password: document.getElementById("new-password").value }) });
    localStorage.setItem("smpAuthToken", result.token); form.reset(); feedback.textContent = result.message; showToast(result.message);
  } catch (e) { feedback.textContent = e.message; }
}
/* Purpose: submit the basic contact form without pretending email delivery is connected. */
async function submitContactForm(event) { event.preventDefault(); showToast("Contact messaging is not configured in this starter version."); }

document.addEventListener("click", async event => {
  const nav = event.target.closest("[data-page-link]"); if (nav) { event.preventDefault(); showPage(nav.dataset.pageLink); return; }
  const payBtn = event.target.closest("[data-pay-order]"); if (payBtn) { payBtn.disabled = true; await payOrder(payBtn.dataset.payOrder); return; }
  const cancelBtn = event.target.closest("[data-cancel-order]"); if (cancelBtn) { await cancelOrder(cancelBtn.dataset.cancelOrder); return; }
  const itemBtn = event.target.closest("[data-update-item]"); if (itemBtn) { const id = itemBtn.dataset.updateItem; const status = document.querySelector(`[data-item-status="${id}"]`).value; if (status === "Pending") { showToast("Choose Preparing, Shipped or Delivered first."); return; } try { const result = await apiRequest(`/api/trader/order-items/${id}`, { method: "PATCH", body: JSON.stringify({ fulfilment_status: status }) }); showToast(result.message); } catch (e) { showToast(e.message); } return; }
  if (event.target.closest("[data-close-checkout]")) { document.getElementById("checkout-overlay").hidden = true; return; }
  if (event.target.id === "load-more-button") { event.target.disabled = true; await loadProducts(true); event.target.disabled = false; return; }
  const add = event.target.closest("[data-add-to-cart]"); if (add && !add.disabled) { await addToCart(add.dataset.addToCart); return; }
  const openStoreButton = event.target.closest("[data-open-store]"); if (openStoreButton) { await openStore(openStoreButton.dataset.openStore); return; }
  const roleButton = event.target.closest("[data-auth-role]"); if (roleButton) { showAuthForm("signup", roleButton.dataset.authRole); return; }
  if (event.target.closest("[data-open-auth]")) { openAuth(event.target.closest("[data-open-auth]").dataset.openAuth); return; }
  if (event.target.closest("[data-close-auth]")) { closeAuth(); return; }
  const qty = event.target.closest("[data-cart-quantity]"); if (qty) { await changeCartQuantity(qty.dataset.cartQuantity, Number(qty.dataset.quantity)); return; }
  const remove = event.target.closest("[data-remove-cart]"); if (remove) { await removeCartItem(remove.dataset.removeCart); return; }
  const productSave = event.target.closest("[data-save-product]"); if (productSave) { const id=productSave.dataset.saveProduct; const priceInput=document.querySelector(`[data-price-value="${id}"]`); const stockInput=document.querySelector(`[data-stock-value="${id}"]`); const price=Number(priceInput.value); const stock=Number(stockInput.value); if (!Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) { showToast("Enter a valid non-negative price and whole-number stock quantity."); return; } try { const result=await apiRequest(`/api/trader/products/${id}`,{method:"PATCH",body:JSON.stringify({price,stock})}); showToast(result.message); await loadTraderDashboard(); await loadProducts(); await loadTraders(); } catch(e) { showToast(e.message); } return; }
  const del = event.target.closest("[data-delete-product]"); if (del) { if (!confirm("Remove this product from your shop?")) return; try { const result = await apiRequest(`/api/trader/products/${del.dataset.deleteProduct}`, { method: "DELETE" }); await loadTraderDashboard(); await loadProducts(); showToast(result.message); } catch (e) { showToast(e.message); } return; }
  if (event.target.id === "checkout-button") { if (!currentUser || currentUser.role !== "buyer") { window.checkoutPending = true; openAuth("buyer"); if (currentUser?.role === "trader") document.getElementById("auth-feedback").textContent = "You're signed in as a trader. Please use a buyer account to check out."; } else await openCheckout(); return; }
  if (event.target.id === "logout-button") { try { await apiRequest("/api/logout", { method: "POST", body: JSON.stringify({}) }); currentUser = null; localStorage.removeItem("smpAuthToken"); updateHeaderAccount(); renderAccount(); showToast("Signed out."); showPage("home"); } catch (e) { showToast(e.message); } }
  if (event.target.id === "header-account-button") { if (currentUser) showPage("account"); else openAuth("choices"); return; }
  if (event.target.id === "search-button") { await loadProducts(); await loadTraders(); }
  if (event.target.id === "choice-login") { showAuthForm("login", "buyer"); return; }
  if (event.target.id === "signup-tab") showAuthForm("signup", activeAuthRole);
  if (event.target.id === "login-tab") showAuthForm("login", activeAuthRole);
  if (event.target.id === "back-to-roles") { document.getElementById("auth-form-wrap").hidden = true; document.getElementById("role-choices").hidden = false; document.getElementById("auth-title").textContent = "How would you like to continue?"; }
  if (event.target.closest("[data-scroll-to]")) document.getElementById(event.target.closest("[data-scroll-to]").dataset.scrollTo)?.scrollIntoView({ behavior: "smooth" });
});
document.getElementById("market-search").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); loadProducts(); loadTraders(); } });
document.getElementById("category-filter").addEventListener("change", loadProducts);
document.getElementById("auth-form").addEventListener("submit", submitAuth);
document.getElementById("product-form").addEventListener("submit", submitProduct);
document.getElementById("checkout-form").addEventListener("submit", submitCheckout);
/* Purpose: if the browser restores this page from its back/forward cache after Paystack, reload so nothing is stuck. */
window.addEventListener("pageshow", event => { if (event.persisted) window.location.reload(); });
(async function initializeApp() {
  try { const result = await apiRequest("/api/me"); currentUser = result.user; if (!currentUser) localStorage.removeItem("smpAuthToken"); updateHeaderAccount(); } catch (e) { /* Visitors can browse without signing in. */ }
  renderAccount();
  const params = new URLSearchParams(window.location.search); const reference = params.get("reference") || params.get("trxref");
  if (reference) { window.history.replaceState({}, "", window.location.pathname); await confirmPayment(reference); }
  await refreshCartCount(); await loadTraders(); await loadProducts();
})();
