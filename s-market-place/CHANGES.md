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
