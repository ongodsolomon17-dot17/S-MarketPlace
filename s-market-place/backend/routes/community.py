"""Shop profiles, followers and buyer ratings.

* A shop page shows the trader's stats (live products, followers, items sold), their star rating and a
  "Verified" badge. The badge is given only by the superadmin (see routes/admin.py).
* Anyone signed in can follow a shop.
* A buyer can rate a trader ONCE per order line, and only after confirming they received the item
  (that is when the escrow money is released), so ratings always come from real purchases.
"""
from flask import Blueprint, g, jsonify, request

import escrow_service
from auth import current_user, require_role
from database import db
from helpers import int_arg, iso

bp = Blueprint('community', __name__)


def _trader(con, username):
    return con.execute(
        """SELECT id, username, first_name, last_name, store_name, store_description, profile_image,
                  is_verified, created_at FROM users WHERE role='trader' AND LOWER(username)=LOWER(%s)""",
        (username,)).fetchone()


def _stats(con, trader_id):
    """The numbers shown on a shop page and on the trader's own dashboard."""
    return con.execute(
        """SELECT
             (SELECT COUNT(*) FROM products WHERE trader_id=%(t)s AND is_active AND stock > 0)::int AS products,
             (SELECT COUNT(*) FROM follows WHERE trader_id=%(t)s)::int AS followers,
             (SELECT COALESCE(SUM(quantity), 0) FROM order_items
                WHERE trader_id=%(t)s AND escrow_status='released')::int AS sold,
             (SELECT ROUND(AVG(stars)::numeric, 1) FROM trader_ratings WHERE trader_id=%(t)s) AS rating,
             (SELECT COUNT(*) FROM trader_ratings WHERE trader_id=%(t)s)::int AS rating_count""",
        {'t': trader_id}).fetchone()


# ----------------------------------------------------------------------------- a shop's public profile
@bp.get('/api/shops/<username>')
def shop_profile(username):
    me = current_user()
    with db() as con:
        trader = _trader(con, username)
        if not trader:
            return jsonify(error='This shop was not found.'), 404
        stats = _stats(con, trader['id'])
        following = bool(me and con.execute('SELECT 1 FROM follows WHERE follower_id=%s AND trader_id=%s',
                                            (me['id'], trader['id'])).fetchone())
    return jsonify(shop={
        'username': trader['username'],
        'store_name': trader['store_name'] or f"{trader['first_name']} {trader['last_name']}",
        'store_description': trader['store_description'],
        'profile_image': trader['profile_image'],
        'is_verified': bool(trader['is_verified']),
        'joined': iso(trader['created_at']),
        'products': stats['products'], 'followers': stats['followers'], 'sold': stats['sold'],
        'rating': float(stats['rating']) if stats['rating'] is not None else None,
        'rating_count': stats['rating_count'],
        'following': following,
        'is_mine': bool(me and me['id'] == trader['id']),
    })


@bp.get('/api/shops/<username>/reviews')
def shop_reviews(username):
    limit = int_arg('limit', 10, 1, 50)
    with db() as con:
        trader = _trader(con, username)
        if not trader:
            return jsonify(error='This shop was not found.'), 404
        rows = con.execute(
            """SELECT r.stars, r.comment, r.created_at, b.first_name, oi.product_name
               FROM trader_ratings r JOIN users b ON b.id = r.buyer_id JOIN order_items oi ON oi.id = r.order_item_id
               WHERE r.trader_id=%s ORDER BY r.id DESC LIMIT %s""", (trader['id'], limit)).fetchall()
    return jsonify(reviews=[{'stars': r['stars'], 'comment': r['comment'], 'product_name': r['product_name'],
                             'buyer': r['first_name'], 'created_at': iso(r['created_at'])} for r in rows])


# ----------------------------------------------------------------------------- follow / unfollow
@bp.post('/api/shops/<username>/follow')
def follow_shop(username):
    me = current_user()
    if not me:
        return jsonify(error='Please log in to follow a shop.'), 401
    with db() as con:
        trader = _trader(con, username)
        if not trader:
            return jsonify(error='This shop was not found.'), 404
        if trader['id'] == me['id']:
            return jsonify(error="You can't follow your own shop."), 400
        added = con.execute('INSERT INTO follows(follower_id, trader_id) VALUES(%s,%s) ON CONFLICT DO NOTHING RETURNING 1',
                            (me['id'], trader['id'])).fetchone()
        if added:                                                   # only the first follow sends a notification
            who = me.get('store_name') or f"{me['first_name']} {me['last_name']}".strip()
            escrow_service.notify(con, trader['id'], 'New follower', f'{who} started following your shop.', 'trader-dashboard')
        followers = con.execute('SELECT COUNT(*)::int AS n FROM follows WHERE trader_id=%s', (trader['id'],)).fetchone()['n']
    return jsonify(following=True, followers=followers)


@bp.delete('/api/shops/<username>/follow')
def unfollow_shop(username):
    me = current_user()
    if not me:
        return jsonify(error='Please log in first.'), 401
    with db() as con:
        trader = _trader(con, username)
        if not trader:
            return jsonify(error='This shop was not found.'), 404
        con.execute('DELETE FROM follows WHERE follower_id=%s AND trader_id=%s', (me['id'], trader['id']))
        followers = con.execute('SELECT COUNT(*)::int AS n FROM follows WHERE trader_id=%s', (trader['id'],)).fetchone()['n']
    return jsonify(following=False, followers=followers)


# ----------------------------------------------------------------------------- rate a trader
@bp.post('/api/orders/items/<int:item_id>/rating')
@require_role('buyer')
def rate_trader(item_id):
    data = request.get_json(silent=True) or {}
    try:
        stars = int(data.get('stars'))
    except (TypeError, ValueError):
        stars = 0
    comment = str(data.get('comment', '')).strip()
    if not 1 <= stars <= 5:
        return jsonify(error='Choose a rating from 1 to 5 stars.'), 400
    if len(comment) > 500:
        return jsonify(error='Please keep your comment under 500 characters.'), 400
    with db() as con:
        item = con.execute(
            """SELECT oi.id, oi.trader_id, oi.product_name, oi.escrow_status FROM order_items oi
               JOIN orders o ON o.id = oi.order_id WHERE oi.id=%s AND o.buyer_id=%s FOR UPDATE OF oi""",
            (item_id, g.user['id'])).fetchone()
        if not item or not item['trader_id']:
            return jsonify(error='Order item not found.'), 404
        if item['escrow_status'] != 'released':
            return jsonify(error='You can rate a trader after you confirm that you received the item.'), 409
        added = con.execute(
            'INSERT INTO trader_ratings(order_item_id, buyer_id, trader_id, stars, comment) VALUES(%s,%s,%s,%s,%s) '
            'ON CONFLICT (order_item_id) DO NOTHING RETURNING id', (item_id, g.user['id'], item['trader_id'], stars, comment)).fetchone()
        if not added:
            return jsonify(error='You have already rated this item.'), 409
        escrow_service.notify(con, item['trader_id'], f'New {stars}-star rating',
                              f"A buyer rated you for {item['product_name']}.", 'trader-dashboard')
    return jsonify(message='Thank you! Your rating was sent.', stars=stars)


# ----------------------------------------------------------------------------- the trader's own counts
@bp.get('/api/trader/summary')
@require_role('trader')
def trader_summary():
    """Everything the trader's dashboard tiles need in one call."""
    uid = g.user['id']
    with db() as con:
        stats = _stats(con, uid)
        counts = con.execute(
            """SELECT
                 (SELECT COUNT(*) FROM products WHERE trader_id=%(u)s AND deleted_at IS NULL AND purged_at IS NULL)::int AS products,
                 (SELECT COUNT(*) FROM follows WHERE follower_id=%(u)s)::int AS following,
                 (SELECT COUNT(*) FROM notifications WHERE user_id=%(u)s AND read_at IS NULL)::int AS unread,
                 (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                    WHERE oi.trader_id=%(u)s AND o.status='Paid' AND oi.fulfilment_status <> 'Delivered')::int AS to_fulfil,
                 (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                    WHERE oi.trader_id=%(u)s AND o.status='Paid' AND oi.fulfilment_status = 'Delivered')::int AS fulfilled""",
            {'u': uid}).fetchone()
        verified = con.execute('SELECT is_verified FROM users WHERE id=%s', (uid,)).fetchone()['is_verified']
    return jsonify(products=counts['products'], followers=stats['followers'], following=counts['following'],
                   unread=counts['unread'], to_fulfil=counts['to_fulfil'], fulfilled=counts['fulfilled'],
                   rating=float(stats['rating']) if stats['rating'] is not None else None,
                   rating_count=stats['rating_count'], is_verified=bool(verified))
