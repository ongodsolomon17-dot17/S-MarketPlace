"use strict";
/* ============================================================================
   main.js — wires buttons to the functions in the other files, then starts the app.

   Instead of attaching a listener to every button (cards are created on the fly),
   one listener on the whole page checks which button was clicked, using the
   data-… attributes written in the HTML.
   ============================================================================ */

document.addEventListener("click", async event => {
  const target = event.target;
  const closest = selector => target.closest(selector);

  /* ---- page navigation ---- */
  const navLink = closest("[data-page-link]");
  if (navLink) { event.preventDefault(); showPage(navLink.dataset.pageLink); return; }
  if (closest("[data-back]")) { closeProduct(); return; }
  if (target.id === "header-account-button" || closest("#header-account-button")) { openAccountArea(); return; }

  /* ---- cart buttons come BEFORE "open product" because the + button sits on top of the picture ---- */
  const addButton = closest("[data-add-to-cart]");
  if (addButton) { if (!addButton.disabled) await addToCart(addButton.dataset.addToCart); return; }
  const storeButton = closest("[data-open-store]");
  if (storeButton) { await openStore(storeButton.dataset.openStore); return; }
  const productOpener = closest("[data-open-product]");
  if (productOpener) { await openProduct(productOpener.dataset.openProduct); return; }

  const quantityButton = closest("[data-cart-quantity]");
  if (quantityButton) { await changeCartQuantity(quantityButton.dataset.cartQuantity, Number(quantityButton.dataset.quantity)); return; }
  const removeButton = closest("[data-remove-cart]");
  if (removeButton) { await removeCartItem(removeButton.dataset.removeCart); return; }
  if (target.id === "checkout-button") {
    if (!currentUser || currentUser.role !== "buyer") {
      window.checkoutPending = true;
      openAuth("buyer");
      if (currentUser?.role === "trader") document.getElementById("auth-feedback").textContent = "You're signed in as a trader. Please use a buyer account to check out.";
    } else {
      await openCheckout();
    }
    return;
  }
  if (closest("[data-close-checkout]")) { document.getElementById("checkout-overlay").hidden = true; return; }

  /* ---- home screen: chips, search, refresh, load more ---- */
  const chip = closest(".chip");
  if (chip) { selectCategory(chip.dataset.category); return; }
  if (target.id === "search-button") { runSearch(); return; }
  if (target.id === "refresh-feed-button") { refreshFeed(); return; }
  if (target.id === "load-more-button") { target.disabled = true; await loadHome(true); target.disabled = false; return; }
  if (closest("[data-scroll-to]")) { document.getElementById(closest("[data-scroll-to]").dataset.scrollTo)?.scrollIntoView({ behavior: "smooth" }); return; }

  /* ---- sign up / log in ---- */
  const roleButton = closest("[data-auth-role]");
  if (roleButton) { showAuthForm("signup", roleButton.dataset.authRole); return; }
  const authOpener = closest("[data-open-auth]");
  if (authOpener) { openAuth(authOpener.dataset.openAuth); return; }
  if (closest("[data-close-auth]")) { closeAuth(); return; }
  if (target.id === "choice-login") { showAuthForm("login", "buyer"); return; }
  if (target.id === "signup-tab") { showAuthForm("signup", activeAuthRole); return; }
  if (target.id === "login-tab") { showAuthForm("login", activeAuthRole); return; }
  if (target.id === "back-to-roles") {
    document.getElementById("auth-form-wrap").hidden = true;
    document.getElementById("role-choices").hidden = false;
    document.getElementById("auth-title").textContent = "How would you like to continue?";
    return;
  }
  if (closest("[data-logout]")) { await logout(); return; }

  /* ---- trader tools: products ---- */
  if (closest("[data-open-product-editor]")) { await openProductEditor(); return; }
  const editButton = closest("[data-edit-product]");
  if (editButton) { await openProductEditor(ownedProducts[editButton.dataset.editProduct]); return; }
  if (closest("[data-close-product-editor]")) { closeProductEditor(); return; }
  if (target.id === "pe-delete") { await deleteEditingProduct(); return; }
  if (target.id === "pe-pause") { await togglePauseEditing(); return; }
  const restoreButton = closest("[data-restore-product]");
  if (restoreButton) { await restoreProduct(restoreButton.dataset.restoreProduct); return; }
  const updateLine = closest("[data-update-item]");
  if (updateLine) { await updateOrderLine(updateLine.dataset.updateItem); return; }

  /* ---- Fast Finger ---- */
  if (closest("[data-open-deal-editor]")) { openDealEditor(); return; }
  if (closest("[data-close-deal-editor]")) { closeDealEditor(); return; }
  const soldButton = closest("[data-deal-sold]");
  if (soldButton) { await markDealSold(soldButton.dataset.dealSold); return; }
  const deleteDealButton = closest("[data-deal-delete]");
  if (deleteDealButton) { await deleteDeal(deleteDealButton.dataset.dealDelete); return; }
  const description = closest("[data-toggle-description]");
  if (description) { description.classList.toggle("is-open"); return; }   // tap a deal's text to read all of it

  /* ---- buyer orders ---- */
  const payButton = closest("[data-pay-order]");
  if (payButton) { payButton.disabled = true; await payOrder(payButton.dataset.payOrder); return; }
  const cancelButton = closest("[data-cancel-order]");
  if (cancelButton) { await cancelOrder(cancelButton.dataset.cancelOrder); return; }
});

/* Keyboard: Enter or Space on a focused product picture opens it (it is a role="button" div). */
document.addEventListener("keydown", event => {
  const opener = event.target.closest?.("[data-open-product][role='button']");
  if (opener && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openProduct(opener.dataset.openProduct); }
});

/* Search box: Enter searches. */
document.getElementById("market-search").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); runSearch(); }
});

/* Forms. */
document.getElementById("auth-form").addEventListener("submit", submitAuth);
document.getElementById("product-form").addEventListener("submit", saveProduct);
document.getElementById("deal-form").addEventListener("submit", saveDeal);
document.getElementById("checkout-form").addEventListener("submit", submitCheckout);
document.getElementById("pe-category").addEventListener("change", toggleCustomCategory);
document.getElementById("pe-slash-toggle").addEventListener("change", togglePriceSlash);

/* Price-slash inputs (product pop-up and deal pop-up): update the "= new price" line as the trader types. */
document.addEventListener("input", event => {
  if (event.target.classList.contains("slash-input")) refreshSlashPreview(event.target.dataset.slash);
});

/* If the browser restores this page from its back/forward cache after Paystack, reload so nothing is stuck. */
window.addEventListener("pageshow", event => { if (event.persisted) window.location.reload(); });

/* ----------------------------------------------------------------------------
   Start-up
   ---------------------------------------------------------------------------- */
(async function initializeApp() {
  // 1. Who is signed in? (An invalid or expired token is thrown away.)
  try {
    const result = await apiRequest("/api/me");
    currentUser = result.user;
    if (!currentUser) localStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* guests can browse without signing in */ }
  updateHeaderAccount();
  renderAccount();

  // 2. Did Paystack just send the buyer back with a payment reference?
  const params = new URLSearchParams(window.location.search);
  const reference = params.get("reference") || params.get("trxref");
  if (reference) {
    window.history.replaceState({}, "", window.location.pathname);
    await confirmPayment(reference);
  }

  // 3. Fill the home screen (the feed, category chips, trader shops) and the cart badge.
  await Promise.all([refreshCartCount(), loadCategoryChips(), loadTraders(), loadHome()]);
})();
