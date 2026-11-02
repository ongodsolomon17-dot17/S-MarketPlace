"""Order rules that don't belong to a single web route: cancelling, expiring and settling payments."""
import config
import escrow_service
import feed
from database import db
from helpers import to_kobo


def cancel_unpaid_order(con, order_id, new_status):
    """Cancel one UNPAID order and put everything it reserved back on sale.

    Returns False if the order was no longer waiting for payment (nothing is changed then).
    Products get their stock back. Fast Finger deals get their quantity back, and a deal that had
    sold out by itself becomes available again (one the trader marked as sold stays sold).
    """
    done = con.execute("UPDATE orders SET status=%s WHERE id=%s AND status='Awaiting payment' RETURNING id",
                       (new_status, order_id)).fetchone()
    if not done:
        return False
    # Always lock products first, then deals, each in id order, so two jobs can never wait on each other.
    for item in con.execute('SELECT product_id, quantity FROM order_items WHERE order_id=%s AND product_id IS NOT NULL ORDER BY product_id',
                            (order_id,)).fetchall():
        con.execute('UPDATE products SET stock = stock + %s WHERE id=%s', (item['quantity'], item['product_id']))
    for item in con.execute('SELECT deal_id, quantity FROM order_items WHERE order_id=%s AND deal_id IS NOT NULL ORDER BY deal_id',
                            (order_id,)).fetchall():
        con.execute('UPDATE flash_deals SET quantity = quantity + %s, '
                    'sold_at = CASE WHEN sold_by_trader THEN sold_at ELSE NULL END WHERE id=%s', (item['quantity'], item['deal_id']))
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
            # The buyer paid AFTER the hold expired and everything was put back on sale.
            # Try to take it again; if something has sold out meanwhile, flag the order for a refund.
            if not take_reserved_items_again(con, order_id):
                status = 'Refund needed'

        con.execute('UPDATE orders SET status=%s, paid_at=NOW(), payment_reference=%s WHERE id=%s', (status, reference, order_id))
        if status == 'Paid':
            escrow_service.hold_order_in_escrow(con, order_id)   # the money is secured; traders are told
            feed.record_purchases(con, order_id)          # buying is the strongest hint for the "For you" feed
        return status


def take_reserved_items_again(con, order_id):
    """Re-reserve every line of an order whose hold had expired. All-or-nothing: returns True if it worked.

    Products need enough stock. A Fast Finger deal needs enough quantity left and must not have been
    marked "sold" by its trader. (Locks are taken in the same order as everywhere else: products, then deals.)
    """
    products = con.execute('SELECT product_id, quantity FROM order_items WHERE order_id=%s AND product_id IS NOT NULL ORDER BY product_id',
                           (order_id,)).fetchall()
    deals = con.execute('SELECT deal_id, quantity FROM order_items WHERE order_id=%s AND deal_id IS NOT NULL ORDER BY deal_id',
                        (order_id,)).fetchall()
    # Order lines whose deal was already deleted (deal_id became NULL) can't be re-reserved.
    lost_deal_lines = con.execute('SELECT 1 FROM order_items WHERE order_id=%s AND product_id IS NULL AND deal_id IS NULL LIMIT 1',
                                  (order_id,)).fetchone()
    if lost_deal_lines:
        return False

    enough = True
    for item in products:
        stock = con.execute('SELECT stock FROM products WHERE id=%s FOR UPDATE', (item['product_id'],)).fetchone()
        if not stock or stock['stock'] < item['quantity']:
            enough = False
    for item in deals:
        deal = con.execute('SELECT quantity, sold_by_trader, sold_at FROM flash_deals WHERE id=%s FOR UPDATE', (item['deal_id'],)).fetchone()
        if not deal or deal['quantity'] < item['quantity'] or (deal['sold_by_trader'] and deal['sold_at'] is not None):
            enough = False
    if not enough:
        return False

    for item in products:
        con.execute('UPDATE products SET stock = stock - %s WHERE id=%s', (item['quantity'], item['product_id']))
    for item in deals:
        con.execute('UPDATE flash_deals SET quantity = quantity - %s, '
                    'sold_at = CASE WHEN quantity - %s <= 0 THEN COALESCE(sold_at, NOW()) ELSE sold_at END WHERE id=%s',
                    (item['quantity'], item['quantity'], item['deal_id']))
    return True
