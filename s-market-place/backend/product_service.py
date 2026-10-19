"""The life of a product: live -> (paused) -> deleted -> erased for good.

  live     shoppers can see and buy it
  paused   the trader hid it for a while; they can resume it any time
  deleted  hidden at once, but the trader can restore it for 30 days
  erased   30 days later the system removes it for good, together with its Cloudinary picture

`products.is_active` always means "shoppers can see it right now" (not paused and not deleted),
so every shopper-facing query only needs to check that one flag.
"""
import image_service

RECOVERY_DAYS = 30


def purge_deleted_products(con):
    """Erase products that were deleted more than 30 days ago.

    The picture goes onto the Cloudinary "to delete" list. The product row is removed; the only
    exception is a product that appears in past orders. Its row is kept as an empty shell so the
    buyer's order history still works, but its picture and description are wiped.
    """
    due = con.execute(
        f"""SELECT id, image FROM products
            WHERE deleted_at < NOW() - INTERVAL '{RECOVERY_DAYS} days' AND purged_at IS NULL
            ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED""").fetchall()
    for product in due:
        image_service.queue_image_deletion(con, product['image'])
        in_orders = con.execute('SELECT 1 FROM order_items WHERE product_id=%s LIMIT 1', (product['id'],)).fetchone()
        if in_orders:
            con.execute("UPDATE products SET image='', description='', stock=0, purged_at=NOW() WHERE id=%s", (product['id'],))
        else:
            con.execute('DELETE FROM products WHERE id=%s', (product['id'],))
    return len(due)
