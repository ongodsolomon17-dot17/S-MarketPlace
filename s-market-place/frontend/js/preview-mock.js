/* ============================================================================
   PREVIEW-ONLY  —  js/preview-mock.js
   ----------------------------------------------------------------------------
   This file lets you design the front end WITHOUT the backend and WITHOUT logging in.
     • It replaces apiRequest() with fake data (nothing is sent to Render, nothing is saved).
     • It signs you in automatically as Guest / Buyer / Trader / Admin (pick from the bar at the bottom-left).
   It is loaded by ONE line in index.html (marked "PREVIEW ONLY").
   Before you copy your work to the real project: delete that line. Do NOT copy this file.
   ============================================================================ */
(function () {
  "use strict";

  const ROLE_KEY = "smpPreviewRole";
  const ROLES = ["guest", "buyer", "trader", "admin"];
  let role = "trader";
  try { role = localStorage.getItem(ROLE_KEY) || "trader"; } catch (_) {}
  if (!ROLES.includes(role)) role = "trader";

  /* ---------------------------------------------------------------- fake people */
  const USERS = {
    buyer: { id: 101, first_name: "Amaka", last_name: "Obi", username: "amaka", email: "amaka@example.com", phone: "08030000001", role: "buyer", is_admin: false },
    trader: { id: 1, first_name: "Chidi", last_name: "Okafor", username: "chidi", email: "chidi@example.com", phone: "08030000002", role: "trader",
      store_name: "Chidi Scents", store_description: "Fine fragrances and personal care, delivered across Enugu and beyond.", profile_image: "", is_admin: false, is_verified: true },
    admin: { id: 900, first_name: "Site", last_name: "Admin", username: "admin", email: "admin@example.com", phone: "", role: "buyer", is_admin: true }
  };
  const me = role === "guest" ? null : USERS[role];

  /* ---------------------------------------------------------------- fake shops */
  const SHOPS = [
    { id: 1, username: "chidi", first_name: "Chidi", last_name: "Okafor", store_name: "Chidi Scents", store_description: "Fine fragrances and personal care, delivered across Enugu and beyond.", profile_image: "", is_verified: true, rating: 4.7, rating_count: 18, followers: 124, sold: 212 },
    { id: 2, username: "ngozi", first_name: "Ngozi", last_name: "Eze", store_name: "Ngozi Beauty Hub", store_description: "Skincare, body care and gift sets.", profile_image: "", is_verified: false, rating: 4.2, rating_count: 6, followers: 41, sold: 58 },
    { id: 3, username: "tunde", first_name: "Tunde", last_name: "Bello", store_name: "Tunde Essentials", store_description: "Everyday grooming for men.", profile_image: "", is_verified: true, rating: 0, rating_count: 0, followers: 9, sold: 4 }
  ];

  /* ---------------------------------------------------------------- fake products */
  const IMG = ["perfume image.webp", "perfume 8.webp", "perfume7.webp", "perfume9.webp", "perfume10.webp", "perfume11.webp",
    "perfume12.webp", "perfume 6.jpg", "perfume img2.jpg", "purple-perfume-img.jpg", "personal care products.jpg", "OIP.jpg"];
  const NAMES = [
    ["Midnight Oud Eau de Parfum", "Perfumes", 28500, 38000, "A deep, smoky oud with warm amber. Long lasting and made for evenings out."],
    ["Fresh Citrus Splash", "Perfumes", 12000, 0, "Light and zesty. Perfect for hot days and the office."],
    ["Velvet Rose Mist", "Perfumes", 15500, 0, "Soft rose and vanilla body mist."],
    ["Royal Musk Roll-on", "Perfumes", 6500, 8000, "Alcohol-free roll-on oil that lasts all day."],
    ["Lavender Night Candle", "Home", 9000, 0, "Hand-poured soy candle with 40 hours of burn time."],
    ["Glow Body Butter", "Personal care", 7500, 0, "Shea and cocoa butter for soft, glowing skin."],
    ["Beard Care Kit", "Personal care", 18000, 24000, "Oil, balm and comb in a gift box."],
    ["Amber Nights Gift Set", "Gift sets", 42000, 55000, "Perfume, body mist and candle in one premium box."],
    ["Purple Haze Perfume", "Perfumes", 21000, 0, "Floral-fruity with a hint of plum."],
    ["Daily Face Wash", "Personal care", 4500, 0, "Gentle gel cleanser for all skin types."],
    ["Sandalwood Deodorant", "Personal care", 3800, 0, "48-hour protection, no white marks."],
    ["Classic Cologne 100ml", "Perfumes", 16000, 20000, "A timeless fresh cologne for men."]
  ];
  const PRODUCTS = NAMES.map((n, i) => {
    const shop = SHOPS[i % 3];
    const soldOut = i === 9;
    const percent = n[3] ? Math.round(((n[3] - n[2]) / n[3]) * 100) : 0;
    return {
      id: i + 1, name: n[0], category: n[1], price: n[2], original_price: n[3] || null, discount_percent: percent || 0,
      description: n[4], image: IMG[i], stock: soldOut ? 0 : (i % 4 === 0 ? null : 3 + i), show_quantity: i % 4 !== 0,
      available: !soldOut, is_paused: false, trader_id: shop.id, trader_username: shop.username, store_name: shop.store_name,
      trader_verified: shop.is_verified
    };
  });
  const OWN_PRODUCTS = PRODUCTS.filter(p => p.trader_username === "chidi");

  /* ---------------------------------------------------------------- fake deals */
  const DEALS = [
    { id: 1, title: "Flash: Royal Musk Roll-on", description: "Today only: half price.", image: IMG[3], price: 4000, original_price: 8000, discount_percent: 50, quantity: 7, seconds_left: 5400, status: "live", trader_id: 1, trader_username: "chidi", store_name: "Chidi Scents", ends_at: new Date(Date.now() + 5400000).toISOString() },
    { id: 2, title: "Body Butter Twin Pack", description: "Two tubs, one price.", image: IMG[5], price: 11000, original_price: 15000, discount_percent: 27, quantity: 3, seconds_left: 1800, status: "live", trader_id: 2, trader_username: "ngozi", store_name: "Ngozi Beauty Hub", ends_at: new Date(Date.now() + 1800000).toISOString() },
    { id: 3, title: "Old Spice Bundle", description: "This one has ended.", image: IMG[6], price: 9000, original_price: 12000, discount_percent: 25, quantity: 0, seconds_left: 0, status: "ended", trader_id: 3, trader_username: "tunde", store_name: "Tunde Essentials", ends_at: new Date(Date.now() - 3600000).toISOString() }
  ];

  /* ---------------------------------------------------------------- fake orders etc. */
  const ago = h => new Date(Date.now() - h * 3600000).toISOString();
  const BUYER_ORDERS = [
    { id: 5001, status: "Paid", total: 41000, created_at: ago(30), shipping_name: "Amaka Obi", shipping_address: "12 Ogui Road", shipping_city: "Enugu", shipping_state: "Enugu", expires_at: null,
      items: [{ id: 9001, name: "Midnight Oud Eau de Parfum", quantity: 1, store_name: "Chidi Scents", fulfilment_status: "Shipped", unit_price: 28500, escrow_status: "held", scanned: false },
              { id: 9002, name: "Glow Body Butter", quantity: 1, store_name: "Chidi Scents", fulfilment_status: "Processing", unit_price: 7500, escrow_status: "held", scanned: false }] },
    { id: 5002, status: "Awaiting payment", total: 12000, created_at: ago(2), shipping_name: "Amaka Obi", shipping_address: "12 Ogui Road", shipping_city: "Enugu", shipping_state: "Enugu", expires_at: ago(-20),
      items: [{ id: 9003, name: "Fresh Citrus Splash", quantity: 1, store_name: "Chidi Scents", fulfilment_status: "Pending", unit_price: 12000 }] }
  ];
  const CHAT = { mode: "system", url: "" };   // preview only: the real backend stores this per trader
  const TRADER_ORDER_LINES = [
    { item_id: 9001, order_id: 5001, product_id: 1, deal_id: null, product_name: "Midnight Oud Eau de Parfum", quantity: 1, unit_price: 28500, seller_amount: 27000, paid_at: ago(30), fulfilment_status: "Shipped", escrow_status: "held", scanned: false, shipping_name: "Amaka Obi", shipping_phone: "08030000001", shipping_address: "12 Ogui Road", shipping_city: "Enugu", shipping_state: "Enugu" },
    { item_id: 9002, order_id: 5001, product_id: 6, deal_id: null, product_name: "Glow Body Butter", quantity: 2, unit_price: 7500, seller_amount: 14200, paid_at: ago(29), fulfilment_status: "Pending", escrow_status: "held", scanned: false, shipping_name: "Amaka Obi", shipping_phone: "08030000001", shipping_address: "12 Ogui Road", shipping_city: "Enugu", shipping_state: "Enugu" },
    { item_id: 9003, order_id: 5004, product_id: 1, deal_id: null, product_name: "Midnight Oud Parfum", quantity: 1, unit_price: 28500, seller_amount: 27000, paid_at: ago(5), fulfilment_status: "Pending", escrow_status: "held", scanned: false, shipping_name: "Emeka Nwosu", shipping_phone: "08030000009", shipping_address: "4 Zik Avenue", shipping_city: "Awka", shipping_state: "Anambra" },
    { item_id: 9004, order_id: 4998, product_id: 7, deal_id: null, product_name: "Beard Care Kit", quantity: 1, unit_price: 18000, seller_amount: 17100, paid_at: ago(1), fulfilment_status: "Processing", escrow_status: "held", scanned: false, shipping_name: "Ife Adeyemi", shipping_phone: "08030000012", shipping_address: "9 Market Road", shipping_city: "Onitsha", shipping_state: "Anambra" },
    { item_id: 9005, order_id: 4970, product_id: 4, deal_id: null, product_name: "Royal Musk Roll-on", quantity: 1, unit_price: 6500, seller_amount: 6200, paid_at: ago(70), fulfilment_status: "Shipped", escrow_status: "disputed", scanned: false, shipping_name: "Kelechi Obi", shipping_phone: "08030000015", shipping_address: "21 Garden Close", shipping_city: "Nsukka", shipping_state: "Enugu" },
    { item_id: 9010, order_id: 4990, product_id: 12, deal_id: null, product_name: "Classic Cologne 100ml", quantity: 1, unit_price: 16000, seller_amount: 15200, paid_at: ago(120), fulfilment_status: "Delivered", escrow_status: "released", scanned: true, shipping_name: "Emeka Nwosu", shipping_phone: "08030000009", shipping_address: "4 Zik Avenue", shipping_city: "Awka", shipping_state: "Anambra" },
    { item_id: 9011, order_id: 4985, product_id: 7, deal_id: null, product_name: "Beard Care Kit", quantity: 1, unit_price: 18000, seller_amount: 17100, paid_at: ago(200), fulfilment_status: "Delivered", escrow_status: "disputed", scanned: true, shipping_name: "Ife Adeyemi", shipping_phone: "08030000010", shipping_address: "9 Market Road", shipping_city: "Onitsha", shipping_state: "Anambra" }
  ];
  const NOTIFICATIONS = [
    { id: 1, title: "New order #5001", body: "Amaka Obi paid for 2 items from your shop.", created_at: ago(30), is_read: false },
    { id: 2, title: "Payout sent", body: "₦50,000 was sent to your bank account.", created_at: ago(96), is_read: true },
    { id: 3, title: "Welcome to S-Market Place", body: "Your trial has started. Add your first product.", created_at: ago(300), is_read: true }
  ];
  const EARNINGS = {
    available: 15200, in_escrow: 41200, disputed: 17100, paid_out: 50000, requested: 0, min_payout: 5000, commission_percent: 5,
    has_account: true, can_request: true,
    weekly_sales: Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.now() - (6 - i) * 86400000);
      const amounts = [0, 12000, 28500, 0, 16000, 41000, 22500];
      return { label: d.toLocaleDateString("en", { weekday: "short" }), date: d.toISOString().slice(0, 10), amount: amounts[i], orders: amounts[i] ? 1 + (i % 3) : 0 };
    }),
    payouts: [
      { id: 1, amount: 50000, status: "paid", created_at: ago(96), reference: "PAY-1042" },
      { id: 2, amount: 20000, status: "rejected", created_at: ago(400), reference: "" }
    ]
  };
  const SUBSCRIPTION = {
    subscription: { status: "trial", plan: "monthly", auto_renew: false, trial_ends_at: new Date(Date.now() + 9 * 86400000).toISOString(), current_period_ends_at: null, can_add_products: true },
    plans: { monthly: 3500, yearly: 37800 }, payments_enabled: true, has_ever_subscribed: false
  };

  /* ---------------------------------------------------------------- helpers */
  const ok = (message = "Preview mode: that worked, but nothing was saved.") => ({ message });
  const page = (list, params) => {
    const limit = Number(params.get("limit") || 24), offset = Number(params.get("offset") || 0);
    return { products: list.slice(offset, offset + limit), has_more: offset + limit < list.length };
  };
  const shopOut = s => ({ ...s, joined: "2026-01-15", products: PRODUCTS.filter(p => p.trader_username === s.username).length,
    is_mine: Boolean(me && me.username === s.username), following: false,
    chat_mode: s.username === "chidi" ? CHAT.mode : "system", chat_url: s.username === "chidi" ? CHAT.url : "" });

  function route(method, path, params, body = {}) {
    // ---- who am I
    if (path === "/api/me") return { user: me };
    if (path === "/api/logout") return ok("Signed out.");
    if (path === "/api/login" || path === "/api/register") throw new Error("Preview mode: use the Guest / Buyer / Trader / Admin bar at the bottom-left instead of logging in.");

    // ---- shopping
    if (path === "/api/feed") return page(PRODUCTS, params);
    if (path === "/api/products") {
      let list = PRODUCTS;
      if (params.get("ids")) { const ids = params.get("ids").split(","); list = list.filter(p => ids.includes(String(p.id))); }
      if (params.get("trader")) list = list.filter(p => p.trader_username === params.get("trader"));
      if (params.get("category")) list = list.filter(p => p.category === params.get("category"));
      const q = (params.get("q") || "").toLowerCase();
      if (q) list = list.filter(p => (p.name + " " + p.description + " " + p.category).toLowerCase().includes(q));
      return page(list, params);
    }
    let m = path.match(/^\/api\/products\/(\d+)\/related$/);
    if (m) return { products: PRODUCTS.filter(p => String(p.id) !== m[1]).slice(0, 8) };
    m = path.match(/^\/api\/products\/(\d+)$/);
    if (m) { const product = PRODUCTS.find(p => String(p.id) === m[1]); if (!product) throw new Error("Product not found."); return { product }; }
    if (path === "/api/categories") {
      const names = [...new Set(PRODUCTS.map(p => p.category))];
      return { categories: names.map((name, i) => ({ id: i + 1, name, product_count: PRODUCTS.filter(p => p.category === name).length })) };
    }
    if (path === "/api/traders") {
      const q = (params.get("q") || "").toLowerCase();
      return SHOPS.filter(s => !q || (s.store_name + s.username).toLowerCase().includes(q))
        .map(s => ({ ...s, product_count: PRODUCTS.filter(p => p.trader_username === s.username).length }));
    }
    m = path.match(/^\/api\/shops\/([^/]+)\/reviews$/);
    if (m) return { reviews: [
      { stars: 5, buyer: "Amaka O.", created_at: ago(70), comment: "Arrived fast and smells amazing.", product_name: "Midnight Oud Eau de Parfum" },
      { stars: 4, buyer: "Emeka N.", created_at: ago(200), comment: "", product_name: "Classic Cologne 100ml" }] };
    m = path.match(/^\/api\/shops\/([^/]+)\/follow$/);
    if (m) return { following: method === "POST", followers: 125 };
    m = path.match(/^\/api\/shops\/([^/]+)$/);
    if (m) { const s = SHOPS.find(x => x.username === decodeURIComponent(m[1])); if (!s) throw new Error("Shop not found."); return { shop: shopOut(s) }; }
    if (path === "/api/deals") {
      if (params.get("ids")) { const ids = params.get("ids").split(","); return { deals: DEALS.filter(d => ids.includes(String(d.id))) }; }
      return { deals: DEALS };
    }
    if (path === "/api/interactions") return {};

    // ---- buyer
    if (path === "/api/orders") return BUYER_ORDERS;
    if (path === "/api/checkout") throw new Error("Preview mode: checkout is switched off (no payment page).");
    if (/^\/api\/orders\//.test(path)) return ok();
    if (path === "/api/notifications") return { notifications: NOTIFICATIONS, unread: NOTIFICATIONS.filter(n => !n.is_read).length };
    if (path === "/api/notifications/read") return ok();

    // ---- trader
    if (path === "/api/trader/summary") return { followers: 124, following: 12, unread: 1, products: OWN_PRODUCTS.length, to_fulfil: 2, fulfilled: 2, is_verified: true };
    if (path === "/api/trader/subscription") return SUBSCRIPTION;
    if (path === "/api/trader/chat-settings") {
      if (method === "PUT") {
        if (body.mode === "external") { if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(String(body.url || ""))) throw new Error("Enter a secure https:// chat link."); CHAT.mode = "external"; CHAT.url = body.url; }
        else { CHAT.mode = "system"; CHAT.url = ""; }
        return ok("Chat setting saved.");
      }
      return { mode: CHAT.mode, url: CHAT.url };
    }
    m = path.match(/^\/api\/trader\/order-items\/(\d+)$/);
    if (m && method === "PATCH") { const l = TRADER_ORDER_LINES.find(x => x.item_id === Number(m[1])); if (l) l.fulfilment_status = body.fulfilment_status; return ok("Order updated."); }
    if (path === "/api/trader/products") return OWN_PRODUCTS;
    if (path === "/api/trader/products/deleted") return [{ id: 77, name: "Old Rose Perfume", days_left: 21, image: IMG[2] }];
    if (path === "/api/trader/orders") return { orders: TRADER_ORDER_LINES, total_sales: 94000 };
    if (path === "/api/trader/earnings") return EARNINGS;
    if (path === "/api/trader/payout-account") return { account: { account_name: "CHIDI OKAFOR", account_number: "0123456789", bank_name: "Access Bank", bank_code: "044" } };
    if (path === "/api/banks") return { banks: [{ code: "044", name: "Access Bank" }, { code: "058", name: "GTBank" }, { code: "011", name: "First Bank" }, { code: "057", name: "Zenith Bank" }] };
    if (/^\/api\/trader\/order-items\/\d+\/code$/.test(path)) return { code: "482915", qr: "PREVIEW-482915", message: "Preview delivery code." };
    if (path === "/api/upload-image") return { url: IMG[0] };

    // ---- admin
    if (path === "/api/admin/overview") return { held_in_escrow: 182000, disputed: 17100, open_disputes: 1, owed_to_traders: 15200, payouts_waiting: 1, paid_out: 250000, commission_earned: 18400 };
    if (path === "/api/admin/disputes") return { disputes: [{ id: 1, order_id: 4985, status: "open", amount: 18000, quantity: 1, product_name: "Beard Care Kit", store_name: "Chidi Scents", buyer_name: "Ife Adeyemi", buyer_phone: "08030000010", reason: "Item not as described", details: "The oil leaked in transit.", photo: "", admin_note: "", created_at: ago(40) }] };
    if (path === "/api/admin/payouts") return { payouts: [{ id: 1, status: "requested", amount: 15200, store_name: "Chidi Scents", username: "chidi", account_name: "CHIDI OKAFOR", account_number: "0123456789", bank_name: "Access Bank", reference: "", note: "", created_at: ago(5) }] };
    if (path === "/api/admin/subscription-plans") return { plans: { monthly: 3500, yearly: 37800 } };
    if (path === "/api/admin/traders") return { traders: SHOPS.map(s => ({ ...s, email: s.username + "@example.com", products: PRODUCTS.filter(p => p.trader_username === s.username).length, created_at: "2026-01-15" })) };

    // ---- anything else: reads return an empty object, writes say "saved"
    if (method === "GET") return {};
    return ok();
  }

  /* ---------------------------------------------------------------- replace the real apiRequest */
  window.apiRequest = async function previewApiRequest(url, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const u = new URL(url, "http://preview.local");
    await new Promise(r => setTimeout(r, 60));          // tiny delay so loading states can be seen
    try {
      return JSON.parse(JSON.stringify(route(method, u.pathname, u.searchParams, options.body ? JSON.parse(options.body) : {})));
    } catch (error) {
      error.status = error.status || 400;
      throw error;
    }
  };

  // Make the "signed in" state exist before the app starts (main.js also asks /api/me).
  try { localStorage.setItem("smpAuthToken", role === "guest" ? "" : "preview-token"); if (role === "guest") localStorage.removeItem("smpAuthToken"); } catch (_) {}

  /* ---------------------------------------------------------------- the little role bar */
  function buildBar() {
    const bar = document.createElement("div");
    bar.id = "preview-bar";
    bar.setAttribute("style", "position:fixed;left:8px;bottom:84px;z-index:2147483647;font:12px/1.2 system-ui,sans-serif;background:#111;color:#fff;border-radius:10px;padding:6px;box-shadow:0 4px 18px rgba(0,0,0,.4);display:flex;gap:4px;align-items:center;opacity:.92");
    const label = document.createElement("span");
    label.textContent = "PREVIEW";
    label.setAttribute("style", "padding:0 6px;letter-spacing:.08em;font-weight:700;color:#f5c542");
    bar.appendChild(label);
    ROLES.forEach(r => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = r[0].toUpperCase() + r.slice(1);
      b.setAttribute("style", "all:unset;cursor:pointer;padding:5px 9px;border-radius:7px;" + (r === role ? "background:#f5c542;color:#111;font-weight:700" : "background:#333;color:#fff"));
      b.addEventListener("click", () => { try { localStorage.setItem(ROLE_KEY, r); } catch (_) {} location.reload(); });
      bar.appendChild(b);
    });
    const hide = document.createElement("button");
    hide.type = "button"; hide.textContent = "×"; hide.title = "Hide this bar until you refresh";
    hide.setAttribute("style", "all:unset;cursor:pointer;padding:3px 7px;color:#aaa");
    hide.addEventListener("click", () => bar.remove());
    bar.appendChild(hide);
    document.body.appendChild(bar);
  }
  if (document.body) buildBar(); else document.addEventListener("DOMContentLoaded", buildBar);
})();
