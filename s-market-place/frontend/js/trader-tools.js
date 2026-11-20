"use strict";
/* ============================================================================
   trader-tools.js — shared pieces for the trader screens
     1. Pop-ups: confirmDanger() (Cancel / Continue), askPin(), uiDialog()
     2. Security PIN (4 digits) for sensitive changes only
     3. Payout request: from 40% of the available balance up to 100%
     4. Weekly sales: this week's chart + older weeks behind "View all"
     5. Followers / Following lists
     6. Order messages (trader -> buyer, one way)
   Loaded after main.js. Everything is plain functions on the page, like the
   other files. The server must repeat every check made here.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   1. Pop-ups
   ---------------------------------------------------------------------------- */
let uiModalDone = null;      // resolves the open dialog's promise
let uiModalCollect = null;   // reads the dialog's answer when "OK" is pressed

function ensureUiModal() {
  let root = document.getElementById("ui-modal");
  if (root) return root;
  root = document.createElement("div");
  root.id = "ui-modal";
  root.className = "ui-modal";
  root.hidden = true;
  root.innerHTML = '<div class="ui-modal-backdrop" data-ui-cancel></div><section class="ui-modal-card" role="dialog" aria-modal="true" aria-labelledby="ui-modal-title"></section>';
  document.body.appendChild(root);
  return root;
}

function finishUiModal(value) {
  const done = uiModalDone;
  uiModalDone = null;
  uiModalCollect = null;
  const root = document.getElementById("ui-modal");
  if (root) root.hidden = true;
  document.body.classList.remove("modal-open");
  if (done) done(value);
}

/** Show a dialog. Resolves with whatever collect() returns (return undefined to keep it open), or null if cancelled. */
function uiDialog(html, collect = () => true) {
  if (uiModalDone) finishUiModal(null);
  return new Promise(resolve => {
    uiModalDone = resolve;
    uiModalCollect = collect;
    const root = ensureUiModal();
    root.querySelector(".ui-modal-card").innerHTML = html;
    root.hidden = false;
    document.body.classList.add("modal-open");
    const first = root.querySelector("[data-autofocus]") || root.querySelector("input, textarea, button");
    if (first) first.focus({ preventScroll: true });
  });
}

function setDialogError(text) {
  const el = document.querySelector("#ui-modal .ui-error");
  if (el) el.textContent = text || "";
}

/** The warning pop-up for risky changes. Returns true only when the person presses Continue. */
async function confirmDanger({ title = "Are you sure?", message = "", confirmLabel = "Continue", cancelLabel = "Cancel", tone = "danger" } = {}) {
  const html = `
    <div class="ui-icon ${tone}" aria-hidden="true">!</div>
    <h2 id="ui-modal-title">${escapeHTML(title)}</h2>
    <p class="ui-message">${escapeHTML(message).replace(/\n/g, "<br>")}</p>
    <div class="ui-actions">
      <button type="button" class="outline-button" data-ui-cancel data-autofocus>${escapeHTML(cancelLabel)}</button>
      <button type="button" class="primary-button${tone === "danger" ? " is-danger" : ""}" data-ui-ok>${escapeHTML(confirmLabel)}</button>
    </div>`;
  return (await uiDialog(html)) === true;
}

document.addEventListener("click", event => {
  if (!event.target.closest) return;
  if (event.target.closest("[data-ui-cancel]")) { if (uiModalDone) finishUiModal(null); return; }
  if (event.target.closest("[data-ui-ok]") && uiModalDone) {
    const value = uiModalCollect ? uiModalCollect() : true;
    if (value !== undefined) finishUiModal(value);
  }
});
document.addEventListener("keydown", event => {
  if (!uiModalDone) return;
  if (event.key === "Escape") finishUiModal(null);
  if (event.key === "Enter" && event.target.matches?.(".pin-box, #payout-amount")) { event.preventDefault(); document.querySelector("#ui-modal [data-ui-ok]")?.click(); }
});

/* ----------------------------------------------------------------------------
   2. Security PIN
   The PIN is typed into masked boxes, sent once over HTTPS, and never stored
   in the browser. The server must hash it, rate-limit wrong tries and lock out.
   ---------------------------------------------------------------------------- */
let pinInfo = { loaded: false, has_pin: false };

async function loadPinInfo(force = false) {
  if (pinInfo.loaded && !force) return pinInfo;
  if (!currentUser || currentUser.role !== "trader") return pinInfo;
  try {
    const result = await apiRequest("/api/trader/pin");
    pinInfo = { loaded: true, has_pin: Boolean(result.has_pin) };
  } catch (_) { pinInfo.loaded = true; }
  return pinInfo;
}

function pinBoxesHTML(name, label) {
  return `<div class="pin-row" role="group" aria-label="${escapeHTML(label)}" data-pin-group="${name}">${[1, 2, 3, 4].map(n =>
    `<input class="pin-box" type="password" inputmode="numeric" pattern="[0-9]" maxlength="1" autocomplete="off" aria-label="${escapeHTML(label)} digit ${n}"${n === 1 && name === "pin" ? " data-autofocus" : ""}>`).join("")}</div>`;
}
function readPinGroup(name) { return [...document.querySelectorAll(`#ui-modal [data-pin-group="${name}"] .pin-box`)].map(b => b.value).join(""); }

// Move between boxes, accept pasted digits, allow backspace to go back.
document.addEventListener("input", event => {
  const box = event.target;
  if (!box.classList || !box.classList.contains("pin-box")) return;
  box.value = box.value.replace(/\D/g, "").slice(-1);
  if (box.value && box.nextElementSibling) box.nextElementSibling.focus();
});
document.addEventListener("keydown", event => {
  const box = event.target;
  if (!box.classList || !box.classList.contains("pin-box")) return;
  if (event.key === "Backspace" && !box.value && box.previousElementSibling) box.previousElementSibling.focus();
});
document.addEventListener("paste", event => {
  const box = event.target;
  if (!box.classList || !box.classList.contains("pin-box")) return;
  const digits = (event.clipboardData?.getData("text") || "").replace(/\D/g, "").slice(0, 4);
  if (!digits) return;
  event.preventDefault();
  const boxes = [...box.parentElement.querySelectorAll(".pin-box")];
  boxes.forEach((b, i) => { b.value = digits[i] || ""; });
  (boxes[Math.min(digits.length, 3)] || boxes[3]).focus();
});

/** Ask for the current PIN. Resolves with the 4 digits, or null if cancelled. */
function askPin(message = "Enter your 4-digit PIN to continue.", title = "Enter your PIN") {
  const html = `
    <div class="ui-icon" aria-hidden="true">🔒</div>
    <h2 id="ui-modal-title">${escapeHTML(title)}</h2>
    <p class="ui-message">${escapeHTML(message)}</p>
    ${pinBoxesHTML("pin", "PIN")}
    <p class="ui-error" role="alert"></p>
    <div class="ui-actions"><button type="button" class="outline-button" data-ui-cancel>Cancel</button><button type="button" class="primary-button" data-ui-ok>Confirm</button></div>`;
  return uiDialog(html, () => {
    const pin = readPinGroup("pin");
    if (!/^\d{4}$/.test(pin)) { setDialogError("Enter all 4 digits."); return undefined; }
    return pin;
  });
}

/** Weak PINs are refused (0000, 1111, 1234, 4321 ...). */
function isWeakPin(pin) {
  if (/^(\d)\1{3}$/.test(pin)) return true;
  return "0123456789".includes(pin) || "9876543210".includes(pin);
}

/** Ask for a new PIN twice. Resolves with the 4 digits, or null if cancelled. */
function askNewPin(title = "Set your PIN") {
  const html = `
    <div class="ui-icon" aria-hidden="true">🔐</div>
    <h2 id="ui-modal-title">${escapeHTML(title)}</h2>
    <p class="ui-message">Choose 4 digits you will remember. Don't use your birth year or phone number, and never share it.</p>
    <p class="pin-label">New PIN</p>${pinBoxesHTML("pin", "New PIN")}
    <p class="pin-label">Repeat PIN</p>${pinBoxesHTML("pin2", "Repeat PIN")}
    <p class="ui-error" role="alert"></p>
    <div class="ui-actions"><button type="button" class="outline-button" data-ui-cancel>Cancel</button><button type="button" class="primary-button" data-ui-ok>Save PIN</button></div>`;
  return uiDialog(html, () => {
    const a = readPinGroup("pin"), b = readPinGroup("pin2");
    if (!/^\d{4}$/.test(a)) { setDialogError("Enter 4 digits."); return undefined; }
    if (a !== b) { setDialogError("The two PINs do not match."); return undefined; }
    if (isWeakPin(a)) { setDialogError("Choose a PIN that is harder to guess."); return undefined; }
    return a;
  });
}

/** Before a sensitive change: "" if the trader has no PIN yet, the PIN if they do, null if they cancel. */
async function requirePin(message) {
  await loadPinInfo();
  if (!pinInfo.has_pin) return "";
  return askPin(message || "Enter your PIN to confirm this change.");
}

/** The Security PIN card in Settings. */
async function initPinSection() {
  const anchor = document.getElementById("password-form");
  if (!anchor) return;
  let section = document.getElementById("pin-section");
  const isNew = !section;
  if (isNew) {
    section = document.createElement("section");
    section.id = "pin-section";
    section.className = "panel-form";
  }
  await loadPinInfo(true);
  renderPinSection(section);                 // fill it first, so the Enlarge / Fold back toggle can attach to its heading
  if (isNew && document.getElementById("password-form")) document.getElementById("password-form").before(section);
}

function renderPinSection(section) {
  const toggle = section.querySelector(".fold-toggle");   // keep the settings fold button when the card is redrawn
  section.innerHTML = pinInfo.has_pin ? `
      <h3>Security PIN</h3>
      <p class="muted">Your 4-digit PIN protects payout requests, bank details, password and chat-link changes.</p>
      <div class="pin-actions"><button type="button" class="outline-button" data-pin-change>Change PIN</button><button type="button" class="outline-button is-danger-outline" data-pin-remove>Remove PIN</button></div>
      <p class="form-feedback" id="pin-feedback" role="status"></p>` : `
      <h3>Security PIN</h3>
      <p class="muted">Add a 4-digit PIN. You will be asked for it before sensitive changes such as payouts, bank details and your password. Never share it with anyone.</p>
      <button type="button" class="primary-button" data-pin-set>Set up PIN</button>
      <p class="form-feedback" id="pin-feedback" role="status"></p>`;
  if (toggle) { const heading = section.querySelector("h3"); heading.classList.add("fold-head"); heading.appendChild(toggle); }
}

async function pinRequest(method, body, successText) {
  const feedback = () => document.getElementById("pin-feedback");
  try {
    const result = await apiRequest("/api/trader/pin", { method, body: JSON.stringify(body) });
    await loadPinInfo(true);
    const section = document.getElementById("pin-section");
    if (section) renderPinSection(section);
    const note = feedback(); if (note) note.textContent = result.message || successText;
    showToast(result.message || successText);
  } catch (error) {
    const note = feedback(); if (note) note.textContent = error.message;
    showToast(error.message);
  }
}

document.addEventListener("click", async event => {
  if (!event.target.closest) return;
  if (event.target.closest("[data-pin-set]")) {
    const pin = await askNewPin("Set your PIN");
    if (pin) await pinRequest("POST", { pin }, "PIN saved.");
  } else if (event.target.closest("[data-pin-change]")) {
    const current = await askPin("Enter your current PIN first.", "Change PIN");
    if (current === null) return;
    const pin = await askNewPin("Choose a new PIN");
    if (pin) await pinRequest("POST", { pin, current_pin: current }, "PIN changed.");
  } else if (event.target.closest("[data-pin-remove]")) {
    const ok = await confirmDanger({ title: "Remove your PIN?", message: "Sensitive changes will no longer ask for a PIN, so anyone using your phone could change them.", confirmLabel: "Continue" });
    if (!ok) return;
    const current = await askPin("Enter your PIN to remove it.", "Remove PIN");
    if (current !== null) await pinRequest("DELETE", { pin: current }, "PIN removed.");
  }
});

/* ----------------------------------------------------------------------------
   3. Payout request: at least 40% of the available balance, up to all of it
   ---------------------------------------------------------------------------- */
const PAYOUT_MIN_SHARE = 0.4;

async function requestPayout() {
  const earnings = typeof currentFinanceEarnings !== "undefined" ? currentFinanceEarnings : null;
  if (!earnings || !earnings.can_request) { showToast("You have no payout available to request yet."); return; }
  const available = Number(earnings.available) || 0;
  const minimum = Math.min(available, Math.max(Math.ceil(available * PAYOUT_MIN_SHARE), Number(earnings.min_payout) || 0));
  const html = `
    <div class="ui-icon" aria-hidden="true">₦</div>
    <h2 id="ui-modal-title">Request payout</h2>
    <p class="ui-message">Available: <strong>${escapeHTML(formatPrice(available))}</strong>.<br>You can request from <strong>${escapeHTML(formatPrice(minimum))}</strong> (40% of your balance) up to the full amount.</p>
    <label class="payout-label" for="payout-amount">Amount (₦)</label>
    <input id="payout-amount" class="payout-amount" type="number" inputmode="decimal" min="${minimum}" max="${available}" step="0.01" value="${available}" data-autofocus>
    <input id="payout-range" class="payout-range" type="range" min="${minimum}" max="${available}" step="1" value="${available}" aria-label="Payout amount">
    <div class="payout-presets">${[0.4, 0.5, 0.75, 1].map(share => {
      const amount = Math.max(minimum, Math.floor(available * share));
      return `<button type="button" class="chip" data-payout-preset="${amount}">${Math.round(share * 100)}%</button>`;
    }).join("")}</div>
    <p class="ui-error" role="alert"></p>
    <div class="ui-actions"><button type="button" class="outline-button" data-ui-cancel>Cancel</button><button type="button" class="primary-button" data-ui-ok>Continue</button></div>`;
  const amount = await uiDialog(html, () => {
    const value = Math.round(Number(document.getElementById("payout-amount").value) * 100) / 100;
    if (!Number.isFinite(value) || value < minimum) { setDialogError(`The smallest payout is ${formatPrice(minimum)} (40% of your available balance).`); return undefined; }
    if (value > available) { setDialogError("You cannot request more than your available balance."); return undefined; }
    return value;
  });
  if (amount === null) return;
  const ok = await confirmDanger({ title: "Send this payout?", message: `${formatPrice(amount)} will be sent to your saved bank account. This cannot be undone once it is paid.`, confirmLabel: "Continue", tone: "warn" });
  if (!ok) return;
  const pin = await requirePin("Enter your PIN to request this payout.");
  if (pin === null) return;
  try {
    const result = await apiRequest("/api/trader/payouts", { method: "POST", body: JSON.stringify(pin ? { amount, pin } : { amount }) });
    showToast(result.message);
  } catch (error) { showToast(error.message); }
  loadEarnings();
}

document.addEventListener("input", event => {
  if (event.target.id === "payout-range") document.getElementById("payout-amount").value = event.target.value;
  if (event.target.id === "payout-amount") { const range = document.getElementById("payout-range"); if (range) range.value = event.target.value; }
});
document.addEventListener("click", event => {
  const preset = event.target.closest?.("[data-payout-preset]");
  if (!preset) return;
  document.getElementById("payout-amount").value = preset.dataset.payoutPreset;
  document.getElementById("payout-range").value = preset.dataset.payoutPreset;
});

/* ----------------------------------------------------------------------------
   4. Weekly sales: the chart is always THIS week (Monday to Sunday) and starts
      fresh every Monday. Older weeks live behind "View all".
   API: GET /api/trader/weekly-sales?weeks=12 -> { weeks: [ { start, end, label, total, orders, days: [...] } ] }  (newest first)
   ---------------------------------------------------------------------------- */
let weeklyHistory = [];
let weeklyKey = "";
let weeklyRolloverChecked = "";

async function loadWeeklyChart(fallbackDays) {
  try {
    const data = await apiRequest("/api/trader/weekly-sales?weeks=12");
    weeklyHistory = Array.isArray(data.weeks) ? data.weeks : [];
  } catch (_) { weeklyHistory = []; }
  const current = weeklyHistory[0];
  weeklyKey = current ? current.start : "";
  renderWeeklySalesChart(current ? current.days : fallbackDays, current ? current.label : "");
}

function mondayKey(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A new week started while the page was open: load the fresh (empty) week once.
function checkWeekRollover() {
  if (!weeklyKey || document.hidden) return;
  const key = mondayKey();
  if (key !== weeklyKey && weeklyRolloverChecked !== key && typeof loadEarnings === "function" && document.getElementById("page-trader-finance")?.classList.contains("is-active")) {
    weeklyRolloverChecked = key;
    loadEarnings();
  }
}
setInterval(checkWeekRollover, 60000);
document.addEventListener("visibilitychange", checkWeekRollover);

function weekRowHTML(week) {
  const values = (week.days || []).map(day => Math.max(0, Number(day.amount) || 0));
  const peak = Math.max(...values, 1);
  const hidden = typeof financeBalancesHidden !== "undefined" && financeBalancesHidden;
  const bars = values.map((value, i) => `<span class="week-bar" title="${escapeHTML((week.days[i].label || "") + ": " + (hidden ? "hidden" : formatPrice(value)))}"><i style="height:${Math.max(4, Math.round(value / peak * 100))}%"></i><b>${escapeHTML((week.days[i].label || "").slice(0, 1))}</b></span>`).join("");
  return `
    <article class="week-row">
      <div class="week-top"><strong>${escapeHTML(week.label || week.start)}</strong><span>${hidden ? "••••••" : escapeHTML(formatPrice(week.total))}</span></div>
      <p class="week-meta">${Number(week.orders) || 0} paid ${(Number(week.orders) || 0) === 1 ? "order" : "orders"}</p>
      <div class="week-bars" aria-hidden="true">${bars}</div>
    </article>`;
}

function openWeeklyHistory() {
  const older = weeklyHistory.slice(1);
  openUiSheet("Weekly sales", "Previous weeks", older.length
    ? `<div class="week-list">${older.map(weekRowHTML).join("")}</div>`
    : '<p class="muted">Earlier weeks will appear here once a new week starts. Your chart always shows the current week.</p>');
}

/* ----------------------------------------------------------------------------
   Side sheet used by the lists (same look as the order details sheet)
   ---------------------------------------------------------------------------- */
function openUiSheet(title, eyebrow, bodyHTML) {
  let sheet = document.getElementById("ui-sheet");
  if (!sheet) {
    sheet = document.createElement("div");
    sheet.id = "ui-sheet";
    sheet.className = "order-sheet";
    sheet.innerHTML = '<div class="order-sheet-backdrop" data-ui-sheet-close></div><section class="order-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="ui-sheet-title"></section>';
    document.body.appendChild(sheet);
  }
  sheet.querySelector(".order-sheet-panel").innerHTML = `
    <header class="sheet-head"><button type="button" class="management-back-button" data-ui-sheet-close aria-label="Close">←</button>
      <div><p class="eyebrow">${escapeHTML(eyebrow || "")}</p><h2 id="ui-sheet-title">${escapeHTML(title)}</h2></div></header>
    <div class="sheet-scroll" id="ui-sheet-body">${bodyHTML}</div>`;
  sheet.hidden = false;
  document.body.classList.add("sheet-open");
  sheet.querySelector(".management-back-button")?.focus();
}
function closeUiSheet() {
  const sheet = document.getElementById("ui-sheet");
  if (sheet) sheet.hidden = true;
  if (!document.querySelector(".order-sheet:not([hidden])")) document.body.classList.remove("sheet-open");
}
document.addEventListener("keydown", event => { if (event.key === "Escape" && !uiModalDone) closeUiSheet(); });

/* ----------------------------------------------------------------------------
   5. Followers / Following (tap the numbers on the trader's account page)
   API: GET /api/trader/followers  and  GET /api/trader/following  ->  { people: [ { username, name, store_name, profile_image, is_verified, is_trader, since } ] }
   ---------------------------------------------------------------------------- */
function personRowHTML(person, kind) {
  const label = person.store_name || person.name || person.username;
  const initial = escapeHTML(String(label || "?").slice(0, 1).toUpperCase());
  const canOpen = person.is_trader || kind === "following";
  return `
    <li class="person-row" data-person="${escapeHTML((label + " " + person.username).toLowerCase())}">
      <span class="trader-avatar" aria-hidden="true">${person.profile_image ? `<img src="${escapeHTML(person.profile_image)}" alt="" class="avatar-image">` : initial}</span>
      <span class="person-copy"><strong>${escapeHTML(label)} ${verifiedBadgeHTML(person.is_verified, true)}</strong><small>@${escapeHTML(person.username)}${person.since ? ` · since ${escapeHTML(formatDate(person.since))}` : ""}</small></span>
      ${canOpen ? `<button type="button" class="outline-button" data-open-store="${escapeHTML(person.username)}" data-close-sheet>Visit shop</button>` : ""}
    </li>`;
}

async function openPeopleList(kind) {
  const isFollowers = kind === "followers";
  openUiSheet(isFollowers ? "Your followers" : "People you follow", "Community", '<p class="muted">Loading…</p>');
  try {
    const { people } = await apiRequest(`/api/trader/${kind}`);
    const body = document.getElementById("ui-sheet-body");
    if (!body) return;
    body.innerHTML = people.length ? `
      <label class="list-search"><span aria-hidden="true">⌕</span><input id="people-search" type="search" placeholder="Search by name or @username" autocomplete="off" aria-label="Search this list"></label>
      <ul class="person-list" id="person-list">${people.map(person => personRowHTML(person, kind)).join("")}</ul>
      <p class="muted list-empty" id="people-empty" hidden>No one matches that search.</p>`
      : `<p class="muted">${isFollowers ? "No one follows your shop yet. Share your shop link to get your first followers." : "You are not following any shops yet."}</p>`;
  } catch (error) {
    const body = document.getElementById("ui-sheet-body");
    if (body) body.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

document.addEventListener("input", event => {
  if (event.target.id !== "people-search") return;
  const query = event.target.value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll("#person-list .person-row").forEach(row => {
    const match = !query || row.dataset.person.includes(query);
    row.hidden = !match;
    if (match) shown += 1;
  });
  const empty = document.getElementById("people-empty");
  if (empty) empty.hidden = shown > 0;
});

document.addEventListener("click", event => {
  if (!event.target.closest) return;
  const community = event.target.closest("[data-community]");
  if (community) { event.stopImmediatePropagation(); openPeopleList(community.dataset.community === "followers" ? "followers" : "following"); return; }
  if (event.target.closest("[data-ui-sheet-close]")) { closeUiSheet(); return; }
  if (event.target.closest("[data-close-sheet]")) closeUiSheet();
  if (event.target.closest("[data-view-weeks]")) openWeeklyHistory();
}, true);

/* ----------------------------------------------------------------------------
   6. Order messages: a brief one-way note from the trader to the buyer.
   API: POST /api/trader/order-items/<id>/message { message }   (max 200 characters, max 3 per order item)
   The buyer sees it on "My orders"; there is no reply box.
   ---------------------------------------------------------------------------- */
const ORDER_MESSAGE_MAX = 200;
const ORDER_MESSAGE_LIMIT = 3;
const LINK_PATTERN = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|ng|io|co|me|app|ly)\b)/i;

async function openOrderMessage(itemId) {
  const line = traderOrderLines.find(item => item.item_id === itemId);
  if (!line) return;
  const sent = Array.isArray(line.trader_messages) ? line.trader_messages : [];
  const full = sent.length >= ORDER_MESSAGE_LIMIT;
  const html = `
    <div class="ui-icon" aria-hidden="true">💬</div>
    <h2 id="ui-modal-title">Message ${escapeHTML(shortPersonName(line.shipping_name))}</h2>
    <p class="ui-message">About order #${line.order_id} · ${escapeHTML(line.product_name)}. The buyer will see this on their order but <strong>cannot reply</strong>.</p>
    ${sent.length ? `<ul class="sent-messages">${sent.map(m => `<li>${escapeHTML(m.text)}<small>${escapeHTML(formatDate(m.created_at))}</small></li>`).join("")}</ul>` : ""}
    ${full ? `<p class="ui-error">You have reached the limit of ${ORDER_MESSAGE_LIMIT} messages for this order.</p>` : `
      <textarea id="order-message-text" class="order-message-text" maxlength="${ORDER_MESSAGE_MAX}" rows="3" placeholder="e.g. Your order is packed and leaves today." data-autofocus></textarea>
      <p class="char-count" id="order-message-count">0 / ${ORDER_MESSAGE_MAX}</p>
      <p class="ui-error" role="alert"></p>`}
    <div class="ui-actions"><button type="button" class="outline-button" data-ui-cancel>${full ? "Close" : "Cancel"}</button>${full ? "" : '<button type="button" class="primary-button" data-ui-ok>Send message</button>'}</div>`;
  const text = await uiDialog(html, () => {
    const value = (document.getElementById("order-message-text")?.value || "").trim();
    if (!value) { setDialogError("Write a short message first."); return undefined; }
    if (LINK_PATTERN.test(value)) { setDialogError("Links are not allowed in messages. Keep it short and about this order."); return undefined; }
    return value;
  });
  if (!text) return;
  try {
    const result = await apiRequest(`/api/trader/order-items/${itemId}/message`, { method: "POST", body: JSON.stringify({ message: text }) });
    line.trader_messages = [...sent, { text, created_at: new Date().toISOString() }];
    showToast(result.message || "Message sent.");
  } catch (error) { showToast(error.message); }
}

document.addEventListener("input", event => {
  if (event.target.id !== "order-message-text") return;
  const count = document.getElementById("order-message-count");
  if (count) count.textContent = `${event.target.value.length} / ${ORDER_MESSAGE_MAX}`;
});
document.addEventListener("click", event => {
  const button = event.target.closest?.("[data-order-message]");
  if (button) { event.stopPropagation(); openOrderMessage(Number(button.dataset.orderMessage)); }
}, true);
