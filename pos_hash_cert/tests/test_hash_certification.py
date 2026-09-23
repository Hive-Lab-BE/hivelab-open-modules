from odoo.tests import HttpCase
from odoo.tests.common import TransactionCase, tagged
from odoo.tools import file_open

from odoo.addons.pos_hash_cert.controllers.checksum import CERTIFIED_FILES, calculate_checksum
from odoo.addons.pos_hash_cert.controllers.expected_checksum import EXPECTED_CHECKSUM


class TestChecksum(TransactionCase):
    """Tests for the checksum calculation logic."""

    def test_checksum_matches_expected(self):
        """Computed checksum should match the expected value."""
        global_hash = calculate_checksum()[0]
        self.assertEqual(
            global_hash, EXPECTED_CHECKSUM,
            "Computed checksum does not match EXPECTED_CHECKSUM. "
            "If you changed a certified file, update expected_checksum.py."
        )

    def test_checksum_deterministic(self):
        """Two consecutive calls should return the same hash."""
        hash1 = calculate_checksum()[0]
        hash2 = calculate_checksum()[0]
        self.assertEqual(hash1, hash2, "Checksum should be deterministic")

    def test_all_certified_files_exist(self):
        """All files in CERTIFIED_FILES should be readable via file_open."""
        for path in CERTIFIED_FILES:
            try:
                with file_open(path, 'rb') as f:
                    content = f.read()
                self.assertTrue(len(content) > 0, f"File {path} is empty")
            except FileNotFoundError:
                self.fail(f"Certified file not found: {path}")


@tagged('post_install', '-at_install')
class TestController(HttpCase):
    """Tests for the hash certification HTTP endpoints."""

    def test_html_endpoint_format(self):
        """HTML endpoint should return styled HTML page with global hash."""
        self.authenticate("admin", "admin")
        response = self.url_open("/pos/module_hash/html")
        self.assertEqual(response.status_code, 200)
        self.assertIn('text/html', response.headers.get('Content-Type', ''))

        global_hash = calculate_checksum()[0]
        self.assertIn(global_hash, response.text)


class TestHashCertificationModel(TransactionCase):
    """Tests for pos.hash.certification model."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.HashCert = cls.env['pos.hash.certification']

    def test_certification_record_created(self):
        """Creating a certification record should store module info."""
        module_info = {
            'name': 'test_module',
            'version': '19.0.1.0.0',
            'hash': 'abc123def456' * 4,  # 48 chars
            'hash_algorithm': 'SHA256',
        }
        record = self.HashCert.create_certification_record(module_info)

        self.assertEqual(record.name, 'test_module')
        self.assertEqual(record.version, '19.0.1.0.0')
        self.assertEqual(record.hash_value, module_info['hash'])
        self.assertEqual(record.hash_algorithm, 'SHA256')
        self.assertEqual(record.status, 'verified')

    def test_certification_record_no_hash(self):
        """Certification record without hash should have 'not_found' status."""
        module_info = {
            'name': 'missing_module',
            'version': '1.0.0',
            'hash': None,
        }
        record = self.HashCert.create_certification_record(module_info)

        self.assertEqual(record.name, 'missing_module')
        self.assertEqual(record.status, 'not_found')

    def test_certification_record_with_pos_config(self):
        """Certification record should link to POS config if provided."""
        pos_config = self.env['pos.config'].search([], limit=1)
        if not pos_config:
            pos_config = self.env['pos.config'].create({
                'name': 'Test POS',
            })

        module_info = {
            'name': 'test_module',
            'version': '1.0.0',
            'hash': 'abc123' * 8,
        }
        record = self.HashCert.create_certification_record(module_info, pos_config.id)

        self.assertEqual(record.pos_config_id.id, pos_config.id)

    def test_certification_record_default_algorithm(self):
        """Certification record should default to SHA256 algorithm."""
        module_info = {
            'name': 'test_module',
            'version': '1.0.0',
            'hash': 'abc123' * 8,
        }
        record = self.HashCert.create_certification_record(module_info)

        self.assertEqual(record.hash_algorithm, 'SHA256')
