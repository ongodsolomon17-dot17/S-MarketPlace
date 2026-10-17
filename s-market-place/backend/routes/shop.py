"""What shoppers see: the "For you" feed, product lists and details, categories, shops and tracking."""
import random
import re

from flask import Blueprint, jsonify, request

import feed
import maintenance
from auth import current_user, visitor_id
from categories import list_categories
from database import db
from helpers import int_arg, like_term, product_dict, search_tokens, too_many_requests

bp = Blueprint('shop', __name__)

# Columns every product list needs: the product plus its shop's name.
PRODUCT_SELECT = ('SELECT p.*, u.store_name, u.username AS trader_username '
                  'FROM products p JOIN users u ON u.id = p.trader_id WHERE p.is_active')


# ----------------------------------------------------------------------------- the "For you" feed
@bp.get('/api/feed')
def for_you_feed():
    """A personalised page of products. `seed` keeps paging stable; a new seed reshuffles the mix."""
    maintenance.run_periodically()
    seed = re.sub(r'[^A-Za-z0-9]', '', request.args.get('seed', ''))[:20] or str(random.randrange(10 ** 9))
    limit, offset = int_arg('limit', 24, 1, 48), int_arg('offset', 0, 0, feed.FEED_LENGTH)
    user = current_user()
    with db() as con:
        rows, has_more = feed.feed_page(con, user['id'] if user else None, visitor_id(), seed, offset, limit)
    return jsonify(products=[product_dict(row) for row in rows], has_more=has_more, seed=seed)


@bp.post('/api/interactions')
def track_interaction():
    """Remember a product view, an add-to-cart or a category tap so the feed can adapt."""
    if too_many_requests('interactions', 120, 60):
        return jsonify(error='Slow down a little.'), 429
    data = request.get_json(silent=True) or {}
    kind = str(data.get('kind', ''))
    if kind not in ('view', 'cart', 'category'):          # purchases are recorded by the server, never the browser
        return jsonify(error='Unknown interaction.'), 400
    user = current_user()
    user_id = user['id'] if user else None

    with db() as con:
        if kind == 'category':
            row = con.execute('SELECT name FROM categories WHERE LOWER(name)=LOWER(%s)', (str(data.get('category', '')),)).fetchone()
            if not row:
                return jsonify(error='Unknown category.'), 400
            feed.record_interaction(con, user_id, visitor_id(), 'category', category=row['name'])
        else:
            try:
                product_id = int(data.get('product_id'))
            except (TypeError, ValueError):
                return jsonify(error='A product is required.'), 400
            product = con.execute('SELECT id, trader_id, category FROM products WHERE id=%s AND is_active', (product_id,)).fetchone()
            if not product:
                return jsonify(error='Product not found.'), 404
            feed.record_interaction(con, user_id, visitor_id(), kind, product=product)
    return jsonify(ok=True)


# ----------------------------------------------------------------------------- products
@bp.get('/api/products')
def list_products():
    """Search and filter products. Several words must ALL match (name, description, category or shop)."""
    maintenance.run_periodically()
    category = request.args.get('category', '').strip()
    query, trader = request.args.get('q', '').strip(), request.args.get('trader', '').strip()
    limit, offset = int_arg('limit', 24, 1, 100), int_arg('offset', 0, 0, 100000)

    sql, params = PRODUCT_SELECT, []
    if 'ids' in request.args:                                   # used by the cart to load only what it needs
        ids = [int(x) for x in request.args['ids'].split(',') if x.strip().isdigit()][:100]
        if not ids:
            return jsonify(products=[], has_more=False)
        sql += ' AND p.id = ANY(%s)'
        params.append(ids)
    if category and category.lower() != 'all':
        sql += ' AND LOWER(p.category) = LOWER(%s)'
        params.append(category)
    if trader:
        sql += ' AND LOWER(u.username) = LOWER(%s)'
        params.append(trader)

    # Every search word has to appear somewhere. Matches in the name rank above category, above the rest.
    order_sql, order_params = 'p.id DESC', []
    tokens = search_tokens(query)
    if tokens:
        relevance = []
        for word in tokens:
            sql += ' AND (p.name ILIKE %s OR p.description ILIKE %s OR p.category ILIKE %s OR u.store_name ILIKE %s OR u.username ILIKE %s)'
            params += [like_term(word)] * 5
            relevance.append('(CASE WHEN p.name ILIKE %s THEN 3 WHEN p.category ILIKE %s THEN 2 ELSE 1 END)')
            order_params += [like_term(word)] * 2
        order_sql = ' + '.join(relevance) + ' DESC, p.id DESC'

    sql += f' ORDER BY {order_sql} LIMIT %s OFFSET %s'
    with db() as con:
        rows = con.execute(sql, [*params, *order_params, limit + 1, offset]).fetchall()
    return jsonify(products=[product_dict(row) for row in rows[:limit]], has_more=len(rows) > limit)


@bp.get('/api/products/<int:product_id>')
def product_detail(product_id):
    """One product with its full description (the shop page opens this when a shopper taps an item)."""
    with db() as con:
        row = con.execute(PRODUCT_SELECT + ' AND p.id = %s', (product_id,)).fetchone()
    if not row:
        return jsonify(error='This product is no longer available.'), 404
    return jsonify(product=product_dict(row))


@bp.get('/api/products/<int:product_id>/related')
def related_products(product_id):
    """Other items to show under an opened product: same category first, then same shop, then newest."""
    limit = int_arg('limit', 12, 1, 36)
    with db() as con:
        current = con.execute('SELECT category, trader_id FROM products WHERE id=%s AND is_active', (product_id,)).fetchone()
        if not current:
            return jsonify(products=[])
        rows = con.execute(
            PRODUCT_SELECT + ' AND p.id <> %s ORDER BY (p.stock > 0) DESC, (p.category = %s) DESC, (p.trader_id = %s) DESC, p.id DESC LIMIT %s',
            (product_id, current['category'], current['trader_id'], limit)).fetchall()
    return jsonify(products=[product_dict(row) for row in rows])


# ----------------------------------------------------------------------------- categories and shops
@bp.get('/api/categories')
def categories():
    """All categories (for a trader choosing one) or only those that have products (`?used=1`, for shoppers)."""
    with db() as con:
        return jsonify(categories=list_categories(con, used_only=request.args.get('used') == '1'))


@bp.get('/api/traders')
def list_traders():
    """Find trader shops by shop name, username or first name."""
    term = like_term(request.args.get('q', '').strip())
    with db() as con:
        rows = con.execute("""SELECT u.id, u.first_name, u.last_name, u.username, u.store_name, u.store_description,
                  u.profile_image, COUNT(p.id)::int AS product_count
           FROM users u LEFT JOIN products p ON p.trader_id = u.id AND p.is_active
           WHERE u.role = 'trader' AND (u.store_name ILIKE %s OR u.username ILIKE %s OR u.first_name ILIKE %s)
           GROUP BY u.id ORDER BY u.store_name LIMIT 100""", (term, term, term)).fetchall()
    return jsonify([dict(row) for row in rows])
