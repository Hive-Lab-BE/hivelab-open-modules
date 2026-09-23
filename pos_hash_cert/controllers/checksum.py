import hashlib

from odoo.tools import file_open


CERTIFIED_FILES = [
    'pos_hash_cert/controllers/checksum.py',
    'pos_hash_cert/static/src/pos_overrides/components/orderline/certified_orderline.js',
    'pos_hash_cert/static/src/pos_overrides/components/orderline/certified_orderline.xml',
    'pos_hash_cert/static/src/pos_overrides/components/order_receipt/certified_order_receipt.xml',
    'pos_hash_cert/static/src/pos_overrides/components/scale_screen/certified_scale_service.js',
    'pos_hash_cert/static/src/pos_overrides/components/scale_screen/certified_scale_screen.js',
    'pos_hash_cert/static/src/pos_overrides/components/scale_screen/certified_scale_screen.xml',
    # Driver balance (copie de référence certifiée)
    'pos_hash_cert/certified_drivers/serial_scale_dialog06_driver.py',
]


def calculate_checksum():
    files_data = []
    main_hash = hashlib.sha256()
    for path in sorted(CERTIFIED_FILES):
        with file_open(path, 'rb') as file:
            content = file.read()
        content_hash = hashlib.sha256(content).hexdigest()
        files_data.append({
            'name': path,
            'size_in_bytes': len(content),
            'contents': content.decode(),
            'hash': content_hash
        })
        main_hash.update(content_hash.encode())

    return main_hash.hexdigest(), files_data
