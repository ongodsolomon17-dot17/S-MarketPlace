"use strict";
/* ============================================================================
   navigation.js — switching between screens ("pages") without reloading the site.
   ============================================================================ */

let activePage = "home";

/* Which bottom-menu tab each screen belongs to (so the right tab stays highlighted). */
const ACCOUNT_TAB_PAGES = new Set(["account", "settings", "trader-dashboard", "orders"]);
const HOME_TAB_PAGES = new Set(["home", "product", "store"]);

function tabFor(page) {
  if (ACCOUNT_TAB_PAGES.has(page)) return "account";
  if (HOME_TAB_PAGES.has(page)) return "home";
  return page;
}

/**
 * Show one screen and hide the others.
 * options.restoreScroll — jump back to this scroll position instead of scrolling to the top.
 */
function showPage(name, options = {}) {
  // A trader who taps "Account" lands on the add-item screen; account details live under Settings.
  if (name === "account" && currentUser && currentUser.role === "trader") name = "trader-dashboard";
  activePage = name;

  document.querySelectorAll(".page-panel").forEach(panel => {
    const isActive = panel.dataset.page === name;
    panel.hidden = !isActive;
    panel.classList.toggle("is-active", isActive);
  });
  document.querySelectorAll("[data-page-link]").forEach(link => {
    link.classList.toggle("is-current", tabFor(link.dataset.pageLink) === tabFor(name));
  });

  // Screens that load their content when opened:
  if (name === "cart") renderCart();
  if (name === "orders") renderOrders();
  if (name === "account") renderAccount();
  if (name === "settings") renderSettings();
  if (name === "trader-dashboard") loadTraderDashboard();

  if (options.restoreScroll !== undefined) window.scrollTo(0, options.restoreScroll);
  else window.scrollTo({ top: 0, behavior: "smooth" });
}
