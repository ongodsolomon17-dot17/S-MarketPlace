"""Accounts: sign up, log in, profile settings, password change and image upload."""
import os
import re

import cloudinary.uploader
import psycopg
from flask import Blueprint, current_app, g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

import config
import image_service
from auth import USER_COLUMNS, current_user, make_token, public_user, require_login
from database import db
from helpers import TOO_MANY_MESSAGE, too_many_requests

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
    identity, password = str(data.get('identity', '')).strip(), str(data.get('password', ''))
    with db() as con:
        row = con.execute('SELECT * FROM users WHERE LOWER(username)=LOWER(%s) OR LOWER(email)=LOWER(%s)',
                          (identity, identity)).fetchone()
    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify(error='Incorrect username/email or password.'), 401
    return jsonify(message='You are now signed in.', user=public_user(row), token=make_token(row['id'], row['password_hash']))


@bp.post('/api/logout')
def logout():
    """Tokens live in the browser, so signing out is done there; this just confirms."""
    return jsonify(message='Signed out.')


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
