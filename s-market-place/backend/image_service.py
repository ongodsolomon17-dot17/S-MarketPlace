"""Cleaning up pictures in Cloudinary.

Cloudinary keeps every uploaded picture until we tell it to delete it. Whenever a picture
stops being used (a product is erased for good, a deal is removed, or a picture is replaced)
we put its address in a small "to delete" list (the `image_cleanup` table). A background job
then removes the pictures from Cloudinary.

Why a list instead of deleting on the spot?
  * It never slows down a customer's request.
  * If Cloudinary is busy or down, the job simply tries again a minute later.
  * Before deleting we double-check nothing else still uses the same picture.

Only pictures WE uploaded (folder "s-market-place") are ever touched. A picture a trader
pasted from another website is never deleted.
"""
import os
import re

import cloudinary.uploader

# https://res.cloudinary.com/<cloud>/image/upload/v123456/s-market-place/<id>.jpg  ->  s-market-place/<id>
OUR_IMAGE = re.compile(r'^https://res\.cloudinary\.com/[^/]+/image/upload/(?:v\d+/)?(s-market-place/[^/.]+)\.[A-Za-z0-9]+$')
MAX_ATTEMPTS = 10      # give up on a picture after this many failed tries (it is logged)
BATCH_SIZE = 10        # pictures handled per run


def cloudinary_public_id(url):
    """The Cloudinary id of one of OUR pictures, or None for anything else (empty, external, other folder)."""
    match = OUR_IMAGE.match(url or '')
    return match.group(1) if match else None


def cloudinary_ready():
    """True when the three Cloudinary settings are present on this server."""
    return all(os.environ.get(name) for name in ('CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'))


def queue_image_deletion(con, url):
    """Add a picture to the "to delete" list (ignored if it is not one of ours or is already listed)."""
    public_id = cloudinary_public_id(url)
    if public_id:
        con.execute('INSERT INTO image_cleanup(url, public_id) VALUES(%s,%s) ON CONFLICT (url) DO NOTHING', (url, public_id))


def is_still_used(con, url):
    """True if any product, deal or profile still shows this picture (so it must NOT be deleted)."""
    row = con.execute(
        """SELECT 1 FROM products WHERE image = %s
           UNION ALL SELECT 1 FROM flash_deals WHERE image = %s
           UNION ALL SELECT 1 FROM users WHERE profile_image = %s LIMIT 1""", (url, url, url)).fetchone()
    return row is not None


def process_queue(con, logger):
    """Delete the listed pictures from Cloudinary. Returns how many were removed."""
    if not cloudinary_ready():
        return 0                                   # nothing we can do until Cloudinary is configured
    rows = con.execute('SELECT id, url, public_id, attempts FROM image_cleanup ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED',
                       (BATCH_SIZE,)).fetchall()
    removed = 0
    for row in rows:
        if is_still_used(con, row['url']):         # another product reuses the same picture: keep it
            con.execute('DELETE FROM image_cleanup WHERE id=%s', (row['id'],))
            continue
        try:
            result = cloudinary.uploader.destroy(row['public_id'], resource_type='image', invalidate=True)
            if result.get('result') not in ('ok', 'not found'):      # "not found" = already gone, which is fine
                raise RuntimeError(f'Cloudinary answered: {result}')
            con.execute('DELETE FROM image_cleanup WHERE id=%s', (row['id'],))
            removed += 1
        except Exception as error:    # noqa: BLE001 - keep going; we retry on the next run
            attempts = row['attempts'] + 1
            if attempts >= MAX_ATTEMPTS:
                logger.error('Giving up deleting Cloudinary picture %s after %s tries: %s', row['public_id'], attempts, error)
                con.execute('DELETE FROM image_cleanup WHERE id=%s', (row['id'],))
            else:
                con.execute('UPDATE image_cleanup SET attempts=%s WHERE id=%s', (attempts, row['id']))
    return removed
