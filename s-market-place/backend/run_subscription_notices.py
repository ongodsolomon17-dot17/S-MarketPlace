"""Scheduled entry point for trader subscription reminders."""
from app import create_app
from database import db, ensure_schema
import subscription_service


def main():
    app = create_app()

    with app.app_context():
        ensure_schema()

        with db() as con:
            subscription_service.create_due_subscription_in_app_notices(con)

        subscription_service.send_pending_subscription_notice_emails(app.logger)


if __name__ == '__main__':
    main()