"""Buying: checkout, paying with Paystack, and the buyer's order history."""
import json
import re
import secrets
from collections import defaultdict
from datetime import datetime
from decimal import Decimal

import psycopg
from flask import Blueprint, current_app, g, jsonify, request

import config
import maintenance
import order_service
import payment_service
from auth import require_role
from database import db
from helpers import iso

bp = Blueprint('orders', __name__)
ORDER_REF = re.compile(config.ORDER_REF_PATTERN)


class CheckoutError(Exception):
    """A problem the buyer should be told about (out of stock, product removed, ...)."""

    def __init__(self, message, status=409):
        super().__init__(message)
        self.message, self.status = message, status


def _order_dict(order, items):
    """An order row plus its items, shaped for the frontend."""
    data = dict(order)
    data['total'] = float(data['total'])
    for key in ('created_at', 'paid_at', 'expires_at'):
        data[key] = iso(data.get(key))
    data.pop('buyer_id', None)
    data['items'] = [{**dict(item), 'unit_price': float(item['unit_price'])} for item in items]
    return data


# ----------------------------------------------------------------------------- checkout
@bp.post('/api/checkout')
@require_role('buyer')
def checkout():
    """Reserve the stock under row locks, create the order, then hand the buyer to Paystack to pay."""
    if not config.PAYSTACK_SECRET_KEY:
        return jsonify(error='Online payment is not set up yet. Please try again later.'), 503
    data = request.get_json(silent=True) or {}
    items, shipping = data.get('items') or [], data.get('shipping') or {}
    if not items:
        return jsonify(error='Your cart is empty.'), 400

    # --- validate delivery details
    ship = {key: str(shipping.get(key, '')).strip() for key in ('name', 'phone', 'address', 'city', 'state')}
    if not all(ship.values()):
        return jsonify(error='Enter your full name, phone number, delivery address, city and state.'), 400
    limits = {'name': 160, 'phone': 40, 'address': 400, 'city': 80, 'state': 80}
    if any(len(ship[key]) > limit for key, limit in limits.items()):
        return jsonify(error='One of the delivery details is too long.'), 400

    # --- validate the cart (merge duplicate lines of the same product)
    try:
        quantities = {}
        for item in items:
            product_id, quantity = int(item['product_id']), int(item['quantity'])
            if quantity < 1 or quantity > 1000:
                raise ValueError
            quantities[product_id] = quantities.get(product_id, 0) + quantity
    except (KeyError, TypeError, ValueError):
        return jsonify(error='Your cart contains an invalid item or quantity.'), 400

    maintenance.run_periodically(force=True)       # give back stock from expired orders first
    try:
        with db() as con:
            total, locked = Decimal('0.00'), []
            for product_id in sorted(quantities):    # always lock in the same order so two checkouts can't deadlock
                quantity = quantities[product_id]
                row = con.execute('SELECT id,name,price,stock FROM products WHERE id=%s AND is_active FOR UPDATE',
                                  (product_id,)).fetchone()
                if not row:
                    raise CheckoutError('A product in your cart is no longer available.')
                if row['stock'] < quantity:
                    raise CheckoutError(f"Only {row['stock']} of {row['name']} remain in stock.")
                total += row['price'] * quantity
                locked.append((row, quantity))

            order = con.execute(
                "INSERT INTO orders(buyer_id,total,status,shipping_name,shipping_phone,shipping_address,shipping_city,"
                "shipping_state,expires_at) VALUES(%s,%s,'Awaiting payment',%s,%s,%s,%s,%s, NOW() + %s::int * INTERVAL '1 minute') "
                "RETURNING id",
                (g.user['id'], total, ship['name'], ship['phone'], ship['address'], ship['city'], ship['state'],
                 config.ORDER_HOLD_MINUTES)).fetchone()
            reference = f"SMP-{order['id']}-{secrets.token_hex(6)}"
            con.execute('UPDATE orders SET payment_reference=%s WHERE id=%s', (reference, order['id']))
            for row, quantity in locked:                                  # reserve the stock for this order
                con.execute('INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price) VALUES(%s,%s,%s,%s,%s)',
                            (order['id'], row['id'], row['name'], quantity, row['price']))
                con.execute('UPDATE products SET stock = stock - %s WHERE id=%s', (quantity, row['id']))
    except CheckoutError as error:
        return jsonify(error=error.message), error.status
    except psycopg.Error:
        current_app.logger.exception('Checkout failed')
        return jsonify(error='We could not create the order. Please try again.'), 500

    try:
        url = payment_service.paystack_initialize(order['id'], reference, g.user['email'], total)
    except Exception:    # noqa: BLE001
        current_app.logger.exception('Paystack initialize failed')
        with db() as con:                                                 # give the stock back straight away
            order_service.cancel_unpaid_order(con, order['id'], 'Cancelled')
        return jsonify(error='We could not reach the payment provider. Your cart is unchanged, please try again.'), 502
    return jsonify(message=f"Order #{order['id']} created. Redirecting to payment…",
                   order_id=order['id'], total=float(total), authorization_url=url)


# ----------------------------------------------------------------------------- order history
@bp.get('/api/orders')
@require_role('buyer')
def my_orders():
    """The signed-in buyer's recent orders with their items and delivery progress."""
    maintenance.run_periodically()
    with db() as con:
        orders = con.execute('SELECT * FROM orders WHERE buyer_id=%s ORDER BY id DESC LIMIT 50', (g.user['id'],)).fetchall()
        items = con.execute("""SELECT oi.id, oi.order_id, oi.product_id, oi.product_name AS name, oi.quantity, oi.unit_price,
                  oi.fulfilment_status, p.image, u.store_name
               FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN users u ON u.id = p.trader_id
               WHERE oi.order_id = ANY(%s) ORDER BY oi.id""", ([o['id'] for o in orders],)).fetchall()
    by_order = defaultdict(list)
    for item in items:
        by_order[item['order_id']].append(item)
    return jsonify([_order_dict(order, by_order[order['id']]) for order in orders])


# ----------------------------------------------------------------------------- payment confirmation
@bp.post('/api/orders/verify')
@require_role('buyer')
def verify_order():
    """After Paystack sends the buyer back, ask Paystack if the payment really went through."""
    reference = str((request.get_json(silent=True) or {}).get('reference', '')).strip()
    match = ORDER_REF.match(reference)
    if not match or not config.PAYSTACK_SECRET_KEY:
        return jsonify(error='That payment reference is not valid.'), 400
    order_id = int(match.group(1))
    with db() as con:
        order = con.execute('SELECT id,status FROM orders WHERE id=%s AND buyer_id=%s', (order_id, g.user['id'])).fetchone()
    if not order:
        return jsonify(error='Order not found.'), 404
    try:
        data = payment_service.paystack_verify(reference)
    except Exception:    # noqa: BLE001
        current_app.logger.exception('Paystack verify failed')
        return jsonify(error='We could not reach the payment provider. Please check your orders again in a minute.'), 502

    if not data or data.get('status') != 'success':
        return jsonify(order_id=order_id, paid=False, status=order['status'],
                       message='Payment was not completed. You can pay again from My orders before the order expires.')
    status = order_service.settle_payment(order_id, reference, int(data.get('amount', 0)), data.get('currency'), current_app.logger)
    messages = {'Paid': 'Payment received. Thank you! The trader has been notified.',
                'Refund needed': 'Your payment arrived after the order expired and the items sold out. We will refund you.'}
    return jsonify(order_id=order_id, paid=status == 'Paid', status=status,
                   message=messages.get(status, 'We received your payment but could not confirm it yet. Please contact support.'))


@bp.post('/api/orders/<int:order_id>/pay')
@require_role('buyer')
def pay_order(order_id):
    """Pay again for an unpaid order that is still being held."""
    if not config.PAYSTACK_SECRET_KEY:
        return jsonify(error='Online payment is not set up yet.'), 503
    reference = f'SMP-{order_id}-{secrets.token_hex(6)}'
    with db() as con:
        order = con.execute('SELECT id,total,status,expires_at FROM orders WHERE id=%s AND buyer_id=%s FOR UPDATE',
                            (order_id, g.user['id'])).fetchone()
        if not order:
            return jsonify(error='Order not found.'), 404
        expired = order['expires_at'] and order['expires_at'] < datetime.now(order['expires_at'].tzinfo)
        if order['status'] != 'Awaiting payment' or expired:
            return jsonify(error='This order can no longer be paid. Please place a new order.'), 409
        con.execute('UPDATE orders SET payment_reference=%s WHERE id=%s', (reference, order_id))
    try:
        url = payment_service.paystack_initialize(order_id, reference, g.user['email'], order['total'])
    except Exception:    # noqa: BLE001
        current_app.logger.exception('Paystack initialize failed')
        return jsonify(error='We could not reach the payment provider. Please try again.'), 502
    return jsonify(authorization_url=url)


@bp.post('/api/orders/<int:order_id>/cancel')
@require_role('buyer')
def cancel_order(order_id):
    """Cancel an unpaid order; its items go back on sale."""
    with db() as con:
        order = con.execute('SELECT id FROM orders WHERE id=%s AND buyer_id=%s FOR UPDATE', (order_id, g.user['id'])).fetchone()
        if not order:
            return jsonify(error='Order not found.'), 404
        if not order_service.cancel_unpaid_order(con, order_id, 'Cancelled'):
            return jsonify(error='Only unpaid orders can be cancelled here. For a paid order, please contact the trader.'), 409
    return jsonify(message='Order cancelled and the items were returned to stock.')


@bp.post('/api/paystack/webhook')
def paystack_webhook():
    """Paystack calls this server-to-server when a payment succeeds, even if the buyer closed their browser."""
    if not config.PAYSTACK_SECRET_KEY:
        return '', 503
    raw = request.get_data()
    if not payment_service.webhook_signature_is_valid(raw, request.headers.get('x-paystack-signature', '')):
        return '', 401                                       # not really from Paystack
    try:
        event = json.loads(raw or b'{}')                     # parse the exact bytes that were signed
        if isinstance(event, dict) and event.get('event') == 'charge.success':
            data = event.get('data') or {}
            reference = str(data.get('reference', ''))
            match = ORDER_REF.match(reference)
            if match:
                order_service.settle_payment(int(match.group(1)), reference, int(data.get('amount', 0)),
                                             data.get('currency'), current_app.logger)
    except Exception:    # noqa: BLE001
        current_app.logger.exception('Webhook processing failed')
        return '', 500                                       # Paystack will retry later
    return '', 200
