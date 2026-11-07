"use strict";
/* ============================================================================
   delivery.js — confirming delivery with a one-time QR code.

   TRADER: makes a QR for each paid item and gives it to whoever delivers it.
   BUYER:  opens the item in "My orders" and either
             1. scans the package QR  → "Package confirmed"  → taps "Received" (the trader is paid), or
             2. taps "Report a problem" (text + up to 2 photos) → the money stays on hold.
   ============================================================================ */

let orderItems = {};      // every order line the buyer can see, by id (filled in by renderOrders)
let deliveryItemId = null;   // the line shown in the "Confirm delivery" sheet
let scanStream = null;       // the camera while scanning
let scanTimer = null;
let qrState = null;          // the QR the trader is looking at

/* ----------------------------------------------------------------------------
   Buyer: the note and buttons under each paid item in "My orders"
   ---------------------------------------------------------------------------- */
function escrowHTML(order, item) {
  if (order.status !== "Paid") return "";
  switch (item.escrow_status) {
    case "held":
      return `<div class="item-escrow"><p class="escrow-note">🔒 Your payment is held safely until you confirm delivery.</p>
        <button class="primary-button small" type="button" data-open-delivery="${item.id}">Confirm delivery</button></div>`;
    case "disputed":
      return '<div class="item-escrow"><p class="escrow-note warn">⚠ Problem reported. Your payment stays on hold while we review it.</p></div>';
    case "released":
      return `<div class="item-escrow"><p class="escrow-note ok">✓ Delivery confirmed. The seller has been paid.</p>
        ${!item.trader_username ? "" : item.my_rating
          ? `<p class="rated-line">You rated ${escapeHTML(item.store_name || "this trader")}: <span class="stars" aria-label="${item.my_rating} out of 5">${starsText(item.my_rating)}</span></p>`
          : `<button class="outline-button small" type="button" data-open-rating="${item.id}">★ Rate this trader</button>`}</div>`;
    case "refunded":
      return '<div class="item-escrow"><p class="escrow-note">↩ This item was refunded.</p></div>';
    default:
      return "";
  }
}

/* ----------------------------------------------------------------------------
   Buyer: the "Confirm delivery" sheet
   ---------------------------------------------------------------------------- */
function openDeliverySheet(itemId) {
  deliveryItemId = String(itemId);
  renderDeliverySheet();
  document.getElementById("delivery-overlay").hidden = false;
}

function closeDeliverySheet() {
  stopScan();
  document.getElementById("delivery-overlay").hidden = true;
}

/** Draw the sheet for the item's current state: no QR yet / ready to scan / scanned. */
function renderDeliverySheet() {
  const item = orderItems[deliveryItemId];
  const target = document.getElementById("delivery-content");
  if (!item) { target.innerHTML = '<p class="muted">This item could not be found.</p>'; return; }
  const report = `<button class="outline-button" type="button" data-open-dispute="${item.id}">Report a problem</button>`;
  let body;
  if (item.scanned) {
    body = `<p class="escrow-note ok">✔ Package confirmed: ${escapeHTML(item.name)}. This QR matches your order.</p>
      <div class="modal-actions"><button class="primary-button" type="button" data-confirm-received="${item.id}">Received ✔</button>${report}</div>`;
  } else if (!item.has_code) {
    body = `<p class="muted">The trader hasn't prepared the delivery QR for this item yet. When your package arrives with its QR code, come back here to scan it.</p>
      <div class="modal-actions">${report}</div>`;
  } else {
    body = `
      <div id="scanner-box" class="scanner-box" hidden>
        <video id="scan-video" playsinline muted></video>
        <p class="muted">Point your camera at the QR code on the package.</p>
        <button class="outline-button" type="button" data-stop-scan>Cancel scanning</button>
      </div>
      <div id="scan-actions">
        <p class="muted">Scan the QR code that came with your package to confirm it is the right one.</p>
        <div class="modal-actions"><button class="primary-button" type="button" data-start-scan="${item.id}">📷 Scan package QR</button>${report}</div>
        <details class="manual-code"><summary>Can't scan? Type the code</summary>
          <input id="manual-code" placeholder="SMP-XXXXX-XXXXX" autocomplete="off" autocapitalize="characters">
          <button class="outline-button" type="button" data-submit-code="${item.id}">Check code</button>
        </details>
      </div>`;
  }
  target.innerHTML = `<p class="auth-intro"><strong>${escapeHTML(item.name)}</strong> × ${item.quantity} · ${escapeHTML(item.store_name)}</p>${body}<p class="form-feedback" id="delivery-feedback" role="status"></p>`;
}

/** Open the camera and read the QR code; falls back to typing the code if the camera is unavailable. */
async function startScan(itemId) {
  const feedback = document.getElementById("delivery-feedback");
  try {
    await loadScript("/js/vendor/jsQR.js");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("no camera");
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = document.getElementById("scan-video");
    video.srcObject = scanStream;
    await video.play();
    document.getElementById("scanner-box").hidden = false;
    document.getElementById("scan-actions").hidden = true;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    scanTimer = setInterval(() => {                      // look at the camera picture 4 times a second
      if (video.readyState < 2) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0);
      const picture = context.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(picture.data, picture.width, picture.height);
      if (found && found.data) { stopScan(); submitCode(itemId, found.data); }
    }, 250);
  } catch (error) {
    stopScan();
    feedback.textContent = "We couldn't open the camera. Allow camera access, or type the code instead (tap “Can't scan?”).";
  }
}

function stopScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  if (scanStream) { scanStream.getTracks().forEach(track => track.stop()); scanStream = null; }
  const box = document.getElementById("scanner-box");
  const actions = document.getElementById("scan-actions");
  if (box) box.hidden = true;
  if (actions) actions.hidden = false;
}

/** Send the scanned (or typed) code to the server; it must match THIS item. */
async function submitCode(itemId, code) {
  const feedback = document.getElementById("delivery-feedback");
  try {
    const result = await apiRequest(`/api/orders/items/${itemId}/scan`, { method: "POST", body: JSON.stringify({ code }) });
    orderItems[itemId].scanned = true;
    renderDeliverySheet();
    showToast(result.message);
  } catch (error) {
    if (feedback) feedback.textContent = error.message;
  }
}

function submitManualCode(itemId) {
  const code = document.getElementById("manual-code").value.trim();
  if (!code) { document.getElementById("delivery-feedback").textContent = "Type the code printed under the QR."; return; }
  submitCode(itemId, code);
}

/** "Received": the buyer confirms. The server releases the trader's money from escrow. */
async function confirmReceived(itemId) {
  try {
    const result = await apiRequest(`/api/orders/items/${itemId}/confirm`, { method: "POST", body: JSON.stringify({}) });
    closeDeliverySheet();
    showToast(result.message);
  } catch (error) {
    document.getElementById("delivery-feedback").textContent = error.message;
    return;
  }
  renderOrders();
}

/* ----------------------------------------------------------------------------
   Buyer: report a problem (a description and up to 2 photos)
   ---------------------------------------------------------------------------- */
function openDispute(itemId) {
  const item = orderItems[itemId];
  if (!item) return;
  closeDeliverySheet();
  deliveryItemId = String(itemId);
  document.getElementById("dispute-form").reset();
  document.getElementById("dispute-feedback").textContent = "";
  document.getElementById("dispute-item").textContent = `${item.name} × ${item.quantity}`;
  document.getElementById("dispute-overlay").hidden = false;
}

function closeDispute() {
  document.getElementById("dispute-overlay").hidden = true;
}

async function submitDispute(event) {
  event.preventDefault();
  const feedback = document.getElementById("dispute-feedback");
  const button = document.getElementById("dispute-submit");
  button.disabled = true;
  feedback.textContent = "Sending…";
  try {
    // Photos are uploaded first (to Cloudinary), then the report carries their links.
    const photos = [];
    for (const id of ["dispute-photo1", "dispute-photo2"]) {
      const file = document.getElementById(id).files[0];
      if (!file) continue;
      const body = new FormData();
      body.append("image", file);
      photos.push((await apiRequest("/api/upload-image", { method: "POST", body })).url);
    }
    const result = await apiRequest(`/api/orders/items/${deliveryItemId}/dispute`, {
      method: "POST",
      body: JSON.stringify({ reason_type: document.getElementById("dispute-reason").value, details: document.getElementById("dispute-details").value.trim(), photos })
    });
    closeDispute();
    showToast(result.message);
    renderOrders();
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

/* ----------------------------------------------------------------------------
   Trader: the delivery QR
   ---------------------------------------------------------------------------- */
/** Draw a QR for `text`. `scalable` gives a picture that resizes to fit; otherwise a fixed size for saving as an image. */
async function makeQrSvg(text, scalable) {
  await loadScript("/js/vendor/qrcode.js");
  const qr = qrcode(0, "M");                 // type 0 = pick the smallest size that fits; M = medium error correction
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: scalable ? 8 : 14, margin: 3, scalable });
}

/** Show the one-time QR for an order line. `regenerate` replaces the code (only possible before the buyer scans it). */
async function openDeliveryQR(itemId, regenerate = false) {
  const overlay = document.getElementById("qr-overlay");
  const target = document.getElementById("qr-content");
  target.innerHTML = '<p class="muted">Preparing the QR…</p>';
  overlay.hidden = false;
  try {
    const data = await apiRequest(`/api/trader/order-items/${itemId}/code`, { method: "POST", body: JSON.stringify({ regenerate }) });
    qrState = { ...data, itemId };
    target.innerHTML = `
      <div class="qr-box">${await makeQrSvg(data.code, true)}</div>
      <p class="qr-name">${escapeHTML(data.name)} × ${data.quantity}</p>
      <p class="muted">Order #${data.order_id}</p>
      <p class="qr-code">${escapeHTML(data.code)}</p>
      <p class="muted">Give this QR to the person delivering the item. The buyer scans it to confirm the package, and it can only be used once. If the QR is lost, make a new one.</p>
      <div class="modal-actions">
        <button class="primary-button" type="button" data-qr-share>Share</button>
        <button class="outline-button" type="button" data-qr-download>Download</button>
        <button class="outline-button" type="button" data-qr-regenerate>New code</button>
      </div>`;
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

function closeDeliveryQR() {
  document.getElementById("qr-overlay").hidden = true;
}

/** A printable picture: the QR with the item name, the code and the order number underneath. */
async function qrLabelBlob() {
  const size = 720;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size + 200;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const picture = new Image();
  const svg = await makeQrSvg(qrState.code, false);
  await new Promise((resolve, reject) => {
    picture.onload = resolve;
    picture.onerror = reject;
    picture.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
  context.drawImage(picture, 0, 0, size, size);
  context.fillStyle = "#111";
  context.textAlign = "center";
  context.font = "bold 34px sans-serif";
  context.fillText(`${qrState.name.slice(0, 32)} × ${qrState.quantity}`, size / 2, size + 50);
  context.font = "30px monospace";
  context.fillText(qrState.code, size / 2, size + 100);
  context.font = "24px sans-serif";
  context.fillText(`Order #${qrState.order_id} · S-Market Place`, size / 2, size + 150);
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** Send the QR picture through any app (WhatsApp, the chat app …); downloads it where sharing isn't available. */
async function shareDeliveryQR() {
  try {
    const blob = await qrLabelBlob();
    const file = new File([blob], `delivery-qr-order-${qrState.order_id}.png`, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Delivery QR", text: `${qrState.name} · order #${qrState.order_id}` });
    } else {
      downloadBlob(blob, file.name);
      showToast("QR picture saved. You can now send it to the delivery person.");
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast("Could not prepare the picture. You can read the code out instead: " + qrState.code);
  }
}

async function downloadDeliveryQR() {
  try {
    downloadBlob(await qrLabelBlob(), `delivery-qr-order-${qrState.order_id}.png`);
  } catch (_) {
    showToast("Could not prepare the picture. You can read the code out instead: " + qrState.code);
  }
}
