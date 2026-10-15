# S-Market Place

A multi-vendor perfume marketplace. Traders open shops and list perfumes, buyers check out and pay with Paystack, and visitors can browse without an account.

| Part | Runs on | Folder |
|---|---|---|
| Website (HTML/CSS/JS) | Vercel | `frontend/` |
| API (Flask) | Render | `backend/` |
| Database | Neon PostgreSQL | — |
| Product/profile images | Cloudinary | — |
| Payments (₦) | Paystack | — |

## What it does

- Browse and search traders and perfumes as a guest (24 per page, "Load more"); the cart lives in the browser.
- Buyer and trader accounts, hashed passwords, 14-day signed login tokens, change password (signs out other devices), rate-limited login/registration.
- Traders: shop profile, add/edit/delete products, exact stock counts, image upload, **orders to fulfil** with the buyer's delivery details, and a Processing/Shipped/Delivered status for each line.
- Checkout: buyer enters delivery details, stock is reserved inside a database transaction, and the buyer is sent to Paystack.
- Payments are confirmed **server-side** (Paystack verify call + signed webhook). Underpayments are rejected.
- Unpaid orders are held for 30 minutes (`ORDER_HOLD_MINUTES`), then cancelled and the stock goes back on sale. Buyers can also pay again or cancel from **My orders**.
- A payment that arrives after the hold expired re-takes the stock if it is still available; otherwise the order is flagged **Refund needed**.
- Deleting a product that already has orders hides it instead of crashing, so order history stays intact.

## Environment variables (set these on Render)

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `SECRET_KEY` | Generated for you by `render.yaml` (or any random 32+ characters) |
| `FRONTEND_ORIGIN` | Your exact Vercel URL, e.g. `https://s-market-place.vercel.app` (comma-separate extra origins; no `*`) |
| `PAYSTACK_SECRET_KEY` | Paystack secret key (`sk_test_…` for testing, `sk_live_…` when live) |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | From the Cloudinary dashboard |
| `ORDER_HOLD_MINUTES` | Optional, default 30 |

The API refuses to start without `SECRET_KEY` and `FRONTEND_ORIGIN`, so a forgotten variable shows up in the Render logs instead of leaving the site insecure.

## Setup, step by step

1. **Neon** — create a project at neon.tech and copy the connection string (Dashboard → Connect).
2. **Cloudinary** — create an account and copy the cloud name, API key and API secret from the dashboard.
3. **Paystack** — create an account at paystack.com and copy the **test** secret key (Settings → API Keys & Webhooks).
4. **GitHub** — push this folder as a repository (the `.gitignore` already keeps secrets and `venv` out).
5. **Vercel (first)** — Add New → Project → import the repo → set **Root Directory** to `frontend` → Deploy. Note the URL it gives you.
6. **Render** — New → Blueprint → pick the repo. Render reads `render.yaml` and asks for each variable above; paste the values (use the Vercel URL for `FRONTEND_ORIGIN`).
7. **Check the API** — open `https://YOUR-SERVICE.onrender.com/api/health`. You want `status: ok`, `database: connected`, `payments: configured`.
8. **Point the site at the API** — if your Render URL differs from the one in `frontend/js/config.js`, edit that file, commit and push; Vercel redeploys on its own.
9. **Paystack webhook** — Paystack → Settings → API Keys & Webhooks → set the webhook URL to `https://YOUR-SERVICE.onrender.com/api/paystack/webhook` and save.
10. **Test end to end** — create a trader, add a product, then (in a private window) create a buyer, add it to the cart, check out and pay with a Paystack test card. The order should show **Paid** under My orders and appear under the trader's **Orders to fulfil**.
11. **Going live** — complete Paystack's business verification, replace `PAYSTACK_SECRET_KEY` on Render with the live key and set the live webhook URL.

## Local testing

```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env    # then export the variables (or set them in your shell)
python app.py           # API on http://127.0.0.1:5000

cd ../frontend
python -m http.server 8000   # site on http://localhost:8000
```

`FLASK_DEBUG=1` relaxes the secret/origin checks for local use only. `frontend/js/config.js` automatically uses the local API on localhost.

## Not built yet

- **Paying traders out.** All payments go to your one Paystack account. Paystack split payments/subaccounts would pay traders automatically; until then payouts are manual.
- Refund button (refunds are done in the Paystack dashboard; paid orders can't be cancelled in the app).
- Password reset and email verification (need an email service), order emails/notifications.
- Reviews and ratings, product detail pages, multiple images per product, admin moderation, real URL routing.
- The login token lives in browser local storage; the rate limiter is in-memory per server process.
- Render's free plan sleeps when idle, so the first request after a quiet period can take up to a minute.
