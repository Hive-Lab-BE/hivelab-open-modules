from odoo.tests.common import TransactionCase
from odoo.exceptions import ValidationError


class TestPosContainerEAN13(TransactionCase):
    """Tests for EAN-13 barcode validation in pos.container model."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Container = cls.env['pos.container']

    # -------------------------------------------------------------------------
    # Tests: _compute_ean13_check_digit
    # -------------------------------------------------------------------------

    def test_ean13_check_digit_valid(self):
        """Check digit calculation should return correct value for valid input."""
        # 049000000001 -> check digit should be 6 (0490000000016)
        check = self.Container._compute_ean13_check_digit('049000000001')
        self.assertEqual(check, 6, "Check digit for 049000000001 should be 6")

        # Another test case: 590123412345 -> check digit is 7
        check2 = self.Container._compute_ean13_check_digit('590123412345')
        self.assertEqual(check2, 7, "Check digit for 590123412345 should be 7")

        # Test with zeros: 000000000000 -> check digit is 0
        check3 = self.Container._compute_ean13_check_digit('000000000000')
        self.assertEqual(check3, 0, "Check digit for all zeros should be 0")

    def test_ean13_check_digit_invalid_length(self):
        """Check digit should return None for input != 12 characters."""
        # Too short
        result = self.Container._compute_ean13_check_digit('04900000001')
        self.assertIsNone(result, "Should return None for 11 characters")

        # Too long
        result = self.Container._compute_ean13_check_digit('0490000000012')
        self.assertIsNone(result, "Should return None for 13 characters")

        # Empty string
        result = self.Container._compute_ean13_check_digit('')
        self.assertIsNone(result, "Should return None for empty string")

    def test_ean13_check_digit_non_numeric(self):
        """Check digit should return None for non-numeric input."""
        result = self.Container._compute_ean13_check_digit('04900000000A')
        self.assertIsNone(result, "Should return None for non-numeric input")

        result = self.Container._compute_ean13_check_digit('abcdefghijkl')
        self.assertIsNone(result, "Should return None for alphabetic input")

    # -------------------------------------------------------------------------
    # Tests: _is_valid_ean13
    # -------------------------------------------------------------------------

    def test_is_valid_ean13_correct(self):
        """Valid EAN-13 barcodes should pass validation."""
        # 0490000000016 is valid (check digit = 6)
        self.assertTrue(
            self.Container._is_valid_ean13('0490000000016'),
            "0490000000016 should be valid"
        )
        # 5901234123457 is a known valid EAN-13
        self.assertTrue(
            self.Container._is_valid_ean13('5901234123457'),
            "5901234123457 should be valid"
        )

    def test_is_valid_ean13_wrong_checksum(self):
        """Invalid check digit should fail validation."""
        # 0490000000012 has wrong check digit (should be 6, not 2)
        self.assertFalse(
            self.Container._is_valid_ean13('0490000000012'),
            "0490000000012 should be invalid (wrong checksum)"
        )

    def test_is_valid_ean13_wrong_length(self):
        """Non-13 character barcodes should fail validation."""
        self.assertFalse(
            self.Container._is_valid_ean13('04900000000'),
            "11-character barcode should be invalid"
        )
        self.assertFalse(
            self.Container._is_valid_ean13('04900000000123'),
            "14-character barcode should be invalid"
        )

    def test_is_valid_ean13_non_numeric(self):
        """Non-numeric barcodes should fail validation."""
        self.assertFalse(
            self.Container._is_valid_ean13('049000000001A'),
            "Barcode with letter should be invalid"
        )


class TestPosContainerConstraints(TransactionCase):
    """Tests for pos.container model constraints."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Container = cls.env['pos.container']

    def test_barcode_prefix_049_required(self):
        """Container barcode must start with 049."""
        with self.assertRaises(ValidationError) as cm:
            self.Container.create({
                'name': 'Test Container',
                'barcode': '1234567890128',  # Valid EAN-13 but wrong prefix
                'tare': 0.100,
            })
        self.assertIn('049', str(cm.exception))

    def test_barcode_length_13(self):
        """Container barcode must be exactly 13 characters."""
        with self.assertRaises(ValidationError) as cm:
            self.Container.create({
                'name': 'Test Container',
                'barcode': '04900000001',  # Only 11 characters
                'tare': 0.100,
            })
        self.assertIn('13', str(cm.exception))

    def test_barcode_digits_only(self):
        """Container barcode must contain only digits."""
        with self.assertRaises(ValidationError) as cm:
            self.Container.create({
                'name': 'Test Container',
                'barcode': '049000000001A',  # Contains letter
                'tare': 0.100,
            })
        self.assertIn('chiffres', str(cm.exception))

    def test_barcode_valid_checksum_required(self):
        """Container barcode must have valid EAN-13 checksum."""
        with self.assertRaises(ValidationError) as cm:
            self.Container.create({
                'name': 'Test Container',
                'barcode': '0490000000012',  # Wrong check digit (should be 6)
                'tare': 0.100,
            })
        self.assertIn('check digit', str(cm.exception).lower())

    def test_tare_positive_constraint(self):
        """Container tare must be >= 0."""
        barcode = self.Container._generate_next_barcode()
        with self.assertRaises(ValidationError) as cm:
            self.Container.create({
                'name': 'Test Container',
                'barcode': barcode,
                'tare': -0.100,  # Negative tare
            })
        self.assertIn('positive', str(cm.exception).lower())

    def test_tare_zero_allowed(self):
        """Container tare of 0 should be allowed."""
        barcode = self.Container._generate_next_barcode()
        container = self.Container.create({
            'name': 'Zero Tare Container',
            'barcode': barcode,
            'tare': 0.0,
        })
        self.assertEqual(container.tare, 0.0)


class TestPosContainerBarcodeGeneration(TransactionCase):
    """Tests for barcode generation in pos.container model."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Container = cls.env['pos.container']

    def test_generate_barcode_sequence(self):
        """Generated barcodes should be sequential and valid."""
        barcode1 = self.Container._generate_next_barcode()
        self.assertTrue(barcode1.startswith('049'), "Generated barcode should start with 049")
        self.assertEqual(len(barcode1), 13, "Generated barcode should be 13 characters")
        self.assertTrue(
            self.Container._is_valid_ean13(barcode1),
            "Generated barcode should be valid EAN-13"
        )

        # Create container with first barcode
        self.Container.create({
            'name': 'Container 1',
            'barcode': barcode1,
            'tare': 0.100,
        })

        # Generate next barcode - should be sequential
        barcode2 = self.Container._generate_next_barcode()
        self.assertTrue(
            self.Container._is_valid_ean13(barcode2),
            "Second generated barcode should be valid EAN-13"
        )
        # The numeric part should be incremented
        num1 = int(barcode1[3:12])
        num2 = int(barcode2[3:12])
        self.assertEqual(num2, num1 + 1, "Sequential barcodes should increment by 1")

    def test_barcode_unique_constraint(self):
        """Two containers cannot have the same barcode."""
        barcode = self.Container._generate_next_barcode()
        self.Container.create({
            'name': 'Container 1',
            'barcode': barcode,
            'tare': 0.100,
        })

        with self.assertRaises(Exception):  # Could be IntegrityError or ValidationError
            self.Container.create({
                'name': 'Container 2',
                'barcode': barcode,  # Same barcode
                'tare': 0.200,
            })


class TestPosContainerCreate(TransactionCase):
    """Tests for creating pos.container records."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Container = cls.env['pos.container']

    def test_create_valid_container(self):
        """Creating a container with valid data should succeed."""
        barcode = self.Container._generate_next_barcode()
        container = self.Container.create({
            'name': 'Bocal 500ml',
            'barcode': barcode,
            'tare': 0.250,
            'deposit_amount': 1.50,
        })
        self.assertEqual(container.name, 'Bocal 500ml')
        self.assertEqual(container.barcode, barcode)
        self.assertEqual(container.tare, 0.250)
        self.assertEqual(container.deposit_amount, 1.50)
        self.assertEqual(container.state, 'in_store')  # Default state

    def test_action_generate_barcode(self):
        """Action to generate barcode should work on new containers."""
        # Test _generate_next_barcode method directly
        barcode = self.Container._generate_next_barcode()

        self.assertTrue(barcode, "Barcode should be generated")
        self.assertEqual(len(barcode), 13, "Generated barcode should be 13 chars")
        self.assertTrue(barcode.startswith('049'), "Should start with 049 prefix")
        self.assertTrue(
            self.Container._is_valid_ean13(barcode),
            "Generated barcode should be valid EAN-13"
        )


class TestPosContainerPOSDataLoading(TransactionCase):
    """Tests for POS data loading in pos.container model."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Container = cls.env['pos.container']
        # Get or create POS config
        cls.pos_config = cls.env['pos.config'].search([], limit=1)
        if not cls.pos_config:
            cls.pos_config = cls.env['pos.config'].create({
                'name': 'Test POS',
            })

    def test_pos_data_fields_loaded(self):
        """POS should load all required container fields."""
        fields = self.Container._load_pos_data_fields(self.pos_config)
        expected_fields = ['id', 'name', 'barcode', 'tare', 'deposit_amount', 'state']
        for field in expected_fields:
            self.assertIn(field, fields, f"Field {field} should be loaded in POS")

    def test_pos_data_domain_returns_all(self):
        """POS data domain should return empty list (load all containers)."""
        domain = self.Container._load_pos_data_domain({}, self.pos_config)
        self.assertEqual(domain, [], "Domain should be empty to load all containers")
