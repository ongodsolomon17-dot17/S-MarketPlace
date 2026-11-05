"""Subscription payment settlement rules shared by routes and webhooks."""
import mfa_service
import math

import escrow_service
import config
import email_service
from database import db

def subscription_allows_pro_features(con, trader_id):
    """Check the trader's Pro entitlement using the database clock."""
    subscription = con.execute(
        """SELECT status,
                  (
                      (status = 'trial' AND trial_ends_at > NOW())
                      OR
                      (status = 'active' AND current_period_ends_at > NOW())
                  ) AS can_access
           FROM trader_subscriptions
           WHERE trader_id=%s
           FOR UPDATE""",
        (trader_id,)
    ).fetchone()

    if not subscription:
        return False

    if subscription['can_access']:
        return True

    if subscription['status'] in ('trial', 'active'):
        con.execute(
            """UPDATE trader_subscriptions
               SET status='expired', updated_at=NOW()
               WHERE trader_id=%s AND status IN ('trial', 'active')""",
            (trader_id,)
        )
    return False


def settle_trader_subscription_payment(
    con,
    reference,
    amount_kobo,
    currency,
    transaction_id=None
):
    """Activate a saved subscription payment after checking its reference and amount."""
    payment = con.execute(
        """SELECT id, trader_id, plan, amount_ngn, auto_renew, status
           FROM trader_subscription_payments
           WHERE reference=%s
           FOR UPDATE""",
        (reference,)
    ).fetchone()

    if not payment:
        return 'unknown'

    if payment['status'] == 'paid':
        return 'already_paid'

    if payment['status'] != 'pending':
        return 'not_pending'

    if currency != 'NGN' or int(amount_kobo) != int(payment['amount_ngn']) * 100:
        return 'amount_mismatch'

    con.execute(
        """UPDATE trader_subscription_payments
           SET status='paid',
               paystack_transaction_id=%s,
               paid_at=NOW(),
               updated_at=NOW()
           WHERE id=%s AND status='pending'""",
        (str(transaction_id) if transaction_id is not None else None, payment['id'])
    )

    con.execute(
        """UPDATE trader_subscriptions
           SET status='active',
               plan=%s,
               auto_renew=%s,
               current_period_starts_at=GREATEST(
                   COALESCE(current_period_ends_at, NOW()),
                   NOW()
               ),
               current_period_ends_at=GREATEST(
                   COALESCE(current_period_ends_at, NOW()),
                   NOW()
               ) + CASE
                       WHEN %s='monthly' THEN INTERVAL '1 month'
                       ELSE INTERVAL '1 year'
                   END,
               updated_at=NOW()
           WHERE trader_id=%s""",
        (payment['plan'], payment['auto_renew'], payment['plan'], payment['trader_id'])
    )

    return 'paid'

def attach_paystack_subscription(con, data):
    """Link Paystack's recurring subscription details to the matching trader."""
    subscription_code = data.get('subscription_code')
    email_token = data.get('email_token')
    customer = data.get('customer') or {}
    plan = data.get('plan') or {}
    plan_code = plan.get('plan_code') or data.get('plan_code')
    email = str(customer.get('email', '')).strip().lower()
    customer_code = customer.get('customer_code')

    if not subscription_code or not email_token or not plan_code or not email:
        return False

    encrypted_email_token = mfa_service.encrypt_secret(str(email_token))

    payment = con.execute(
        """SELECT p.id, p.trader_id
           FROM trader_subscription_payments p
           JOIN users u ON u.id = p.trader_id
           WHERE LOWER(u.email) = %s
             AND p.paystack_plan_code = %s
             AND p.auto_renew = TRUE
             AND p.status IN ('pending', 'paid')
           ORDER BY p.created_at DESC
           LIMIT 1
           FOR UPDATE OF p""",
        (email, plan_code)
    ).fetchone()

    if not payment:
        return False

    con.execute(
        """UPDATE trader_subscriptions
           SET paystack_subscription_code=%s,
               paystack_customer_code=%s,
               paystack_subscription_email_token_encrypted=%s,
               updated_at=NOW()
           WHERE trader_id=%s""",
        (
            subscription_code,
            customer_code,
            encrypted_email_token,
            payment['trader_id']
        )
    )
    con.execute(
        """UPDATE trader_subscription_payments
           SET paystack_subscription_code=%s, updated_at=NOW()
           WHERE id=%s""",
        (subscription_code, payment['id'])
    )

    return True


def apply_paystack_invoice_update(con, data):
    """Apply a successful recurring invoice's billing period to its trader."""
    subscription = data.get('subscription') or {}
    subscription_code = subscription.get('subscription_code')
    period_start = data.get('period_start')
    period_end = data.get('period_end')

    if (
        not subscription_code
        or not period_start
        or not period_end
        or not data.get('paid')
        or data.get('status') != 'success'
    ):
        return False

    updated = con.execute(
        """UPDATE trader_subscriptions
           SET status='active',
               current_period_starts_at=%s,
               current_period_ends_at=%s,
               updated_at=NOW()
           WHERE paystack_subscription_code=%s
           RETURNING trader_id""",
        (period_start, period_end, subscription_code)
    ).fetchone()

    return bool(updated)

def mark_paystack_subscription_nonrenewing(con, data):
    """Turn off local renewal after Paystack reports cancellation or a failed invoice."""
    subscription = data.get('subscription') or {}
    subscription_code = (
        data.get('subscription_code')
        or subscription.get('subscription_code')
    )

    if not subscription_code:
        return False

    updated = con.execute(
        """UPDATE trader_subscriptions
           SET auto_renew=FALSE,
               paystack_subscription_email_token_encrypted=NULL,
               status=CASE
                   WHEN current_period_ends_at IS NOT NULL
                        AND current_period_ends_at <= NOW()
                   THEN 'expired'
                   ELSE status
               END,
               updated_at=NOW()
           WHERE paystack_subscription_code=%s
           RETURNING trader_id""",
        (subscription_code,)
    ).fetchone()

    return bool(updated)

def create_due_subscription_in_app_notices(con):
    """Create each due five-day or expiry notification only once per period."""
    rows = con.execute(
        """SELECT s.trader_id, s.status, s.plan, s.auto_renew,
                  COALESCE(s.current_period_ends_at, s.trial_ends_at) AS period_end_at,
                  NOW() AS checked_at
           FROM trader_subscriptions s
           WHERE s.status IN ('trial', 'active', 'expired')
             AND (
                 COALESCE(s.current_period_ends_at, s.trial_ends_at) <= NOW()
                 OR (
                     s.status IN ('trial', 'active')
                     AND COALESCE(s.current_period_ends_at, s.trial_ends_at)
                         <= NOW() + INTERVAL '5 days'
                 )
             )"""
    ).fetchall()

    for row in rows:
        period_end = row['period_end_at']
        expired = period_end <= row['checked_at']
        notice_type = 'expired' if expired else 'five_day'

        if expired and row['status'] in ('trial', 'active'):
            con.execute(
                """UPDATE trader_subscriptions
                   SET status='expired', updated_at=NOW()
                   WHERE trader_id=%s AND status IN ('trial', 'active')""",
                (row['trader_id'],)
            )

        notice = con.execute(
            """INSERT INTO trader_subscription_notice_log
                   (trader_id, period_end_at, notice_type)
               VALUES (%s, %s, %s)
               ON CONFLICT (trader_id, period_end_at, notice_type) DO NOTHING
               RETURNING id""",
            (row['trader_id'], period_end, notice_type)
        ).fetchone()

        if not notice:
            continue

        date_label = period_end.strftime('%B %d, %Y')
        days_left = max(1, math.ceil(
            (period_end - row['checked_at']).total_seconds() / 86400
        ))
        is_trial = row['status'] == 'trial' or not row['plan']

        if expired:
            title = 'Your trader subscription has expired'
            body = (
                f'Your {"free trial" if is_trial else "paid subscription"} ended on {date_label}. '
                'Adding products and other Pro features are locked. You can still view and edit '
                'existing products and request an available payout. Choose a plan to restore access.'
            )
        else:
            title = 'Your trader subscription ends soon'
            if is_trial:
                body = (
                    f'Your free trial ends in about {days_left} day(s), on {date_label}. '
                    'Choose a monthly or yearly plan to keep Pro features.'
                )
            else:
                renewal_note = (
                    'Auto-renew is on.'
                    if row['auto_renew']
                    else 'Auto-renew is off; choose whether to renew.'
                )
                body = (
                    f'Your paid subscription period ends in about {days_left} day(s), '
                    f'on {date_label}. {renewal_note}'
                )

        escrow_service.notify(
            con,
            row['trader_id'],
            title,
            body,
            'trader-dashboard'
        )
        con.execute(
            """UPDATE trader_subscription_notice_log
               SET in_app_sent_at=NOW()
               WHERE id=%s""",
            (notice['id'],)
        )




        def send_pending_subscription_notice_emails(logger):
    """Send queued notice emails, marking each sent only after Resend accepts it."""
    if not config.RESEND_API_KEY or not config.RESEND_FROM_EMAIL:
        return 0

    with db() as con:
        rows = con.execute(
            """SELECT l.id, l.notice_type, l.period_end_at,
                      u.email, u.first_name,
                      s.plan, s.auto_renew, s.trial_ends_at,
                      NOW() AS checked_at
               FROM trader_subscription_notice_log l
               JOIN users u ON u.id = l.trader_id
               JOIN trader_subscriptions s ON s.trader_id = l.trader_id
               WHERE l.email_sent_at IS NULL
                 AND l.in_app_sent_at IS NOT NULL
               ORDER BY l.id
               LIMIT 100"""
        ).fetchall()

    sent = 0

    for row in rows:
        is_trial = row['period_end_at'] == row['trial_ends_at']
        date_label = row['period_end_at'].strftime('%B %d, %Y')
        greeting = f"Hi {row['first_name']}," if row['first_name'] else "Hello,"

        if row['notice_type'] == 'expired':
            subject = 'Your S-Market Place trader subscription has expired'
            body = (
                f"{greeting}\n\n"
                f"Your {'free trial' if is_trial else 'paid subscription'} ended on {date_label}. "
                "Adding products and other Pro features are locked. You can still view and edit "
                "existing products and request an available payout. Choose a plan to restore access."
            )
        else:
            days_left = max(1, math.ceil(
                (row['period_end_at'] - row['checked_at']).total_seconds() / 86400
            ))
            subject = 'Your S-Market Place trader subscription ends soon'

            if is_trial:
                body = (
                    f"{greeting}\n\n"
                    f"Your free trial ends in about {days_left} day(s), on {date_label}. "
                    "Choose a monthly or yearly plan to keep Pro features."
                )
            else:
                renew_note = (
                    "Auto-renew is on."
                    if row['auto_renew']
                    else "Auto-renew is off; choose whether to renew."
                )
                body = (
                    f"{greeting}\n\n"
                    f"Your paid subscription period ends in about {days_left} day(s), "
                    f"on {date_label}. {renew_note}"
                )

        try:
            email_service.send_email(
                row['email'],
                subject,
                body,
                idempotency_key=f'trader-subscription-notice-{row["id"]}'
            )
        except Exception:
            logger.exception(
                'Could not send trader subscription notice email for notice %s.',
                row['id']
            )
            continue

        with db() as con:
            con.execute(
                """UPDATE trader_subscription_notice_log
                   SET email_sent_at=NOW()
                   WHERE id=%s AND email_sent_at IS NULL""",
                (row['id'],)
            )

        sent += 1

    return sent