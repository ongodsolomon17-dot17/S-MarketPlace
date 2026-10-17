"""Order rules that don't belong to a single web route: cancelling, expiring and settling payments."""
import config
import feed
from database import db
from helpers import to_kobo


def cancel_unpaid_order(con, order_id, new_status):
    """Cancel one UNPAID order and put its reserved stock back on sale.

    Returns False if the order was no longer waiting for payment (nothing is changed then).
    """
    done = con.execute("UPDATE orders SET status=%s WHERE id=%s AND status='Awaiting payment' RETURNING id",
                       (new_status, order_id)).fetchone()
    if not done:
        return False
    items = con.execute('SELECT product_id, quantity FROM order_items WHERE order_id=%s ORDER BY product_id', (order_id,)).fetchall()
    for item in items:
        con.execute('UPDATE products SET stock = stock + %s WHERE id=%s', (item['quantity'], item['product_id']))
    return True


def release_expired_orders(con):
    """Cancel every unpaid order whose hold time has run out, returning its stock."""
    rows = con.execute(
        "SELECT id FROM orders WHERE status='Awaiting payment' AND expires_at IS NOT NULL AND expires_at < NOW() "
        "ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED").fetchall()
    for row in rows:
        cancel_unpaid_order(con, row['id'], 'Expired')


def settle_payment(order_id, reference, paid_kobo, currency, logger):
    """Mark an order paid after Paystack confirmed the payment.

    Safe to call many times (the webhook and the buyer's browser both call it).
    Returns the resulting status: 'Paid', 'Refund needed', 'Amount mismatch', or None if no such order.
    """
    with db() as con:
        order = con.execute('SELECT * FROM orders WHERE id=%s FOR UPDATE', (order_id,)).fetchone()
        if not order:
            return None
        if order['status'] in ('Paid', 'Refund needed'):
            return order['status']                       # already handled

        # Never accept less money than the order total, or a different currency.
        if currency != 'NGN' or paid_kobo < to_kobo(order['total']):
            logger.error('Payment amount mismatch on order %s: paid %s %s, expected %s',
                         order_id, paid_kobo, currency, order['total'])
            return 'Amount mismatch'

        status = 'Paid'
        if order['status'] != 'Awaiting payment':
            # The buyer paid AFTER the hold expired and the stock was released.
            # Try to take the stock again; if it has sold out meanwhile, flag the order for a refund.
            items = con.execute('SELECT product_id, quantity FROM order_items WHERE order_id=%s ORDER BY product_id',
                                (order_id,)).fetchall()
            enough_stock = True
            for item in items:
                stock = con.execute('SELECT stock FROM products WHERE id=%s FOR UPDATE', (item['product_id'],)).fetchone()
                if not stock or stock['stock'] < item['quantity']:
                    enough_stock = False
            if enough_stock:
                for item in items:
                    con.execute('UPDATE products SET stock = stock - %s WHERE id=%s', (item['quantity'], item['product_id']))
            else:
                status = 'Refund needed'

        con.execute('UPDATE orders SET status=%s, paid_at=NOW(), payment_reference=%s WHERE id=%s', (status, reference, order_id))
        if status == 'Paid':
            feed.record_purchases(con, order_id)          # buying is the strongest hint for the "For you" feed
        return status
