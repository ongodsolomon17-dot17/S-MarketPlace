"""The personalised "For you" feed.

HOW IT WORKS (in plain words)
1. Every time someone opens a product, adds it to the cart, taps a category, or buys,
   we remember it (the `interactions` table). Guests are tracked with a random id kept
   in their own browser; signed-in users with their account.
2. Newer actions count more than old ones (a "half-life" of 14 days), and buying counts
   more than adding to cart, which counts more than just looking.
3. To build the feed we collect a pool of candidate products (newest ones, a random
   sample, and products from the categories the person likes), then give each a score:

       score = category liking + shop liking + freshness + popularity + a dash of randomness

   - If we know nothing about the person, the feed is mostly random with a bias to new items.
   - If we know their taste, matching categories rise to the top, but the randomness
     still lets other things appear so the feed keeps surprising them.
4. Finally we shuffle lightly so one trader never fills the screen with 3+ items in a row.

The ranked list is cached for a few minutes per person and per `seed`, so scrolling
("Load more") never repeats or skips products. A new seed (a refresh) gives a new mix.
"""
import hashlib
import time

# How much each kind of action says about someone's taste.
WEIGHTS = {'view': 1.0, 'category': 2.0, 'cart': 4.0, 'purchase': 6.0}
HALF_LIFE_DAYS = 14          # an action's weight halves every 14 days
HISTORY_DAYS = 90            # older actions are ignored (and deleted)

# Size of the candidate pool.
POOL_NEWEST = 300
POOL_RANDOM = 200
POOL_PER_FAVOURITE_CATEGORY = 150
FAVOURITE_CATEGORIES = 3
FEED_LENGTH = 300            # the most products one feed will ever contain

CACHE_SECONDS = 15 * 60
_feed_cache = {}             # (person, seed) -> (expires_at, [product ids])


# ============================================================================ recording what people do
def _actor_clause(user_id, visitor_id):
    """SQL fragment matching "this person": their account and/or their browser's visitor id."""
    parts, params = [], []
    if user_id:
        parts.append('user_id = %s')
        params.append(user_id)
    if visitor_id:
        parts.append('visitor_id = %s')
        params.append(visitor_id)
    if not parts:
        return None, []
    return '(' + ' OR '.join(parts) + ')', params


def record_interaction(con, user_id, visitor_id, kind, product=None, category=''):
    """Remember that someone viewed / carted / bought a product, or tapped a category."""
    clause, params = _actor_clause(user_id, visitor_id)
    if clause is None:
        return                                       # we don't know who this is: nothing to learn
    if product:
        category = product['category']
        # Ignore the same person re-opening the same product within 30 seconds (accidental double taps).
        recent = con.execute(
            f"SELECT 1 FROM interactions WHERE kind=%s AND product_id=%s AND {clause} "
            "AND created_at > NOW() - INTERVAL '30 seconds' LIMIT 1", (kind, product['id'], *params)).fetchone()
        if recent:
            return
    con.execute(
        'INSERT INTO interactions(user_id, visitor_id, product_id, trader_id, category, kind) VALUES(%s,%s,%s,%s,%s,%s)',
        (user_id, visitor_id or '', product['id'] if product else None,
         product['trader_id'] if product else None, category or '', kind))


def record_purchases(con, order_id):
    """Count every item of a paid order as a "purchase" for the buyer (the strongest taste signal)."""
    con.execute("""INSERT INTO interactions(user_id, product_id, trader_id, category, kind)
        SELECT o.buyer_id, oi.product_id, p.trader_id, p.category, 'purchase'
        FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = %s""", (order_id,))


def purge_old_interactions(con):
    """Forget interactions older than the history window."""
    con.execute(f"DELETE FROM interactions WHERE created_at < NOW() - INTERVAL '{HISTORY_DAYS} days'")


# ============================================================================ understanding a person's taste
def load_profile(con, user_id, visitor_id):
    """Summarise a person's recent behaviour.

    Returns {'categories': {name: score}, 'traders': {id: score}, 'views': {product_id: count}}.
    """
    profile = {'categories': {}, 'traders': {}, 'views': {}}
    clause, params = _actor_clause(user_id, visitor_id)
    if clause is None:
        return profile
    rows = con.execute(
        f"""SELECT kind, product_id, trader_id, category, EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 AS age_days
            FROM interactions WHERE {clause} AND created_at > NOW() - INTERVAL '{HISTORY_DAYS} days'
            ORDER BY id DESC LIMIT 500""", params).fetchall()
    for row in rows:
        # Older actions fade: weight * 0.5 ^ (age / half-life).
        weight = WEIGHTS[row['kind']] * 0.5 ** (float(row['age_days']) / HALF_LIFE_DAYS)
        if row['category']:
            profile['categories'][row['category']] = profile['categories'].get(row['category'], 0) + weight
        if row['trader_id']:
            profile['traders'][row['trader_id']] = profile['traders'].get(row['trader_id'], 0) + weight
        if row['kind'] == 'view' and row['product_id']:
            profile['views'][row['product_id']] = profile['views'].get(row['product_id'], 0) + 1
    return profile


def load_popularity(con):
    """How much everyone has been interacting with each product in the last 30 days."""
    rows = con.execute(
        """SELECT product_id,
                  SUM(CASE kind WHEN 'purchase' THEN 6 WHEN 'cart' THEN 4 WHEN 'view' THEN 1 ELSE 0 END) AS score
           FROM interactions WHERE product_id IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'
           GROUP BY product_id ORDER BY score DESC LIMIT 500""").fetchall()
    return {row['product_id']: float(row['score']) for row in rows}


# ============================================================================ choosing and ranking candidates
_CANDIDATE_SELECT = """SELECT p.id, p.trader_id, p.category,
       EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 86400.0 AS age_days
       FROM products p WHERE p.is_active AND p.stock > 0"""


def load_candidates(con, seed, favourite_categories):
    """Gather products worth considering: the newest, a random sample, and the person's favourite categories.

    The "random" parts are ordered by md5(id + seed). That looks random but is the same every
    time for one seed, so paging through the feed is stable.
    """
    pool = {}

    def add(rows):
        for row in rows:
            pool[row['id']] = row

    add(con.execute(_CANDIDATE_SELECT + ' ORDER BY p.id DESC LIMIT %s', (POOL_NEWEST,)).fetchall())
    add(con.execute(_CANDIDATE_SELECT + ' ORDER BY md5(p.id::text || %s) LIMIT %s', (seed, POOL_RANDOM)).fetchall())
    for category in favourite_categories:
        add(con.execute(_CANDIDATE_SELECT + ' AND p.category = %s ORDER BY md5(p.id::text || %s) LIMIT %s',
                        (category, seed, POOL_PER_FAVOURITE_CATEGORY)).fetchall())
    return list(pool.values())


def seeded_random(seed, product_id):
    """A repeatable pseudo-random number between 0 and 1 for this (seed, product) pair."""
    digest = hashlib.md5(f'{seed}:{product_id}'.encode()).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def score_candidates(candidates, profile, popularity, seed):
    """Return the candidates sorted best-first."""
    top_category = max(profile['categories'].values(), default=0)
    top_trader = max(profile['traders'].values(), default=0)
    top_popularity = max(popularity.values(), default=0)
    knows_taste = top_category > 0

    def score(product):
        freshness = 1 / (1 + float(product['age_days']) / 7)                         # 1.0 = brand new, fades over weeks
        crowd = popularity.get(product['id'], 0) / top_popularity if top_popularity else 0
        luck = seeded_random(seed, product['id'])
        if not knows_taste:
            return 1.0 * freshness + 0.8 * crowd + 2.0 * luck                       # mostly random for newcomers
        liking = profile['categories'].get(product['category'], 0) / top_category   # 0..1
        shop = profile['traders'].get(product['trader_id'], 0) / top_trader if top_trader else 0
        already_seen = min(profile['views'].get(product['id'], 0), 5) * 0.15        # don't repeat what they just looked at
        return 3.0 * liking + 1.2 * shop + 0.8 * freshness + 0.6 * crowd + 1.0 * luck - already_seen

    return sorted(candidates, key=score, reverse=True)


def spread_by_trader(ranked, max_in_a_row=2):
    """Re-order so no trader shows more than `max_in_a_row` products back to back."""
    remaining, result = list(ranked), []
    while remaining:
        pick = 0
        for index, product in enumerate(remaining):
            recent = result[-max_in_a_row:]
            if len(recent) < max_in_a_row or any(item['trader_id'] != product['trader_id'] for item in recent):
                pick = index
                break
        result.append(remaining.pop(pick))
    return result


# ============================================================================ the public entry point
def _prune_cache():
    now = time.time()
    for key in [k for k, (expires, _) in _feed_cache.items() if expires < now]:
        del _feed_cache[key]
    if len(_feed_cache) > 500:
        _feed_cache.clear()


def build_feed_ids(con, user_id, visitor_id, seed):
    """The full ranked list of product ids for this person and seed (cached for a few minutes)."""
    person = f'u{user_id}' if user_id else f'v{visitor_id}'
    key = (person, seed)
    cached = _feed_cache.get(key)
    if cached and cached[0] > time.time():
        return cached[1]
    profile = load_profile(con, user_id, visitor_id)
    favourites = [name for name, _ in sorted(profile['categories'].items(), key=lambda item: -item[1])[:FAVOURITE_CATEGORIES]]
    candidates = load_candidates(con, seed, favourites)
    ranked = spread_by_trader(score_candidates(candidates, profile, load_popularity(con), seed))
    ids = [product['id'] for product in ranked][:FEED_LENGTH]
    _prune_cache()
    _feed_cache[key] = (time.time() + CACHE_SECONDS, ids)
    return ids


def feed_page(con, user_id, visitor_id, seed, offset, limit):
    """One page of the feed: (product rows, has_more)."""
    ids = build_feed_ids(con, user_id, visitor_id, seed)
    page_ids = ids[offset:offset + limit]
    if not page_ids:
        return [], False
    rows = con.execute(
        """SELECT p.*, u.store_name, u.username AS trader_username
           FROM products p JOIN users u ON u.id = p.trader_id
           WHERE p.id = ANY(%s) AND p.is_active AND p.stock > 0""", (page_ids,)).fetchall()
    by_id = {row['id']: row for row in rows}
    ordered = [by_id[i] for i in page_ids if i in by_id]       # keep the ranked order; skip anything that just sold out
    return ordered, offset + limit < len(ids)
