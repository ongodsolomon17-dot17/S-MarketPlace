"""Fast Finger: short, time-limited price-slash deals.

Traders post a deal (a product with a percentage knocked off and a countdown). When the
countdown ends the deal shows as "Ended"; the trader can also mark it "Sold". Either way it
stays visible for 24 hours, then the system deletes it (the trader can delete it sooner).
"""

from flask import Blueprint, g, jsonify, request

import image_service
import maintenance
from auth import require_role
from database import db
from helpers import TOO_MANY_MESSAGE, discount_percent, iso, too_many_requests
from routes.seller import parse_money

bp = Blueprint('deals', __name__)

MIN_MINUTES, MAX_MINUTES = 5, 1440         # a deal runs between 5 minutes and 24 hours
MAX_LIVE_DEALS_PER_TRADER = 10

# Every deal query starts from this. The inner SELECT works out two things on the database
# clock (so a wrong phone clock can't cheat the countdown):
#   status        'sold' | 'ended' | 'live'
#   seconds_left  time remaining (0 once finished)
# and keeps only deals that finished less than 24 hours ago.
DEAL_SELECT = """
    SELECT * FROM (
        SELECT d.*, u.store_name, u.username AS trader_username,
               CASE WHEN d.sold_at IS NOT NULL THEN 'sold'
                    WHEN d.ends_at <= NOW() THEN 'ended'
                    ELSE 'live' END AS status,
               GREATEST(0, EXTRACT(EPOCH FROM (d.ends_at - NOW())))::int AS seconds_left
        FROM flash_deals d JOIN users u ON u.id = d.trader_id
        WHERE LEAST(d.sold_at, d.ends_at) >= NOW() - INTERVAL '24 hours'
    ) deal
"""
# Live deals first (ending soonest at the top), then finished ones (most recent first).
DEAL_ORDER = ("ORDER BY (status = 'live') DESC, CASE WHEN status = 'live' THEN ends_at END ASC NULLS LAST, "
              "COALESCE(sold_at, ends_at) DESC")


def deal_dict(row):
    """A deal row shaped for the frontend."""
    deal = dict(row)
    deal['discount_percent'] = discount_percent(deal['original_price'], deal['price'])
    deal['price'] = float(deal['price'])
    deal['original_price'] = float(deal['original_price'])
    for key in ('ends_at', 'sold_at', 'created_at'):
        deal[key] = iso(deal.get(key))
    return deal


# ----------------------------------------------------------------------------- everyone can see deals
@bp.get('/api/deals')
def list_deals():
    """All current deals: live ones with their countdown, and recently ended or sold ones."""
    maintenance.run_periodically()
    with db() as con:
        rows = con.execute(f'{DEAL_SELECT} {DEAL_ORDER} LIMIT 100').fetchall()
    return jsonify(deals=[deal_dict(row) for row in rows])


# ----------------------------------------------------------------------------- traders post and manage deals
@bp.post('/api/trader/deals')
@require_role('trader')
def post_deal():
    """Post a new deal: title, the original price, the slashed price and how long it runs."""
    if too_many_requests('deal', 30, 3600):
        return jsonify(error=TOO_MANY_MESSAGE), 429
    data = request.get_json(silent=True) or {}
    title, description = str(data.get('title', '')).strip(), str(data.get('description', '')).strip()
    image = str(data.get('image', '')).strip()
    original, price = parse_money(data.get('original_price')), parse_money(data.get('price'))
    try:
        minutes = int(data.get('duration_minutes'))
    except (TypeError, ValueError):
        minutes = 0

    if not 1 <= len(title) <= 120:
        return jsonify(error='Enter a deal title of up to 120 characters.'), 400
    if len(description) > 300:
        return jsonify(error='Keep the description under 300 characters.'), 400
    if image and (not image.startswith('https://') or len(image) > 500):
        return jsonify(error='The image must be an https:// link or an uploaded file.'), 400
    if original is None or price is None or original <= 0:
        return jsonify(error='Enter a valid original price and discount.'), 400
    if price >= original:
        return jsonify(error='The deal price must be lower than the original price.'), 400
    if not MIN_MINUTES <= minutes <= MAX_MINUTES:
        return jsonify(error='Choose how long the deal should run (5 minutes to 24 hours).'), 400

    with db() as con:
        live = con.execute("SELECT COUNT(*) AS n FROM flash_deals WHERE trader_id=%s AND sold_at IS NULL AND ends_at > NOW()",
                           (g.user['id'],)).fetchone()['n']
        if live >= MAX_LIVE_DEALS_PER_TRADER:
            return jsonify(error=f'You can have up to {MAX_LIVE_DEALS_PER_TRADER} live deals at a time. Delete or wait for one to end.'), 400
        row = con.execute(
            "INSERT INTO flash_deals(trader_id,title,description,image,original_price,price,ends_at) "
            "VALUES(%s,%s,%s,%s,%s,%s, NOW() + %s::int * INTERVAL '1 minute') RETURNING id",
            (g.user['id'], title, description, image, original, price, minutes)).fetchone()
        deal = con.execute(f'{DEAL_SELECT} WHERE id = %s', (row['id'],)).fetchone()
    return jsonify(message='Your deal is live!', deal=deal_dict(deal))


@bp.post('/api/trader/deals/<int:deal_id>/sold')
@require_role('trader')
def mark_deal_sold(deal_id):
    """Mark a deal as sold (it stops counting down and shows "Sold")."""
    with db() as con:
        done = con.execute('UPDATE flash_deals SET sold_at = NOW() WHERE id=%s AND trader_id=%s AND sold_at IS NULL RETURNING id',
                           (deal_id, g.user['id'])).fetchone()
    if not done:
        return jsonify(error='Deal not found, or it is already marked as sold.'), 404
    return jsonify(message='Marked as sold. It will be removed automatically after 24 hours.')


@bp.delete('/api/trader/deals/<int:deal_id>')
@require_role('trader')
def delete_deal(deal_id):
    """Delete one of your deals right away."""
    with db() as con:
        done = con.execute('DELETE FROM flash_deals WHERE id=%s AND trader_id=%s RETURNING id, image', (deal_id, g.user['id'])).fetchone()
        if done:
            image_service.queue_image_deletion(con, done['image'])   # remove the picture from Cloudinary too
    if not done:
        return jsonify(error='Deal not found.'), 404
    return jsonify(message='Deal deleted.')
