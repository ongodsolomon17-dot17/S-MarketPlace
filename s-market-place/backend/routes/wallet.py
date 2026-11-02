"""A trader's money: bank details, earnings, payout requests, and notifications for everyone."""
import time

from flask import Blueprint, current_app, g, jsonify, request

import config
import escrow_service
import payment_service
from auth import require_login, require_role
from database import db
from helpers import TOO_MANY_MESSAGE, iso, too_many_requests

bp = Blueprint('wallet', __name__)

_bank_cache = {'loaded_at': 0.0, 'banks': []}      # the bank list barely changes, so keep it for a day


def get_banks():
    """Nigerian banks from Paystack (cached for 24 hours)."""
    if not _bank_cache['banks'] or time.time() - _bank_cache['loaded_at'] > 86400:
        _bank_cache['banks'] = payment_service.paystack_banks()
        _bank_cache['loaded_at'] = time.time()
    return _bank_cache['banks']


@bp.get('/api/banks')
@require_login
def list_banks():
    if not config.PAYSTACK_SECRET_KEY:
        return jsonify(error='Bank details cannot be added yet because payments are not set up.'), 503
    try:
        return jsonify(banks=get_banks())
    except Exception:    # noqa: BLE001
        current_app.logger.exception('Could not load banks')
        return jsonify(error='We could not load the list of banks. Please try again.'), 502


# ----------------------------------------------------------------------------- where a trader gets paid
@bp.get('/api/trader/payout-account')
@require_role('trader')
def get_payout_account():
    with db() as con:
        account = con.execute('SELECT bank_code, bank_name, account_number, account_name FROM payout_accounts WHERE trader_id=%s',
                              (g.user['id'],)).fetchone()
    return jsonify(account=dict(account) if account else None)


@bp.post('/api/trader/payout-account')
@require_role('trader')
def save_payout_account():
    """Save the bank account. Paystack looks up the account holder's name, which is stored and shown back."""
    if too_many_requests('bank-account', 10, 3600):
        return jsonify(error=TOO_MANY_MESSAGE), 429
    if not config.PAYSTACK_SECRET_KEY:
        return jsonify(error='Bank details cannot be added yet because payments are not set up.'), 503
    data = request.get_json(silent=True) or {}
    bank_code, number = str(data.get('bank_code', '')).strip(), str(data.get('account_number', '')).strip()
    if not (number.isdigit() and len(number) == 10):
        return jsonify(error='A Nigerian account number has exactly 10 digits.'), 400
    try:
        bank = next((b for b in get_banks() if b['code'] == bank_code), None)
        if not bank:
            return jsonify(error='Choose your bank from the list.'), 400
        account_name = payment_service.paystack_resolve_account(number, bank_code)
    except Exception:    # noqa: BLE001
        current_app.logger.exception('Bank lookup failed')
        return jsonify(error='We could not check that account right now. Please try again.'), 502
    if not account_name:
        return jsonify(error='We could not find that account. Check the bank and the account number.'), 400
    with db() as con:
        con.execute(
            """INSERT INTO payout_accounts(trader_id, bank_code, bank_name, account_number, account_name)
               VALUES(%s,%s,%s,%s,%s)
               ON CONFLICT (trader_id) DO UPDATE SET bank_code=EXCLUDED.bank_code, bank_name=EXCLUDED.bank_name,
                   account_number=EXCLUDED.account_number, account_name=EXCLUDED.account_name, verified_at=NOW()""",
            (g.user['id'], bank_code, bank['name'], number, account_name))
    return jsonify(message=f'Saved: {account_name}, {bank["name"]}.',
                   account=dict(bank_code=bank_code, bank_name=bank['name'], account_number=number, account_name=account_name))


# ----------------------------------------------------------------------------- earnings and payouts
@bp.get('/api/trader/earnings')
@require_role('trader')
def earnings():
    """The trader's money at a glance: in escrow, on hold in a dispute, available, and payout history."""
    with db() as con:
        balances = escrow_service.trader_balances(con, g.user['id'])
        has_account = con.execute('SELECT 1 FROM payout_accounts WHERE trader_id=%s', (g.user['id'],)).fetchone() is not None
        history = con.execute('SELECT id, amount, status, reference, note, created_at, resolved_at FROM payouts '
                              'WHERE trader_id=%s ORDER BY id DESC LIMIT 10', (g.user['id'],)).fetchall()
    return jsonify(
        in_escrow=float(balances['in_escrow']), disputed=float(balances['disputed']), available=float(balances['available']),
        requested=float(balances['requested']), paid_out=float(balances['paid_out']),
        min_payout=float(config.MIN_PAYOUT), commission_percent=float(config.COMMISSION_PERCENT), has_account=has_account,
        can_request=has_account and balances['available'] >= config.MIN_PAYOUT and balances['requested'] == 0,
        payouts=[{**dict(row), 'amount': float(row['amount']), 'created_at': iso(row['created_at']), 'resolved_at': iso(row['resolved_at'])}
                 for row in history])


@bp.post('/api/trader/payouts')
@require_role('trader')
def request_payout():
    """Ask for the whole available balance to be paid to the saved bank account."""
    with db() as con:
        con.execute('SELECT id FROM users WHERE id=%s FOR UPDATE', (g.user['id'],))       # one request at a time per trader
        account = con.execute('SELECT bank_name, account_number, account_name FROM payout_accounts WHERE trader_id=%s',
                              (g.user['id'],)).fetchone()
        if not account:
            return jsonify(error='Add your bank details first (Settings → Payout account).'), 400
        balances = escrow_service.trader_balances(con, g.user['id'])
        if balances['requested'] > 0:
            return jsonify(error='You already have a payout waiting to be paid.'), 409
        if balances['available'] < config.MIN_PAYOUT:
            return jsonify(error=f'The minimum payout is {escrow_service.naira(config.MIN_PAYOUT)}.'), 400
        payout = con.execute(
            'INSERT INTO payouts(trader_id, amount, bank_name, account_number, account_name) VALUES(%s,%s,%s,%s,%s) RETURNING id',
            (g.user['id'], balances['available'], account['bank_name'], account['account_number'], account['account_name'])).fetchone()
        escrow_service.notify_admins(con, 'Payout requested',
                                     f"{g.user['store_name'] or g.user['username']} asked for {escrow_service.naira(balances['available'])}.", 'admin')
    return jsonify(message=f"Payout of {escrow_service.naira(balances['available'])} requested. It will be sent to {account['account_name']}.",
                   payout_id=payout['id'])


# ----------------------------------------------------------------------------- notifications (everyone)
@bp.get('/api/notifications')
@require_login
def list_notifications():
    with db() as con:
        rows = con.execute('SELECT id, title, body, link, read_at IS NOT NULL AS is_read, created_at FROM notifications '
                           'WHERE user_id=%s ORDER BY id DESC LIMIT 30', (g.user['id'],)).fetchall()
        unread = con.execute('SELECT COUNT(*) AS n FROM notifications WHERE user_id=%s AND read_at IS NULL', (g.user['id'],)).fetchone()['n']
    return jsonify(unread=unread, notifications=[{**dict(row), 'created_at': iso(row['created_at'])} for row in rows])


@bp.post('/api/notifications/read')
@require_login
def mark_notifications_read():
    with db() as con:
        con.execute('UPDATE notifications SET read_at = NOW() WHERE user_id=%s AND read_at IS NULL', (g.user['id'],))
    return jsonify(ok=True)
