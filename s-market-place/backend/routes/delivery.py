"""Confirming delivery: the one-time QR, the buyer's scan, "Received", and disputes.

The flow, from the buyer's side:
    1. The trader makes a one-time delivery QR for the item and gives it to whoever delivers it.
    2. The package arrives. The buyer opens the item in "My orders" and either
         - taps "Scan package QR"  (the code must match THIS item), then taps "Received", or
         - taps "Report a problem" (before scanning): a text and up to 2 photos. The money then stays on hold.
    3. "Received" releases the trader's money from escrow (see escrow_service.py).
"""
import re
import secrets

from flask import Blueprint, g, jsonify, request

import escrow_service
import image_service
from auth import require_role
from database import db
from helpers import TOO_MANY_MESSAGE, too_many_requests

bp = Blueprint('delivery', __name__)

CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'      # no 0/O or 1/I, so a typed code can't be misread
DISPUTE_REASONS = {
    'not_received': 'Item not received',
    'damaged': 'Item arrived damaged',
    'not_as_described': 'Not as described',
    'wrong_item': 'Wrong item',
    'return_request': 'I want to return it',
}


def make_code():
    """A new delivery code such as SMP-7K3QX-9M2AB (about 50 bits of randomness)."""
    block = lambda: ''.join(secrets.choice(CODE_ALPHABET) for _ in range(5))
    return f'SMP-{block()}-{block()}'


def code_matches(entered, real):
    """Compare codes ignoring case, spaces and dashes; the SMP- prefix may be left off when typing."""
    clean = lambda text: re.sub(r'[^A-Z0-9]', '', str(text or '').upper())
    entered, real = clean(entered), clean(real)
    return bool(real) and entered in (real, real[len('SMP'):])


# ----------------------------------------------------------------------------- trader: make the QR
@bp.post('/api/trader/order-items/<int:item_id>/code')
@require_role('trader')
def delivery_code(item_id):
    """Get (or, with {"regenerate": true}, replace) the one-time delivery code for a paid item."""
    regenerate = bool((request.get_json(silent=True) or {}).get('regenerate'))
    with db() as con:
        item = con.execute(
            """SELECT oi.id, oi.product_name, oi.quantity, oi.order_id, oi.delivery_code, oi.code_scanned_at, oi.escrow_status,
                      o.status AS order_status
               FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE oi.id=%s AND oi.trader_id=%s FOR UPDATE OF oi""", (item_id, g.user['id'])).fetchone()
        if not item:
            return jsonify(error='Order line not found.'), 404
        if item['order_status'] != 'Paid' or item['escrow_status'] != 'held':
            return jsonify(error='A delivery QR is only available for paid items that the buyer has not confirmed yet.'), 409
        if item['code_scanned_at']:
            return jsonify(error='The buyer already scanned this package, so its QR can no longer change.'), 409
        code = item['delivery_code']
        if not code or regenerate:
            code = make_code()
            con.execute('UPDATE order_items SET delivery_code=%s WHERE id=%s', (code, item_id))
    return jsonify(code=code, name=item['product_name'], quantity=item['quantity'], order_id=item['order_id'])


# ----------------------------------------------------------------------------- buyer: scan, receive, dispute
def _load_buyer_item(con, item_id):
    """The buyer's own order line (locked for the rest of this request), or None."""
    return con.execute(
        """SELECT oi.id, oi.trader_id, oi.product_name, oi.order_id, oi.delivery_code, oi.code_scanned_at, oi.escrow_status,
                  o.status AS order_status
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE oi.id=%s AND o.buyer_id=%s FOR UPDATE OF oi""", (item_id, g.user['id'])).fetchone()


def _not_open_for_confirmation(item):
    """An error response if this line can't be confirmed or disputed right now, else None."""
    if not item:
        return jsonify(error='Order line not found.'), 404
    if item['order_status'] != 'Paid':
        return jsonify(error='This order has not been paid.'), 409
    messages = {'disputed': 'A problem was already reported for this item. It is under review.',
                'released': 'You already confirmed this item. Thank you!', 'refunded': 'This item was refunded.'}
    if item['escrow_status'] in messages:
        return jsonify(error=messages[item['escrow_status']]), 409
    return None


@bp.post('/api/orders/items/<int:item_id>/scan')
@require_role('buyer')
def scan_package(item_id):
    """The buyer scanned (or typed) the package code. It must belong to THIS item."""
    if too_many_requests('scan', 15, 600):
        return jsonify(error=TOO_MANY_MESSAGE), 429
    code = (request.get_json(silent=True) or {}).get('code', '')
    with db() as con:
        item = _load_buyer_item(con, item_id)
        problem = _not_open_for_confirmation(item)
        if problem:
            return problem
        if not item['delivery_code']:
            return jsonify(error="The trader hasn't prepared the delivery QR yet."), 409
        if not code_matches(code, item['delivery_code']):
            return jsonify(error='This QR code does not match this package. Check that you are confirming the right item.'), 400
        con.execute('UPDATE order_items SET code_scanned_at = COALESCE(code_scanned_at, NOW()) WHERE id=%s', (item_id,))
    return jsonify(message=f"Package confirmed: {item['product_name']}. Tap Received to finish.", name=item['product_name'], scanned=True)


@bp.post('/api/orders/items/<int:item_id>/confirm')
@require_role('buyer')
def confirm_received(item_id):
    """The buyer tapped "Received" (only possible after scanning). The trader is paid from escrow."""
    with db() as con:
        item = _load_buyer_item(con, item_id)
        problem = _not_open_for_confirmation(item)
        if problem:
            return problem
        if not item['code_scanned_at']:
            return jsonify(error='Scan the package QR first.'), 409
        escrow_service.release_item(con, item_id)
    return jsonify(message='Thank you! Delivery confirmed and the trader has been paid.')


@bp.post('/api/orders/items/<int:item_id>/dispute')
@require_role('buyer')
def report_problem(item_id):
    """Report a problem instead of confirming. The money stays on hold until the admin decides."""
    data = request.get_json(silent=True) or {}
    reason = str(data.get('reason_type', ''))
    details = str(data.get('details', '')).strip()
    photos = data.get('photos') or []
    if reason not in DISPUTE_REASONS:
        return jsonify(error='Choose what went wrong.'), 400
    if not 10 <= len(details) <= 1000:
        return jsonify(error='Please describe the problem (10 to 1000 characters).'), 400
    if not isinstance(photos, list) or len(photos) > 2 or not all(image_service.cloudinary_public_id(url) for url in photos):
        return jsonify(error='You can attach up to 2 photos, uploaded through the site.'), 400
    photos = [*photos, '', ''][:2]
    with db() as con:
        item = _load_buyer_item(con, item_id)
        problem = _not_open_for_confirmation(item)
        if problem:
            return problem
        con.execute('INSERT INTO disputes(order_item_id, buyer_id, reason_type, details, photo1, photo2) VALUES(%s,%s,%s,%s,%s,%s)',
                    (item_id, g.user['id'], reason, details, photos[0], photos[1]))
        con.execute("UPDATE order_items SET escrow_status='disputed' WHERE id=%s", (item_id,))
        text = f"{DISPUTE_REASONS[reason]}: {item['product_name']} (order #{item['order_id']})."
        escrow_service.notify(con, item['trader_id'], 'The buyer reported a problem',
                              text + ' The payment stays on hold while this is reviewed.', 'trader-dashboard')
        escrow_service.notify_admins(con, 'New dispute to review', text, 'admin')
    return jsonify(message='Your report was sent. The payment stays on hold while we review it.')
