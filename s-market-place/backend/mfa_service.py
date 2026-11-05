"""Helpers for protecting authenticator-app secrets."""
from cryptography.fernet import Fernet, InvalidToken

import config
import hmac
import re
from datetime import datetime, timezone

import pyotp

_fernet = (
    Fernet(config.MFA_ENCRYPTION_KEY.encode())
    if config.MFA_ENCRYPTION_KEY
    else None
)


def _cipher():
    if _fernet is None:
        raise RuntimeError('MFA_ENCRYPTION_KEY is not configured.')
    return _fernet


def encrypt_secret(secret):
    """Encrypt a plaintext TOTP secret before it is stored."""
    return _cipher().encrypt(secret.encode()).decode()


def decrypt_secret(encrypted_secret):
    """Decrypt a stored TOTP secret for code verification."""
    try:
        return _cipher().decrypt(encrypted_secret.encode()).decode()
    except InvalidToken as error:
        raise RuntimeError(
            'Could not decrypt the authenticator secret. Check MFA_ENCRYPTION_KEY.'
        ) from error

def new_totp_secret():
    """Create a fresh secret for authenticator-app enrollment."""
    return pyotp.random_base32()


def provisioning_uri(secret, account_name):
    """Create the URI the admin's authenticator app scans during setup."""
    return pyotp.TOTP(secret).provisioning_uri(
        name=account_name,
        issuer_name='S-Market Place'
    )


def matching_totp_step(secret, code, valid_window=1):
    """Return the matched time step, or None if the six-digit code is invalid."""
    code = str(code).strip()
    if not re.fullmatch(r'\d{6}', code):
        return None

    totp = pyotp.TOTP(secret)
    current_step = totp.timecode(datetime.now(timezone.utc))

    for step in range(current_step - valid_window, current_step + valid_window + 1):
        candidate = totp.at(step * totp.interval)
        if hmac.compare_digest(candidate, code):
            return step

    return None
    