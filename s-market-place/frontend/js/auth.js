"use strict";
/* ============================================================================
   auth.js — sign up / log in, the account screen and the Settings screen.

   Where does the account button take you?
     • guests  → the sign-up / log-in window
     • traders → the ADD-ITEM screen (trader dashboard). Their profile details are
                 tucked behind the "Settings" button.
     • buyers  → a small account screen (orders, cart) with a Settings button.
   ============================================================================ */

let activeAuthRole = "buyer";
let adminMfaChallenge = null;

/* ----------------------------------------------------------------------------
   The sign-up / log-in window
   ---------------------------------------------------------------------------- */
/** Open the window. `role` is "choices", "buyer", "trader" or "login". */
function openAuth(role = "choices") {
  document.getElementById("auth-overlay").hidden = false;
  document.getElementById("auth-form-wrap").hidden = true;
  document.getElementById("role-choices").hidden = false;
  document.getElementById("auth-feedback").textContent = "";
  activeAuthRole = role;
  if (role === "login") showAuthForm("login", "buyer");
  else if (role === "buyer" || role === "trader") showAuthForm("signup", role);
  else document.getElementById("auth-title").textContent = "How would you like to continue?";
}

/** Switch the form between "signup" and "login" for the chosen role. */
function showAuthForm(mode, role) {
  activeAuthRole = role;
  adminMfaChallenge = null;

  const signup = mode === "signup";
  const byId = id => document.getElementById(id);

  byId("role-choices").hidden = true;
  byId("auth-form-wrap").hidden = false;
  byId("auth-mode").value = mode;
  byId("auth-role").value = role;
  byId("signup-fields").hidden = !signup;
  byId("login-fields").hidden = signup;
  byId("admin-mfa-login-fields").hidden = true;
  byId("admin-mfa-login-code").required = false;
  byId("admin-mfa-login-code").value = "";

  document.querySelectorAll("#signup-fields input").forEach(input => { input.disabled = !signup; });
  document.querySelectorAll("#login-fields input").forEach(input => { input.disabled = signup; });

  byId("auth-password-label").hidden = !signup;
  byId("auth-password").hidden = !signup;
  byId("auth-password").required = signup;
  byId("login-password").required = !signup;
  byId("login-identity").required = !signup;
  byId("store-name-field").hidden = !(signup && role === "trader");
  byId("auth-store-name").required = signup && role === "trader";
  byId("signup-tab").classList.toggle("active", signup);
  byId("login-tab").classList.toggle("active", !signup);
  byId("auth-title").textContent = signup
    ? (role === "trader" ? "Create your trader account" : "Create your buyer account")
    : "Welcome back";
  byId("auth-submit").textContent = signup
    ? (role === "trader" ? "Create trader account" : "Create buyer account")
    : "Log in";
  byId("auth-feedback").textContent = "";
}

function closeAuth() {
  document.getElementById("auth-overlay").hidden = true;
}

/** Send the sign-up or log-in details to the backend. */
async function submitAuth(event) {
  event.preventDefault();
  const mode = document.getElementById("auth-mode").value;
  const feedback = document.getElementById("auth-feedback");
  const submitButton = document.getElementById("auth-submit");
  const value = id => document.getElementById(id).value.trim();

  const payload = mode === "signup"
    ? {
        role: activeAuthRole,
        first_name: value("auth-first"),
        last_name: value("auth-last"),
        username: value("auth-username"),
        email: value("auth-email"),
        phone: value("auth-phone"),
        password: document.getElementById("auth-password").value,
        store_name: value("auth-store-name")
      }
    : adminMfaChallenge
      ? {
          challenge: adminMfaChallenge,
          ...( /^\d{6}$/.test(value("admin-mfa-login-code"))
            ? { code: value("admin-mfa-login-code") }
            : { recovery_code: value("admin-mfa-login-code").toUpperCase() })
        }
      : {
          identity: value("login-identity"),
          password: document.getElementById("login-password").value
        };

  const endpoint = mode === "signup"
    ? "/api/register"
    : adminMfaChallenge
      ? "/api/admin/mfa/login"
      : "/api/login";

  submitButton.disabled = true;
  feedback.textContent = "Please wait…";

  try {
    const result = await apiRequest(endpoint, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    if (result.mfa_required) {
      adminMfaChallenge = result.challenge;
      document.getElementById("login-fields").hidden = true;
      document.getElementById("admin-mfa-login-fields").hidden = false;
      document.getElementById("admin-mfa-login-code").required = true;
      document.getElementById("auth-title").textContent = "Verify it's you";
      submitButton.textContent = "Verify code";
      feedback.textContent = result.message;
      document.getElementById("admin-mfa-login-code").focus();
      return;
    }

    if (result.token) {
      localStorage.setItem(TOKEN_KEY, result.token);
    }

    currentUser = result.user || (await apiRequest("/api/me")).user;
    adminMfaChallenge = null;

    closeAuth();
    updateHeaderAccount();
    renderAccount();
    showToast(result.message);
    loadHome();

    if (currentUser.role === "trader") {
      showPage("trader-dashboard");
      const pendingSubscriptionReference =
        sessionStorage.getItem("smpPendingSubscriptionReference");

      if (pendingSubscriptionReference) {
        await confirmTraderSubscriptionPayment(pendingSubscriptionReference);
      }
    } else if (sessionStorage.getItem("smpPendingReference")) {
      await confirmPayment(sessionStorage.getItem("smpPendingReference"));
    } else if (window.checkoutPending) {
      window.checkoutPending = false;
      await openCheckout();
    }
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
}

/* ----------------------------------------------------------------------------
   Header / menu
   ---------------------------------------------------------------------------- */
/** Keep the header button and the bottom-menu label in step with who is signed in. */
function updateHeaderAccount() {
  const button = document.getElementById("header-account-button");
  button.title = currentUser ? `${currentUser.first_name} · ${currentUser.role}` : "Sign in / Join";
  if (typeof syncSubscriptionCrown === "function") syncSubscriptionCrown();
  else {
    const subscriptionButton = document.getElementById("header-subscription-button");
    if (subscriptionButton) subscriptionButton.hidden = !currentUser || currentUser.role !== "trader";
  }
  if ((!currentUser || currentUser.role !== "trader") && typeof closeTraderSubscriptionModal === "function") closeTraderSubscriptionModal();
  const label = document.getElementById("nav-account-label");
  if (label) label.textContent = currentUser && currentUser.role === "trader" ? "My shop" : "Account";
}

/** The header account button: sign in, or go to the right place for this account type. */
function openAccountArea() {
  if (!currentUser) openAuth("choices");
  else showPage(currentUser.role === "trader" ? "trader-dashboard" : "account");
}

async function logout() {
  try {
    await apiRequest("/api/logout", { method: "POST", body: JSON.stringify({}) });
    currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    updateHeaderAccount();
    renderAccount();
    showToast("Signed out.");
    showPage("home");
    loadHome();
  } catch (error) {
    showToast(error.message);
  }
}

/* ----------------------------------------------------------------------------
   Account screen (buyers; guests see a welcome)
   ---------------------------------------------------------------------------- */
/** Round profile picture, or a circle with the first letter of the name. */
function avatarHTML(user) {
  return user.profile_image
    ? `<img src="${escapeHTML(user.profile_image)}" alt="Profile picture" class="profile-picture">`
    : `<div class="account-avatar">${escapeHTML(user.first_name.slice(0, 1).toUpperCase())}</div>`;
}

function guestPromptHTML() {
  return `<h2>Welcome!</h2>
    <p>You can browse and add products without an account. Create a buyer account when you are ready to check out, or join as a trader to open a shop.</p>
    <div class="hero-actions">
      <button class="primary-button" type="button" data-open-auth="buyer">Create buyer account</button>
      <button class="outline-button" type="button" data-open-auth="trader">Create trader account</button>
      <button class="text-button" type="button" data-open-auth="login">Log in</button>
    </div>`;
}

function renderAccount() {
  const target = document.getElementById("account-content");
  if (!currentUser) { target.innerHTML = guestPromptHTML(); return; }
  const trader = currentUser.role === "trader";
  target.innerHTML = `
    <div class="profile-summary">${avatarHTML(currentUser)}
      <div><h2>Welcome back, ${escapeHTML(currentUser.first_name)}.</h2>
        <p><strong>${trader ? "Trader account" : "Buyer account"}</strong> · @${escapeHTML(currentUser.username)}</p></div>
    </div>
    <div class="hero-actions">
      ${trader
        ? '<button class="primary-button" type="button" data-page-link="trader-dashboard">Add an item</button>'
        : '<button class="primary-button" type="button" data-page-link="orders">My orders</button><button class="outline-button" type="button" data-page-link="cart">Go to cart</button>'}
      <button class="outline-button" type="button" data-page-link="settings">⚙ Settings</button>
      ${currentUser.is_admin ? '<button class="outline-button" type="button" data-page-link="admin">🛠 Admin</button>' : ""}
      <button class="text-button" type="button" data-logout>Log out</button>
    </div>`;
}

/* ----------------------------------------------------------------------------
   Settings screen: edit profile, picture and password
   ---------------------------------------------------------------------------- */
function renderSettings() {
  const target = document.getElementById("settings-content");
  if (!currentUser) { target.innerHTML = guestPromptHTML(); return; }
  const trader = currentUser.role === "trader";
  const user = currentUser;
  target.innerHTML = `
    <div class="profile-summary">${avatarHTML(user)}
      <div><h2>${escapeHTML(user.first_name)} ${escapeHTML(user.last_name)}</h2>
        <p><strong>${trader ? "Trader account" : "Buyer account"}</strong> · @${escapeHTML(user.username)} · Account ID ${user.id}</p></div>
    </div>

    <section class="theme-preferences panel-form" aria-labelledby="theme-preferences-title">
      <div class="theme-preferences-copy">
        <p class="eyebrow">DISPLAY</p>
        <h3 id="theme-preferences-title">Theme</h3>
        <p>Choose the look that feels right. Your choice is saved on this device.</p>
      </div>
      <fieldset class="theme-options">
        <legend>Choose a theme</legend>
        <label class="theme-option">
          <input type="radio" name="theme-preference" data-theme-choice value="dark" ${getThemePreference() === "dark" ? "checked" : ""}>
          <span class="theme-choice-swatch theme-choice-dark" aria-hidden="true"></span><span>Dark</span>
        </label>
        <label class="theme-option">
          <input type="radio" name="theme-preference" data-theme-choice value="light" ${getThemePreference() === "light" ? "checked" : ""}>
          <span class="theme-choice-swatch theme-choice-light" aria-hidden="true"></span><span>Light</span>
        </label>
      </fieldset>
    </section>

    <form id="profile-edit-form" class="panel-form">
      <h3>Edit your profile</h3>
      <label for="edit-first-name">First name</label>
      <input id="edit-first-name" name="first_name" value="${escapeHTML(user.first_name)}" minlength="2" required>
      <label for="edit-last-name">Last name</label>
      <input id="edit-last-name" name="last_name" value="${escapeHTML(user.last_name)}" minlength="2" required>
      <label for="edit-email">Email</label>
      <input id="edit-email" name="email" type="email" value="${escapeHTML(user.email)}" required>
      <label for="edit-phone">Phone number</label>
      <input id="edit-phone" name="phone" value="${escapeHTML(user.phone || "")}">
      ${trader ? `
        <label for="edit-store-name">Shop name</label>
        <input id="edit-store-name" name="store_name" value="${escapeHTML(user.store_name || "")}" required>
        <label for="edit-store-description">Shop description</label>
        <textarea id="edit-store-description" name="store_description" rows="3">${escapeHTML(user.store_description || "")}</textarea>` : ""}
      <label for="profile-picture-file">Profile picture</label>
      <input id="profile-picture-file" type="file" accept="image/png,image/jpeg,image/webp">
      <button class="primary-button" type="submit">Save profile changes</button>
      <p id="profile-feedback" class="form-feedback" role="status"></p>
    </form>

    ${trader ? payoutFormHTML() : ""}

    <form id="password-form" class="panel-form">
      <h3>Change password</h3>
      <label for="current-password">Current password</label>
      <input id="current-password" type="password" autocomplete="current-password" required>
      <label for="new-password">New password (minimum 8 characters)</label>
      <input id="new-password" type="password" minlength="8" autocomplete="new-password" required>
      <button class="primary-button" type="submit">Change password</button>
      <p id="password-feedback" class="form-feedback" role="status"></p>
    </form>

    <div class="hero-actions">
      <button class="outline-button" type="button" data-page-link="${trader ? "trader-dashboard" : "account"}">← Back</button>
      ${user.is_admin ? '<button class="outline-button" type="button" data-page-link="admin">🛠 Admin</button>' : ""}
      <button class="text-button" type="button" data-logout>Log out</button>
    </div>`;
  if (trader) initPayoutAccountForm();                    // load the bank list and the saved account
  document.getElementById("profile-edit-form").addEventListener("submit", saveProfile);
  document.getElementById("password-form").addEventListener("submit", changePassword);
}

/** Save profile details; if a picture was chosen, upload it to Cloudinary and save its link too. */
async function saveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.getElementById("profile-feedback");
  const payload = Object.fromEntries(new FormData(form).entries());
  const file = document.getElementById("profile-picture-file").files[0];
  try {
    const result = await apiRequest("/api/profile/edit", { method: "PATCH", body: JSON.stringify(payload) });
    currentUser = result.user;
    if (file) {
      const body = new FormData();
      body.append("image", file);
      const uploaded = await apiRequest("/api/upload-image", { method: "POST", body });
      const updated = await apiRequest("/api/profile/image", { method: "PATCH", body: JSON.stringify({ profile_image: uploaded.url }) });
      currentUser = updated.user;
    }
    renderSettings();
    renderAccount();
    updateHeaderAccount();
    showToast("Profile saved successfully.");
  } catch (error) {
    feedback.textContent = error.message;
  }
}

/** Change the password. The backend signs other devices out and gives this one a fresh token. */
async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;   // read it now: it is gone after the first `await`
  const feedback = document.getElementById("password-feedback");
  try {
    const result = await apiRequest("/api/profile/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: document.getElementById("current-password").value,
        new_password: document.getElementById("new-password").value
      })
    });
    localStorage.setItem(TOKEN_KEY, result.token);
    form.reset();
    feedback.textContent = result.message;
    showToast(result.message);
  } catch (error) {
    feedback.textContent = error.message;
  }
}
