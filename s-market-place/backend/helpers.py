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


def product_dict(row):
    """A product row shaped for the frontend (numbers and dates made JSON-friendly)."""
    product = dict(row)
    product['price'] = float(product['price'])
    product['available'] = int(product['stock']) > 0
    product['created_at'] = iso(product.get('created_at'))
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
