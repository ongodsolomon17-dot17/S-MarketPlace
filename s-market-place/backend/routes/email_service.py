"""Send transactional email through Resend."""
import requests

import config


RESEND_API = 'https://api.resend.com/emails'


def send_email(recipient, subject, text, idempotency_key):
    """Send a plain-text transactional email; raise if delivery could not be requested."""
    if not config.RESEND_API_KEY or not config.RESEND_FROM_EMAIL:
        raise RuntimeError('Resend email settings are not configured.')

    response = requests.post(
        RESEND_API,
        headers={
            'Authorization': f'Bearer {config.RESEND_API_KEY}',
            'Content-Type': 'application/json',
            'Idempotency-Key': str(idempotency_key)[:256]
        },
        timeout=15,
        json={
            'from': config.RESEND_FROM_EMAIL,
            'to': [recipient],
            'subject': subject,
            'text': text
        }
    )

    try:
        body = response.json()
    except ValueError:
        body = {}

    if not response.ok or not body.get('id'):
        raise RuntimeError('Resend could not accept the email request.')

    return body['id']