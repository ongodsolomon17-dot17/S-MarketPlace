"""Who is making this request? Signed login tokens, role checks, and the guest "visitor id"."""
import hashlib
import hmac
import re
from datetime import datetime
from decimal import Decimal
from functools import wraps

from flask import g, jsonify, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

import config
from database import db

# Columns of the users table that are safe to send to the browser (never the password hash).
USER_COLUMNS = 'id,role,first_name,last_name,username,email,phone,store_name,store_description,profile_image,created_at'

serializer = URLSafeTimedSerializer(config.SECRET_KEY, salt='smp-auth-v1')
VISITOR_ID_PATTERN = re.compile(r'[A-Za-z0-9_-]{8,64}')


def public_user(row):
    """A user row without the password hash, with dates/decimals turned into text."""
    if not row:
        return None
    return {k: (str(v) if isinstance(v, (datetime, Decimal)) else v) for k, v in dict(row).items() if k != 'password_hash'}


def _fingerprint(password_hash):
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def make_token(user_id, password_hash):
    """Create a signed login token.

    It carries the user id plus a fingerprint of the password, so changing the
    password automatically signs the user out of every other device.
    """
    return serializer.dumps([user_id, _fingerprint(password_hash)])


def current_user():
    """The signed-in user for this request (read from the bearer token), or None for guests."""
    if hasattr(g, '_user'):
        return g._user               # already worked out earlier in this request
    g._user = None
    header = request.headers.get('Authorization', '')
    if header.startswith('Bearer '):
        try:
            user_id, fingerprint = serializer.loads(header[7:], max_age=config.TOKEN_MAX_AGE)
            with db() as con:
                row = con.execute(f'SELECT {USER_COLUMNS},password_hash FROM users WHERE id=%s', (user_id,)).fetchone()
            if row and hmac.compare_digest(_fingerprint(row['password_hash']), str(fingerprint)):
                g._user = public_user(row)
        except (BadSignature, SignatureExpired, TypeError, ValueError):
            pass                     # bad or expired token: treat as a guest
    return g._user


def visitor_id():
    """The random id the browser keeps for guests (sent in the X-Visitor-Id header), or '' if missing/invalid."""
    value = request.headers.get('X-Visitor-Id', '')
    return value if VISITOR_ID_PATTERN.fullmatch(value) else ''


def require_login(fn):
    """Route decorator: any signed-in user. The user is available as `g.user`."""
    @wraps(fn)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify(error='Please sign in first.', needs_auth=True), 401
        g.user = user
        return fn(*args, **kwargs)
    return wrapped


def require_role(role):
    """Route decorator: only a 'buyer' or only a 'trader' may use this route."""
    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            user = current_user()
            if not user:
                return jsonify(error='Please sign in or create an account first.', needs_auth=True), 401
            if user['role'] != role:
                return jsonify(error=f'This action requires a {role} account.'), 403
            g.user = user
            return fn(*args, **kwargs)
        return wrapped
    return decorator
