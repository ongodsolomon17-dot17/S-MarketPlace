"""Database access: connecting to Neon PostgreSQL and creating/upgrading the tables."""
import psycopg
from psycopg.rows import dict_row

import config
from categories import category_match_key


def db():
    """Open a connection to Neon. Use as `with db() as con:` - it commits on success and rolls back on error."""
    if not config.DATABASE_URL:
        raise RuntimeError('DATABASE_URL is missing. Add your Neon connection string to the Render environment variables.')
    return psycopg.connect(config.DATABASE_URL, row_factory=dict_row, connect_timeout=10, sslmode=config.DB_SSLMODE)


# Each statement is safe to run on every start-up (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS),
# so the same list both creates a fresh database and upgrades an older one without losing data.
SCHEMA = [
    # ---- people ----------------------------------------------------------------------------------
    """CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        role VARCHAR(10) NOT NULL CHECK(role IN ('buyer','trader')),
        first_name VARCHAR(80) NOT NULL, last_name VARCHAR(80) NOT NULL,
        username VARCHAR(30) NOT NULL UNIQUE, email VARCHAR(255) NOT NULL UNIQUE,
        phone VARCHAR(40) NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
        store_name VARCHAR(120) NOT NULL DEFAULT '', store_description TEXT NOT NULL DEFAULT '',
        profile_image TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",

    # ---- categories (chosen from a list, or typed in by traders) ---------------------------------
    """CREATE TABLE IF NOT EXISTS categories (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(60) NOT NULL,
        match_key VARCHAR(60) NOT NULL UNIQUE,          -- lets "shoe" and "Shoes" count as the same category
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",

    # ---- products --------------------------------------------------------------------------------
    """CREATE TABLE IF NOT EXISTS products (
        id BIGSERIAL PRIMARY KEY,
        trader_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL, price NUMERIC(12,2) NOT NULL CHECK(price >= 0),
        category VARCHAR(60) NOT NULL DEFAULT 'General',
        description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
        stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",

    # ---- orders ----------------------------------------------------------------------------------
    """CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY, buyer_id BIGINT NOT NULL REFERENCES users(id),
        total NUMERIC(12,2) NOT NULL, status VARCHAR(40) NOT NULL DEFAULT 'Awaiting payment',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS order_items (
        id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id BIGINT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity > 0),
        unit_price NUMERIC(12,2) NOT NULL)""",

    # ---- what people look at: powers the personalised "For you" feed ------------------------------
    """CREATE TABLE IF NOT EXISTS interactions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,        -- set when the person is signed in
        visitor_id VARCHAR(64) NOT NULL DEFAULT '',                    -- random id the browser keeps for guests
        product_id BIGINT REFERENCES products(id) ON DELETE CASCADE,
        trader_id BIGINT,
        category VARCHAR(60) NOT NULL DEFAULT '',
        kind VARCHAR(12) NOT NULL CHECK(kind IN ('view','cart','purchase','category')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",

    # ---- upgrades for databases created by earlier versions --------------------------------------
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_check",         # categories are no longer a fixed list
    "ALTER TABLE products ALTER COLUMN category TYPE VARCHAR(60)",
    "ALTER TABLE products ALTER COLUMN category SET DEFAULT 'General'",
    "UPDATE products SET category='Perfumes & Fragrances' WHERE category IN ('men','women','gift','unisex')",
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

    # ---- indexes (make the common lookups fast) --------------------------------------------------
    "CREATE INDEX IF NOT EXISTS idx_products_trader ON products(trader_id)",
    "CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)",
    "CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id)",
    "CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status, expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)",
    "CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id)",
    "CREATE INDEX IF NOT EXISTS idx_interactions_user ON interactions(user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_interactions_visitor ON interactions(visitor_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_interactions_product ON interactions(product_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username))",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email))",
]

_schema_ready = False


def initialize_database():
    """Create the tables and add the starter categories, without touching existing records."""
    with db() as con:
        con.execute('SELECT pg_advisory_xact_lock(727274)')      # stops two workers building tables at the same time
        for statement in SCHEMA:
            con.execute(statement)
        for name in config.DEFAULT_CATEGORIES:
            con.execute('INSERT INTO categories(name, match_key) VALUES(%s,%s) ON CONFLICT (match_key) DO NOTHING',
                        (name, category_match_key(name)))


def ensure_schema():
    """Make sure the tables exist before serving requests (retries if Neon was asleep at start-up)."""
    global _schema_ready
    if _schema_ready or not config.DATABASE_URL:
        return
    initialize_database()
    _schema_ready = True
