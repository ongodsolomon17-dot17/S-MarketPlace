"""S-Market Place API.

Runs on Render (Flask + Gunicorn) and uses:
  * Neon PostgreSQL for data          (DATABASE_URL)
  * Cloudinary for uploaded images    (CLOUDINARY_*)
  * Paystack for naira card payments  (PAYSTACK_SECRET_KEY)
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from functools import wraps

import cloudinary
import cloudinary.uploader
import psycopg
import requests
from flask import Flask, jsonify, request, g
from flask_cors import CORS
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from psycopg.rows import dict_row
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import generate_password_hash, check_password_hash

# ---------------------------------------------------------------------------
# Configuration (all secrets come from environment variables, never from code)
# ---------------------------------------------------------------------------
DEBUG = os.environ.get('FLASK_DEBUG') == '1'
DATABASE_URL = os.environ.get('DATABASE_URL')
DB_SSLMODE = os.environ.get('DB_SSLMODE', 'require')
PAYSTACK_SECRET_KEY = os.environ.get('PAYSTACK_SECRET_KEY', '')
ORDER_HOLD_MINUTES = int(os.environ.get('ORDER_HOLD_MINUTES', '30'))
TOKEN_MAX_AGE = 60 * 60 * 24 * 14          # login tokens last 14 days
ROLES = {'buyer', 'trader'}
CATEGORIES = {'men', 'women', 'gift', 'unisex'}
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
ORDER_REF_RE = re.compile(r'^SMP-(\d+)-[0-9a-f]{12}$')

SECRET_KEY = os.environ.get('SECRET_KEY', '')
if len(SECRET_KEY) < 32:
    if DEBUG:
        SECRET_KEY = SECRET_KEY or 'local-development-only-secret-do-not-deploy'
    else:
        raise RuntimeError('SECRET_KEY must be set to a random string of at least 32 characters.')

ORIGINS = [o.strip().rstrip('/') for o in os.environ.get('FRONTEND_ORIGIN', '').split(',') if o.strip()]
if not ORIGINS:
    if DEBUG:
        ORIGINS = ['http://localhost:8000', 'http://127.0.0.1:8000']
    else:
        raise RuntimeError('FRONTEND_ORIGIN must be set to your Vercel site URL, e.g. https://your-site.vercel.app')
if '*' in ORIGINS and not DEBUG:
    raise RuntimeError('FRONTEND_ORIGIN must list exact site URLs, not *.')
# Paystack sends the buyer back here after paying; it appends ?reference=...
PAYMENT_RETURN_URL = ORIGINS[0] + '/'

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)   # trust Render's proxy for the real client IP
serializer = URLSafeTimedSerializer(SECRET_KEY, salt='smp-auth-v1')
CORS(app, origins=ORIGINS, supports_credentials=False,
     allow_headers=['Content-Type', 'Authorization'], methods=['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'])
cloudinary.config(cloud_name=os.environ.get('CLOUDINARY_CLOUD_NAME'), api_key=os.environ.get('CLOUDINARY_API_KEY'),
                  api_secret=os.environ.get('CLOUDINARY_API_SECRET'), secure=True)


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
# Purpose: open a PostgreSQL connection to Neon and return dictionary-shaped rows.
def db():
    if not DATABASE_URL:
        raise RuntimeError('DATABASE_URL is missing. Add your Neon connection string to Render environment variables.')
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, connect_timeout=10, sslmode=DB_SSLMODE)


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY, role VARCHAR(10) NOT NULL CHECK(role IN ('buyer','trader')),
        first_name VARCHAR(80) NOT NULL, last_name VARCHAR(80) NOT NULL,
        username VARCHAR(30) NOT NULL UNIQUE, email VARCHAR(255) NOT NULL UNIQUE,
        phone VARCHAR(40) NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
        store_name VARCHAR(120) NOT NULL DEFAULT '', store_description TEXT NOT NULL DEFAULT '',
        profile_image TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS products (
        id BIGSERIAL PRIMARY KEY, trader_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL, price NUMERIC(12,2) NOT NULL CHECK(price >= 0),
        category VARCHAR(20) NOT NULL DEFAULT 'unisex' CHECK(category IN ('men','women','gift','unisex')),
        description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
        stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY, buyer_id BIGINT NOT NULL REFERENCES users(id),
        total NUMERIC(12,2) NOT NULL, status VARCHAR(40) NOT NULL DEFAULT 'Awaiting payment',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS order_items (
        id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id BIGINT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity > 0),
        unit_price NUMERIC(12,2) NOT NULL)""",
    # Columns added after the first version. IF NOT EXISTS makes these safe on an existing database.
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_name VARCHAR(160) NOT NULL DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_phone VARCHAR(40) NOT NULL DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_city VARCHAR(80) NOT NULL DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_state VARCHAR(80) NOT NULL DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(80)",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ",
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_name VARCHAR(120) NOT NULL DEFAULT ''",
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fulfilment_status VARCHAR(20) NOT NULL DEFAULT 'Pending'",
    "CREATE INDEX IF NOT EXISTS idx_products_trader ON products(trader_id)",
    "CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)",
    "CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id)",
    "CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status, expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)",
    "CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username))",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email))",
]

_schema_ready = False


# Purpose: create marketplace tables in Neon without deleting existing records.
def initialize_database():
    with db() as con:
        con.execute('SELECT pg_advisory_xact_lock(727274)')   # stops two workers creating tables at once
        for statement in SCHEMA:
            con.execute(statement)


# Purpose: make sure the tables exist before the first request is handled (retries if Neon was asleep at boot).
def ensure_schema():
    global _schema_ready
    if _schema_ready or not DATABASE_URL:
        return
    initialize_database()
    _schema_ready = True


try:
    ensure_schema()
except Exception:   # noqa: BLE001 - the first request will retry
    print('Database not reachable at startup; will retry on the first request.')


@app.before_request
def _before_request():
    if request.path.startswith('/api/'):
        ensure_schema()


@app.after_request
def _security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


# Purpose: convert a PostgreSQL user row into JSON-friendly values without the password hash.
def public_user(row):
    if not row:
        return None
    return {k: (str(v) if isinstance(v, (datetime, Decimal)) else v) for k, v in dict(row).items() if k != 'password_hash'}


def product_dict(row):
    p = dict(row)
    p['price'] = float(p['price'])
    p['available'] = int(p['stock']) > 0
    p['created_at'] = iso(p.get('created_at'))
    return p


def to_kobo(amount):
    return int((Decimal(amount) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


# Purpose: escape % and _ so search text is matched literally by ILIKE.
def like_term(text):
    return '%' + text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


def int_arg(name, default, low, high):
    try:
        value = int(request.args.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


_hits = defaultdict(deque)


# Purpose: simple per-IP limiter for sensitive routes (resets when the server restarts).
def too_many_requests(bucket, limit, window_seconds):
    now = time.monotonic()
    if len(_hits) > 5000:
        for key in [k for k, q in _hits.items() if not q or now - q[-1] > 3600]:
            del _hits[key]
    queue = _hits[(bucket, request.remote_addr)]
    while queue and now - queue[0] > window_seconds:
        queue.popleft()
    if len(queue) >= limit:
        return True
    queue.append(now)
    return False


TOO_MANY = ('Too many attempts. Please wait a few minutes and try again.', 429)

USER_COLUMNS = 'id,role,first_name,last_name,username,email,phone,store_name,store_description,profile_image,created_at'


# ---------------------------------------------------------------------------
# Authentication (signed bearer token, so no cross-site cookies are needed)
# ---------------------------------------------------------------------------
def _fingerprint(password_hash):
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


# Purpose: the token holds the user id plus a fingerprint of the password, so changing the password signs out old tokens.
def make_token(user_id, password_hash):
    return serializer.dumps([user_id, _fingerprint(password_hash)])


# Purpose: identify the current user from the bearer token sent by the Vercel frontend.
def current_user():
    if hasattr(g, '_user'):
        return g._user
    g._user = None
    header = request.headers.get('Authorization', '')
    if header.startswith('Bearer '):
        try:
            user_id, fingerprint = serializer.loads(header[7:], max_age=TOKEN_MAX_AGE)
            with db() as con:
                row = con.execute(f'SELECT {USER_COLUMNS},password_hash FROM users WHERE id=%s', (user_id,)).fetchone()
            if row and hmac.compare_digest(_fingerprint(row['password_hash']), str(fingerprint)):
                g._user = public_user(row)
        except (BadSignature, SignatureExpired, TypeError, ValueError):
            pass
    return g._user


def require_role(role):
    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            user = current_user()
            if not user:
                return jsonify(error='Please sign in or create an account first.', needs_auth=True), 401
            if user['role'] != role:
                return jsonify(error=f'This action requires a {role} account.'), 403
            g.user = user
            return fn(*args, **kwargs)
        return wrapped
    return decorator


def require_login(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify(error='Please sign in first.', needs_auth=True), 401
        g.user = user
        return fn(*args, **kwargs)
    return wrapped


@app.get('/api/health')
def health():
    try:
        with db() as con:
            con.execute('SELECT 1')
        return jsonify(status='ok', database='connected', payments='configured' if PAYSTACK_SECRET_KEY else 'not configured')
    except Exception:   # noqa: BLE001
        app.logger.exception('Health check failed')
        return jsonify(status='error', error='Database connection failed'), 503


@app.post('/api/register')
def register():
    if too_many_requests('register', 8, 600):
        return jsonify(error=TOO_MANY[0]), TOO_MANY[1]
    data = request.get_json(silent=True) or {}
    role = str(data.get('role', '')).lower()
    first, last = str(data.get('first_name', '')).strip(), str(data.get('last_name', '')).strip()
    username, email = str(data.get('username', '')).strip(), str(data.get('email', '')).strip().lower()
    phone, password = str(data.get('phone', '')).strip(), str(data.get('password', ''))
    store = str(data.get('store_name', '')).strip() if role == 'trader' else ''
    if role not in ROLES:
        return jsonify(error='Choose a buyer or trader account.'), 400
    if not all([first, last, username, email, password]):
        return jsonify(error='Please complete all required fields.'), 400
    if len(first) > 80 or len(last) > 80 or len(phone) > 40 or len(store) > 120 or len(email) > 255:
        return jsonify(error='One of the fields is too long.'), 400
    if not EMAIL_RE.match(email):
        return jsonify(error='Enter a valid email address.'), 400
    if len(username) < 3 or len(username) > 30 or not re.fullmatch(r'[A-Za-z0-9_.-]+', username):
        return jsonify(error='Username must be 3–30 characters and use letters, numbers, dots, underscores or hyphens.'), 400
    if len(password) < 8 or len(password) > 128:
        return jsonify(error='Password must be between 8 and 128 characters.'), 400
    if role == 'trader' and not store:
        return jsonify(error='Enter your shop name to create a trader account.'), 400
    password_hash = generate_password_hash(password)
    try:
        with db() as con:
            row = con.execute(
                f'INSERT INTO users(role,first_name,last_name,username,email,phone,password_hash,store_name) '
                f'VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING {USER_COLUMNS}',
                (role, first, last, username, email, phone, password_hash, store)).fetchone()
        return jsonify(message=f'{role.title()} account created successfully.', user=public_user(row),
                       token=make_token(row['id'], password_hash))
    except psycopg.errors.UniqueViolation:
        return jsonify(error='That username or email is already registered. Try signing in instead.'), 409


@app.post('/api/login')
def login():
    if too_many_requests('login', 10, 300):
        return jsonify(error=TOO_MANY[0]), TOO_MANY[1]
    data = request.get_json(silent=True) or {}
    identity, password = str(data.get('identity', '')).strip(), str(data.get('password', ''))
    with db() as con:
        row = con.execute('SELECT * FROM users WHERE LOWER(username)=LOWER(%s) OR LOWER(email)=LOWER(%s)', (identity, identity)).fetchone()
    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify(error='Incorrect username/email or password.'), 401
    return jsonify(message='You are now signed in.', user=public_user(row), token=make_token(row['id'], row['password_hash']))


@app.post('/api/logout')
def logout():
    return jsonify(message='Signed out.')


@app.get('/api/me')
def me():
    return jsonify(user=current_user())


# Purpose: update editable personal details and trader storefront details without changing role or username.
@app.patch('/api/profile/edit')
@require_login
def edit_profile():
    user = g.user
    data = request.get_json(silent=True) or {}
    allowed = {'first_name', 'last_name', 'email', 'phone', 'store_name', 'store_description'}
    fields = {k: str(data[k]).strip() for k in allowed if k in data}
    if user['role'] != 'trader':
        fields.pop('store_name', None)
        fields.pop('store_description', None)
    if 'email' in fields:
        fields['email'] = fields['email'].lower()
        if not EMAIL_RE.match(fields['email']) or len(fields['email']) > 255:
            return jsonify(error='Enter a valid email address.'), 400
    if 'first_name' in fields and not 2 <= len(fields['first_name']) <= 80:
        return jsonify(error='First name must contain 2–80 characters.'), 400
    if 'last_name' in fields and not 2 <= len(fields['last_name']) <= 80:
        return jsonify(error='Last name must contain 2–80 characters.'), 400
    if 'store_name' in fields and not 1 <= len(fields['store_name']) <= 120:
        return jsonify(error='Shop name must contain 1–120 characters.'), 400
    if 'phone' in fields and len(fields['phone']) > 40:
        return jsonify(error='Phone number is too long.'), 400
    if 'store_description' in fields and len(fields['store_description']) > 1000:
        return jsonify(error='Shop description is too long (maximum 1000 characters).'), 400
    if not fields:
        return jsonify(error='No profile changes were provided.'), 400
    try:
        with db() as con:
            row = con.execute('UPDATE users SET ' + ', '.join(f'{k}=%s' for k in fields) + f' WHERE id=%s RETURNING {USER_COLUMNS}',
                              (*fields.values(), user['id'])).fetchone()
        return jsonify(message='Profile updated successfully.', user=public_user(row))
    except psycopg.errors.UniqueViolation:
        return jsonify(error='That email is already in use.'), 409


@app.post('/api/profile/password')
@require_login
def change_password():
    if too_many_requests('password', 5, 300):
        return jsonify(error=TOO_MANY[0]), TOO_MANY[1]
    data = request.get_json(silent=True) or {}
    current, new = str(data.get('current_password', '')), str(data.get('new_password', ''))
    if not 8 <= len(new) <= 128:
        return jsonify(error='The new password must be between 8 and 128 characters.'), 400
    with db() as con:
        row = con.execute('SELECT password_hash FROM users WHERE id=%s', (g.user['id'],)).fetchone()
        if not row or not check_password_hash(row['password_hash'], current):
            return jsonify(error='Your current password is incorrect.'), 400
        new_hash = generate_password_hash(new)
        con.execute('UPDATE users SET password_hash=%s WHERE id=%s', (new_hash, g.user['id']))
    # The old token stops working, so hand back a fresh one for this device.
    return jsonify(message='Password changed. Other devices have been signed out.', token=make_token(g.user['id'], new_hash))


# Purpose: upload profile/product images to Cloudinary so they persist across Render deploys.
@app.post('/api/upload-image')
@require_login
def upload_image():
    file = request.files.get('image')
    if not file or not file.filename:
        return jsonify(error='Choose an image file first.'), 400
    if file.mimetype not in {'image/jpeg', 'image/png', 'image/webp'}:
        return jsonify(error='Only JPG, PNG or WebP images are allowed.'), 400
    if not all(os.environ.get(k) for k in ('CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET')):
        return jsonify(error='Image storage is not configured yet. Add the Cloudinary environment variables on Render.'), 503
    try:
        result = cloudinary.uploader.upload(file, folder='s-market-place', resource_type='image',
                                            transformation=[{'width': 1200, 'height': 1200, 'crop': 'limit'}])
        return jsonify(url=result['secure_url'])
    except Exception:   # noqa: BLE001
        app.logger.exception('Cloudinary upload failed')
        return jsonify(error='Image upload failed. Please try again.'), 502


@app.patch('/api/profile/image')
@require_login
def update_profile_image():
    url = str((request.get_json(silent=True) or {}).get('profile_image', '')).strip()
    if not url.startswith('https://') or len(url) > 500:
        return jsonify(error='A secure image URL is required.'), 400
    with db() as con:
        row = con.execute(f'UPDATE users SET profile_image=%s WHERE id=%s RETURNING {USER_COLUMNS}', (url, g.user['id'])).fetchone()
    return jsonify(message='Profile picture updated.', user=public_user(row))


# ---------------------------------------------------------------------------
# Public shop
# ---------------------------------------------------------------------------
_last_release = 0.0


# Purpose: cancel unpaid orders whose hold time ran out and put their stock back on the shelf.
def release_expired_orders(force=False):
    global _last_release
    if not force and time.monotonic() - _last_release < 60:
        return
    _last_release = time.monotonic()
    try:
        with db() as con:
            rows = con.execute("SELECT id FROM orders WHERE status='Awaiting payment' AND expires_at IS NOT NULL AND expires_at < NOW() "
                               "ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED").fetchall()
            for row in rows:
                cancel_unpaid_order(con, row['id'], 'Expired')
    except Exception:   # noqa: BLE001
        app.logger.exception('Releasing expired orders failed')


# Purpose: cancel one unpaid order and restore its reserved stock. Returns False if it was no longer unpaid.
def cancel_unpaid_order(con, order_id, new_status):
    done = con.execute("UPDATE orders SET status=%s WHERE id=%s AND status='Awaiting payment' RETURNING id", (new_status, order_id)).fetchone()
    if not done:
        return False
    for item in con.execute('SELECT product_id, quantity FROM order_items WHERE order_id=%s ORDER BY product_id', (order_id,)).fetchall():
        con.execute('UPDATE products SET stock=stock+%s WHERE id=%s', (item['quantity'], item['product_id']))
    return True


@app.get('/api/products')
def api_products():
    release_expired_orders()
    category = request.args.get('category', '').lower()
    query, trader = request.args.get('q', '').strip(), request.args.get('trader', '').strip()
    if category and category not in CATEGORIES | {'all'}:
        return jsonify(error='Unknown category.'), 400
    limit, offset = int_arg('limit', 24, 1, 100), int_arg('offset', 0, 0, 100000)
    sql = 'SELECT p.*,u.store_name,u.username AS trader_username FROM products p JOIN users u ON u.id=p.trader_id WHERE p.is_active'
    params = []
    if 'ids' in request.args:
        ids = [int(x) for x in request.args['ids'].split(',') if x.strip().isdigit()][:100]
        if not ids:
            return jsonify(products=[], has_more=False)
        sql += ' AND p.id = ANY(%s)'
        params.append(ids)
    if category and category != 'all':
        sql += ' AND p.category=%s'
        params.append(category)
    if query:
        sql += ' AND (p.name ILIKE %s OR p.description ILIKE %s OR u.store_name ILIKE %s OR u.username ILIKE %s)'
        params += [like_term(query)] * 4
    if trader:
        sql += ' AND LOWER(u.username)=LOWER(%s)'
        params.append(trader)
    sql += ' ORDER BY p.id DESC LIMIT %s OFFSET %s'
    params += [limit + 1, offset]
    with db() as con:
        rows = con.execute(sql, params).fetchall()
    return jsonify(products=[product_dict(r) for r in rows[:limit]], has_more=len(rows) > limit)


@app.get('/api/traders')
def api_traders():
    term = like_term(request.args.get('q', '').strip())
    with db() as con:
        rows = con.execute("""SELECT u.id,u.first_name,u.last_name,u.username,u.store_name,u.store_description,u.profile_image,
            COUNT(p.id)::int AS product_count FROM users u LEFT JOIN products p ON p.trader_id=u.id AND p.is_active
            WHERE u.role='trader' AND (u.store_name ILIKE %s OR u.username ILIKE %s OR u.first_name ILIKE %s)
            GROUP BY u.id ORDER BY u.store_name LIMIT 100""", (term, term, term)).fetchall()
    return jsonify([dict(r) for r in rows])


# ---------------------------------------------------------------------------
# Checkout and payments (Paystack)
# ---------------------------------------------------------------------------
class CheckoutError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.message, self.status = message, status


def paystack_headers():
    return {'Authorization': f'Bearer {PAYSTACK_SECRET_KEY}'}


# Purpose: ask Paystack for a payment page for this order and return its URL.
def paystack_initialize(order_id, reference, email, total):
    response = requests.post('https://api.paystack.co/transaction/initialize', headers=paystack_headers(), timeout=15, json={
        'email': email, 'amount': to_kobo(total), 'currency': 'NGN', 'reference': reference,
        'callback_url': PAYMENT_RETURN_URL, 'metadata': {'order_id': order_id}})
    body = response.json()
    if not response.ok or not body.get('status'):
        raise RuntimeError(body.get('message', 'Paystack refused the request'))
    return body['data']['authorization_url']


# Purpose: ask Paystack whether a payment really succeeded (never trust the browser for this).
def paystack_verify(reference):
    response = requests.get(f'https://api.paystack.co/transaction/verify/{reference}', headers=paystack_headers(), timeout=15)
    body = response.json()
    return body.get('data') if response.ok and body.get('status') else None


# Purpose: mark an order paid after Paystack confirmed it. Safe to call repeatedly (webhook + browser both call it).
def settle_payment(order_id, reference, paid_kobo, currency):
    with db() as con:
        order = con.execute('SELECT * FROM orders WHERE id=%s FOR UPDATE', (order_id,)).fetchone()
        if not order:
            return None
        if order['status'] in ('Paid', 'Refund needed'):
            return order['status']
        if currency != 'NGN' or paid_kobo < to_kobo(order['total']):
            app.logger.error('Payment amount mismatch on order %s: paid %s %s, expected %s', order_id, paid_kobo, currency, order['total'])
            return 'Amount mismatch'
        status = 'Paid'
        if order['status'] != 'Awaiting payment':
            # The buyer paid after the hold expired. Try to take the stock again; otherwise flag it for a refund.
            items = con.execute('SELECT product_id, quantity FROM order_items WHERE order_id=%s ORDER BY product_id', (order_id,)).fetchall()
            enough = True
            for item in items:
                stock = con.execute('SELECT stock FROM products WHERE id=%s FOR UPDATE', (item['product_id'],)).fetchone()
                if not stock or stock['stock'] < item['quantity']:
                    enough = False
            if enough:
                for item in items:
                    con.execute('UPDATE products SET stock=stock-%s WHERE id=%s', (item['quantity'], item['product_id']))
            else:
                status = 'Refund needed'
        con.execute('UPDATE orders SET status=%s, paid_at=NOW(), payment_reference=%s WHERE id=%s', (status, reference, order_id))
        return status


# Purpose: create a buyer order, reserve stock under row locks, then send the buyer to Paystack to pay.
@app.post('/api/checkout')
@require_role('buyer')
def checkout():
    if not PAYSTACK_SECRET_KEY:
        return jsonify(error='Online payment is not set up yet. Please try again later.'), 503
    data = request.get_json(silent=True) or {}
    items, shipping = data.get('items') or [], data.get('shipping') or {}
    if not items:
        return jsonify(error='Your cart is empty.'), 400
    ship = {k: str(shipping.get(k, '')).strip() for k in ('name', 'phone', 'address', 'city', 'state')}
    if not all(ship.values()):
        return jsonify(error='Enter your full name, phone number, delivery address, city and state.'), 400
    if len(ship['name']) > 160 or len(ship['phone']) > 40 or len(ship['address']) > 400 or len(ship['city']) > 80 or len(ship['state']) > 80:
        return jsonify(error='One of the delivery details is too long.'), 400
    try:
        quantities = {}
        for item in items:
            pid, qty = int(item['product_id']), int(item['quantity'])
            if qty < 1 or qty > 1000:
                raise ValueError
            quantities[pid] = quantities.get(pid, 0) + qty
    except (KeyError, TypeError, ValueError):
        return jsonify(error='Your cart contains an invalid item or quantity.'), 400
    release_expired_orders(force=True)
    try:
        with db() as con:
            total, locked = Decimal('0.00'), []
            for pid in sorted(quantities):
                qty = quantities[pid]
                row = con.execute('SELECT id,name,price,stock FROM products WHERE id=%s AND is_active FOR UPDATE', (pid,)).fetchone()
                if not row:
                    raise CheckoutError('A product in your cart is no longer available.')
                if row['stock'] < qty:
                    raise CheckoutError(f"Only {row['stock']} of {row['name']} remain in stock.")
                total += row['price'] * qty
                locked.append((row, qty))
            order = con.execute(
                "INSERT INTO orders(buyer_id,total,status,shipping_name,shipping_phone,shipping_address,shipping_city,shipping_state,expires_at) "
                "VALUES(%s,%s,'Awaiting payment',%s,%s,%s,%s,%s, NOW() + %s::int * INTERVAL '1 minute') RETURNING id",
                (g.user['id'], total, ship['name'], ship['phone'], ship['address'], ship['city'], ship['state'], ORDER_HOLD_MINUTES)).fetchone()
            reference = f"SMP-{order['id']}-{secrets.token_hex(6)}"
            con.execute('UPDATE orders SET payment_reference=%s WHERE id=%s', (reference, order['id']))
            for row, qty in locked:
                con.execute('INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price) VALUES(%s,%s,%s,%s,%s)',
                            (order['id'], row['id'], row['name'], qty, row['price']))
                con.execute('UPDATE products SET stock=stock-%s WHERE id=%s', (qty, row['id']))
    except CheckoutError as error:
        return jsonify(error=error.message), error.status
    except psycopg.Error:
        app.logger.exception('Checkout failed')
        return jsonify(error='We could not create the order. Please try again.'), 500
    try:
        url = paystack_initialize(order['id'], reference, g.user['email'], total)
    except Exception:   # noqa: BLE001
        app.logger.exception('Paystack initialize failed')
        with db() as con:
            cancel_unpaid_order(con, order['id'], 'Cancelled')
        return jsonify(error='We could not reach the payment provider. Your cart is unchanged, please try again.'), 502
    return jsonify(message=f"Order #{order['id']} created. Redirecting to payment…", order_id=order['id'], total=float(total), authorization_url=url)


# Purpose: shape an order row and its items for the frontend.
def order_dict(order, items):
    d = dict(order)
    d['total'] = float(d['total'])
    for key in ('created_at', 'paid_at', 'expires_at'):
        d[key] = iso(d.get(key))
    d.pop('buyer_id', None)
    d['items'] = [{**dict(i), 'unit_price': float(i['unit_price'])} for i in items]
    return d


@app.get('/api/orders')
@require_role('buyer')
def my_orders():
    release_expired_orders()
    with db() as con:
        orders = con.execute('SELECT * FROM orders WHERE buyer_id=%s ORDER BY id DESC LIMIT 50', (g.user['id'],)).fetchall()
        items = con.execute("""SELECT oi.id, oi.order_id, oi.product_id, oi.product_name AS name, oi.quantity, oi.unit_price,
            oi.fulfilment_status, p.image, u.store_name FROM order_items oi JOIN products p ON p.id=oi.product_id
            JOIN users u ON u.id=p.trader_id WHERE oi.order_id = ANY(%s) ORDER BY oi.id""", ([o['id'] for o in orders],)).fetchall()
    by_order = defaultdict(list)
    for item in items:
        by_order[item['order_id']].append(item)
    return jsonify([order_dict(o, by_order[o['id']]) for o in orders])


# Purpose: after the buyer returns from Paystack, confirm the payment with Paystack and update the order.
@app.post('/api/orders/verify')
@require_role('buyer')
def verify_order():
    reference = str((request.get_json(silent=True) or {}).get('reference', '')).strip()
    match = ORDER_REF_RE.match(reference)
    if not match or not PAYSTACK_SECRET_KEY:
        return jsonify(error='That payment reference is not valid.'), 400
    order_id = int(match.group(1))
    with db() as con:
        order = con.execute('SELECT id,status FROM orders WHERE id=%s AND buyer_id=%s', (order_id, g.user['id'])).fetchone()
    if not order:
        return jsonify(error='Order not found.'), 404
    try:
        data = paystack_verify(reference)
    except Exception:   # noqa: BLE001
        app.logger.exception('Paystack verify failed')
        return jsonify(error='We could not reach the payment provider. Please check your orders again in a minute.'), 502
    if not data or data.get('status') != 'success':
        return jsonify(order_id=order_id, paid=False, status=order['status'],
                       message='Payment was not completed. You can pay again from My orders before the order expires.')
    status = settle_payment(order_id, reference, int(data.get('amount', 0)), data.get('currency'))
    paid = status == 'Paid'
    message = {'Paid': 'Payment received. Thank you! The trader has been notified.',
               'Refund needed': 'Your payment arrived after the order expired and the items sold out. We will refund you.'}.get(
        status, 'We received your payment but could not confirm it yet. Please contact support.')
    return jsonify(order_id=order_id, paid=paid, status=status, message=message)


# Purpose: let a buyer retry payment for an unpaid order that has not expired yet.
@app.post('/api/orders/<int:order_id>/pay')
@require_role('buyer')
def pay_order(order_id):
    if not PAYSTACK_SECRET_KEY:
        return jsonify(error='Online payment is not set up yet.'), 503
    reference = f'SMP-{order_id}-{secrets.token_hex(6)}'
    with db() as con:
        order = con.execute('SELECT id,total,status,expires_at FROM orders WHERE id=%s AND buyer_id=%s FOR UPDATE', (order_id, g.user['id'])).fetchone()
        if not order:
            return jsonify(error='Order not found.'), 404
        if order['status'] != 'Awaiting payment' or (order['expires_at'] and order['expires_at'] < datetime.now(order['expires_at'].tzinfo)):
            return jsonify(error='This order can no longer be paid. Please place a new order.'), 409
        con.execute('UPDATE orders SET payment_reference=%s WHERE id=%s', (reference, order_id))
    try:
        url = paystack_initialize(order_id, reference, g.user['email'], order['total'])
    except Exception:   # noqa: BLE001
        app.logger.exception('Paystack initialize failed')
        return jsonify(error='We could not reach the payment provider. Please try again.'), 502
    return jsonify(authorization_url=url)


@app.post('/api/orders/<int:order_id>/cancel')
@require_role('buyer')
def cancel_order(order_id):
    with db() as con:
        order = con.execute('SELECT id,status FROM orders WHERE id=%s AND buyer_id=%s FOR UPDATE', (order_id, g.user['id'])).fetchone()
        if not order:
            return jsonify(error='Order not found.'), 404
        if not cancel_unpaid_order(con, order_id, 'Cancelled'):
            return jsonify(error='Only unpaid orders can be cancelled here. For a paid order, please contact the trader.'), 409
    return jsonify(message='Order cancelled and the items were returned to stock.')


# Purpose: Paystack calls this server-to-server when a payment succeeds, even if the buyer closed their browser.
@app.post('/api/paystack/webhook')
def paystack_webhook():
    if not PAYSTACK_SECRET_KEY:
        return '', 503
    raw = request.get_data()
    expected = hmac.new(PAYSTACK_SECRET_KEY.encode(), raw, hashlib.sha512).hexdigest()
    if not hmac.compare_digest(request.headers.get('x-paystack-signature', '').encode(), expected.encode()):
        return '', 401
    try:
        event = json.loads(raw or b'{}')   # parse the exact bytes that were signed
        if not isinstance(event, dict):
            return '', 200
        if event.get('event') == 'charge.success':
            data = event.get('data') or {}
            reference = str(data.get('reference', ''))
            match = ORDER_REF_RE.match(reference)
            if match:
                settle_payment(int(match.group(1)), reference, int(data.get('amount', 0)), data.get('currency'))
    except Exception:   # noqa: BLE001
        app.logger.exception('Webhook processing failed')
        return '', 500   # Paystack will retry
    return '', 200


# ---------------------------------------------------------------------------
# Trader tools
# ---------------------------------------------------------------------------
@app.get('/api/trader/products')
@require_role('trader')
def trader_products():
    with db() as con:
        rows = con.execute('SELECT * FROM products WHERE trader_id=%s AND is_active ORDER BY id DESC', (g.user['id'],)).fetchall()
    return jsonify([product_dict(r) for r in rows])


# Purpose: validate product fields shared by "add" and "edit". Returns (clean_fields, error_message).
def clean_product_fields(data, partial):
    fields = {}
    if 'name' in data or not partial:
        fields['name'] = str(data.get('name', '')).strip()
        if not 1 <= len(fields['name']) <= 120:
            return None, 'Enter a product name of up to 120 characters.'
    if 'description' in data or not partial:
        fields['description'] = str(data.get('description', '')).strip()
        if len(fields['description']) > 1000:
            return None, 'The description is too long (maximum 1000 characters).'
    if 'category' in data or not partial:
        fields['category'] = str(data.get('category', 'unisex')).lower()
        if fields['category'] not in CATEGORIES:
            return None, 'Choose a valid product category.'
    if 'image' in data or not partial:
        fields['image'] = str(data.get('image', '')).strip()
        if fields['image'] and (not fields['image'].startswith('https://') or len(fields['image']) > 500):
            return None, 'The image must be an https:// link or an uploaded file.'
    if 'price' in data or not partial:
        try:
            fields['price'] = Decimal(str(data.get('price')))
        except Exception:   # noqa: BLE001
            return None, 'Enter a valid price.'
        if not fields['price'].is_finite() or fields['price'] < 0 or fields['price'] > Decimal('999999999.99'):
            return None, 'Enter a valid price.'
        fields['price'] = fields['price'].quantize(Decimal('0.01'))
    if 'stock' in data or not partial:
        try:
            fields['stock'] = int(data.get('stock'))
        except (TypeError, ValueError):
            return None, 'Stock must be a whole number.'
        if fields['stock'] < 0 or fields['stock'] > 1000000:
            return None, 'Stock must be between 0 and 1,000,000.'
    return fields, None


# Purpose: add a product with its exact stock quantity entered by the trader.
@app.post('/api/trader/products')
@require_role('trader')
def create_product():
    fields, error = clean_product_fields(request.get_json(silent=True) or {}, partial=False)
    if error:
        return jsonify(error=error), 400
    with db() as con:
        row = con.execute('INSERT INTO products(trader_id,name,price,category,description,image,stock) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                          (g.user['id'], fields['name'], fields['price'], fields['category'], fields['description'], fields['image'], fields['stock'])).fetchone()
    row['store_name'], row['trader_username'] = g.user['store_name'], g.user['username']
    return jsonify(message=f"Product added with {fields['stock']} item(s) in stock.", product=product_dict(row))


# Purpose: edit a trader's own product, including the available stock count.
@app.patch('/api/trader/products/<int:product_id>')
@require_role('trader')
def update_product(product_id):
    data = request.get_json(silent=True) or {}
    data = {k: data[k] for k in ('name', 'price', 'category', 'description', 'image', 'stock') if k in data}
    if not data:
        return jsonify(error='No product changes were provided.'), 400
    fields, error = clean_product_fields(data, partial=True)
    if error:
        return jsonify(error=error), 400
    with db() as con:
        row = con.execute('UPDATE products SET ' + ', '.join(f'{k}=%s' for k in fields) + ' WHERE id=%s AND trader_id=%s AND is_active RETURNING *',
                          (*fields.values(), product_id, g.user['id'])).fetchone()
    if not row:
        return jsonify(error='Product not found in your shop.'), 404
    row['store_name'], row['trader_username'] = g.user['store_name'], g.user['username']
    return jsonify(message='Product updated.', product=product_dict(row))


# Purpose: delete a product. If it already appears in orders it is hidden instead, so order history stays intact.
@app.delete('/api/trader/products/<int:product_id>')
@require_role('trader')
def delete_product(product_id):
    def hide():
        with db() as con:
            return con.execute('UPDATE products SET is_active=FALSE, stock=0 WHERE id=%s AND trader_id=%s AND is_active RETURNING id', (product_id, g.user['id'])).fetchone()
    with db() as con:
        has_orders = con.execute('SELECT 1 FROM order_items WHERE product_id=%s LIMIT 1', (product_id,)).fetchone()
    if has_orders:
        found = hide()
        message = 'This product has past orders, so it was hidden from your shop instead of deleted.'
    else:
        try:
            with db() as con:
                found = con.execute('DELETE FROM products WHERE id=%s AND trader_id=%s RETURNING id', (product_id, g.user['id'])).fetchone()
            message = 'Product removed from your shop.'
        except psycopg.errors.ForeignKeyViolation:   # an order was placed a moment ago
            found = hide()
            message = 'This product has past orders, so it was hidden from your shop instead of deleted.'
    if not found:
        return jsonify(error='Product not found in your shop.'), 404
    return jsonify(message=message)


# Purpose: paid order lines for this trader's products, with the delivery details needed to ship them.
@app.get('/api/trader/orders')
@require_role('trader')
def trader_orders():
    with db() as con:
        rows = con.execute("""SELECT oi.id AS item_id, oi.order_id, oi.product_name, oi.quantity, oi.unit_price, oi.fulfilment_status,
            o.paid_at, o.shipping_name, o.shipping_phone, o.shipping_address, o.shipping_city, o.shipping_state
            FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
            WHERE p.trader_id=%s AND o.status='Paid' ORDER BY o.paid_at DESC, oi.id DESC LIMIT 200""", (g.user['id'],)).fetchall()
    lines = [{**dict(r), 'unit_price': float(r['unit_price']), 'paid_at': iso(r['paid_at'])} for r in rows]
    return jsonify(orders=lines, total_sales=float(sum(Decimal(str(l['unit_price'])) * l['quantity'] for l in lines)))


@app.patch('/api/trader/order-items/<int:item_id>')
@require_role('trader')
def update_order_item(item_id):
    status = str((request.get_json(silent=True) or {}).get('fulfilment_status', ''))
    if status not in {'Processing', 'Shipped', 'Delivered'}:
        return jsonify(error='Choose Processing, Shipped or Delivered.'), 400
    with db() as con:
        row = con.execute("""UPDATE order_items oi SET fulfilment_status=%s FROM orders o, products p
            WHERE oi.id=%s AND o.id=oi.order_id AND p.id=oi.product_id AND p.trader_id=%s AND o.status='Paid' RETURNING oi.id""",
                          (status, item_id, g.user['id'])).fetchone()
    if not row:
        return jsonify(error='Order line not found.'), 404
    return jsonify(message=f'Marked as {status.lower()}.')


# ---------------------------------------------------------------------------
# Error handling: always answer the frontend with JSON
# ---------------------------------------------------------------------------
@app.errorhandler(413)
def too_large(_error):
    return jsonify(error='The image is too large. Maximum size is 5MB.'), 413


@app.errorhandler(404)
def not_found(_error):
    return jsonify(error='Not found.'), 404


@app.errorhandler(405)
def method_not_allowed(_error):
    return jsonify(error='That action is not allowed.'), 405


@app.errorhandler(psycopg.OperationalError)
def database_unavailable(_error):
    app.logger.exception('Database unavailable')
    return jsonify(error='The database is waking up. Please try again in a few seconds.'), 503


@app.errorhandler(Exception)
def unexpected_error(error):
    from werkzeug.exceptions import HTTPException
    if isinstance(error, HTTPException):
        return jsonify(error=error.description), error.code
    app.logger.exception('Unhandled error')
    return jsonify(error='Something went wrong on our side. Please try again.'), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=DEBUG)
