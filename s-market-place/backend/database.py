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

    # ---- Fast Finger: time-limited price-slash deals posted by traders ----------------------------
    # status is worked out when read: 'sold' (trader marked it), 'ended' (countdown reached zero) or 'live'.
    # Finished deals are deleted by the system 24 hours after they ended or were marked sold.
    """CREATE TABLE IF NOT EXISTS flash_deals (
        id BIGSERIAL PRIMARY KEY,
        trader_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(120) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        image TEXT NOT NULL DEFAULT '',
        original_price NUMERIC(12,2) NOT NULL CHECK(original_price > 0),
        price NUMERIC(12,2) NOT NULL CHECK(price >= 0),
        ends_at TIMESTAMPTZ NOT NULL,
        sold_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",

    # ---- pictures waiting to be deleted from Cloudinary (see image_service.py) --------------------
    """CREATE TABLE IF NOT EXISTS image_cleanup (
        id BIGSERIAL PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        public_id VARCHAR(200) NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",

    # ---- escrow: traders' bank details, payout requests, disputes and notifications ---------------
    """CREATE TABLE IF NOT EXISTS payout_accounts (
        trader_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        bank_code VARCHAR(20) NOT NULL, bank_name VARCHAR(120) NOT NULL,
        account_number VARCHAR(20) NOT NULL, account_name VARCHAR(160) NOT NULL,
        verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS payouts (
        id BIGSERIAL PRIMARY KEY,
        trader_id BIGINT NOT NULL REFERENCES users(id),
        amount NUMERIC(12,2) NOT NULL CHECK(amount > 0),
        status VARCHAR(12) NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','paid','rejected')),
        bank_name VARCHAR(120) NOT NULL, account_number VARCHAR(20) NOT NULL, account_name VARCHAR(160) NOT NULL,  -- copied at request time
        reference VARCHAR(120) NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ)""",
    """CREATE TABLE IF NOT EXISTS disputes (
        id BIGSERIAL PRIMARY KEY,
        order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
        buyer_id BIGINT NOT NULL REFERENCES users(id),
        reason_type VARCHAR(24) NOT NULL, details TEXT NOT NULL,
        photo1 TEXT NOT NULL DEFAULT '', photo2 TEXT NOT NULL DEFAULT '',
        status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK(status IN ('open','released','refunded')),
        admin_note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ)""",
    """CREATE TABLE IF NOT EXISTS notifications (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(160) NOT NULL, body TEXT NOT NULL DEFAULT '', link VARCHAR(60) NOT NULL DEFAULT '',
        read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",

    # ---- upgrades for databases created by earlier versions --------------------------------------
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS original_price NUMERIC(12,2)",            # the "was" price (price slash)
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS show_quantity BOOLEAN NOT NULL DEFAULT TRUE",  # show "5 left" or just "In stock"
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS is_paused BOOLEAN NOT NULL DEFAULT FALSE",      # trader paused it (can resume)
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ",                         # trader deleted it (30 days to restore)
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ",                          # set when only an empty shell is left
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
    # Products hidden by the older "delete" (is_active false, not paused) start their 30 days now.
    # This must come AFTER the is_active / is_paused / deleted_at columns above exist.
    "UPDATE products SET deleted_at = NOW() WHERE NOT is_active AND NOT is_paused AND deleted_at IS NULL",

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
    # Fast Finger deals can be bought: they have a quantity, and an order line can point at a deal instead of a product.
    "ALTER TABLE flash_deals ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0)",
    # sold_by_trader: TRUE when the trader pressed "Mark as sold"; FALSE when it sold out by itself.
    # (Pre-existing deals can only have been marked by the trader, hence the one-time DEFAULT TRUE below.)
    "ALTER TABLE flash_deals ADD COLUMN IF NOT EXISTS sold_by_trader BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE flash_deals ALTER COLUMN sold_by_trader SET DEFAULT FALSE",
    "ALTER TABLE order_items ALTER COLUMN product_id DROP NOT NULL",
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS deal_id BIGINT REFERENCES flash_deals(id) ON DELETE SET NULL",
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS trader_id BIGINT",     # who sells this line (works for products AND deals)
    "UPDATE order_items oi SET trader_id = p.trader_id FROM products p WHERE oi.product_id = p.id AND oi.trader_id IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_order_items_trader ON order_items(trader_id)",
    "CREATE INDEX IF NOT EXISTS idx_order_items_deal ON order_items(deal_id)",
    # Escrow: where each order line's money is. unpaid -> held -> released (to the trader) | disputed -> released/refunded
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS escrow_status VARCHAR(12) NOT NULL DEFAULT 'unpaid'",
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS commission NUMERIC(12,2) NOT NULL DEFAULT 0",     # what the marketplace keeps
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS seller_amount NUMERIC(12,2) NOT NULL DEFAULT 0",  # what the trader receives
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS delivery_code VARCHAR(24)",                       # the one-time code inside the QR
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS code_scanned_at TIMESTAMPTZ",
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ",
    "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ",
    # Lines that were already paid before escrow existed are treated as held (no commission was taken on them).
    "UPDATE order_items oi SET escrow_status='held', seller_amount = oi.quantity * oi.unit_price "
    "FROM orders o WHERE o.id = oi.order_id AND o.status = 'Paid' AND oi.escrow_status = 'unpaid'",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_code ON order_items(delivery_code) WHERE delivery_code IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_order_items_escrow ON order_items(trader_id, escrow_status)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_one_open ON disputes(order_item_id) WHERE status = 'open'",
    "CREATE INDEX IF NOT EXISTS idx_payouts_trader ON payouts(trader_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_products_deleted ON products(deleted_at) WHERE deleted_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_flash_deals_trader ON flash_deals(trader_id)",
    "CREATE INDEX IF NOT EXISTS idx_flash_deals_ends ON flash_deals(ends_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username))",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email))",
        # ---- trader subscriptions --------------------------------------------------------------------
    """CREATE TABLE IF NOT EXISTS trader_subscriptions (
        id BIGSERIAL PRIMARY KEY,
        trader_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(12) NOT NULL DEFAULT 'trial'
            CHECK(status IN ('trial','active','expired','cancelled')),
        plan VARCHAR(10)
            CHECK(plan IS NULL OR plan IN ('monthly','yearly')),
        trial_starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
        current_period_starts_at TIMESTAMPTZ,
        current_period_ends_at TIMESTAMPTZ,
        auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
        paystack_customer_code VARCHAR(100),
        paystack_subscription_code VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    "ALTER TABLE trader_subscriptions "
    "ADD COLUMN IF NOT EXISTS paystack_subscription_email_token_encrypted TEXT",
    "CREATE INDEX IF NOT EXISTS idx_trader_subscriptions_status_expiry "
    "ON trader_subscriptions(status, trial_ends_at, current_period_ends_at)",
   
    """INSERT INTO trader_subscriptions(trader_id)
        SELECT id FROM users WHERE role='trader'
        ON CONFLICT (trader_id) DO NOTHING""",  
        """CREATE TABLE IF NOT EXISTS trader_subscription_notice_log (
        id BIGSERIAL PRIMARY KEY,
        trader_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        period_end_at TIMESTAMPTZ NOT NULL,
        notice_type VARCHAR(12) NOT NULL
            CHECK(notice_type IN ('five_day', 'expired')),
        in_app_sent_at TIMESTAMPTZ,
        email_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(trader_id, period_end_at, notice_type))""",

    """CREATE TABLE IF NOT EXISTS trader_subscription_plans (
        plan VARCHAR(10) PRIMARY KEY CHECK(plan IN ('monthly','yearly')),
        price_ngn INTEGER NOT NULL CHECK(price_ngn > 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",

    "ALTER TABLE trader_subscription_plans "
    "ADD COLUMN IF NOT EXISTS paystack_plan_code VARCHAR(100)",

    """INSERT INTO trader_subscription_plans(plan, price_ngn)
       VALUES ('monthly', 3500), ('yearly', 37800)
       ON CONFLICT (plan) DO NOTHING""",

    """CREATE TABLE IF NOT EXISTS trader_subscription_payments (
        id BIGSERIAL PRIMARY KEY,
        trader_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        plan VARCHAR(10) NOT NULL CHECK(plan IN ('monthly', 'yearly')),
        amount_ngn INTEGER NOT NULL CHECK(amount_ngn > 0),
        auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
        reference VARCHAR(120) NOT NULL UNIQUE,
        paystack_plan_code VARCHAR(100),
        paystack_subscription_code VARCHAR(100),
        paystack_transaction_id VARCHAR(40),
        status VARCHAR(12) NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'paid', 'failed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    "CREATE INDEX IF NOT EXISTS idx_trader_subscription_payments_trader "
    "ON trader_subscription_payments(trader_id, created_at DESC)",
    # ---- admin tools: audit log, MFA and recovery codes --------------------------------------------
    """CREATE TABLE IF NOT EXISTS admin_audit_log (
        id BIGSERIAL PRIMARY KEY,
        admin_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        action VARCHAR(80) NOT NULL,
        target_type VARCHAR(80) NOT NULL,
        target_id BIGINT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    "CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created "
    "ON admin_audit_log(created_at DESC)",   
    
     """CREATE TABLE IF NOT EXISTS admin_mfa (
        admin_user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
        secret_encrypted TEXT,
        pending_secret_encrypted TEXT,
        pending_secret_expires_at TIMESTAMPTZ,
        enabled_at TIMESTAMPTZ,
        last_used_step BIGINT NOT NULL DEFAULT -1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",

    """CREATE TABLE IF NOT EXISTS admin_mfa_recovery_codes (
        id BIGSERIAL PRIMARY KEY,
        admin_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        code_hash CHAR(64) NOT NULL UNIQUE,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    "CREATE INDEX IF NOT EXISTS idx_admin_mfa_recovery_available "
    "ON admin_mfa_recovery_codes(admin_user_id) WHERE used_at IS NULL",          

    # ---- trader community: verified badge, followers and buyer ratings ----------------------------
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE",   # set only by the superadmin
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ",
    """CREATE TABLE IF NOT EXISTS follows (
        follower_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        trader_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (follower_id, trader_id),
        CHECK (follower_id <> trader_id))""",
    "CREATE INDEX IF NOT EXISTS idx_follows_trader ON follows(trader_id)",
    # One rating per delivered order line. A buyer can only rate after confirming they received the item.
    """CREATE TABLE IF NOT EXISTS trader_ratings (
        id BIGSERIAL PRIMARY KEY,
        order_item_id BIGINT NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE CASCADE,
        buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        trader_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
        comment TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    "CREATE INDEX IF NOT EXISTS idx_trader_ratings_trader ON trader_ratings(trader_id, id DESC)",
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
