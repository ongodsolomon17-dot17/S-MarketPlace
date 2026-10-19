# S-Market Place

A multi-trader marketplace where traders sell **any kind of product** and shoppers browse a personalised
"For you" feed. Visitors can browse without an account; buyers pay with Paystack; traders manage their own shop.

| Part | Runs on | Folder |
|---|---|---|
| Website (HTML/CSS/JS) | Vercel | `frontend/` |
| API (Flask) | Render | `backend/` |
| Database | Neon PostgreSQL | — |
| Product/profile images | Cloudinary | — |
| Payments (₦) | Paystack | — |

**Repo layout:** `backend/`, `frontend/`, `render.yaml` and this README sit at the **top level** of the repository
(Render's *Root Directory* is `backend`, Vercel's is `frontend`).

## What it does

- **"For you" home feed** — a random mix that adapts to what each person looks at, adds to the cart, taps or buys (details below).
- **Any category** — traders pick from the category list or type a new one; near-duplicates ("shoe"/"Shoes") are merged automatically.
- **Product cards show 2 lines of description.** Tapping the picture, name or description opens the full product as one block, with other items underneath.
- **Search** — several words must all match a name, description, category or shop; name matches rank first.
- **Traders** get a tidy screen: an **+ Add product** button (the form opens in a pop-up), a slim product list (name, price, quantity, **Edit**) and slim order rows (buyer, condition, **Save update**). Profile editing lives behind a **Settings** button.
- **Edit everything** about a product in the same pop-up, including a **price slash** (original price + % off → "~~₦200,000~~ ₦140,000 · 30% OFF") and a choice to show **how many are left** or just **"In stock"**.
- **Pause / resume** a product (it is hidden from shoppers but kept), and **delete** with a 30-day countdown: deleted products wait in "Recently deleted" (restorable), then are erased for good together with their Cloudinary picture.
- **Fast Finger** (bottom menu) — traders post limited-time price-slash deals with a live countdown. Ended or sold deals disappear 24 hours later. See `CHANGES.md`.
- **Buyers** check out with delivery details and pay with Paystack; payments are confirmed server-side (verify call + signed webhook). Unpaid orders are held for 30 minutes and then released; a late payment re-takes the stock or is flagged "Refund needed".
- Hashed passwords, 14-day signed tokens, change-password signs out other devices, rate-limited login/registration.

## How the "For you" feed works

1. The site remembers what a person does (`interactions` table): open a product = 1 point, tap a category = 2, add to cart = 4, buy = 6.
   Guests are recognised by a random id stored in their own browser; signed-in users by their account.
2. Points fade with time (halving every 14 days); history older than 90 days is deleted.
3. The feed ranks a pool of products (newest + a random sample + the person's favourite categories) by
   *category liking + shop liking + freshness + popularity + a little randomness*.
   Newcomers get a mostly-random, newness-biased mix. No trader fills more than 2 slots in a row.
4. The ranked list is cached for 15 minutes per person and `seed`, so "Load more" never repeats or skips items. **↻ Refresh** uses a new seed.

The code is in `backend/feed.py` (heavily commented); the weights at the top of that file are easy to tune.

## Code map

```
backend/
  app.py              entry point (Gunicorn runs app:app) – builds the Flask app
  config.py           settings from environment variables (+ start-up safety checks)
  database.py         Neon connection, tables and automatic upgrades
  auth.py             login tokens, "who is this?", guest visitor id
  categories.py       category cleaning, duplicate detection, pick-or-create
  feed.py             the "For you" recommendation engine
  order_service.py    cancel / expire / settle orders
  payment_service.py  Paystack calls and webhook signature check
  maintenance.py      periodic housekeeping
  deal_service.py     deletes finished Fast Finger deals after 24 hours
  product_service.py  erases products 30 days after they were deleted
  image_service.py    deletes unused pictures from Cloudinary (queue + retries)
  routes/             accounts.py · shop.py · orders.py · seller.py · deals.py
frontend/
  index.html          all screens
  css/style.css
  js/                 config → utils → api → navigation → cart → products → deals → auth → seller → orders → main
```

## Environment variables (set on Render)

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon connection string (just the `postgresql://…` part) |
| `SECRET_KEY` | A random string of 32+ characters (Render can generate it) |
| `FRONTEND_ORIGIN` | Your exact Vercel URL, e.g. `https://s-marketplace-s-market-place.vercel.app` (no trailing slash, no `*`) |
| `PAYSTACK_SECRET_KEY` | `sk_test_…` while testing, `sk_live_…` when live |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | From the Cloudinary dashboard |
| `ORDER_HOLD_MINUTES` | Optional, default 30 |

The API refuses to start without `SECRET_KEY` and `FRONTEND_ORIGIN`, so a forgotten variable shows up in the Render logs.

## Setup

1. **Neon** – create a project, copy the connection string. **Cloudinary** – note cloud name, API key and secret. **Paystack** – copy the *test* secret key.
2. **GitHub** – the repository root must contain `backend/`, `frontend/` and `render.yaml`.
3. **Vercel** – import the repo, **Root Directory = `frontend`**, deploy. Note the permanent domain (Project → Domains).
4. **Render** – New → Web Service (or Blueprint), **Root Directory = `backend`**, Build `pip install -r requirements.txt`,
   Start `gunicorn app:app --workers 1 --threads 4 --timeout 60`, then add the environment variables above.
5. Open `https://YOUR-SERVICE.onrender.com/api/health` → expect `status: ok`, `database: connected`, `payments: configured`.
6. Make sure `frontend/js/config.js` has your Render URL, commit and push (Vercel redeploys).
7. In Paystack, set the webhook URL to `https://YOUR-SERVICE.onrender.com/api/paystack/webhook`.
8. Test: create a trader and add a product (pick or type a category) → in a private window create a buyer, check out and pay with a Paystack test card.
9. Going live: finish Paystack business verification, swap in the `sk_live_` key and the live webhook.

## Local testing

```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# set the variables from .env.example in your shell (FLASK_DEBUG=1 relaxes the production checks)
python app.py                                           # API on http://127.0.0.1:5000

cd ../frontend
python -m http.server 8000                              # site on http://localhost:8000
```

## Not built yet

- Paying traders out automatically (all money lands in your one Paystack account; Paystack split payments could automate it).
- Refund button, password reset / email verification, order emails, reviews, admin moderation, real URL routing (the browser Back button leaves the site; use the in-page Back button).
- The login token is kept in browser local storage; rate limits and the feed cache live in memory per server process.
- Render's free plan sleeps when idle, so the first request after a quiet period can take up to a minute.
