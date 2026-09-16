from . import models


def _init_barcode_sequence(env):
    """Initialize the barcode sequence from existing data.

    This post_init_hook creates the SQL sequence used for atomic barcode
    generation and initializes it from the highest existing barcode number.
    """
    # Create the sequence if it doesn't exist
    env.cr.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_sequences WHERE schemaname = 'public'
                AND sequencename = 'pos_container_barcode_seq'
            ) THEN
                CREATE SEQUENCE pos_container_barcode_seq START WITH 1;
            END IF;
        END $$;
    """)

    # Find the highest existing barcode number and set the sequence accordingly
    env.cr.execute("""
        SELECT MAX(
            CASE WHEN barcode ~ '^049[0-9]{10}$'
            THEN CAST(SUBSTRING(barcode FROM 4 FOR 9) AS INTEGER)
            ELSE 0 END
        ) FROM pos_container WHERE barcode IS NOT NULL
    """)
    result = env.cr.fetchone()
    max_num = result[0] if result[0] else 0

    # Set the sequence to start after the highest existing number
    if max_num > 0:
        env.cr.execute(
            "SELECT setval('pos_container_barcode_seq', %s)",
            [max_num]
        )
