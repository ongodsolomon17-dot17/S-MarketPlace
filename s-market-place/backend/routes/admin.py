"""The marketplace owner's tools: money overview, disputes, and paying traders out.

Only accounts listed in the ADMIN_USER_IDS environment variable can use these routes.
"""

import hashlib
import secrets
from flask import Blueprint, current_app, g, jsonify, request
import config
import payment_service
import escrow_service
from auth import require_admin
from database import db
from helpers import TOO_MANY_MESSAGE, iso, too_many_requests
from routes.delivery import DISPUTE_REASONS
from werkzeug.security import check_password_hash
import mfa_service

bp = Blueprint('admin', __name__)


@bp.post('/api/admin/mfa/setup')
@require_admin
def setup_admin_mfa():

    data = request.get_json(silent=True) or {}
    password = str(data.get('password', ''))

    with db() as con:
        user = con.execute(
            'SELECT email, password_hash FROM users WHERE id=%s',
            (g.user['id'],)
        ).fetchone()

    if not user or not check_password_hash(user['password_hash'], password):
        return jsonify(error='Your password is incorrect.'), 401

    secret = mfa_service.new_totp_secret()
    encrypted_secret = mfa_service.encrypt_secret(secret)

    with db() as con:
        row = con.execute(
            """INSERT INTO admin_mfa
                   (admin_user_id, pending_secret_encrypted,
                    pending_secret_expires_at, updated_at)
               VALUES (%s, %s, NOW() + INTERVAL '10 minutes', NOW())
               ON CONFLICT (admin_user_id) DO UPDATE
                   SET pending_secret_encrypted = EXCLUDED.pending_secret_encrypted,
                       pending_secret_expires_at = EXCLUDED.pending_secret_expires_at,
                       updated_at = NOW()
                   WHERE admin_mfa.enabled_at IS NULL
               RETURNING admin_user_id""",
            (g.user['id'], encrypted_secret)
        ).fetchone()

    if not row:
        return jsonify(error='Authenticator MFA is already enabled for this admin.'), 409

    return jsonify(
        message='Scan this setup link in your authenticator app, then verify a code to finish setup.',
        provisioning_uri=mfa_service.provisioning_uri(secret, user['email'])
    )

@bp.post('/api/admin/mfa/verify-setup')
@require_admin
def verify_admin_mfa_setup():
    if too_many_requests(f'admin-mfa-setup:{g.user["id"]}', 10, 600):
        return jsonify(error=TOO_MANY_MESSAGE), 429

    data = request.get_json(silent=True) or {}
    code = str(data.get('code', '')).strip()

    with db() as con:
        pending = con.execute(
            """SELECT pending_secret_encrypted
               FROM admin_mfa
               WHERE admin_user_id=%s
                 AND enabled_at IS NULL
                 AND pending_secret_expires_at > NOW()""",
            (g.user['id'],)
        ).fetchone()

    if not pending or not pending['pending_secret_encrypted']:
        return jsonify(error='Your setup link expired. Start MFA setup again.'), 400

    secret = mfa_service.decrypt_secret(pending['pending_secret_encrypted'])
    matched_step = mfa_service.matching_totp_step(secret, code)

    if matched_step is None:
        return jsonify(error='That code is invalid or expired. Try the current code in your authenticator app.'), 400

    with db() as con:
        enabled = con.execute(
            """UPDATE admin_mfa
               SET secret_encrypted = pending_secret_encrypted,
                   pending_secret_encrypted = NULL,
                   pending_secret_expires_at = NULL,
                   enabled_at = NOW(),
                   last_used_step = %s,
                   updated_at = NOW()
               WHERE admin_user_id = %s
                 AND enabled_at IS NULL
                 AND pending_secret_expires_at > NOW()
               RETURNING admin_user_id""",
            (matched_step, g.user['id'])
        ).fetchone()

    if not enabled:
        return jsonify(error='Setup expired or already completed. Start again if MFA is not enabled.'), 409

    return jsonify(message='Authenticator MFA is now enabled for this admin account.')

@bp.post('/api/admin/mfa/recovery-codes')
@require_admin
def create_admin_mfa_recovery_codes():
    if too_many_requests(f'admin-mfa-recovery:{g.user["id"]}', 5, 600):
        return jsonify(error=TOO_MANY_MESSAGE), 429

    data = request.get_json(silent=True) or {}
    password = str(data.get('password', ''))
    code = str(data.get('code', '')).strip()

    with db() as con:
        row = con.execute(
            """SELECT u.password_hash, m.secret_encrypted, m.last_used_step
               FROM users u
               JOIN admin_mfa m ON m.admin_user_id = u.id
               WHERE u.id=%s AND m.enabled_at IS NOT NULL""",
            (g.user['id'],)
        ).fetchone()

    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify(error='Your password is incorrect or authenticator MFA is not enabled.'), 401

    secret = mfa_service.decrypt_secret(row['secret_encrypted'])
    matched_step = mfa_service.matching_totp_step(secret, code)

    if matched_step is None or matched_step <= row['last_used_step']:
        return jsonify(error='Enter a fresh code from your authenticator app.'), 401

    with db() as con:
        accepted = con.execute(
            """UPDATE admin_mfa
               SET last_used_step=%s, updated_at=NOW()
               WHERE admin_user_id=%s
                 AND enabled_at IS NOT NULL
                 AND last_used_step < %s
               RETURNING admin_user_id""",
            (matched_step, g.user['id'], matched_step)
        ).fetchone()

        if not accepted:
            return jsonify(error='That authenticator code was already used. Enter the current code.'), 401

        codes = [secrets.token_hex(8).upper() for _ in range(10)]

        con.execute(
            'DELETE FROM admin_mfa_recovery_codes WHERE admin_user_id=%s AND used_at IS NULL',
            (g.user['id'],)
        )

        for recovery_code in codes:
            code_hash = hashlib.sha256(recovery_code.encode('ascii')).hexdigest()
            con.execute(
                'INSERT INTO admin_mfa_recovery_codes(admin_user_id, code_hash) VALUES(%s, %s)',
                (g.user['id'], code_hash)
            )

    return jsonify(
        message='Save these recovery codes somewhere private. Each code can be used once.',
        recovery_codes=codes
    )

@bp.get('/api/admin/overview')
@require_admin
def overview():
    """Where all the money is, so it can be matched against the Paystack balance."""
    with db() as con:
        sales = con.execute(
            """SELECT COALESCE(SUM(seller_amount + commission) FILTER (WHERE escrow_status = 'held'), 0)     AS held,
                      COALESCE(SUM(seller_amount + commission) FILTER (WHERE escrow_status = 'disputed'), 0) AS disputed,
                      COALESCE(SUM(commission) FILTER (WHERE escrow_status = 'released'), 0)                 AS commission_earned,
                      COALESCE(SUM(seller_amount) FILTER (WHERE escrow_status = 'released'), 0)              AS released
               FROM order_items""").fetchone()
        payouts = con.execute(
            """SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid,
                      COUNT(*) FILTER (WHERE status = 'requested') AS waiting FROM payouts""").fetchone()
        open_disputes = con.execute("SELECT COUNT(*) AS n FROM disputes WHERE status='open'").fetchone()['n']
    return jsonify(
        held_in_escrow=float(sales['held']), disputed=float(sales['disputed']),
        owed_to_traders=float(sales['released'] - payouts['paid']),          # released to traders but not yet paid out
        paid_out=float(payouts['paid']), commission_earned=float(sales['commission_earned']),
        payouts_waiting=payouts['waiting'], open_disputes=open_disputes)
@bp.get('/api/admin/subscription-plans')
@require_admin
def subscription_plans():
    with db() as con:
        rows = con.execute(
            'SELECT plan, price_ngn FROM trader_subscription_plans ORDER BY plan'
        ).fetchall()

    return jsonify(plans={row['plan']: row['price_ngn'] for row in rows})


@bp.patch('/api/admin/subscription-plans')
@require_admin
def update_subscription_plan():
    if not config.PAYSTACK_SECRET_KEY:
        return jsonify(
            error='Paystack is not configured yet, so the subscription price was not changed.'
        ), 503

    data = request.get_json(silent=True) or {}
    plan = str(data.get('plan', '')).strip()

    if plan not in ('monthly', 'yearly'):
        return jsonify(error='Choose monthly or yearly.'), 400

    try:
        price = int(data.get('price_ngn'))
    except (TypeError, ValueError):
        return jsonify(error='Enter a whole-number price in naira.'), 400

    if not 1 <= price <= 100_000_000:
        return jsonify(error='Enter a price between ₦1 and ₦100,000,000.'), 400

    with db() as con:
        current = con.execute(
            """SELECT price_ngn, paystack_plan_code
               FROM trader_subscription_plans
               WHERE plan=%s
               FOR UPDATE""",
            (plan,)
        ).fetchone()

        if not current:
            return jsonify(error='That subscription plan was not found.'), 404

        try:
            plan_code = payment_service.paystack_sync_subscription_plan(
                plan,
                price,
                current['paystack_plan_code']
            )
        except Exception:
            current_app.logger.exception('Could not sync subscription plan with Paystack.')
            return jsonify(
                error='Could not sync the plan with Paystack, so the price was not changed.'
            ), 502

        row = con.execute(
            """UPDATE trader_subscription_plans
               SET price_ngn=%s, paystack_plan_code=%s, updated_at=NOW()
               WHERE plan=%s
               RETURNING plan, price_ngn""",
            (price, plan_code, plan)
        ).fetchone()

        con.execute(
            """INSERT INTO admin_audit_log
                   (admin_user_id, action, target_type, details)
               VALUES (
                   %s,
                   'subscription_price_updated',
                   'subscription_plan',
                   jsonb_build_object(
                       'plan', %s,
                       'old_price_ngn', %s,
                       'new_price_ngn', %s
                   )
               )""",
            (g.user['id'], plan, current['price_ngn'], row['price_ngn'])
        )

    return jsonify(plan=row['plan'], price_ngn=row['price_ngn'])


# ----------------------------------------------------------------------------- disputes
@bp.get('/api/admin/disputes')
@require_admin
def list_disputes():
    with db() as con:
        rows = con.execute(
            """SELECT d.id, d.order_item_id, d.reason_type, d.details, d.photo1, d.photo2, d.status, d.admin_note, d.created_at,
                      oi.product_name, oi.quantity, oi.unit_price, oi.order_id, oi.seller_amount, oi.commission,
                      o.shipping_name AS buyer_name, o.shipping_phone AS buyer_phone, t.store_name
               FROM disputes d JOIN order_items oi ON oi.id = d.order_item_id JOIN orders o ON o.id = oi.order_id
               LEFT JOIN users t ON t.id = oi.trader_id
               ORDER BY (d.status = 'open') DESC, d.id DESC LIMIT 100""").fetchall()
    return jsonify(disputes=[{**dict(r), 'reason': DISPUTE_REASONS.get(r['reason_type'], r['reason_type']),
                              'unit_price': float(r['unit_price']), 'amount': float(r['seller_amount'] + r['commission']),
                              'seller_amount': float(r['seller_amount']), 'commission': float(r['commission']),
                              'created_at': iso(r['created_at'])} for r in rows])


@bp.post('/api/admin/disputes/<int:dispute_id>/resolve')
@require_admin
def resolve_dispute(dispute_id):
    """Decide a dispute: "release" pays the trader; "refund" sides with the buyer (refund them in the Paystack dashboard)."""
    data = request.get_json(silent=True) or {}
    decision, note = str(data.get('decision', '')), str(data.get('note', '')).strip()[:500]
    if decision not in ('release', 'refund'):
        return jsonify(error='Choose release or refund.'), 400
    with db() as con:
        dispute = con.execute('SELECT id, order_item_id, buyer_id, status FROM disputes WHERE id=%s FOR UPDATE', (dispute_id,)).fetchone()
        if not dispute or dispute['status'] != 'open':
            return jsonify(error='This dispute is not open.'), 404
        if decision == 'release':
            escrow_service.release_item(con, dispute['order_item_id'])
        else:
            escrow_service.refund_item(con, dispute['order_item_id'])
        con.execute('UPDATE disputes SET status=%s, admin_note=%s, resolved_at=NOW() WHERE id=%s',
                    ('released' if decision == 'release' else 'refunded', note, dispute_id))
        outcome = ('the seller was paid.' if decision == 'release' else 'you will be refunded.')
        escrow_service.notify(con, dispute['buyer_id'], 'Your report was reviewed', f'Decision: {outcome} {note}'.strip(), 'orders')
    return jsonify(message='Dispute resolved.' + (' Remember to refund the buyer in your Paystack dashboard.' if decision == 'refund' else ''))


# ----------------------------------------------------------------------------- payouts
@bp.get('/api/admin/payouts')
@require_admin
def list_payouts():
    with db() as con:
        rows = con.execute(
            """SELECT p.id, p.amount, p.status, p.bank_name, p.account_number, p.account_name, p.reference, p.note, p.created_at,
                      p.resolved_at, u.store_name, u.username
               FROM payouts p JOIN users u ON u.id = p.trader_id
               ORDER BY (p.status = 'requested') DESC, p.id DESC LIMIT 100""").fetchall()
    return jsonify(payouts=[{**dict(r), 'amount': float(r['amount']), 'created_at': iso(r['created_at']), 'resolved_at': iso(r['resolved_at'])}
                            for r in rows])


def _finish_payout(payout_id, status, reference, note, title, body):
    with db() as con:
        payout = con.execute("UPDATE payouts SET status=%s, reference=%s, note=%s, resolved_at=NOW() "
                             "WHERE id=%s AND status='requested' RETURNING trader_id, amount", (status, reference, note, payout_id)).fetchone()
        if not payout:
            return jsonify(error='This payout is not waiting.'), 404
        escrow_service.notify(con, payout['trader_id'], title, body.format(amount=escrow_service.naira(payout['amount'])), 'trader-dashboard')
    return jsonify(message='Payout updated.')


@bp.post('/api/admin/payouts/<int:payout_id>/paid')
@require_admin
def mark_payout_paid(payout_id):
    """Record that you have sent the money to the trader's bank account."""
    reference = str((request.get_json(silent=True) or {}).get('reference', '')).strip()[:120]
    return _finish_payout(payout_id, 'paid', reference, '', 'Payout sent', '{amount} was sent to your bank account.')


@bp.post('/api/admin/payouts/<int:payout_id>/reject')
@require_admin
def reject_payout(payout_id):
    """Refuse a payout request; the money goes back to the trader's available balance."""
    note = str((request.get_json(silent=True) or {}).get('note', '')).strip()[:500]
    return _finish_payout(payout_id, 'rejected', '', note, 'Payout request declined',
                          'Your request for {amount} was declined' + (f': {note}' if note else '.'))
