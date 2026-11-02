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

async function loadEarnings() {
  const grid = document.getElementById("earnings-grid");
  try {
    const earnings = await apiRequest("/api/trader/earnings");
    const box = (label, amount, hint, strong) =>
      `<div class="earn-box ${strong ? "is-strong" : ""}"><span>${label}</span><strong>${formatPrice(amount)}</strong><small>${hint}</small></div>`;
    grid.innerHTML =
      box("In escrow", earnings.in_escrow, "Paid by buyers. Credited when they confirm delivery.") +
      box("Available", earnings.available, "Ready to withdraw", true) +
      box("On hold", earnings.disputed, "A buyer reported a problem") +
      box("Paid out", earnings.paid_out, "Sent to your bank");

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
      : "";
  } catch (error) {
    grid.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
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
