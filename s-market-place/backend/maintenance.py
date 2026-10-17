"""Housekeeping that runs now and then, triggered by normal traffic (there is no separate scheduler)."""
import time

import feed
import order_service
from database import db

_last_run = 0.0
_last_purge = 0.0


def run_periodically(force=False):
    """Release unpaid orders that expired (at most once a minute) and purge old feed history (once an hour)."""
    global _last_run, _last_purge
    now = time.monotonic()
    if not force and now - _last_run < 60:
        return
    _last_run = now
    try:
        with db() as con:
            order_service.release_expired_orders(con)
            if now - _last_purge > 3600:
                _last_purge = now
                feed.purge_old_interactions(con)
    except Exception:    # noqa: BLE001 - housekeeping must never break a customer's request
        from flask import current_app
        current_app.logger.exception('Maintenance failed')
