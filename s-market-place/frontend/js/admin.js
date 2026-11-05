"use strict";
/* ============================================================================
   admin.js — the marketplace owner's screen: where the money is, disputes to
   decide, and trader payouts to send. (Only accounts in ADMIN_USER_IDS see it.)
   ============================================================================ */

function adminOverviewHTML(overview) {
  const box = (label, value, hint) => `<div class="earn-box"><span>${label}</span><strong>${value}</strong><small>${hint}</small></div>`;
  return `<section class="panel-list"><h2>Money overview</h2><div class="earn-grid">
    ${box("In escrow", formatPrice(overview.held_in_escrow), "Paid by buyers, not yet delivered")}
    ${box("On hold", formatPrice(overview.disputed), `${overview.open_disputes} open dispute(s)`)}
    ${box("Owed to traders", formatPrice(overview.owed_to_traders), `${overview.payouts_waiting} payout(s) waiting`)}
    ${box("Paid out", formatPrice(overview.paid_out), "Sent to traders")}
    ${box("Your commission", formatPrice(overview.commission_earned), "From confirmed deliveries")}
  </div><p class="muted earn-note">These should add up to the balance of your Paystack account.</p></section>`;
}

function adminSubscriptionPlansHTML(plans) {
  const monthly = Number(plans.monthly) || 3500;
  const yearly = Number(plans.yearly) || 37800;

  return `<section class="panel-list">
    <h2>Trader subscription prices</h2>
    <p class="muted">Saving a price syncs it to Paystack for new subscribers. Existing subscriptions keep their current price.</p>

    <div class="order-actions">
      <label for="admin-plan-monthly">Monthly price (naira)</label>
      <input id="admin-plan-monthly" type="number" min="1" max="100000000" step="1" value="${monthly}">
      <button class="outline-button" type="button" data-admin-plan-save="monthly">Save monthly price</button>

      <label for="admin-plan-yearly">Yearly price (naira)</label>
      <input id="admin-plan-yearly" type="number" min="1" max="100000000" step="1" value="${yearly}">
      <button class="outline-button" type="button" data-admin-plan-save="yearly">Save yearly price</button>
    </div>
    <p id="admin-plan-message" class="muted" aria-live="polite"></p>
  </section>`;
}

function adminMfaHTML() {
  return `<section class="panel-list">
    <h2>Admin sign-in security</h2>
    <p class="muted">Set up an authenticator app for this admin account.</p>

    <div class="order-actions">
      <label for="admin-mfa-password">Confirm your password</label>
      <input id="admin-mfa-password" type="password" autocomplete="current-password">
      <button class="primary-button" type="button" data-admin-mfa-start>
        Set up authenticator
      </button>
    </div>

    <div id="admin-mfa-enrollment" hidden>
      <p>Scan this QR code with your authenticator app, then enter its current six-digit code.</p>
      <div id="admin-mfa-qr" aria-label="Authenticator setup QR code"></div>

      <div class="order-actions">
        <label for="admin-mfa-code">Six-digit code</label>
        <input id="admin-mfa-code" inputmode="numeric" autocomplete="one-time-code"
               maxlength="6" pattern="[0-9]{6}">
        <button class="primary-button" type="button" data-admin-mfa-confirm>
          Verify and enable
        </button>
      </div>
    </div>

        <div class="panel-list">
      <h3>Recovery codes</h3>
      <p class="muted">Generate backup codes in case you lose access to your authenticator app.</p>

      <div class="order-actions">
        <label for="admin-mfa-recovery-password">Confirm your password</label>
        <input id="admin-mfa-recovery-password" type="password" autocomplete="current-password">

        <label for="admin-mfa-recovery-totp">Current authenticator code</label>
        <input id="admin-mfa-recovery-totp" inputmode="numeric"
               autocomplete="one-time-code" maxlength="6">

        <button class="outline-button" type="button" data-admin-mfa-recovery>
          Generate recovery codes
        </button>
      </div>

      <pre id="admin-mfa-recovery-list" hidden></pre>
    </div>

    <p id="admin-mfa-message" class="muted" aria-live="polite"></p>
  </section>`;
}

function disputeCardHTML(dispute) {
  const photos = [dispute.photo1, dispute.photo2].filter(Boolean)
    .map(url => `<a href="${escapeHTML(url)}" target="_blank" rel="noopener"><img class="evidence" src="${escapeHTML(url)}" alt="Evidence photo"></a>`).join("");
  const open = dispute.status === "open";
  return `<article class="order-card">
    <div class="order-head"><h3>${escapeHTML(dispute.product_name)} × ${dispute.quantity}</h3>
      <span class="badge ${open ? "badge-pending" : dispute.status === "released" ? "badge-paid" : "badge-bad"}">${open ? "Open" : dispute.status === "released" ? "Seller paid" : "Buyer refunded"}</span></div>
    <p class="order-meta"><strong>${escapeHTML(dispute.reason)}</strong> · order #${dispute.order_id} · ${formatPrice(dispute.amount)}<br>
      Buyer: ${escapeHTML(dispute.buyer_name)} (${escapeHTML(dispute.buyer_phone)}) · Seller: ${escapeHTML(dispute.store_name || "")}<br>
      Reported ${escapeHTML(formatDate(dispute.created_at))}</p>
    <p>${escapeHTML(dispute.details)}</p>
    ${photos ? `<div class="evidence-row">${photos}</div>` : ""}
    ${dispute.admin_note ? `<p class="muted">Your note: ${escapeHTML(dispute.admin_note)}</p>` : ""}
    ${open ? `<div class="order-actions">
      <button class="primary-button" type="button" data-admin-resolve="${dispute.id}" data-decision="release">Pay the seller</button>
      <button class="outline-button" type="button" data-admin-resolve="${dispute.id}" data-decision="refund">Refund the buyer</button></div>` : ""}
  </article>`;
}

function payoutRowHTML(payout) {
  const waiting = payout.status === "requested";
  return `<article class="order-card">
    <div class="order-head"><h3>${formatPrice(payout.amount)} · ${escapeHTML(payout.store_name || payout.username)}</h3>
      <span class="badge ${waiting ? "badge-pending" : payout.status === "paid" ? "badge-paid" : "badge-bad"}">${PAYOUT_LABEL[payout.status]}</span></div>
    <p class="order-meta">Send to: <strong>${escapeHTML(payout.account_name)}</strong><br>${escapeHTML(payout.bank_name)} · ${escapeHTML(payout.account_number)}<br>
      Requested ${escapeHTML(formatDate(payout.created_at))}${payout.reference ? ` · ref ${escapeHTML(payout.reference)}` : ""}${payout.note ? ` · ${escapeHTML(payout.note)}` : ""}</p>
    ${waiting ? `<div class="order-actions">
      <button class="primary-button" type="button" data-admin-paid="${payout.id}">Mark as paid</button>
      <button class="outline-button" type="button" data-admin-reject="${payout.id}">Decline</button></div>` : ""}
  </article>`;
}

async function renderAdmin() {
  const target = document.getElementById("admin-content");
  if (!currentUser || !currentUser.is_admin) {
    target.innerHTML = '<div class="empty-state"><h2>This area is for the marketplace admin.</h2><p>Your account is not listed as an admin.</p></div>';
    return;
  }
  target.innerHTML = '<p class="muted">Loading…</p>';
  try {
      const [overview, { disputes }, { payouts }, { plans }] = await Promise.all([
        apiRequest("/api/admin/overview"),
        apiRequest("/api/admin/disputes"),
        apiRequest("/api/admin/payouts"),
        apiRequest("/api/admin/subscription-plans")
      ]);
    target.innerHTML = adminMfaHTML() + adminSubscriptionPlansHTML(plans) + adminOverviewHTML(overview) +
      `<section class="panel-list"><h2>Disputes</h2>${disputes.length ? disputes.map(disputeCardHTML).join("") : '<p class="muted">No disputes.</p>'}</section>` +
      `<section class="panel-list"><h2>Payouts</h2>${payouts.length ? payouts.map(payoutRowHTML).join("") : '<p class="muted">No payout requests yet.</p>'}</section>`;
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

async function saveAdminSubscriptionPlan(plan) {
  const inputId = plan === "monthly" ? "admin-plan-monthly" : "admin-plan-yearly";
  const input = document.getElementById(inputId);
  const message = document.getElementById("admin-plan-message");
  const button = document.querySelector(`[data-admin-plan-save="${plan}"]`);
  const price = Number(input.value);

  if (!Number.isInteger(price) || price < 1 || price > 100000000) {
    message.textContent = "Enter a whole-number price from ₦1 to ₦100,000,000.";
    input.focus();
    return;
  }

  button.disabled = true;
  message.textContent = "Saving price and syncing with Paystack…";

  try {
    const result = await apiRequest("/api/admin/subscription-plans", {
      method: "PATCH",
      body: JSON.stringify({ plan, price_ngn: price })
    });

    input.value = result.price_ngn;
    message.textContent = `${plan === "monthly" ? "Monthly" : "Yearly"} price saved as ${formatPrice(result.price_ngn)}.`;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

/** Decide a dispute. "release" pays the seller; "refund" sides with the buyer (you then refund them in Paystack). */
async function resolveDispute(id, decision) {
  const note = prompt(decision === "release" ? "Note for the buyer (optional):" : "Note for the buyer (optional). Remember to refund them in your Paystack dashboard:");
  if (note === null) return;                       // cancelled
  try {
    const result = await apiRequest(`/api/admin/disputes/${id}/resolve`, { method: "POST", body: JSON.stringify({ decision, note }) });
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
  renderAdmin();
}

async function markPayoutPaid(id) {
  const reference = prompt("Transfer reference (optional):");
  if (reference === null) return;
  try { showToast((await apiRequest(`/api/admin/payouts/${id}/paid`, { method: "POST", body: JSON.stringify({ reference }) })).message); }
  catch (error) { showToast(error.message); }
  renderAdmin();
}

async function rejectPayout(id) {
  const note = prompt("Why is this payout declined? (the trader will see it)");
  if (note === null) return;
  try { showToast((await apiRequest(`/api/admin/payouts/${id}/reject`, { method: "POST", body: JSON.stringify({ note }) })).message); }
  catch (error) { showToast(error.message); }
  renderAdmin();
}

async function startAdminMfa() {
  const passwordInput = document.getElementById("admin-mfa-password");
  const message = document.getElementById("admin-mfa-message");
  const enrollment = document.getElementById("admin-mfa-enrollment");
  const qrTarget = document.getElementById("admin-mfa-qr");
  const button = document.querySelector("[data-admin-mfa-start]");

  if (!passwordInput.value) {
    message.textContent = "Enter your password to continue.";
    passwordInput.focus();
    return;
  }

  button.disabled = true;
  message.textContent = "Preparing authenticator setup…";

  try {
    const result = await apiRequest("/api/admin/mfa/setup", {
      method: "POST",
      body: JSON.stringify({ password: passwordInput.value })
    });

    qrTarget.innerHTML = await makeQrSvg(result.provisioning_uri, true);
    enrollment.hidden = false;
    message.textContent = "Scan the QR code with your authenticator app.";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}


async function confirmAdminMfa() {
  const codeInput = document.getElementById("admin-mfa-code");
  const message = document.getElementById("admin-mfa-message");
  const button = document.querySelector("[data-admin-mfa-confirm]");
  const code = codeInput.value.trim();

  if (!/^\d{6}$/.test(code)) {
    message.textContent = "Enter the six-digit code from your authenticator app.";
    codeInput.focus();
    return;
  }

  button.disabled = true;
  message.textContent = "Verifying code…";

  try {
    const result = await apiRequest("/api/admin/mfa/verify-setup", {
      method: "POST",
      body: JSON.stringify({ code })
    });

    message.textContent = result.message;
    document.getElementById("admin-mfa-enrollment").hidden = true;
    document.getElementById("admin-mfa-password").value = "";

    const startButton = document.querySelector("[data-admin-mfa-start]");
    startButton.disabled = true;
    startButton.textContent = "Authenticator enabled";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function createAdminMfaRecoveryCodes() {
  const password = document.getElementById("admin-mfa-recovery-password").value;
  const code = document.getElementById("admin-mfa-recovery-totp").value.trim();
  const message = document.getElementById("admin-mfa-message");
  const list = document.getElementById("admin-mfa-recovery-list");
  const button = document.querySelector("[data-admin-mfa-recovery]");

  if (!password || !/^\d{6}$/.test(code)) {
    message.textContent = "Enter your password and current six-digit authenticator code.";
    return;
  }

  button.disabled = true;
  message.textContent = "Generating recovery codes…";

  try {
    const result = await apiRequest("/api/admin/mfa/recovery-codes", {
      method: "POST",
      body: JSON.stringify({ password, code })
    });

    list.textContent = result.recovery_codes.join("\n");
    list.hidden = false;
    document.getElementById("admin-mfa-recovery-password").value = "";
    document.getElementById("admin-mfa-recovery-totp").value = "";
    message.textContent = result.message;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}