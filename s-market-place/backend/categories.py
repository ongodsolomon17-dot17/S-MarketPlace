"""Product categories: cleaning typed names, spotting duplicates, and "pick or add" logic.

Traders choose a category from the list or type a new one. To keep search and the
recommendation feed accurate, a typed name is first compared with the existing ones:
"shoe", "Shoes" and "SHOES " all resolve to the same category instead of creating three.
"""
import re
from string import capwords

MAX_NEW_CATEGORIES_PER_DAY = 5      # stops one account from flooding the list
RESERVED_KEYS = {'all'}             # "all" means "no filter" in the shop, so it can't be a category
NAME_PATTERN = re.compile(r"[\w][\w &'/,.+()-]*")


def clean_category_name(raw):
    """Tidy a typed category name. Returns (name, error_message)."""
    name = re.sub(r'\s+', ' ', str(raw or '')).strip()
    if not name:
        return None, 'Choose a category or type a new one.'
    if not 2 <= len(name) <= 40:
        return None, 'A category name must be 2–40 characters long.'
    if not NAME_PATTERN.fullmatch(name):
        return None, 'A category name can only use letters, numbers and simple symbols (& - , . / + ( ) \').'
    if name == name.lower() or name == name.upper():
        name = capwords(name)            # "home decor" -> "Home Decor"; mixed case like "iPhone Cases" is kept
    return name, None


def category_match_key(name):
    """Reduce a name to a comparison key so near-identical names are treated as one category."""
    key = re.sub(r'[\W_]+', '', name.lower().replace('&', ' and '))
    if len(key) > 3 and key.endswith('s') and not key.endswith('ss'):
        key = key[:-1]                   # "shoes" and "shoe" share one key
    return key


def resolve_category(con, raw_name, user_id):
    """Return the canonical name for a category, creating it if it does not exist yet.

    `con` is an open database connection. Returns (canonical_name, error_message).
    """
    name, error = clean_category_name(raw_name)
    if error:
        return None, error
    key = category_match_key(name)
    if key in RESERVED_KEYS:
        return None, 'Please choose a more specific category name.'

    existing = con.execute('SELECT name FROM categories WHERE match_key=%s', (key,)).fetchone()
    if existing:
        return existing['name'], None    # reuse the category that is already in the system

    recent = con.execute(
        "SELECT COUNT(*) AS n FROM categories WHERE created_by=%s AND created_at > NOW() - INTERVAL '1 day'",
        (user_id,)).fetchone()['n']
    if recent >= MAX_NEW_CATEGORIES_PER_DAY:
        return None, 'You can add up to 5 new categories per day. Please pick an existing category.'

    created = con.execute(
        'INSERT INTO categories(name, match_key, created_by) VALUES(%s,%s,%s) '
        'ON CONFLICT (match_key) DO NOTHING RETURNING name', (name, key, user_id)).fetchone()
    if created:
        return created['name'], None
    # Someone created the same category a split second ago; use theirs.
    return con.execute('SELECT name FROM categories WHERE match_key=%s', (key,)).fetchone()['name'], None


def list_categories(con, used_only=False):
    """All categories with the number of live products in each (most popular first)."""
    having = 'HAVING COUNT(p.id) > 0' if used_only else ''
    rows = con.execute(f"""
        SELECT c.name, COUNT(p.id)::int AS product_count
        FROM categories c LEFT JOIN products p ON p.category = c.name AND p.is_active
        GROUP BY c.id {having}
        ORDER BY product_count DESC, c.name""").fetchall()
    return [dict(r) for r in rows]
