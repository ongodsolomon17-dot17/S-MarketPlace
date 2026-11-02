"""The marketplace owner's tools: money overview, disputes, and paying traders out.

Only accounts listed in the ADMIN_USER_IDS environment variable can use these routes.
"""
from flask import Blueprint, g, jsonify, request

import escrow_service
from auth import require_admin
from database import db
from helpers import iso
from routes.delivery import DISPUTE_REASONS

bp = Blueprint('admin', __name__)


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
