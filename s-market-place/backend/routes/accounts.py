"""Accounts: sign up, log in, profile settings, password change and image upload."""
import os
import re
import hashlib
import secrets
import payment_service
import subscription_service
import cloudinary.uploader
import psycopg
from flask import Blueprint, current_app, g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

import config
import image_service
from auth import (
    USER_COLUMNS,
    current_user,
    make_admin_mfa_challenge,
    make_token,
    public_user,
    require_login,
    require_role,
    read_admin_mfa_challenge
)
from itsdangerous import BadSignature, SignatureExpired
import mfa_service
from database import db
from helpers import TOO_MANY_MESSAGE, iso, too_many_requests

bp = Blueprint('accounts', __name__)
EMAIL_PATTERN = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


def _too_many():
    return jsonify(error=TOO_MANY_MESSAGE), 429


# ----------------------------------------------------------------------------- sign up / log in
@bp.post('/api/register')
def register():
    """Create a buyer or trader account and sign the new user in."""
    if too_many_requests('register', 8, 600):
        return _too_many()
    data = request.get_json(silent=True) or {}
    role = str(data.get('role', '')).lower()
    first, last = str(data.get('first_name', '')).strip(), str(data.get('last_name', '')).strip()
    username, email = str(data.get('username', '')).strip(), str(data.get('email', '')).strip().lower()
    phone, password = str(data.get('phone', '')).strip(), str(data.get('password', ''))
    store = str(data.get('store_name', '')).strip() if role == 'trader' else ''

    if role not in config.ROLES:
        return jsonify(error='Choose a buyer or trader account.'), 400
    if not all([first, last, username, email, password]):
        return jsonify(error='Please complete all required fields.'), 400
    if len(first) > 80 or len(last) > 80 or len(phone) > 40 or len(store) > 120 or len(email) > 255:
        return jsonify(error='One of the fields is too long.'), 400
    if not EMAIL_PATTERN.match(email):
        return jsonify(error='Enter a valid email address.'), 400
    if not 3 <= len(username) <= 30 or not re.fullmatch(r'[A-Za-z0-9_.-]+', username):
        return jsonify(error='Username must be 3–30 characters and use letters, numbers, dots, underscores or hyphens.'), 400
    if not 8 <= len(password) <= 128:
        return jsonify(error='Password must be between 8 and 128 characters.'), 400
    if role == 'trader' and not store:
        return jsonify(error='Enter your shop name to create a trader account.'), 400

    password_hash = generate_password_hash(password)
    try:
        with db() as con:
            row = con.execute(
                f'INSERT INTO users(role,first_name,last_name,username,email,phone,password_hash,store_name) '
                f'VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING {USER_COLUMNS}',
                (role, first, last, username, email, phone, password_hash, store)).fetchone()
            if role == 'trader':
                con.execute(
                    'INSERT INTO trader_subscriptions(trader_id) VALUES(%s) '
                    'ON CONFLICT (trader_id) DO NOTHING',
                    (row['id'],)
                )
        return jsonify(message=f'{role.title()} account created successfully.', user=public_user(row),
                       token=make_token(row['id'], password_hash))
    except psycopg.errors.UniqueViolation:
        return jsonify(error='That username or email is already registered. Try signing in instead.'), 409


@bp.post('/api/login')
def login():
    """Sign in with a username or email plus password."""
    if too_many_requests('login', 10, 300):
        return _too_many()

    data = request.get_json(silent=True) or {}
    identity = str(data.get('identity', '')).strip()
    password = str(data.get('password', ''))

    with db() as con:
        row = con.execute(
            'SELECT * FROM users WHERE LOWER(username)=LOWER(%s) OR LOWER(email)=LOWER(%s)',
            (identity, identity)
        ).fetchone()

    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify(error='Incorrect username/email or password.'), 401

    if row['id'] in config.ADMIN_USER_IDS:
        with db() as con:
            mfa = con.execute(
                """SELECT enabled_at
                   FROM admin_mfa
                   WHERE admin_user_id=%s AND enabled_at IS NOT NULL""",
                (row['id'],)
            ).fetchone()

        if mfa:
            return jsonify(
                message='Enter the code from your authenticator app.',
                mfa_required=True,
                challenge=make_admin_mfa_challenge(row['id'], row['password_hash'])
            )

    return jsonify(
        message='You are now signed in.',
        user=public_user(row),
        token=make_token(row['id'], row['password_hash'])
    )

@bp.post('/api/admin/mfa/login')
def complete_admin_mfa_login():
    data = request.get_json(silent=True) or {}
    challenge = str(data.get('challenge', '')).strip()
    code = str(data.get('code', '')).strip()
    recovery_code = str(data.get('recovery_code', '')).strip().upper()

    if not challenge or (not code and not recovery_code):
        return jsonify(error='Enter an authenticator code or recovery code.'), 400

    if too_many_requests(f'admin-mfa-login:{challenge[:32]}', 10, 300):
        return _too_many()

    try:
        payload = read_admin_mfa_challenge(challenge)
    except (BadSignature, SignatureExpired, TypeError, ValueError):
        return jsonify(error='Your sign-in challenge expired. Sign in again.'), 401

    if not isinstance(payload, list) or len(payload) != 2:
        return jsonify(error='Your sign-in challenge is invalid. Sign in again.'), 401

    user_id = payload[0]
    if not isinstance(user_id, int) or user_id not in config.ADMIN_USER_IDS:
        return jsonify(error='This sign-in challenge is invalid.'), 401

    with db() as con:
        row = con.execute(
            """SELECT u.password_hash, m.secret_encrypted, m.last_used_step
               FROM users u
               JOIN admin_mfa m ON m.admin_user_id = u.id
               WHERE u.id=%s AND m.enabled_at IS NOT NULL""",
            (user_id,)
        ).fetchone()

    if not row:
        return jsonify(error='Authenticator MFA is not enabled for this admin.'), 401

    if code:
        secret = mfa_service.decrypt_secret(row['secret_encrypted'])
        matched_step = mfa_service.matching_totp_step(secret, code)

        if matched_step is None:
            return jsonify(error='That authenticator code is invalid or expired.'), 401

        with db() as con:
            accepted = con.execute(
                """UPDATE admin_mfa
                   SET last_used_step=%s, updated_at=NOW()
                   WHERE admin_user_id=%s
                     AND enabled_at IS NOT NULL
                     AND last_used_step < %s
                   RETURNING admin_user_id""",
                (matched_step, user_id, matched_step)
            ).fetchone()

        if not accepted:
            return jsonify(error='That code was already used. Enter the current code.'), 401

    else:
        if not re.fullmatch(r'[A-F0-9]{16}', recovery_code):
            return jsonify(error='That recovery code is invalid.'), 401

        recovery_hash = hashlib.sha256(recovery_code.encode('ascii')).hexdigest()

        with db() as con:
            consumed = con.execute(
                """UPDATE admin_mfa_recovery_codes
                   SET used_at=NOW()
                   WHERE admin_user_id=%s
                     AND code_hash=%s
                     AND used_at IS NULL
                   RETURNING id""",
                (user_id, recovery_hash)
            ).fetchone()

        if not consumed:
            return jsonify(error='That recovery code is invalid or has already been used.'), 401

    return jsonify(
        message='You are now signed in.',
        token=make_token(user_id, row['password_hash'], admin_mfa_verified=True)
    )

@bp.post('/api/logout')
def logout():
    """Tokens live in the browser, so signing out is done there; this just confirms."""
    return jsonify(message='Signed out.')

@bp.get('/api/trader/subscription')
@require_role('trader')
def trader_subscription():
    with db() as con:
        row = con.execute(
            """SELECT status, plan, trial_starts_at, trial_ends_at,
                      current_period_starts_at, current_period_ends_at, auto_renew,
                      (
                          (status = 'trial' AND trial_ends_at > NOW())
                          OR
                          (status = 'active' AND current_period_ends_at > NOW())
                      ) AS can_add_products
               FROM trader_subscriptions
               WHERE trader_id=%s
               FOR UPDATE""",
            (g.user['id'],)
        ).fetchone()

        plan_rows = con.execute(
            'SELECT plan, price_ngn FROM trader_subscription_plans ORDER BY plan'
        ).fetchall()

        if row and row['status'] in ('trial', 'active') and not row['can_add_products']:
            con.execute(
                """UPDATE trader_subscriptions
                   SET status='expired', updated_at=NOW()
                   WHERE trader_id=%s AND status IN ('trial', 'active')""",
                (g.user['id'],)
            )

    plans = {
        plan_row['plan']: int(plan_row['price_ngn'])
        for plan_row in plan_rows
    }

    if not row:
        return jsonify(subscription=None, plans=plans)

    subscription = dict(row)

    if subscription['status'] in ('trial', 'active') and not subscription['can_add_products']:
        subscription['status'] = 'expired'

    for field in (
        'trial_starts_at',
        'trial_ends_at',
        'current_period_starts_at',
        'current_period_ends_at'
    ):
        subscription[field] = iso(subscription[field])

    return jsonify(subscription=subscription, plans=plans)

@bp.post('/api/trader/subscription/checkout')
@require_role('trader')
def start_trader_subscription_checkout():
    if too_many_requests(f'subscription-checkout:{g.user["id"]}', 5, 300):
        return _too_many()

    data = request.get_json(silent=True) or {}
    plan = str(data.get('plan', '')).strip()
    auto_renew = data.get('auto_renew', False)

    if plan not in ('monthly', 'yearly'):
        return jsonify(error='Choose a monthly or yearly plan.'), 400

    if not isinstance(auto_renew, bool):
        return jsonify(error='Choose whether to turn on auto-renew.'), 400

    reference = f'SMP-SUB-{g.user["id"]}-{secrets.token_hex(10)}'

    with db() as con:
        subscription = con.execute(
            'SELECT trader_id FROM trader_subscriptions WHERE trader_id=%s FOR UPDATE',
            (g.user['id'],)
        ).fetchone()

        if not subscription:
            return jsonify(error='Your trader subscription record was not found.'), 404

        plan_row = con.execute(
            """SELECT price_ngn, paystack_plan_code
               FROM trader_subscription_plans
               WHERE plan=%s
               FOR UPDATE""",
            (plan,)
        ).fetchone()

        if not plan_row:
            return jsonify(error='That subscription plan is unavailable.'), 404

        plan_code = plan_row['paystack_plan_code']

        if auto_renew:
            try:
                plan_code = payment_service.paystack_sync_subscription_plan(
                    plan, plan_row['price_ngn'], plan_code
                )
            except Exception:
                current_app.logger.exception('Could not sync the Paystack subscription plan.')
                return jsonify(error='Could not prepare this plan with Paystack.'), 502

            con.execute(
                """UPDATE trader_subscription_plans
                   SET paystack_plan_code=%s, updated_at=NOW()
                   WHERE plan=%s""",
                (plan_code, plan)
            )

        con.execute(
            """INSERT INTO trader_subscription_payments
                   (trader_id, plan, amount_ngn, auto_renew, reference, paystack_plan_code)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (
                g.user['id'],
                plan,
                plan_row['price_ngn'],
                auto_renew,
                reference,
                plan_code if auto_renew else None
            )
        )

    try:
        checkout_url = payment_service.paystack_initialize_trader_subscription(
            g.user['id'],
            reference,
            g.user['email'],
            plan_row['price_ngn'],
            plan_code if auto_renew else None
        )
    except Exception:
        current_app.logger.exception('Could not initialize trader subscription payment.')
        with db() as con:
            con.execute(
                """UPDATE trader_subscription_payments
                   SET status='failed', updated_at=NOW()
                   WHERE reference=%s AND status='pending'""",
                (reference,)
            )
        return jsonify(error='Could not start the subscription payment. Please try again.'), 502

    return jsonify(checkout_url=checkout_url, reference=reference)

@bp.post('/api/trader/subscription/verify')
@require_role('trader')
def verify_trader_subscription_payment():
    if too_many_requests(f'subscription-verify:{g.user["id"]}', 10, 300):
        return _too_many()

    data = request.get_json(silent=True) or {}
    reference = str(data.get('reference', '')).strip()

    expected_reference = rf'SMP-SUB-{g.user["id"]}-[a-f0-9]{{20}}'
    if not re.fullmatch(expected_reference, reference):
        return jsonify(error='That subscription payment reference is not valid.'), 400

    with db() as con:
        payment = con.execute(
            """SELECT status
               FROM trader_subscription_payments
               WHERE reference=%s AND trader_id=%s""",
            (reference, g.user['id'])
        ).fetchone()

    if not payment:
        return jsonify(error='Subscription payment not found.'), 404

    if payment['status'] == 'paid':
        return jsonify(paid=True, message='Your subscription payment is already confirmed.')

    if payment['status'] != 'pending':
        return jsonify(paid=False, message='This subscription payment is no longer pending.'), 409

    try:
        verified = payment_service.paystack_verify(reference)
    except Exception:
        current_app.logger.exception('Paystack subscription verification failed.')
        return jsonify(error='Could not reach Paystack to confirm payment. Try again shortly.'), 502

    if not verified or verified.get('status') != 'success':
        return jsonify(
            paid=False,
            message='Payment has not been confirmed yet. You can try checking again shortly.'
        )

    if verified.get('reference') != reference:
        return jsonify(error='Paystack returned a different payment reference.'), 409

    with db() as con:
        result = subscription_service.settle_trader_subscription_payment(
            con,
            reference,
            int(verified.get('amount', 0)),
            verified.get('currency'),
            verified.get('id')
        )

    if result in ('paid', 'already_paid'):
        return jsonify(paid=True, message='Payment confirmed. Your subscription is active.')

    if result == 'amount_mismatch':
        current_app.logger.error('Subscription payment amount or currency mismatch for %s.', reference)
        return jsonify(error='The payment amount could not be verified. Contact support.'), 409

    return jsonify(error='This subscription payment could not be settled.'), 409


@bp.post('/api/trader/subscription/auto-renew/disable')
@require_role('trader')
def disable_trader_subscription_auto_renew():
    if too_many_requests(f'subscription-auto-renew:{g.user["id"]}', 5, 300):
        return _too_many()

    with db() as con:
        subscription = con.execute(
            """SELECT auto_renew, paystack_subscription_code,
                      paystack_subscription_email_token_encrypted
               FROM trader_subscriptions
               WHERE trader_id=%s
               FOR UPDATE""",
            (g.user['id'],)
        ).fetchone()

    if not subscription:
        return jsonify(error='Your subscription record was not found.'), 404

    if not subscription['auto_renew']:
        return jsonify(message='Auto-renew is already off.')

    if (
        not subscription['paystack_subscription_code']
        or not subscription['paystack_subscription_email_token_encrypted']
    ):
        return jsonify(
            error='The recurring subscription details are not ready yet. Please try again shortly.'
        ), 409

    try:
        email_token = mfa_service.decrypt_secret(
            subscription['paystack_subscription_email_token_encrypted']
        )
        payment_service.paystack_disable_subscription(
            subscription['paystack_subscription_code'],
            email_token
        )
    except Exception:
        current_app.logger.exception('Could not disable Paystack subscription.')
        return jsonify(error='Could not turn off auto-renew with Paystack. Please try again.'), 502

    with db() as con:
        con.execute(
            """UPDATE trader_subscriptions
               SET auto_renew=FALSE, updated_at=NOW()
               WHERE trader_id=%s""",
            (g.user['id'],)
        )

    return jsonify(
        message='Auto-renew is off. Your current paid access remains until its end date.'
    )


@bp.get('/api/me')
def me():
    """Who am I? Returns the signed-in user, or null for guests."""
    return jsonify(user=current_user())


# ----------------------------------------------------------------------------- settings
@bp.patch('/api/profile/edit')
@require_login
def edit_profile():
    """Change personal details (and, for traders, the shop name and description)."""
    user = g.user
    data = request.get_json(silent=True) or {}
    editable = {'first_name', 'last_name', 'email', 'phone', 'store_name', 'store_description'}
    fields = {key: str(data[key]).strip() for key in editable if key in data}
    if user['role'] != 'trader':                       # buyers have no shop details
        fields.pop('store_name', None)
        fields.pop('store_description', None)

    if 'email' in fields:
        fields['email'] = fields['email'].lower()
        if not EMAIL_PATTERN.match(fields['email']) or len(fields['email']) > 255:
            return jsonify(error='Enter a valid email address.'), 400
    if 'first_name' in fields and not 2 <= len(fields['first_name']) <= 80:
        return jsonify(error='First name must contain 2–80 characters.'), 400
    if 'last_name' in fields and not 2 <= len(fields['last_name']) <= 80:
        return jsonify(error='Last name must contain 2–80 characters.'), 400
    if 'store_name' in fields and not 1 <= len(fields['store_name']) <= 120:
        return jsonify(error='Shop name must contain 1–120 characters.'), 400
    if 'phone' in fields and len(fields['phone']) > 40:
        return jsonify(error='Phone number is too long.'), 400
    if 'store_description' in fields and len(fields['store_description']) > 1000:
        return jsonify(error='Shop description is too long (maximum 1000 characters).'), 400
    if not fields:
        return jsonify(error='No profile changes were provided.'), 400

    try:
        with db() as con:
            row = con.execute('UPDATE users SET ' + ', '.join(f'{key}=%s' for key in fields)
                              + f' WHERE id=%s RETURNING {USER_COLUMNS}', (*fields.values(), user['id'])).fetchone()
        return jsonify(message='Profile updated successfully.', user=public_user(row))
    except psycopg.errors.UniqueViolation:
        return jsonify(error='That email is already in use.'), 409


@bp.post('/api/profile/password')
@require_login
def change_password():
    """Change the password. Other devices are signed out; this device gets a fresh token."""
    if too_many_requests('password', 5, 300):
        return _too_many()
    data = request.get_json(silent=True) or {}
    current, new = str(data.get('current_password', '')), str(data.get('new_password', ''))
    if not 8 <= len(new) <= 128:
        return jsonify(error='The new password must be between 8 and 128 characters.'), 400
    with db() as con:
        row = con.execute('SELECT password_hash FROM users WHERE id=%s', (g.user['id'],)).fetchone()
        if not row or not check_password_hash(row['password_hash'], current):
            return jsonify(error='Your current password is incorrect.'), 400
        new_hash = generate_password_hash(new)
        con.execute('UPDATE users SET password_hash=%s WHERE id=%s', (new_hash, g.user['id']))
    return jsonify(message='Password changed. Other devices have been signed out.', token=make_token(g.user['id'], new_hash))


# ----------------------------------------------------------------------------- images (Cloudinary)
@bp.post('/api/upload-image')
@require_login
def upload_image():
    """Upload a profile or product picture to Cloudinary (Render's disk is wiped on every deploy)."""
    file = request.files.get('image')
    if not file or not file.filename:
        return jsonify(error='Choose an image file first.'), 400
    if file.mimetype not in {'image/jpeg', 'image/png', 'image/webp'}:
        return jsonify(error='Only JPG, PNG or WebP images are allowed.'), 400
    if not all(os.environ.get(name) for name in ('CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET')):
        return jsonify(error='Image storage is not configured yet. Add the Cloudinary variables on Render.'), 503
    try:
        result = cloudinary.uploader.upload(file, folder='s-market-place', resource_type='image',
                                            transformation=[{'width': 1200, 'height': 1200, 'crop': 'limit'}])
        return jsonify(url=result['secure_url'])
    except Exception:    # noqa: BLE001
        current_app.logger.exception('Cloudinary upload failed')
        return jsonify(error='Image upload failed. Please try again.'), 502


@bp.patch('/api/profile/image')
@require_login
def update_profile_image():
    """Save an uploaded picture as the user's profile picture."""
    url = str((request.get_json(silent=True) or {}).get('profile_image', '')).strip()
    if not url.startswith('https://') or len(url) > 500:
        return jsonify(error='A secure image URL is required.'), 400
    with db() as con:
        old = con.execute('SELECT profile_image FROM users WHERE id=%s', (g.user['id'],)).fetchone()['profile_image']
        row = con.execute(f'UPDATE users SET profile_image=%s WHERE id=%s RETURNING {USER_COLUMNS}',
                          (url, g.user['id'])).fetchone()
        if old and old != url:
            image_service.queue_image_deletion(con, old)     # the old picture is no longer used
    return jsonify(message='Profile picture updated.', user=public_user(row))
