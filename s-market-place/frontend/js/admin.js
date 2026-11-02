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
    const [overview, { disputes }, { payouts }] = await Promise.all([
      apiRequest("/api/admin/overview"), apiRequest("/api/admin/disputes"), apiRequest("/api/admin/payouts")]);
    target.innerHTML = adminOverviewHTML(overview) +
      `<section class="panel-list"><h2>Disputes</h2>${disputes.length ? disputes.map(disputeCardHTML).join("") : '<p class="muted">No disputes.</p>'}</section>` +
      `<section class="panel-list"><h2>Payouts</h2>${payouts.length ? payouts.map(payoutRowHTML).join("") : '<p class="muted">No payout requests yet.</p>'}</section>`;
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
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
