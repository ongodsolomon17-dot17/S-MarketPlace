"""Trader tools: manage products (with categories and stock) and fulfil paid orders."""
import math
from decimal import Decimal

from flask import Blueprint, g, jsonify, request

import image_service
from auth import require_role
from categories import resolve_category
from database import db
from helpers import iso, product_dict
from product_service import RECOVERY_DAYS

bp = Blueprint('seller', __name__)


# ----------------------------------------------------------------------------- product validation
def parse_money(raw):
    """Turn typed money into a Decimal with 2 decimals, or return None if it is not a valid amount."""
    try:
        amount = Decimal(str(raw))
    except Exception:    # noqa: BLE001
        return None
    if not amount.is_finite() or not 0 <= amount <= Decimal('999999999.99'):
        return None
    return amount.quantize(Decimal('0.01'))


def clean_product_fields(data, partial):
    """Validate the product fields shared by "add" and "edit" (the category is handled separately).

    With partial=True only the fields present in `data` are checked (for edits).
    Returns (clean_fields, error_message).
    """
    fields = {}
    if 'name' in data or not partial:
        fields['name'] = str(data.get('name', '')).strip()
        if not 1 <= len(fields['name']) <= 120:
            return None, 'Enter a product name of up to 120 characters.'
    if 'description' in data or not partial:
        fields['description'] = str(data.get('description', '')).strip()
        if len(fields['description']) > 1000:
            return None, 'The description is too long (maximum 1000 characters).'
    if 'image' in data or not partial:
        fields['image'] = str(data.get('image', '')).strip()
        if fields['image'] and (not fields['image'].startswith('https://') or len(fields['image']) > 500):
            return None, 'The image must be an https:// link or an uploaded file.'
    if 'price' in data or not partial:
        fields['price'] = parse_money(data.get('price'))
        if fields['price'] is None:
            return None, 'Enter a valid price.'
    if 'original_price' in data or not partial:
        # The "was" price for a price slash. Empty means "no slash" (and clears an old one when editing).
        raw = data.get('original_price')
        if raw in (None, ''):
            fields['original_price'] = None
        else:
            fields['original_price'] = parse_money(raw)
            if fields['original_price'] is None or fields['original_price'] <= 0:
                return None, 'Enter a valid original price.'
    if 'show_quantity' in data or not partial:
        fields['show_quantity'] = data.get('show_quantity', True)
        if not isinstance(fields['show_quantity'], bool):
            return None, 'Choose whether to show how many are left.'
    if 'stock' in data or not partial:
        try:
            fields['stock'] = int(data.get('stock'))
        except (TypeError, ValueError):
            return None, 'Stock must be a whole number.'
        if not 0 <= fields['stock'] <= 1_000_000:
            return None, 'Stock must be between 0 and 1,000,000.'
    return fields, None


def slash_error(price, original_price):
    """A price slash only makes sense when the original price is higher than the selling price."""
    if original_price is not None and original_price <= price:
        return 'The original price must be higher than the selling price (or remove the price slash).'
    return None


# ----------------------------------------------------------------------------- products
@bp.get('/api/trader/products')
@require_role('trader')
def my_products():
    """The trader's own products: live ones and paused ones (deleted ones are listed separately)."""
    with db() as con:
        rows = con.execute('SELECT * FROM products WHERE trader_id=%s AND deleted_at IS NULL ORDER BY id DESC', (g.user['id'],)).fetchall()
    return jsonify([product_dict(row) for row in rows])


@bp.post('/api/trader/products')
@require_role('trader')
def create_product():
    """Add a product. The category is picked from the list or typed in (new ones are created automatically)."""
    data = request.get_json(silent=True) or {}
    fields, error = clean_product_fields(data, partial=False)
    if not error:
        error = slash_error(fields['price'], fields['original_price'])    # the "was" price must be higher
    if error:
        return jsonify(error=error), 400
    with db() as con:
        category, error = resolve_category(con, data.get('category'), g.user['id'])
        if error:
            return jsonify(error=error), 400
        row = con.execute(
            'INSERT INTO products(trader_id,name,price,original_price,category,description,image,stock,show_quantity) '
            'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
            (g.user['id'], fields['name'], fields['price'], fields['original_price'], category, fields['description'],
             fields['image'], fields['stock'], fields['show_quantity'])).fetchone()
    row['store_name'], row['trader_username'] = g.user['store_name'], g.user['username']
    return jsonify(message=f"Product added to {category} with {fields['stock']} item(s) in stock.", product=product_dict(row))


@bp.patch('/api/trader/products/<int:product_id>')
@require_role('trader')
def update_product(product_id):
    """Edit one of the trader's own products (price, stock, name, description, image or category)."""
    data = request.get_json(silent=True) or {}
    editable = ('name', 'price', 'original_price', 'category', 'description', 'image', 'stock', 'show_quantity')
    data = {key: data[key] for key in editable if key in data}
    if not data:
        return jsonify(error='No product changes were provided.'), 400
    fields, error = clean_product_fields(data, partial=True)
    if error:
        return jsonify(error=error), 400
    with db() as con:
        current = con.execute('SELECT price, original_price, image FROM products WHERE id=%s AND trader_id=%s AND deleted_at IS NULL',
                              (product_id, g.user['id'])).fetchone()
        if not current:
            return jsonify(error='Product not found in your shop.'), 404
        # Check the price slash against what will actually be saved (new values, or the existing ones).
        new_price = fields.get('price', current['price'])
        new_original = fields['original_price'] if 'original_price' in fields else current['original_price']
        error = slash_error(new_price, new_original)
        if error:
            return jsonify(error=error), 400
        if 'category' in data:
            fields['category'], error = resolve_category(con, data['category'], g.user['id'])
            if error:
                return jsonify(error=error), 400
        row = con.execute('UPDATE products SET ' + ', '.join(f'{key}=%s' for key in fields)
                          + ' WHERE id=%s AND trader_id=%s AND deleted_at IS NULL RETURNING *',
                          (*fields.values(), product_id, g.user['id'])).fetchone()
        if row and 'image' in fields and current['image'] and current['image'] != fields['image']:
            image_service.queue_image_deletion(con, current['image'])    # the old picture is no longer used
    if not row:
        return jsonify(error='Product not found in your shop.'), 404
    row['store_name'], row['trader_username'] = g.user['store_name'], g.user['username']
    return jsonify(message='Product updated.', product=product_dict(row))


@bp.post('/api/trader/products/<int:product_id>/pause')
@require_role('trader')
def pause_product(product_id):
    """Pause a product: shoppers can't see or buy it, but nothing is lost and it can be resumed any time."""
    with db() as con:
        row = con.execute('UPDATE products SET is_paused=TRUE, is_active=FALSE WHERE id=%s AND trader_id=%s '
                          'AND deleted_at IS NULL AND NOT is_paused RETURNING *', (product_id, g.user['id'])).fetchone()
    if not row:
        return jsonify(error='Product not found, or it is already paused.'), 404
    return jsonify(message='Product paused. Shoppers can no longer see it. Resume it whenever you like.', product=product_dict(row))


@bp.post('/api/trader/products/<int:product_id>/resume')
@require_role('trader')
def resume_product(product_id):
    """Resume a paused product: it is visible and buyable again."""
    with db() as con:
        row = con.execute('UPDATE products SET is_paused=FALSE, is_active=TRUE WHERE id=%s AND trader_id=%s '
                          'AND deleted_at IS NULL AND is_paused RETURNING *', (product_id, g.user['id'])).fetchone()
    if not row:
        return jsonify(error='Product not found, or it is not paused.'), 404
    return jsonify(message='Product resumed. Shoppers can see it again.', product=product_dict(row))


@bp.delete('/api/trader/products/<int:product_id>')
@require_role('trader')
def delete_product(product_id):
    """Delete a product. It disappears from the shop at once, but is only erased for good (picture included)
    after 30 days, and the trader can restore it until then."""
    with db() as con:
        row = con.execute('UPDATE products SET is_active=FALSE, is_paused=FALSE, deleted_at=NOW() '
                          'WHERE id=%s AND trader_id=%s AND deleted_at IS NULL RETURNING id', (product_id, g.user['id'])).fetchone()
    if not row:
        return jsonify(error='Product not found in your shop.'), 404
    return jsonify(message=f'Product deleted. It will be erased for good in {RECOVERY_DAYS} days. You can restore it until then.')


@bp.get('/api/trader/products/deleted')
@require_role('trader')
def deleted_products():
    """Products deleted in the last 30 days, each with the time left before it is erased for good."""
    with db() as con:
        rows = con.execute(
            f"""SELECT id, name, price, stock, deleted_at,
                       GREATEST(0, EXTRACT(EPOCH FROM (deleted_at + INTERVAL '{RECOVERY_DAYS} days' - NOW())))::int AS seconds_left
                FROM products WHERE trader_id=%s AND deleted_at IS NOT NULL AND purged_at IS NULL
                ORDER BY deleted_at DESC""", (g.user['id'],)).fetchall()
    return jsonify([{**dict(row), 'price': float(row['price']), 'deleted_at': iso(row['deleted_at']),
                     'days_left': math.ceil(row['seconds_left'] / 86400)} for row in rows])


@bp.post('/api/trader/products/<int:product_id>/restore')
@require_role('trader')
def restore_product(product_id):
    """Bring a deleted product back (only possible during the 30 days)."""
    with db() as con:
        row = con.execute('UPDATE products SET is_active=TRUE, is_paused=FALSE, deleted_at=NULL WHERE id=%s AND trader_id=%s '
                          'AND deleted_at IS NOT NULL AND purged_at IS NULL RETURNING *', (product_id, g.user['id'])).fetchone()
    if not row:
        return jsonify(error='This product can no longer be restored.'), 404
    return jsonify(message='Product restored. It is live again.', product=product_dict(row))


# ----------------------------------------------------------------------------- orders to fulfil
@bp.get('/api/trader/orders')
@require_role('trader')
def my_sales():
    """Paid order lines for this trader's products, with the delivery details needed to ship them."""
    with db() as con:
        rows = con.execute("""SELECT oi.id AS item_id, oi.order_id, oi.product_name, oi.quantity, oi.unit_price, oi.fulfilment_status,
                  o.paid_at, o.shipping_name, o.shipping_phone, o.shipping_address, o.shipping_city, o.shipping_state
               FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
               WHERE p.trader_id = %s AND o.status = 'Paid' ORDER BY o.paid_at DESC, oi.id DESC LIMIT 200""",
                           (g.user['id'],)).fetchall()
    lines = [{**dict(row), 'unit_price': float(row['unit_price']), 'paid_at': iso(row['paid_at'])} for row in rows]
    total = sum(Decimal(str(line['unit_price'])) * line['quantity'] for line in lines)
    return jsonify(orders=lines, total_sales=float(total))


@bp.patch('/api/trader/order-items/<int:item_id>')
@require_role('trader')
def update_delivery_status(item_id):
    """Mark an order line as Processing, Shipped or Delivered (only the trader who owns the product can)."""
    status = str((request.get_json(silent=True) or {}).get('fulfilment_status', ''))
    if status not in {'Processing', 'Shipped', 'Delivered'}:
        return jsonify(error='Choose Processing, Shipped or Delivered.'), 400
    with db() as con:
        row = con.execute("""UPDATE order_items oi SET fulfilment_status=%s FROM orders o, products p
               WHERE oi.id=%s AND o.id=oi.order_id AND p.id=oi.product_id AND p.trader_id=%s AND o.status='Paid'
               RETURNING oi.id""", (status, item_id, g.user['id'])).fetchone()
    if not row:
        return jsonify(error='Order line not found.'), 404
    return jsonify(message=f'Marked as {status.lower()}.')
