"""Fast Finger housekeeping: finished deals are removed by the system after 24 hours."""
import image_service

KEEP_FINISHED_HOURS = 24


def purge_old_deals(con):
    """Delete deals that finished more than 24 hours ago, if the trader has not already deleted them.

    A deal "finishes" when its countdown reaches zero OR when the trader marks it sold,
    whichever happens first. LEAST() picks the earlier of the two times (it ignores a missing sold_at).
    """
    removed = con.execute(
        f"DELETE FROM flash_deals WHERE LEAST(sold_at, ends_at) < NOW() - INTERVAL '{KEEP_FINISHED_HOURS} hours' RETURNING image").fetchall()
    for deal in removed:
        image_service.queue_image_deletion(con, deal['image'])     # the picture is no longer needed in Cloudinary
