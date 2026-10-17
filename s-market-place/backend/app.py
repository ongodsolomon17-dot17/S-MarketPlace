"""S-Market Place API - the entry point. Gunicorn runs it as `app:app`.

Project map (backend/):
    config.py           settings from environment variables
    database.py         connecting to Neon + creating/upgrading tables
    auth.py             login tokens and "who is this?" helpers
    categories.py       product categories (pick from the list or type a new one)
    feed.py             the personalised "For you" recommendation feed
    order_service.py    cancelling, expiring and settling orders
    payment_service.py  Paystack
    maintenance.py      periodic housekeeping
    routes/             the web endpoints: accounts, shop, orders, seller
"""
import os

import cloudinary
import psycopg
from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

import config
from database import db, ensure_schema
from routes import accounts, orders, seller, shop


def create_app():
    """Build and configure the Flask application."""
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024               # reject uploads over 5 MB
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)         # trust Render's proxy for the real visitor IP

    # Only the Vercel site(s) listed in FRONTEND_ORIGIN may call this API from a browser.
    CORS(app, origins=config.ORIGINS, supports_credentials=False,
         allow_headers=['Content-Type', 'Authorization', 'X-Visitor-Id'],
         methods=['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'])

    cloudinary.config(cloud_name=os.environ.get('CLOUDINARY_CLOUD_NAME'), api_key=os.environ.get('CLOUDINARY_API_KEY'),
                      api_secret=os.environ.get('CLOUDINARY_API_SECRET'), secure=True)

    for blueprint in (accounts.bp, shop.bp, orders.bp, seller.bp):
        app.register_blueprint(blueprint)

    register_hooks(app)
    register_error_handlers(app)
    return app


def register_hooks(app):
    """Things that run around every request."""

    @app.before_request
    def make_sure_tables_exist():
        if request.path.startswith('/api/'):
            ensure_schema()

    @app.after_request
    def add_security_headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.get('/api/health')
    def health():
        """Open /api/health after deploying: it reports whether the database and payments are set up."""
        try:
            with db() as con:
                con.execute('SELECT 1')
            return jsonify(status='ok', database='connected',
                           payments='configured' if config.PAYSTACK_SECRET_KEY else 'not configured')
        except Exception:    # noqa: BLE001
            app.logger.exception('Health check failed')
            return jsonify(status='error', error='Database connection failed'), 503


def register_error_handlers(app):
    """Always answer with JSON, so the frontend never has to parse an HTML error page."""

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify(error='The image is too large. Maximum size is 5MB.'), 413

    @app.errorhandler(psycopg.OperationalError)
    def database_unavailable(_error):
        app.logger.exception('Database unavailable')
        return jsonify(error='The database is waking up. Please try again in a few seconds.'), 503

    @app.errorhandler(Exception)
    def unexpected_error(error):
        if isinstance(error, HTTPException):                          # 404, 405 and friends
            return jsonify(error=error.description), error.code
        app.logger.exception('Unhandled error')
        return jsonify(error='Something went wrong on our side. Please try again.'), 500


# Create the tables at start-up if Neon is reachable; otherwise the first request retries.
try:
    ensure_schema()
except Exception:    # noqa: BLE001
    print('Database not reachable at start-up; will retry on the first request.')

app = create_app()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=config.DEBUG)
