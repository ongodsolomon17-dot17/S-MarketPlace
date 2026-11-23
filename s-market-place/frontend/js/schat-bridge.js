"use strict";
/* ============================================================================
   schat-bridge.js — connects S-Marketplace to S-Chat
     1. A pop-up that offers new members an S-Chat account (Skip / Continue,
        then "Fill in with my S-Marketplace info" / Skip)
     2. An "S-Chat account" card in Settings (the same two actions, any time)
     3. The "Share in chat" button on a product's details page
   Switched on by window.SMP_SCHAT_URL in config.js. Loaded after trader-tools.js.

   Privacy: "fill in" sends only the username and email, in the part of the web
   address after "#" (never sent to any server and removed by S-Chat after reading).
   Passwords are never sent, and the terms are never ticked for the person.
   ============================================================================ */
const SCHAT_PROMPT_PREFIX = "smpSchatPrompt:";

/** The S-Chat website address, or "" when it is not set (or not a secure address). */
function schatBase() {
  const raw = String(window.SMP_SCHAT_URL || "").trim();
  const secure = /^https:\/\//i.test(raw) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(raw);
  if (!secure) return "";
  return raw.endsWith("/") ? raw : raw + "/";
}

/** Link to the S-Chat sign-up page, optionally with the member's username and email filled in. */
function schatSignupURL(prefill) {
  const base = schatBase();
  if (!base) return "";
  let url = base + "S-chat-signup.html";
  if (prefill && currentUser) {
    const username = String(currentUser.username || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
    const data = { u: username.length >= 3 ? username : "", e: String(currentUser.email || "").slice(0, 120), src: "smp" };
    let binary = "";
    new TextEncoder().encode(JSON.stringify(data)).forEach(byte => { binary += String.fromCharCode(byte); });
    url += "#prefill=" + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return url;
}

function openSchat(url) { if (url) window.open(url, "_blank", "noopener,noreferrer"); }

/** The pop-up for a new member. Asked once per person on this device. */
async function offerSchatAccount() {
  if (!currentUser || !schatBase() || typeof uiDialog !== "function") return;
  const key = SCHAT_PROMPT_PREFIX + currentUser.id;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "shown");
  } catch (_) { /* private mode: it may be asked again, which is harmless */ }

  const wantsAccount = await uiDialog(`
    <div class="ui-icon" aria-hidden="true">💬</div>
    <h2 id="ui-modal-title">Create your S-Chat account</h2>
    <p class="ui-message">S-Chat is where buyers and traders talk on S-Marketplace. Create your account to message people and keep your conversations in one place.</p>
    <div class="ui-actions">
      <button type="button" class="outline-button" data-ui-cancel>Skip</button>
      <button type="button" class="primary-button" data-ui-ok data-autofocus>Continue</button>
    </div>`);
  if (wantsAccount !== true) return;

  const fillIn = await uiDialog(`
    <div class="ui-icon" aria-hidden="true">✍️</div>
    <h2 id="ui-modal-title">Fill in with your S-Marketplace info?</h2>
    <p class="ui-message">We can open S-Chat with your username and email already typed in. You will still choose your own password. Or skip this and sign up yourself with any details you like.</p>
    <div class="ui-actions">
      <button type="button" class="outline-button" data-ui-cancel>Skip</button>
      <button type="button" class="primary-button" data-ui-ok data-autofocus>Fill in with my S-Marketplace info</button>
    </div>`);
  if (fillIn === true) openSchat(schatSignupURL(true));
}

/* ---- Settings: an "S-Chat account" card, so the choice is never lost ---- */
function addSchatCard() {
  const root = document.getElementById("settings-content");
  const anchor = root && (document.getElementById("pin-section") || document.getElementById("password-form"));
  if (!root || !anchor || document.getElementById("schat-section") || !schatBase()) return;
  const section = document.createElement("section");
  section.id = "schat-section";
  section.className = "panel-form";
  section.innerHTML = `
    <h3>S-Chat account</h3>
    <p class="muted">S-Chat is the chat app for S-Marketplace. Create an account to message traders and buyers.</p>
    <div class="pin-actions">
      <button type="button" class="primary-button" data-schat-signup>Create my S-Chat account</button>
      <button type="button" class="outline-button" data-schat-open>Open S-Chat</button>
    </div>`;
  anchor.before(section);
}
const settingsRoot = document.getElementById("settings-content");
if (settingsRoot) new MutationObserver(() => { if (!document.getElementById("schat-section")) addSchatCard(); }).observe(settingsRoot, { childList: true });

document.addEventListener("click", event => {
  if (!event.target.closest) return;
  if (event.target.closest("[data-schat-signup]")) { openSchat(schatSignupURL(true)); return; }
  if (event.target.closest("[data-schat-open]")) { openSchat(schatBase()); return; }
  const share = event.target.closest("[data-share-product]");
  if (share && /^\d{1,10}$/.test(share.dataset.shareProduct)) {
    openSchat(schatBase() + "S-chat-home.html#share-product=" + share.dataset.shareProduct);
  }
});
