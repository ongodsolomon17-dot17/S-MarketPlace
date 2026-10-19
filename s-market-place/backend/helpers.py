"""Small shared helpers: formatting, search text, money, and a simple rate limiter."""
import time
from collections import defaultdict, deque
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP

from flask import request


# ----------------------------------------------------------------------------- formatting
def iso(value):
    """Datetime -> text for JSON (other values pass through unchanged)."""
    return value.isoformat() if isinstance(value, datetime) else value


def discount_percent(original_price, price):
    """Whole-number percent taken off, e.g. 200000 -> 140000 gives 30. None when there is no price slash."""
    if original_price is None:
        return None
    original, current = Decimal(str(original_price)), Decimal(str(price))
    if original <= 0 or current >= original:
        return None
    return int(((original - current) / original * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def product_dict(row):
    """A product row shaped for the frontend (numbers and dates made JSON-friendly).

    This is the FULL view, with the exact stock. Use it only for the trader who owns the product.
    """
    product = dict(row)
    product['discount_percent'] = discount_percent(product.get('original_price'), product['price'])
    product['price'] = float(product['price'])
    if product.get('original_price') is not None:
        product['original_price'] = float(product['original_price'])
    product['available'] = int(product['stock']) > 0
    for key in ('created_at', 'deleted_at', 'purged_at'):
        product[key] = iso(product.get(key))
    return product


def public_product_dict(row):
    """The version shoppers get. If the trader chose to show only \"In stock\", the exact quantity is hidden."""
    product = product_dict(row)
    if not product.get('show_quantity', True):
        product['stock'] = None
    for private in ('is_paused', 'deleted_at', 'purged_at'):     # the trader's own bookkeeping, not for shoppers
        product.pop(private, None)
    return product


def to_kobo(amount):
    """Naira amount -> kobo (Paystack works in kobo: 100 kobo = 1 naira)."""
    return int((Decimal(amount) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


# ----------------------------------------------------------------------------- search text
def like_term(text):
    """Escape % and _ so a search is matched literally by ILIKE instead of acting as a wildcard."""
    return '%' + text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


def search_tokens(text, limit=5):
    """Split a search box entry into at most `limit` words ("red summer dress" -> 3 words)."""
    return [word for word in text.split() if word][:limit]


def int_arg(name, default, low, high):
    """Read an integer query parameter, falling back to `default` and clamping into [low, high]."""
    try:
        value = int(request.args.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


# ----------------------------------------------------------------------------- rate limiting
_hits = defaultdict(deque)
TOO_MANY_MESSAGE = 'Too many attempts. Please wait a few minutes and try again.'


def too_many_requests(bucket, limit, window_seconds):
    """True when this IP made more than `limit` calls to `bucket` in the last `window_seconds`.

    The counters live in memory, so they reset when the server restarts.
    """
    now = time.monotonic()
    if len(_hits) > 5000:   # forget old visitors so memory cannot grow forever
        for key in [k for k, q in _hits.items() if not q or now - q[-1] > 3600]:
            del _hits[key]
    queue = _hits[(bucket, request.remote_addr)]
    while queue and now - queue[0] > window_seconds:
        queue.popleft()
    if len(queue) >= limit:
        return True
    queue.append(now)
    return False
