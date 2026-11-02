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
