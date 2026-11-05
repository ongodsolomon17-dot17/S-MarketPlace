"""Talking to Paystack (the payment provider). Amounts are in naira; Paystack counts in kobo."""
import hashlib
import hmac

import requests

import config
from helpers import to_kobo

PAYSTACK_API = 'https://api.paystack.co'


def _headers():
    return {'Authorization': f'Bearer {config.PAYSTACK_SECRET_KEY}'}


def paystack_initialize(order_id, reference, email, total):
    """Ask Paystack to create a payment page for this order. Returns the page's URL."""
    response = requests.post(f'{PAYSTACK_API}/transaction/initialize', headers=_headers(), timeout=15, json={
        'email': email, 'amount': to_kobo(total), 'currency': 'NGN', 'reference': reference,
        'callback_url': config.PAYMENT_RETURN_URL, 'metadata': {'order_id': order_id}})
    body = response.json()
    if not response.ok or not body.get('status'):
        raise RuntimeError(body.get('message', 'Paystack refused the request'))
    return body['data']['authorization_url']


def paystack_sync_subscription_plan(plan, price_ngn, plan_code=None):
    """Create or update a Paystack recurring plan and return its plan code."""
    intervals = {
        'monthly': 'monthly',
        'yearly': 'annually'
    }
    if plan not in intervals:
        raise ValueError('Choose a monthly or yearly subscription plan.')

    payload = {
        'name': f'S-Market Place {plan.title()} subscription',
        'amount': to_kobo(price_ngn),
        'interval': intervals[plan],
        'currency': 'NGN',
        'send_invoices': False,
        'send_sms': False
    }

    if plan_code:
        payload['update_existing_subscriptions'] = False
        response = requests.put(
            f'{PAYSTACK_API}/plan/{plan_code}',
            headers=_headers(),
            timeout=15,
            json=payload
        )
    else:
        response = requests.post(
            f'{PAYSTACK_API}/plan',
            headers=_headers(),
            timeout=15,
            json=payload
        )

    body = response.json()
    if not response.ok or not body.get('status'):
        raise RuntimeError(body.get('message', 'Paystack could not sync the subscription plan.'))

    if plan_code:
        return plan_code

    created_code = (body.get('data') or {}).get('plan_code')
    if not created_code:
        raise RuntimeError('Paystack created the plan but did not return its plan code.')

    return created_code

def paystack_disable_subscription(subscription_code, email_token):
    """Ask Paystack to stop renewing a subscription."""
    response = requests.post(
        f'{PAYSTACK_API}/subscription/disable',
        headers=_headers(),
        timeout=15,
        json={
            'code': subscription_code,
            'token': email_token
        }
    )
    body = response.json()

    if not response.ok or not body.get('status'):
        raise RuntimeError(
            body.get('message', 'Paystack could not disable the subscription.')
        )

    return True

def paystack_initialize_trader_subscription(
    trader_id,
    reference,
    email,
    amount_ngn,
    plan_code=None
):
    """Create Paystack checkout for a one-time or recurring trader subscription."""
    payload = {
        'email': email,
        'amount': to_kobo(amount_ngn),
        'currency': 'NGN',
        'reference': reference,
        'callback_url': config.PAYMENT_RETURN_URL,
        'metadata': {
            'type': 'trader_subscription',
            'trader_id': trader_id
        }
    }

    if plan_code:
        payload['plan'] = plan_code

    response = requests.post(
        f'{PAYSTACK_API}/transaction/initialize',
        headers=_headers(),
        timeout=15,
        json=payload
    )
    body = response.json()

    if not response.ok or not body.get('status'):
        raise RuntimeError(
            body.get('message', 'Paystack refused the subscription payment.')
        )

    authorization_url = (body.get('data') or {}).get('authorization_url')
    if not authorization_url:
        raise RuntimeError('Paystack did not return a checkout link.')

    return authorization_url


def paystack_verify(reference):
    """Ask Paystack whether a payment really succeeded (the browser's word is never trusted)."""
    response = requests.get(f'{PAYSTACK_API}/transaction/verify/{reference}', headers=_headers(), timeout=15)
    body = response.json()
    return body.get('data') if response.ok and body.get('status') else None


def webhook_signature_is_valid(raw_body, signature):
    """Check that a webhook call really came from Paystack (HMAC-SHA512 of the body with our secret key)."""
    expected = hmac.new(config.PAYSTACK_SECRET_KEY.encode(), raw_body, hashlib.sha512).hexdigest()
    return hmac.compare_digest(signature.encode(), expected.encode())


def paystack_banks():
    """The list of Nigerian banks Paystack supports: [{'name': ..., 'code': ...}, ...]."""
    response = requests.get(f'{PAYSTACK_API}/bank', params={'country': 'nigeria', 'perPage': 200}, headers=_headers(), timeout=15)
    body = response.json()
    if not response.ok or not body.get('status'):
        raise RuntimeError(body.get('message', 'Paystack could not list the banks'))
    return [{'name': bank['name'], 'code': bank['code']} for bank in body['data'] if bank.get('code')]


def paystack_resolve_account(account_number, bank_code):
    """Ask Paystack who owns a bank account. Returns the account holder's name, or None if it does not exist."""
    response = requests.get(f'{PAYSTACK_API}/bank/resolve', params={'account_number': account_number, 'bank_code': bank_code},
                            headers=_headers(), timeout=15)
    body = response.json()
    if not response.ok or not body.get('status'):
        return None
    return body['data'].get('account_name')
