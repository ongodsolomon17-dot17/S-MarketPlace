"use strict";
/* ============================================================================
   wallet.js — a trader's money screens, and notifications for everyone.

   How a trader gets paid (see backend/escrow_service.py):
     buyer pays → the money is held in ESCROW → the buyer confirms delivery → it becomes AVAILABLE
     → the trader requests a payout → the admin sends it to the trader's bank account.
   ============================================================================ */

/** 0123456789 → ••••••6789 (we never show a full account number on screen). */
function maskAccount(number) {
  return "••••••" + String(number).slice(-4);
}

/* ----------------------------------------------------------------------------
   Earnings panel (trader screen)
   ---------------------------------------------------------------------------- */
const PAYOUT_LABEL = { requested: "Waiting to be sent", paid: "Sent", rejected: "Declined" };
let currentFinanceEarnings = null;
let selectedFinanceBalance = "in_escrow";
let financeBalancesHidden = false;

const FINANCE_BALANCE_CATEGORIES = {
  in_escrow: { label: "In escrow", hint: "Paid by buyers and held until delivery is confirmed." },
  disputed: { label: "On hold", hint: "Held while a buyer report is being reviewed." },
  paid_out: { label: "Paid out", hint: "Successfully sent to your bank account." }
};

function renderFinanceBalanceSelection() {
  const earnings = currentFinanceEarnings;
  if (!earnings) return;
  const category = FINANCE_BALANCE_CATEGORIES[selectedFinanceBalance] || FINANCE_BALANCE_CATEGORIES.in_escrow;
  document.getElementById("finance-available-amount").textContent = financeBalancesHidden ? "••••••••" : formatPrice(earnings.available);
  document.getElementById("finance-selected-label").textContent = category.label;
  document.getElementById("finance-selected-amount").textContent = financeBalancesHidden ? "••••••••" : formatPrice(earnings[selectedFinanceBalance]);
  document.querySelectorAll("[data-finance-category]").forEach(button => {
    const selected = button.dataset.financeCategory === selectedFinanceBalance;
    button.setAttribute("aria-pressed", String(selected));
    button.classList.toggle("is-selected", selected);
  });
  const toggle = document.querySelector("[data-toggle-balance]");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(financeBalancesHidden));
    toggle.setAttribute("aria-label", financeBalancesHidden ? "Show balance amounts" : "Hide balance amounts");
    toggle.title = financeBalancesHidden ? "Show balance amounts" : "Hide balance amounts";
    toggle.querySelector("span").textContent = financeBalancesHidden ? "◉̸" : "◉";
  }
}

function selectFinanceBalance(category) {
  if (!FINANCE_BALANCE_CATEGORIES[category]) return;
  selectedFinanceBalance = category;
  renderFinanceBalanceSelection();
  const detail = document.getElementById("finance-selected-hint");
  if (detail) detail.textContent = FINANCE_BALANCE_CATEGORIES[category].hint;
}

function toggleFinanceBalanceVisibility() {
  financeBalancesHidden = !financeBalancesHidden;
  renderFinanceBalanceSelection();
  if (currentFinanceEarnings) renderWeeklySalesChart(currentFinanceEarnings.weekly_sales);
}

function compactNaira(amount) {
  const value = Number(amount) || 0;
  if (value >= 1000000) return `₦${(value / 1000000).toLocaleString("en-NG", { maximumFractionDigits: 1 })}m`;
  if (value >= 1000) return `₦${(value / 1000).toLocaleString("en-NG", { maximumFractionDigits: 1 })}k`;
  return `₦${Math.round(value).toLocaleString("en-NG")}`;
}

function renderWeeklySalesChart(days) {
  const chart = document.getElementById("finance-weekly-chart");
  const summary = document.getElementById("finance-weekly-summary");
  if (!chart || !summary) return;
  if (!Array.isArray(days) || days.length === 0) {
    chart.innerHTML = '<p class="muted">Weekly sales data is not available yet.</p>';
    summary.textContent = "";
    return;
  }

  const values = days.map(day => Math.max(0, Number(day.amount) || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const orderCount = days.reduce((sum, day) => sum + (Number(day.orders) || 0), 0);
  if (financeBalancesHidden) {
    summary.innerHTML = '<strong>••••••••</strong><span>Weekly sales amounts are hidden</span>';
    chart.innerHTML = '<p class="finance-chart-private">Turn balance visibility back on to view the weekly sales chart.</p>';
    chart.setAttribute("aria-label", "Weekly sales chart is hidden while balance amounts are concealed.");
    return;
  }
  summary.innerHTML = `<strong>${formatPrice(total)}</strong><span>from ${orderCount} paid ${orderCount === 1 ? "order" : "orders"}</span>`;

  const width = 760, height = 270, left = 72, right = 16, top = 18, bottom = 44;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const largest = Math.max(...values, 0);
  const rawStep = largest > 0 ? largest / 4 : 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = Math.max(1, Math.ceil(rawStep / magnitude) * magnitude);
  const ceiling = step * 4;
  const slot = plotWidth / days.length;
  const barWidth = Math.min(46, slot * 0.54);
  const guides = Array.from({ length: 5 }, (_, index) => {
    const value = ceiling - step * index;
    const y = top + (plotHeight * index / 4);
    return `<g class="finance-chart-gridline"><line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text x="${left - 12}" y="${y + 4}" text-anchor="end">${compactNaira(value)}</text></g>`;
  }).join("");
  const bars = days.map((day, index) => {
    const amount = values[index];
    const barHeight = amount > 0 ? Math.max(3, (amount / ceiling) * plotHeight) : 0;
    const x = left + slot * index + (slot - barWidth) / 2;
    const y = top + plotHeight - barHeight;
    const label = escapeHTML(day.label || "");
    const date = escapeHTML(day.date || "");
    return `<g class="finance-chart-bar"><title>${label} ${date}: ${escapeHTML(formatPrice(amount))} from ${Number(day.orders) || 0} paid ${(Number(day.orders) || 0) === 1 ? "order" : "orders"}</title><rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="${Math.min(12, barWidth / 3)}"/><text x="${x + barWidth / 2}" y="${height - 13}" text-anchor="middle">${label}</text></g>`;
  }).join("");
  chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true"><defs><linearGradient id="finance-bar-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%"/><stop offset="100%"/></linearGradient></defs>${guides}<line class="finance-chart-baseline" x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}"/>${bars}</svg>`;
  chart.setAttribute("aria-label", `Sales for the last seven days total ${formatPrice(total)} from ${orderCount} paid orders.`);
}

async function loadEarnings() {
  try {
    const earnings = await apiRequest("/api/trader/earnings");
    currentFinanceEarnings = earnings;
    renderFinanceBalanceSelection();
    const selectedHint = document.getElementById("finance-selected-hint");
    if (selectedHint) selectedHint.textContent = FINANCE_BALANCE_CATEGORIES[selectedFinanceBalance].hint;
    renderWeeklySalesChart(earnings.weekly_sales);

    // One short sentence about what to do next.
    let note;
    if (earnings.requested > 0) note = `A payout of ${formatPrice(earnings.requested)} is waiting to be sent to your bank account.`;
    else if (!earnings.has_account) note = "Add your bank details in Settings so you can get paid.";
    else if (earnings.available < earnings.min_payout) note = `You can request a payout once you have at least ${formatPrice(earnings.min_payout)} available.`;
    else note = "You can withdraw your available balance to your bank account.";
    if (earnings.commission_percent > 0) note += ` S-Market Place keeps ${earnings.commission_percent}% of each sale; the amounts above are what you receive.`;
    document.getElementById("earnings-note").textContent = note;

    document.getElementById("earnings-actions").innerHTML =
      `<button class="primary-button" type="button" data-request-payout ${earnings.can_request ? "" : "disabled"}>Request payout${earnings.can_request ? ` of ${formatPrice(earnings.available)}` : ""}</button>` +
      '<button class="outline-button" type="button" data-page-link="settings">Payout account</button>';

    document.getElementById("payout-history").innerHTML = earnings.payouts.length
      ? '<h3 class="mini-title">Recent payouts</h3>' + earnings.payouts.map(payout => `
          <div class="payout-row"><span>${formatPrice(payout.amount)} · ${escapeHTML(formatDate(payout.created_at))}${payout.reference ? ` · ref ${escapeHTML(payout.reference)}` : ""}</span>
            <span class="badge ${payout.status === "paid" ? "badge-paid" : payout.status === "rejected" ? "badge-bad" : "badge-pending"}">${PAYOUT_LABEL[payout.status]}</span></div>`).join("")
      : '<p class="muted finance-empty-payouts">No payout activity yet. Completed payouts will appear here.</p>';
  } catch (error) {
    document.getElementById("finance-weekly-chart").innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
    document.getElementById("earnings-note").textContent = error.message;
  }
}

/** Ask for the whole available balance to be sent to the saved bank account. */
async function requestPayout() {
  if (!confirm("Request a payout of your full available balance?")) return;
  try {
    const result = await apiRequest("/api/trader/payouts", { method: "POST", body: JSON.stringify({}) });
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
  loadEarnings();
}

/* ----------------------------------------------------------------------------
   Payout account (inside Settings, for traders)
   ---------------------------------------------------------------------------- */
function payoutFormHTML() {
  return `
    <form id="payout-form" class="panel-form">
      <h3>Payout account</h3>
      <p class="muted">This is where your money is sent. We check the account name with your bank before saving.</p>
      <p class="muted" id="payout-current">Loading…</p>
      <label for="payout-bank">Bank</label>
      <select id="payout-bank" required><option value="">Loading banks…</option></select>
      <label for="payout-number">Account number (10 digits)</label>
      <input id="payout-number" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" required>
      <button class="primary-button" type="submit">Verify and save</button>
      <p class="form-feedback" id="payout-feedback" role="status"></p>
    </form>`;
}

/** Fill the bank list and show the account already saved (called after Settings is drawn for a trader). */
async function initPayoutAccountForm() {
  document.getElementById("payout-form").addEventListener("submit", savePayoutAccount);
  const select = document.getElementById("payout-bank");
  const current = document.getElementById("payout-current");
  try {
    const [{ banks }, { account }] = await Promise.all([apiRequest("/api/banks"), apiRequest("/api/trader/payout-account")]);
    select.innerHTML = '<option value="">Choose your bank…</option>' + banks.map(bank => `<option value="${escapeHTML(bank.code)}">${escapeHTML(bank.name)}</option>`).join("");
    current.textContent = account
      ? `Saved: ${account.account_name} · ${account.bank_name} · ${maskAccount(account.account_number)}`
      : "No bank account saved yet.";
  } catch (error) {
    select.innerHTML = '<option value="">Banks unavailable</option>';
    current.textContent = error.message;
  }
}

async function savePayoutAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.getElementById("payout-feedback");
  feedback.textContent = "Checking the account with your bank…";
  try {
    const result = await apiRequest("/api/trader/payout-account", {
      method: "POST",
      body: JSON.stringify({ bank_code: document.getElementById("payout-bank").value, account_number: document.getElementById("payout-number").value.trim() })
    });
    feedback.textContent = result.message;
    document.getElementById("payout-current").textContent = `Saved: ${result.account.account_name} · ${result.account.bank_name} · ${maskAccount(result.account.account_number)}`;
    form.reset();
    document.getElementById("payout-bank").value = result.account.bank_code;
    showToast("Payout account saved.");
  } catch (error) {
    feedback.textContent = error.message;
  }
}

/* ----------------------------------------------------------------------------
   Notifications (traders see them on their screen, buyers on "My orders")
   ---------------------------------------------------------------------------- */
/** Draw the latest notifications into `target`. The panel stays hidden when there is nothing to show. */
async function loadNotifications(target, limit = 5) {
  try {
    const { notifications, unread } = await apiRequest("/api/notifications");
    target.hidden = notifications.length === 0;
    const badge = target.querySelector(".notif-badge");
    if (badge) { badge.textContent = unread; badge.hidden = unread === 0; }
    const list = notifications.slice(0, limit).map(note => `
      <article class="notice ${note.is_read ? "" : "is-new"}">
        <strong>${escapeHTML(note.title)}</strong>
        <p>${escapeHTML(note.body)}</p>
        <small>${escapeHTML(formatDate(note.created_at))}</small>
      </article>`).join("");
    const holder = target.querySelector("[data-notification-list]") || target;
    holder.innerHTML = list + (unread ? '<button class="text-button" type="button" data-mark-notifications-read>Mark all as read</button>' : "");
  } catch (error) {
    target.hidden = true;
  }
}

async function markNotificationsRead() {
  try { await apiRequest("/api/notifications/read", { method: "POST", body: JSON.stringify({}) }); } catch (_) { /* not important */ }
  refreshNotifications();
}

/** Reload whichever notification panel belongs to the signed-in user. */
function refreshNotifications() {
  if (!currentUser) return;
  if (currentUser.role === "trader") loadNotifications(document.getElementById("notifications-panel"));
  else loadNotifications(document.getElementById("buyer-notifications"));
}
