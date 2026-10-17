"""Trader tools: manage products (with categories and stock) and fulfil paid orders."""
from decimal import Decimal

import psycopg
from flask import Blueprint, g, jsonify, request

from auth import require_role
from categories import resolve_category
from database import db
from helpers import iso, product_dict

bp = Blueprint('seller', __name__)


# ----------------------------------------------------------------------------- product validation
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
        try:
            fields['price'] = Decimal(str(data.get('price')))
        except Exception:    # noqa: BLE001
            return None, 'Enter a valid price.'
        if not fields['price'].is_finite() or not 0 <= fields['price'] <= Decimal('999999999.99'):
            return None, 'Enter a valid price.'
        fields['price'] = fields['price'].quantize(Decimal('0.01'))
    if 'stock' in data or not partial:
        try:
            fields['stock'] = int(data.get('stock'))
        except (TypeError, ValueError):
            return None, 'Stock must be a whole number.'
        if not 0 <= fields['stock'] <= 1_000_000:
            return None, 'Stock must be between 0 and 1,000,000.'
    return fields, None


# ----------------------------------------------------------------------------- products
@bp.get('/api/trader/products')
@require_role('trader')
def my_products():
    """The trader's own live products."""
    with db() as con:
        rows = con.execute('SELECT * FROM products WHERE trader_id=%s AND is_active ORDER BY id DESC', (g.user['id'],)).fetchall()
    return jsonify([product_dict(row) for row in rows])


@bp.post('/api/trader/products')
@require_role('trader')
def create_product():
    """Add a product. The category is picked from the list or typed in (new ones are created automatically)."""
    data = request.get_json(silent=True) or {}
    fields, error = clean_product_fields(data, partial=False)
    if error:
        return jsonify(error=error), 400
    with db() as con:
        category, error = resolve_category(con, data.get('category'), g.user['id'])
        if error:
            return jsonify(error=error), 400
        row = con.execute(
            'INSERT INTO products(trader_id,name,price,category,description,image,stock) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *',
            (g.user['id'], fields['name'], fields['price'], category, fields['description'], fields['image'], fields['stock'])).fetchone()
    row['store_name'], row['trader_username'] = g.user['store_name'], g.user['username']
    return jsonify(message=f"Product added to {category} with {fields['stock']} item(s) in stock.", product=product_dict(row))


@bp.patch('/api/trader/products/<int:product_id>')
@require_role('trader')
def update_product(product_id):
    """Edit one of the trader's own products (price, stock, name, description, image or category)."""
    data = request.get_json(silent=True) or {}
    data = {key: data[key] for key in ('name', 'price', 'category', 'description', 'image', 'stock') if key in data}
    if not data:
        return jsonify(error='No product changes were provided.'), 400
    fields, error = clean_product_fields(data, partial=True)
    if error:
        return jsonify(error=error), 400
    with db() as con:
        if 'category' in data:
            fields['category'], error = resolve_category(con, data['category'], g.user['id'])
            if error:
                return jsonify(error=error), 400
        row = con.execute('UPDATE products SET ' + ', '.join(f'{key}=%s' for key in fields)
                          + ' WHERE id=%s AND trader_id=%s AND is_active RETURNING *',
                          (*fields.values(), product_id, g.user['id'])).fetchone()
    if not row:
        return jsonify(error='Product not found in your shop.'), 404
    row['store_name'], row['trader_username'] = g.user['store_name'], g.user['username']
    return jsonify(message='Product updated.', product=product_dict(row))


@bp.delete('/api/trader/products/<int:product_id>')
@require_role('trader')
def delete_product(product_id):
    """Delete a product. If it already appears in orders it is hidden instead, so order history stays intact."""
    hidden_message = 'This product has past orders, so it was hidden from your shop instead of deleted.'

    def hide():
        with db() as con:
            return con.execute('UPDATE products SET is_active=FALSE, stock=0 WHERE id=%s AND trader_id=%s AND is_active RETURNING id',
                               (product_id, g.user['id'])).fetchone()

    with db() as con:
        has_orders = con.execute('SELECT 1 FROM order_items WHERE product_id=%s LIMIT 1', (product_id,)).fetchone()
    if has_orders:
        found, message = hide(), hidden_message
    else:
        try:
            with db() as con:
                found = con.execute('DELETE FROM products WHERE id=%s AND trader_id=%s RETURNING id', (product_id, g.user['id'])).fetchone()
            message = 'Product removed from your shop.'
        except psycopg.errors.ForeignKeyViolation:      # an order was placed a split second ago
            found, message = hide(), hidden_message
    if not found:
        return jsonify(error='Product not found in your shop.'), 404
    return jsonify(message=message)


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
