"""Settings for the S-Market Place API.

Every secret and deployment-specific value comes from an environment variable
(set in the Render dashboard), never from the code. See `.env.example`.
"""
import os
from cryptography.fernet import Fernet
from decimal import Decimal

# ----------------------------------------------------------------- run mode
# FLASK_DEBUG=1 relaxes the strict start-up checks below. Use it on your own computer only.
DEBUG = os.environ.get('FLASK_DEBUG') == '1'

# ----------------------------------------------------------------- database (Neon)
DATABASE_URL = os.environ.get('DATABASE_URL')
DB_SSLMODE = os.environ.get('DB_SSLMODE', 'require')   # Neon requires SSL; local testing sets "disable"

# ----------------------------------------------------------------- payments (Paystack)
PAYSTACK_SECRET_KEY = os.environ.get('PAYSTACK_SECRET_KEY', '')
ORDER_HOLD_MINUTES = int(os.environ.get('ORDER_HOLD_MINUTES', '30'))   # how long an unpaid order keeps its stock

#----------------------------------------------------------------- email (Resend)-----------------
RESEND_API_KEY = os.environ.get('RESEND_API_KEY', '')
RESEND_FROM_EMAIL = os.environ.get('RESEND_FROM_EMAIL', '')
# ----------------------------------------------------------------- escrow and payouts
# The share of each sale that S-Market Place keeps. 0 = no commission. Fixed at the moment a payment is received.
COMMISSION_PERCENT = Decimal(os.environ.get('COMMISSION_PERCENT', '0'))
if not Decimal('0') <= COMMISSION_PERCENT <= Decimal('50'):
    raise RuntimeError('COMMISSION_PERCENT must be between 0 and 50.')
# If a buyer never confirms delivery, release the money N days after the trader marks the item Delivered.
# 0 (the default) switches this off: money is then released only by the buyer's confirmation or by the admin.
AUTO_RELEASE_DAYS = int(os.environ.get('AUTO_RELEASE_DAYS', '0'))
MIN_PAYOUT = Decimal(os.environ.get('MIN_PAYOUT', '1000'))       # the smallest payout a trader can request (naira)
# The admin (you) is identified by account id, NOT by email, because anyone can type any email at sign-up.
ADMIN_USER_IDS = {int(x) for x in os.environ.get('ADMIN_USER_IDS', '').split(',') if x.strip().isdigit()}

# ----------------------------------------------------------------- login tokens
TOKEN_MAX_AGE = 60 * 60 * 24 * 14   # a login lasts 14 days

# Encrypts authenticator-app secrets stored in the database.
MFA_ENCRYPTION_KEY = os.environ.get('MFA_ENCRYPTION_KEY', '')
if MFA_ENCRYPTION_KEY:
    try:
        Fernet(MFA_ENCRYPTION_KEY.encode())
    except (TypeError, ValueError) as error:
        raise RuntimeError('MFA_ENCRYPTION_KEY must be a valid Fernet key.') from error
elif not DEBUG:
    raise RuntimeError('MFA_ENCRYPTION_KEY must be set in production.')

SECRET_KEY = os.environ.get('SECRET_KEY', '')
if len(SECRET_KEY) < 32:
    if DEBUG:
        SECRET_KEY = SECRET_KEY or 'local-development-only-secret-do-not-deploy'
    else:
        # Refuse to start rather than run with a guessable key that would let anyone forge logins.
        raise RuntimeError('SECRET_KEY must be set to a random string of at least 32 characters.')

# ----------------------------------------------------------------- CORS (which website may call this API)
ORIGINS = [o.strip().rstrip('/') for o in os.environ.get('FRONTEND_ORIGIN', '').split(',') if o.strip()]
if not ORIGINS:
    if DEBUG:
        ORIGINS = ['http://localhost:8000', 'http://127.0.0.1:8000']
    else:
        raise RuntimeError('FRONTEND_ORIGIN must be set to your Vercel site URL, e.g. https://your-site.vercel.app')
if '*' in ORIGINS and not DEBUG:
    raise RuntimeError('FRONTEND_ORIGIN must list exact site URLs, not *.')

# Paystack sends the buyer back to this address after paying; it appends ?reference=...
PAYMENT_RETURN_URL = ORIGINS[0] + '/'

# ----------------------------------------------------------------- shared constants
ROLES = {'buyer', 'trader'}
ORDER_REF_PATTERN = r'^SMP-(\d+)-[0-9a-f]{12}$'   # payment references look like SMP-<order id>-<random>

# Categories every new marketplace starts with. Traders can still type a new one when theirs is missing.
DEFAULT_CATEGORIES = [
    'Fashion & Clothing', 'Shoes & Bags', 'Jewelry & Accessories', 'Phones & Tablets',
    'Electronics & Gadgets', 'Computers & Accessories', 'Beauty & Personal Care',
    'Perfumes & Fragrances', 'Home & Kitchen', 'Furniture & Decor', 'Groceries & Food',
    'Health & Wellness', 'Baby & Kids', 'Sports & Fitness', 'Books & Stationery',
    'Art & Crafts', 'Automotive & Parts', 'Gifts & Occasions', 'General',
]
