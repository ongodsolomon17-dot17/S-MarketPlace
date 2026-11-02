"""Escrow: keeping a buyer's money safe until the item is delivered.

HOW THE MONEY MOVES
  1. The buyer pays. Paystack puts the money in the marketplace's own Paystack account. That money is
     "in escrow": it is NOT the trader's yet. Here we record, for every order line, how much of it will
     belong to the trader (the sale minus the marketplace's commission) and mark the line "held".
  2. The trader is notified: "payment received, you will be credited when the buyer confirms delivery".
  3. The buyer receives the item, scans the package QR and taps "Received"  ->  the line is "released":
     the trader's share becomes part of their AVAILABLE balance.
     If instead the buyer reports a problem, the line is "disputed" (the money stays on hold) until the
     admin decides: release it to the trader, or refund the buyer.
  4. A trader asks for a payout of their available balance, and the admin pays it to their bank account.

A line's escrow_status:   unpaid -> held -> released
                                     held -> disputed -> released | refunded

Balances are never stored; they are always added up from the order lines and payouts, so they cannot drift.
"""
from decimal import Decimal, ROUND_HALF_UP

import config


def naira(amount):
    """₦12,500.00 (used inside notification messages)."""
    return f'₦{Decimal(amount):,.2f}'


def split_amount(line_total):
    """Split a sale into (marketplace commission, trader's share). Both are rounded to kobo and add up exactly."""
    commission = (Decimal(line_total) * config.COMMISSION_PERCENT / 100).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    return commission, Decimal(line_total) - commission


# ---------------------------------------------------------------------------- notifications
def notify(con, user_id, title, body='', link=''):
    """Leave an in-app message for someone (shown in their Notifications list)."""
    con.execute('INSERT INTO notifications(user_id, title, body, link) VALUES(%s,%s,%s,%s)', (user_id, title, body, link))


def notify_admins(con, title, body='', link=''):
    """Tell every admin (accounts listed in ADMIN_USER_IDS) about something that needs them."""
    for admin_id in sorted(config.ADMIN_USER_IDS):
        con.execute('INSERT INTO notifications(user_id, title, body, link) SELECT id,%s,%s,%s FROM users WHERE id=%s',
                    (title, body, link, admin_id))


# ---------------------------------------------------------------------------- the money moves
def hold_order_in_escrow(con, order_id):
    """The order was just paid: put every line in escrow and tell each trader their money is secured."""
    lines = con.execute('SELECT id, trader_id, product_name, quantity, unit_price FROM order_items WHERE order_id=%s ORDER BY id',
                        (order_id,)).fetchall()
    per_trader = {}
    for line in lines:
        commission, seller_amount = split_amount(line['unit_price'] * line['quantity'])
        con.execute("UPDATE order_items SET escrow_status='held', commission=%s, seller_amount=%s WHERE id=%s",
                    (commission, seller_amount, line['id']))
        entry = per_trader.setdefault(line['trader_id'], {'amount': Decimal('0'), 'names': []})
        entry['amount'] += seller_amount
        entry['names'].append(f"{line['product_name']} × {line['quantity']}")
    for trader_id, entry in per_trader.items():
        if trader_id is not None:
            notify(con, trader_id, 'Payment received: held in escrow',
                   f"{naira(entry['amount'])} for {', '.join(entry['names'])} (order #{order_id}) is secured in escrow. "
                   'You will be credited as soon as the buyer confirms delivery without a dispute.', 'trader-dashboard')


def release_item(con, item_id):
    """Pay the trader: move one line's money from escrow to their available balance. Returns True if it moved."""
    line = con.execute(
        """UPDATE order_items SET escrow_status='released', released_at=NOW(), fulfilment_status='Delivered',
                  delivered_at=COALESCE(delivered_at, NOW())
           WHERE id=%s AND escrow_status IN ('held','disputed')
           RETURNING trader_id, product_name, seller_amount, order_id""", (item_id,)).fetchone()
    if not line:
        return False
    notify(con, line['trader_id'], 'You have been credited',
           f"{naira(line['seller_amount'])} for {line['product_name']} (order #{line['order_id']}) is now in your available balance.",
           'trader-dashboard')
    return True


def refund_item(con, item_id):
    """The admin sided with the buyer: the trader is NOT paid for this line. Returns True if it changed."""
    line = con.execute(
        "UPDATE order_items SET escrow_status='refunded' WHERE id=%s AND escrow_status='disputed' "
        "RETURNING trader_id, product_name, order_id", (item_id,)).fetchone()
    if not line:
        return False
    notify(con, line['trader_id'], 'Dispute resolved: buyer refunded',
           f"The dispute for {line['product_name']} (order #{line['order_id']}) was decided in the buyer's favour.", 'trader-dashboard')
    return True


def auto_release(con):
    """Optional safety net (AUTO_RELEASE_DAYS): pay traders for items marked Delivered long ago and never disputed."""
    if config.AUTO_RELEASE_DAYS <= 0:
        return 0
    due = con.execute(
        f"""SELECT id FROM order_items WHERE escrow_status='held' AND delivered_at < NOW() - INTERVAL '{int(config.AUTO_RELEASE_DAYS)} days'
            ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED""").fetchall()
    return sum(1 for line in due if release_item(con, line['id']))


# ---------------------------------------------------------------------------- balances
def trader_balances(con, trader_id):
    """What a trader's money looks like right now (all values are Decimals)."""
    sales = con.execute(
        """SELECT COALESCE(SUM(seller_amount) FILTER (WHERE escrow_status = 'held'), 0)     AS in_escrow,
                  COALESCE(SUM(seller_amount) FILTER (WHERE escrow_status = 'disputed'), 0) AS disputed,
                  COALESCE(SUM(seller_amount) FILTER (WHERE escrow_status = 'released'), 0) AS released
           FROM order_items WHERE trader_id = %s""", (trader_id,)).fetchone()
    payouts = con.execute(
        """SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)      AS paid_out,
                  COALESCE(SUM(amount) FILTER (WHERE status = 'requested'), 0) AS requested
           FROM payouts WHERE trader_id = %s""", (trader_id,)).fetchone()
    return {
        'in_escrow': sales['in_escrow'],
        'disputed': sales['disputed'],
        'available': sales['released'] - payouts['paid_out'] - payouts['requested'],   # released and not yet paid or requested
        'requested': payouts['requested'],
        'paid_out': payouts['paid_out'],
    }
