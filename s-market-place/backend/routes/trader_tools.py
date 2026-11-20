"""Trader tools used by the newer trader screens.

* Security PIN      a 4-digit PIN that protects sensitive changes (payout requests, bank details, password, chat link)
* Buyer chat link   the trader chooses the built-in chat or their own chat website (strictly validated)
* Weekly sales      this week (Monday-Sunday, Lagos time) plus the previous weeks
* Followers         who follows the trader, and which shops the trader follows
* Order messages    a short one-way note from the trader to the buyer of an order line

Every check the browser makes is repeated here: the browser is never trusted.
"""
import hashlib
import hmac
import ipaddress
import re
from datetime import date, datetime, timedelta, timezone
from math import ceil
from urllib.parse import urlsplit, urlunsplit

from flask import Blueprint, g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

import config
import escrow_service
from auth import require_role
from database import db
from helpers import TOO_MANY_MESSAGE, int_arg, iso, too_many_requests

bp = Blueprint('trader_tools', __name__)

# ============================================================================= Security PIN
PIN_PATTERN = re.compile(r'[0-9]{4}')
MAX_PIN_TRIES = 5            # wrong tries in a row before the PIN is locked
PIN_LOCK_MINUTES = 15


def _pin_secret(user_id, pin):
    """Mix the PIN with a server-only secret first, so a stolen database alone cannot be used to guess 4-digit PINs offline."""
    return hmac.new(config.PIN_PEPPER.encode(), f'{user_id}:{pin}'.encode(), hashlib.sha256).hexdigest()


def is_weak_pin(pin):
    """0000, 1111, 1234, 4321 ... are refused."""
    return len(set(pin)) == 1 or pin in '0123456789' or pin in '9876543210'


def check_pin(con, user_id, pin):
    """Use this inside `with db() as con:` before a sensitive change.

    Returns None when the change may go ahead (the trader has no PIN, or the PIN is right).
    Otherwise returns a ready-made error response: `err = check_pin(...)`, then `if err: return err`.
    Wrong tries are counted in the database and lock the PIN for a while, so they survive restarts.
    """
    row = con.execute('SELECT pin_hash, failed_attempts, locked_until FROM trader_pins WHERE trader_id=%s FOR UPDATE',
                      (user_id,)).fetchone()
    if not row:
        return None
    now = datetime.now(timezone.utc)
    if row['locked_until'] and row['locked_until'] > now:
        minutes = max(1, ceil((row['locked_until'] - now).total_seconds() / 60))
        return jsonify(error=f"Too many wrong PIN tries. Try again in {minutes} minute{'' if minutes == 1 else 's'}.",
                       pin_locked=True), 429
    pin = pin if isinstance(pin, str) else ''
    if not pin:
        return jsonify(error='Enter your PIN to continue.', pin_required=True), 403     # not a guess, so it is not counted
    if not PIN_PATTERN.fullmatch(pin) or not check_password_hash(row['pin_hash'], _pin_secret(user_id, pin)):
        tries = row['failed_attempts'] + 1
        if tries >= MAX_PIN_TRIES:
            con.execute('UPDATE trader_pins SET failed_attempts=0, locked_until=%s WHERE trader_id=%s',
                        (now + timedelta(minutes=PIN_LOCK_MINUTES), user_id))
            return jsonify(error=f'Too many wrong PIN tries. Try again in {PIN_LOCK_MINUTES} minutes.', pin_locked=True), 429
        con.execute('UPDATE trader_pins SET failed_attempts=%s WHERE trader_id=%s', (tries, user_id))
        return jsonify(error='Incorrect PIN. Please try again.', pin_required=True), 403
    if row['failed_attempts'] or row['locked_until']:
        con.execute('UPDATE trader_pins SET failed_attempts=0, locked_until=NULL WHERE trader_id=%s', (user_id,))
    return None


def _json_body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


@bp.get('/api/trader/pin')
@require_role('trader')
def pin_status():
    with db() as con:
        exists = con.execute('SELECT 1 FROM trader_pins WHERE trader_id=%s', (g.user['id'],)).fetchone() is not None
    return jsonify(has_pin=exists)


@bp.post('/api/trader/pin')
@require_role('trader')
def set_pin():
    """Set a PIN the first time, or change it (the current PIN is then required)."""
    if too_many_requests('pin-change', 15, 3600):
        return jsonify(error=TOO_MANY_MESSAGE), 429
    data = _json_body()
    new_pin = str(data.get('pin', ''))
    if not PIN_PATTERN.fullmatch(new_pin):
        return jsonify(error='A PIN must be exactly 4 digits.'), 400
    if is_weak_pin(new_pin):
        return jsonify(error='Choose a PIN that is harder to guess (not 1234, 1111 and so on).'), 400
    with db() as con:
        con.execute('SELECT id FROM users WHERE id=%s FOR UPDATE', (g.user['id'],))
        existing = con.execute('SELECT 1 FROM trader_pins WHERE trader_id=%s', (g.user['id'],)).fetchone()
        if existing:
            err = check_pin(con, g.user['id'], data.get('current_pin'))
            if err:
                return err
        con.execute(
            """INSERT INTO trader_pins(trader_id, pin_hash) VALUES(%s,%s)
               ON CONFLICT (trader_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash, failed_attempts=0, locked_until=NULL, updated_at=NOW()""",
            (g.user['id'], generate_password_hash(_pin_secret(g.user['id'], new_pin))))
        escrow_service.notify(con, g.user['id'], 'Security PIN ' + ('changed' if existing else 'set'),
                              'If this was not you, change your password now.', 'settings')
    return jsonify(message='PIN changed.' if existing else 'PIN saved. It will now protect sensitive changes.')


@bp.delete('/api/trader/pin')
@require_role('trader')
def remove_pin():
    with db() as con:
        con.execute('SELECT id FROM users WHERE id=%s FOR UPDATE', (g.user['id'],))
        err = check_pin(con, g.user['id'], _json_body().get('pin'))
        if err:
            return err
        con.execute('DELETE FROM trader_pins WHERE trader_id=%s', (g.user['id'],))
        escrow_service.notify(con, g.user['id'], 'Security PIN removed',
                              'If this was not you, change your password now.', 'settings')
    return jsonify(message='PIN removed.')


# ============================================================================= Buyer chat link
_BAD_URL_CHARS = re.compile(r'[\s<>"\'`\\\x00-\x1f\x7f]')


def validate_chat_url(raw):
    """Return (clean_url, None) for a safe public https link, or (None, 'what is wrong')."""
    text = str(raw or '').strip()
    if not text:
        return None, 'Paste your chat link first.'
    if len(text) > 300:
        return None, 'That link is too long (300 characters at most).'
    if _BAD_URL_CHARS.search(text):
        return None, 'Links cannot contain spaces or special characters.'
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        return None, 'That does not look like a valid link.'
    if parts.scheme.lower() != 'https':
        return None, 'Only secure https:// links are allowed.'
    if parts.username or parts.password:
        return None, 'Remove the username or password from the link.'
    host = (parts.hostname or '').lower().rstrip('.')
    if not host or not host.isascii() or '.' not in host:
        return None, 'Use a public website address.'
    try:
        ipaddress.ip_address(host)
        return None, 'Use a website name, not an IP address.'
    except ValueError:
        pass
    if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal', '.lan', '.home', '.corp')):
        return None, 'Use a public website address (not a local address).'
    if port not in (None, 443):
        return None, 'Links with a custom port are not allowed.'
    if config.CHAT_ALLOWED_HOSTS and not any(host == h or host.endswith('.' + h) for h in config.CHAT_ALLOWED_HOSTS):
        return None, 'That chat website is not on the allowed list.'
    return urlunsplit(('https', host + ('' if port is None else ':443'), parts.path, parts.query, '')), None


def public_chat_settings(con, trader_id):
    """What buyers may see on a shop: ('system', '') or ('external', 'https://...'). A stored link that no longer validates is never shown."""
    row = con.execute('SELECT mode, url FROM trader_chat_settings WHERE trader_id=%s', (trader_id,)).fetchone()
    if row and row['mode'] == 'external':
        url, error = validate_chat_url(row['url'])
        if not error:
            return 'external', url
    return 'system', ''


@bp.get('/api/trader/chat-settings')
@require_role('trader')
def get_chat_settings():
    with db() as con:
        row = con.execute('SELECT mode, url FROM trader_chat_settings WHERE trader_id=%s', (g.user['id'],)).fetchone()
    return jsonify(mode=row['mode'] if row else 'system', url=row['url'] if row and row['mode'] == 'external' else '')


@bp.put('/api/trader/chat-settings')
@bp.post('/api/trader/chat-settings')
@require_role('trader')
def save_chat_settings():
    if too_many_requests('chat-settings', 20, 3600):
        return jsonify(error=TOO_MANY_MESSAGE), 429
    data = _json_body()
    mode = str(data.get('mode', ''))
    if mode not in ('system', 'external'):
        return jsonify(error='Choose the S-Market Place chat or your own chat link.'), 400
    url = ''
    if mode == 'external':
        url, error = validate_chat_url(data.get('url'))
        if error:
            return jsonify(error=error), 400
    with db() as con:
        con.execute('SELECT id FROM users WHERE id=%s FOR UPDATE', (g.user['id'],))
        err = check_pin(con, g.user['id'], data.get('pin'))
        if err:
            return err
        con.execute(
            """INSERT INTO trader_chat_settings(trader_id, mode, url) VALUES(%s,%s,%s)
               ON CONFLICT (trader_id) DO UPDATE SET mode=EXCLUDED.mode, url=EXCLUDED.url, updated_at=NOW()""",
            (g.user['id'], mode, url))
    return jsonify(message='Chat setting saved.')


# ============================================================================= Weekly sales
@bp.get('/api/trader/weekly-sales')
@require_role('trader')
def weekly_sales():
    """The current week first (Monday to Sunday, Lagos time; it starts again from zero every Monday), then older weeks."""
    weeks = int_arg('weeks', 12, 1, 52)
    with db() as con:
        rows = con.execute(
            """WITH bounds AS (SELECT date_trunc('week', (NOW() AT TIME ZONE 'Africa/Lagos'))::date AS this_monday)
               SELECT d.day::date AS day, COALESCE(SUM(oi.seller_amount), 0) AS amount, COUNT(DISTINCT oi.order_id)::INTEGER AS orders
               FROM bounds
               CROSS JOIN generate_series((bounds.this_monday - (%(weeks)s - 1) * 7)::timestamp, (bounds.this_monday + 6)::timestamp, INTERVAL '1 day') AS d(day)
               LEFT JOIN orders o
                 ON timezone('Africa/Lagos', COALESCE(o.paid_at, o.created_at)) >= d.day
                AND timezone('Africa/Lagos', COALESCE(o.paid_at, o.created_at)) < d.day + INTERVAL '1 day'
                AND o.status = 'Paid'
               LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.trader_id = %(trader)s AND oi.escrow_status <> 'refunded'
               GROUP BY d.day ORDER BY d.day""",
            {'weeks': weeks, 'trader': g.user['id']}).fetchall()
    by_week = {}
    for row in rows:
        day = row['day']
        monday = day - timedelta(days=day.weekday())
        by_week.setdefault(monday, []).append({
            'label': day.strftime('%a'), 'date': day.isoformat(), 'amount': float(row['amount']), 'orders': row['orders']})
    result = []
    for monday in sorted(by_week, reverse=True):
        days, sunday = by_week[monday], monday + timedelta(days=6)
        result.append({
            'start': monday.isoformat(), 'end': sunday.isoformat(),
            'label': f"{monday.strftime('%b')} {monday.day} – {sunday.strftime('%b')} {sunday.day}",
            'total': round(sum(d['amount'] for d in days), 2), 'orders': sum(d['orders'] for d in days), 'days': days})
    return jsonify(weeks=result)


# ============================================================================= Followers / following
def _person(row):
    """Only public details are shared: a shop name for shops, first name + last initial for everyone else."""
    is_trader = row['role'] == 'trader'
    last = (row['last_name'] or '').strip()
    return {'username': row['username'],
            'name': f"{row['first_name']} {last[:1]}.".strip() if last else row['first_name'],
            'store_name': row['store_name'] if is_trader else '',
            'profile_image': row['profile_image'], 'is_verified': bool(row['is_verified']) and is_trader,
            'is_trader': is_trader, 'since': iso(row['created_at'])}


@bp.get('/api/trader/followers')
@require_role('trader')
def my_followers():
    with db() as con:
        rows = con.execute(
            """SELECT u.username, u.first_name, u.last_name, u.store_name, u.profile_image, u.is_verified, u.role, f.created_at
               FROM follows f JOIN users u ON u.id = f.follower_id
               WHERE f.trader_id = %s ORDER BY f.created_at DESC LIMIT 200""", (g.user['id'],)).fetchall()
    return jsonify(people=[_person(r) for r in rows])


@bp.get('/api/trader/following')
@require_role('trader')
def my_following():
    with db() as con:
        rows = con.execute(
            """SELECT u.username, u.first_name, u.last_name, u.store_name, u.profile_image, u.is_verified, u.role, f.created_at
               FROM follows f JOIN users u ON u.id = f.trader_id
               WHERE f.follower_id = %s ORDER BY f.created_at DESC LIMIT 200""", (g.user['id'],)).fetchall()
    return jsonify(people=[_person(r) for r in rows])


# ============================================================================= Messages to buyers (one way)
ORDER_MESSAGE_MAX = 200
ORDER_MESSAGE_LIMIT = 3          # per order line
_LINK = re.compile(r'(https?:|www\.|\b[a-z0-9-]+\.(com|net|org|ng|io|co|me|app|ly|link|xyz|site)\b)', re.IGNORECASE)
_PHONE = re.compile(r'(?:\+?\d[\s().-]*){8,}')        # 8 or more digits in a row (phone / account numbers)


@bp.post('/api/trader/order-items/<int:item_id>/message')
@require_role('trader')
def message_buyer(item_id):
    """Leave a short note on an order line. The buyer reads it on 'My orders' and cannot reply."""
    if too_many_requests('order-message', 30, 3600):
        return jsonify(error=TOO_MANY_MESSAGE), 429
    text = ' '.join(str(_json_body().get('message', '')).split())
    if not text:
        return jsonify(error='Write a short message first.'), 400
    if len(text) > ORDER_MESSAGE_MAX:
        return jsonify(error=f'Please keep the message under {ORDER_MESSAGE_MAX} characters.'), 400
    if _LINK.search(text):
        return jsonify(error='Links are not allowed in messages. Keep it short and about this order.'), 400
    if _PHONE.search(text):
        return jsonify(error='Please do not put phone or account numbers in a message.'), 400
    with db() as con:
        item = con.execute(
            """SELECT oi.id, oi.product_name, o.buyer_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE oi.id=%s AND oi.trader_id=%s AND o.status='Paid' FOR UPDATE OF oi""", (item_id, g.user['id'])).fetchone()
        if not item:
            return jsonify(error='Order line not found.'), 404
        sent = con.execute('SELECT COUNT(*)::int AS n FROM order_item_messages WHERE order_item_id=%s', (item_id,)).fetchone()['n']
        if sent >= ORDER_MESSAGE_LIMIT:
            return jsonify(error=f'You have reached the limit of {ORDER_MESSAGE_LIMIT} messages for this order.'), 409
        con.execute('INSERT INTO order_item_messages(order_item_id, trader_id, body) VALUES(%s,%s,%s)', (item_id, g.user['id'], text))
        shop = g.user.get('store_name') or g.user['username']
        escrow_service.notify(con, item['buyer_id'], f'Message from {shop}', f"About {item['product_name']}: open My orders to read it.", 'orders')
    return jsonify(message='Message sent. The buyer will see it on their order.')
