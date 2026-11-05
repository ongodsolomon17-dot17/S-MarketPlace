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
admin_mfa_challenge_serializer = URLSafeTimedSerializer(
    config.SECRET_KEY,
    salt='smp-admin-mfa-challenge-v1'
)
VISITOR_ID_PATTERN = re.compile(r'[A-Za-z0-9_-]{8,64}')


def public_user(row):
    """A user row without the password hash, with dates/decimals turned into text."""
    if not row:
        return None
    user = {k: (str(v) if isinstance(v, (datetime, Decimal)) else v) for k, v in dict(row).items() if k != 'password_hash'}
    user['is_admin'] = user['id'] in config.ADMIN_USER_IDS      # set in the ADMIN_USER_IDS environment variable
    return user


def _fingerprint(password_hash):
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def make_token(user_id, password_hash, admin_mfa_verified=False):
    """Create a signed login token; optionally mark admin MFA as verified."""
    return serializer.dumps([
        user_id,
        _fingerprint(password_hash),
        bool(admin_mfa_verified)
    ])

def make_admin_mfa_challenge(user_id, password_hash):
    """Create a five-minute challenge token for an admin completing MFA sign-in."""
    return admin_mfa_challenge_serializer.dumps(
        [user_id, _fingerprint(password_hash)]
    )


def read_admin_mfa_challenge(token):
    """Read a valid, unexpired admin MFA challenge token."""
    return admin_mfa_challenge_serializer.loads(token, max_age=300)


def current_user():
    """The signed-in user for this request (read from the bearer token), or None for guests."""
    if hasattr(g, '_user'):
        return g._user               # already worked out earlier in this request

    g._user = None
    header = request.headers.get('Authorization', '')

    if header.startswith('Bearer '):
        try:
            payload = serializer.loads(
                header[7:],
                max_age=config.TOKEN_MAX_AGE
            )

            if not isinstance(payload, list) or len(payload) not in (2, 3):
                return g._user

            user_id, fingerprint = payload[:2]
            admin_mfa_verified = bool(payload[2]) if len(payload) == 3 else False

            with db() as con:
                row = con.execute(
                    f'SELECT {USER_COLUMNS},password_hash FROM users WHERE id=%s',
                    (user_id,)
                ).fetchone()

            if row and hmac.compare_digest(
                _fingerprint(row['password_hash']),
                str(fingerprint)
            ):
                g._user = public_user(row)
                g._user['_admin_mfa_verified'] = admin_mfa_verified

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


def require_admin(fn):
    """Allow only listed admins, requiring MFA after it has been enabled."""
    @wraps(fn)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify(error='Please sign in first.', needs_auth=True), 401

        if not user['is_admin']:
            return jsonify(error='This area is for the marketplace admin only.'), 403

        with db() as con:
            mfa = con.execute(
                """SELECT enabled_at
                   FROM admin_mfa
                   WHERE admin_user_id=%s AND enabled_at IS NOT NULL""",
                (user['id'],)
            ).fetchone()

        if mfa and not user.get('_admin_mfa_verified', False):
            return jsonify(
                error='Sign in again and enter your authenticator code to access admin tools.',
                mfa_required=True
            ), 403

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
