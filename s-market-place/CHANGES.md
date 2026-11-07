# Update v7: Trader screens, followers, ratings, Verified badge

## What is new
- **Trader account centre**: search + sort your products (by name, category or product ID like `PRD-101`), tap a product for a
  details pop-up (Edit is inside it), and real **Following / Followers** counts.
- **More screen** with live count tiles: Notifications, Listed products, Orders to fulfil, Fulfilled orders, and
  **See my shop as buyers see it**. Each opens its own screen. Orders can be searched by product name, product ID, order number or buyer.
- **Buyer-facing shop page**: cover, avatar, Verified badge, star rating, Products / Followers / Sold, Follow, Message, Share,
  and buyer reviews. Shared links like `https://your-site/?shop=username` open the shop directly.
- **Ratings**: a buyer can rate a trader (1-5 stars + optional comment) once per item, only after confirming delivery
  (My orders -> "Rate this trader"). The trader is notified.
- **Verified badge**: only the superadmin gives it. Admin page -> "Verify traders": search, then Verify / Remove verification.
  Every change is written to the admin audit log and the trader is notified.
- **Unavailable products are hidden from buyers**: sold-out, paused and deleted products no longer appear in the feed, search,
  category lists, shop pages, related items or the shop-list product counts. (A cart that already holds an item still loads it.)
- **Chat link**: the Message buttons say "Coming soon" until you set `window.SMP_CHAT_URL` in `frontend/js/config.js`.
  Then **Message** opens `<chat url>?with=<trader username>&from=<buyer username>` and the trader's **Messages** button opens `<chat url>`.

## Database (upgrades itself on first start, no data is touched)
`users.is_verified`, `users.verified_at`, new tables `follows` and `trader_ratings`.

## New / changed files
- backend: `routes/community.py` (new), `routes/admin.py`, `routes/shop.py`, `routes/orders.py`, `routes/seller.py`, `database.py`, `auth.py`, `app.py`
- frontend: `js/community.js` (new), `js/seller.js`, `js/admin.js`, `js/main.js`, `js/navigation.js`, `js/products.js`, `js/delivery.js`, `js/config.js`, `index.html`, `css/style.css`

# Update v6: Escrow, delivery QR, disputes, payouts

## The big idea

A buyer's payment is no longer "just yours". It is **held in escrow**, and the trader is **credited only after the buyer
confirms delivery**. The flow, exactly as you described:

1. **Buyer pays.** The money lands in your Paystack account (that is the escrow), and the site records, for every item, what
   belongs to the trader (the sale minus your commission). The trader gets a **notification**: "payment received, held in
   escrow, you will be credited when the buyer confirms delivery".
2. **Trader makes a one-time QR** for each item (button **Delivery QR** on the order row) and sends it to the delivery person
   (Share / Download, or read the code out). The QR shows the item name and order number.
3. **Buyer receives the package**, opens the item in **My orders → Confirm delivery**, and either
   - taps **Scan package QR** (or types the code if the camera fails) → "Package confirmed" → taps **Received**, or
   - taps **Report a problem** (before scanning): a reason, a text, and **up to 2 photos**.
4. **Received** → the trader's money moves from escrow to their **available balance**.
   **Report a problem** → the money stays **on hold** until you (the admin) decide: pay the seller, or refund the buyer.
5. The trader adds their **bank details** (Settings → Payout account, checked with the bank), taps **Request payout**, and you
   send the money and tap **Mark as paid** in the **Admin** page.

## IMPORTANT: what "credited" means today

"Credited" means the money appears in the trader's **available balance inside the app**. The real money is in YOUR Paystack
account, so **you send the bank transfer yourself** when a trader requests a payout (the Admin page shows the bank and account
name), then tap Mark as paid. Refunds to buyers are also done by you in the Paystack dashboard (the Admin page reminds you).
Automatic payouts (Paystack Transfers) are a later step.

## Setting yourself up as admin (one time)

1. Register your own account on the site (any type) and open **Settings**. It shows **Account ID** (a number, e.g. 7).
2. On Render, set the environment variable **ADMIN_USER_IDS** to that number (it can list several, separated by commas) and redeploy.
3. An **Admin** button then appears in Settings/Account. (It is by account id and NOT by email, because anyone can type any email at sign-up.)

## New settings (Render environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `COMMISSION_PERCENT` | 0 | The share of each sale you keep (0 to 50). Fixed per sale at the moment of payment. |
| `ADMIN_USER_IDS` | (none) | Your account id(s), see above. |
| `MIN_PAYOUT` | 1000 | The smallest payout a trader can ask for (naira). |
| `AUTO_RELEASE_DAYS` | 0 | 0 = never auto-release. If you set e.g. 7, an item the trader marked Delivered 7 days ago and nobody disputed is released automatically. |

## v6 files: NEW

| File | What it does |
|---|---|
| `backend/escrow_service.py` | The money rules: commission split, hold, release, refund, balances, notifications (read its top comment first) |
| `backend/routes/delivery.py` | Trader's QR code; buyer's scan, Received and Report a problem |
| `backend/routes/wallet.py` | Bank details, earnings, payout requests, notifications |
| `backend/routes/admin.py` | Money overview, disputes, payouts (admin only) |
| `frontend/js/delivery.js` | The Confirm delivery sheet, camera scanning, the dispute form, the trader's QR window |
| `frontend/js/wallet.js` | Earnings panel, payout account form, notifications |
| `frontend/js/admin.js` | The Admin page |
| `frontend/js/vendor/` | Two small open-source libraries: `jsQR.js` (reads a QR with the camera) and `qrcode.js` (draws a QR). Loaded only when needed. |

## v6 files: CHANGED

| File | Where to look | What changed |
|---|---|---|
| `backend/database.py` | `SCHEMA` list, "escrow" lines | New tables `payout_accounts`, `payouts`, `disputes`, `notifications`; new `order_items` columns (`escrow_status`, `commission`, `seller_amount`, `delivery_code`, ...). Existing paid orders are treated as held. |
| `backend/config.py` | "escrow and payouts" block | The four new settings |
| `backend/auth.py` | `public_user`, `require_admin` | `is_admin` flag and the admin check |
| `backend/order_service.py` | `settle_payment` | The moment a payment is confirmed, the money goes into escrow and traders are notified |
| `backend/payment_service.py` | `paystack_banks`, `paystack_resolve_account` | Bank list and account-name check |
| `backend/maintenance.py` | `run_periodically` | Optional auto-release |
| `backend/routes/orders.py`, `routes/seller.py` | order lists | Escrow fields; "Delivered" stamps a time |
| `backend/app.py` | `create_app` | Registers the three new route files |
| `frontend/index.html` | search `earnings-panel`, `delivery-overlay`, `dispute-overlay`, `qr-overlay`, `page-admin` | Earnings and notifications panels, the three pop-ups, the admin page |
| `frontend/js/orders.js` | `orderCardHTML` | Escrow note + "Confirm delivery" under each paid item |
| `frontend/js/seller.js` | `loadTraderOrders`, `escrowLineText` | Escrow line + "Delivery QR" button on each order row |
| `frontend/js/auth.js` | `renderSettings`, `renderAccount` | Payout account form, Account ID, Admin button |
| `frontend/js/main.js`, `navigation.js`, `utils.js`, `css/style.css` | the new sections | Buttons, the admin page, `loadScript`, styles at the end |

The database upgrades itself on the first start (nothing to run by hand).

---

# Update v5: Fast Finger deals can now be bought

Before this update a Fast Finger deal could only be looked at. Now a buyer (or a guest) can add a live deal to the
cart and check out, at the deal price, before the countdown ends.

## How it works

- A trader says **how many are available** at the deal price when posting (1 to 1000).
- Live deals show **"N left"** and an **Add to cart** button (not for the trader who posted it).
- The cart holds products and deals together. Deal lines show a **⚡ Fast Finger deal · ends …** tag.
- At checkout the server re-checks everything: the deal is not sold, the countdown has not ended, and enough are left.
  The order always uses the **deal price**, never the original price.
- When the last one is bought, the deal becomes **Sold** by itself (and goes away 24 hours later, like any finished deal).
- If an unpaid order is cancelled or expires, the quantity goes back and a deal that sold out by itself comes back to life.
  A deal the trader marked "Sold" by hand stays sold.
- A payment that arrives after the hold expired re-takes the deal quantity if it is still there, otherwise the order is
  flagged "Refund needed" (same rule as products).
- Order lines now remember **who sells them**, so a buyer's order history and the trader's "Orders to fulfil" keep working even
  after the deal itself is deleted 24 hours later.

## v5 files: CHANGED (nothing new)

| File | Where to look | What changed |
|---|---|---|
| `backend/database.py` | `SCHEMA` list, the "Fast Finger deals can be bought" lines | `flash_deals.quantity` and `.sold_by_trader`; `order_items.deal_id` and `.trader_id`; `order_items.product_id` may now be empty |
| `backend/routes/deals.py` | `DEAL_SELECT`, `list_deals`, `post_deal`, `mark_deal_sold` | Deals have a quantity; `GET /api/deals?ids=…` for the cart; "sold" also when nothing is left |
| `backend/routes/orders.py` | `checkout()` and `my_orders()` | Checkout accepts `{deal_id, quantity}` lines next to `{product_id, quantity}`; order history reads the seller from the line |
| `backend/order_service.py` | `cancel_unpaid_order`, `take_reserved_items_again` | Cancelling or a late payment handles deal lines too |
| `backend/routes/seller.py` | `my_sales`, `update_delivery_status` | Trader lookups use the seller stored on each order line |
| `frontend/js/cart.js` | whole file (rewritten) | The cart holds products ("12") and deals ("d5"); new `addDealToCart` |
| `frontend/js/deals.js` | `dealCardHTML`, `saveDeal` | "N left", Add to cart button, quantity when posting |
| `frontend/js/orders.js` | `submitCheckout` | Sends deal lines to the server |
| `frontend/js/main.js` | near the `data-add-to-cart` handler | Wires the deal Add to cart button |
| `frontend/index.html` | `deal-quantity` | "How many at this price?" field in the Post a deal pop-up |
| `frontend/css/style.css` | the block at the END, "v5" | Small style for the cart tag |

The database upgrades itself on the first start (nothing to run by hand).

---

# Update v4: Pause, Delete (30 days) and Cloudinary clean-up

## New features, in plain words

1. **Pause / Resume a product.** Open a product with **Edit**, tap **⏸ Pause product**. Shoppers can no longer see or buy it,
   and the row in your list gets a small "Paused" tag. Tap **▶ Resume product** (same place) to show it again.
2. **Delete = a 30-day countdown.** **Delete product** (inside Edit) hides it at once. It moves to **Recently deleted**,
   which shows "Erased for good in 30 days" and a **Restore** button. After 30 days the system erases it permanently,
   **including its picture in Cloudinary**.
3. **Pictures are cleaned from Cloudinary** when they are no longer used: erased products (after 30 days), deleted Fast Finger deals
   (also deals removed by the 24-hour rule), and pictures you replace (product or profile picture).

## Safety rules built into the clean-up

- Only pictures **uploaded through your site** (Cloudinary folder `s-market-place`) are ever deleted. A picture a trader pasted
  from another website is never touched.
- A picture used by **another product, deal or profile** is never deleted.
- Deleting happens in the background and **retries** if Cloudinary is busy (it gives up after 10 tries and writes a line in the Render log).
- A product that already appears in **past orders** is erased down to an empty shell (name only), so buyers' order history keeps working;
  its picture and description are still wiped.
- Products hidden by the OLD delete (v2/v3) automatically start their 30 days the first time the new version starts.

## v4 files: NEW

| File | What it does |
|---|---|
| `backend/image_service.py` | The "pictures to delete" list and the Cloudinary deleting job (`queue_image_deletion`, `process_queue`) |
| `backend/product_service.py` | `purge_deleted_products()`: erases products 30 days after deletion (change `RECOVERY_DAYS` to change the 30) |

## v4 files: CHANGED

| File | Where to look | What changed |
|---|---|---|
| `backend/database.py` | `SCHEMA` list | New columns `products.is_paused / deleted_at / purged_at`; new `image_cleanup` table |
| `backend/routes/seller.py` | `pause_product`, `resume_product`, `delete_product`, `deleted_products`, `restore_product`, `update_product` | The new product endpoints; delete no longer erases at once; replaced pictures go on the clean-up list |
| `backend/maintenance.py` | `run_periodically`, `run_image_cleanup` | Also erases old deleted products and runs the Cloudinary clean-up in a background thread |
| `backend/deal_service.py`, `backend/routes/deals.py` | `purge_old_deals`, `delete_deal` | A removed deal's picture goes on the clean-up list |
| `backend/routes/accounts.py` | `update_profile_image` | The old profile picture goes on the clean-up list |
| `backend/helpers.py` | `product_dict`, `public_product_dict` | Shoppers never receive the pause/delete bookkeeping |
| `frontend/index.html` | `pe-lifecycle`, `pe-paused-note`, `deleted-panel` | Pause + Delete buttons in the Edit pop-up; the "Recently deleted" panel |
| `frontend/js/seller.js` | `loadOwnedProducts`, `deletedProductHTML`, `restoreProduct`, `togglePauseEditing`, `deleteEditingProduct` | Paused tag, recently-deleted list, restore, pause/resume |
| `frontend/js/main.js` | the "trader tools: products" section | Wires Pause and Restore |
| `frontend/css/style.css` | the block at the END, "v4: pause / delete" | Styles for the Paused tag and notes |

---

# Earlier update (v3): Fast Finger, price slash, tidy trader screen

Everything below is already in this project. If you copy the files over your own repo, **use the same paths**.
Search for the function names in the "Where to look" column to find the exact spot in each file.

## New features, in plain words

1. **Fast Finger** (new button in the bottom menu): traders post a product with a price slash and a countdown.
   When the countdown ends it shows "Ended". A trader can mark it "Sold" or delete it. Ended/sold deals stay visible
   for 24 hours and are then deleted by the server automatically.
2. **Price slash on products**: a trader can show "~~₦200,000~~ ₦140,000 · 30% OFF" on any product.
3. **Trader screen made tidy**: "+ Add product" button (form opens in a pop-up), a slim "Your listed products" list
   (name, price, quantity, Edit) and slim "Orders to fulfil" rows (buyer, condition, Save update).
4. **Edit everything** about a product in the same pop-up (name, category, price/discount, quantity, picture, description).
5. **Show quantity or just "In stock"**: chosen per product. When hidden, the exact number never leaves the server.

## Files: NEW

| File | What it does |
|---|---|
| `backend/routes/deals.py` | The Fast Finger API: `GET /api/deals`, `POST /api/trader/deals`, `POST /api/trader/deals/<id>/sold`, `DELETE /api/trader/deals/<id>` |
| `backend/deal_service.py` | `purge_old_deals()`: deletes deals 24 hours after they ended or were marked sold |
| `frontend/js/deals.js` | The Fast Finger screen: deal cards, the 1-second countdown ticker, post / sold / delete |

## Files: CHANGED

| File | Where to look | What changed |
|---|---|---|
| `backend/database.py` | `SCHEMA` list | New `flash_deals` table; new `products.original_price` and `products.show_quantity` columns (added automatically on first start, no data lost) |
| `backend/helpers.py` | `discount_percent`, `product_dict`, `public_product_dict` | Works out "30% off"; `public_product_dict` hides `stock` when the trader chose "In stock" |
| `backend/routes/shop.py` | every `public_product_dict(` | Shoppers only ever receive the public version of a product |
| `backend/routes/seller.py` | `parse_money`, `clean_product_fields`, `slash_error`, `create_product`, `update_product` | Accept `original_price` and `show_quantity`; the original price must be higher than the price; editing accepts every field |
| `backend/routes/orders.py` | `checkout()` stock check | The "not enough stock" message doesn't reveal a hidden quantity |
| `backend/maintenance.py` | `run_periodically` | Also calls `purge_old_deals` (once a minute) |
| `backend/app.py` | `create_app` | Registers the new `deals` blueprint |
| `frontend/index.html` | search for `page-deals`, `product-overlay`, `deal-overlay`, `page-trader-dashboard` | New Fast Finger screen, bottom-menu button, slimmer trader screen, two pop-up forms, one new `<script>` line |
| `frontend/css/style.css` | the block at the very END, "v3 additions" | Styles for price slash, deal cards, slim lists, pop-ups |
| `frontend/js/utils.js` | the block at the END, "Prices, stock labels and the price slash calculator" | `priceHTML`, `ribbonHTML`, `stockLabel`, `formatCountdown`, `readSlash`, `refreshSlashPreview` |
| `frontend/js/cart.js` | `getCartSummary`, `addToCart`, `changeCartQuantity` | Cope with a hidden quantity (`stock` is `null`) |
| `frontend/js/products.js` | `productCardHTML`, `productDetailHTML` | Show the price slash and "In stock" |
| `frontend/js/seller.js` | whole file (rewritten) | Add/Edit pop-up, slim lists, compact orders |
| `frontend/js/navigation.js` | `showPage` | Stops the countdown when you leave Fast Finger; opens the deals screen |
| `frontend/js/main.js` | the click handler: sections "trader tools" and "Fast Finger" | Wires the new buttons and forms |

## Rules worth knowing

- A deal runs between 5 minutes and 24 hours; a trader can have up to 10 live deals at once.
- "24 hours" counts from the moment a deal ENDS (countdown reaches zero) or is marked SOLD, whichever is first.
- The countdown uses the server's clock, so changing a phone's time can't cheat it.
- Deals are a showcase for now: there is no checkout for them (trader/buyer chat comes next).
