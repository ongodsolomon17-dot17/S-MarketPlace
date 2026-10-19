"""Housekeeping that runs now and then, triggered by normal traffic (there is no separate scheduler)."""
import threading
import time

from flask import current_app

import deal_service
import feed
import image_service
import order_service
import product_service
from database import db

_last_run = 0.0
_last_purge = 0.0
_cleanup_lock = threading.Lock()      # makes sure only one Cloudinary clean-up runs at a time


def run_periodically(force=False, background=True):
    """Housekeeping, triggered by normal traffic.

    Once a minute: release expired unpaid orders, delete Fast Finger deals that finished over 24 hours ago,
    erase products deleted over 30 days ago, and start the Cloudinary picture clean-up.
    Once an hour: purge old "For you" feed history.

    background=False runs the Cloudinary clean-up right here (used by the tests).
    """
    global _last_run, _last_purge
    now = time.monotonic()
    if not force and now - _last_run < 60:
        return
    _last_run = now
    try:
        with db() as con:
            order_service.release_expired_orders(con)
            deal_service.purge_old_deals(con)
            product_service.purge_deleted_products(con)
            if now - _last_purge > 3600:
                _last_purge = now
                feed.purge_old_interactions(con)
            pictures_waiting = con.execute('SELECT 1 FROM image_cleanup LIMIT 1').fetchone() is not None
        if pictures_waiting:
            run_image_cleanup(current_app._get_current_object(), background)
    except Exception:    # noqa: BLE001 - housekeeping must never break a customer's request
        current_app.logger.exception('Maintenance failed')


def run_image_cleanup(app, background=True):
    """Delete the waiting pictures from Cloudinary. By default this happens in a separate thread,
    so a slow Cloudinary never makes a shopper wait."""
    if background:
        threading.Thread(target=_cleanup_worker, args=(app,), daemon=True).start()
    else:
        _cleanup_worker(app)


def _cleanup_worker(app):
    if not _cleanup_lock.acquire(blocking=False):
        return                                          # another clean-up is already running
    try:
        with app.app_context(), db() as con:
            image_service.process_queue(con, app.logger)
    except Exception:    # noqa: BLE001
        app.logger.exception('Picture clean-up failed')
    finally:
        _cleanup_lock.release()
