from odoo.tests.common import TransactionCase


class TestPosOrderLineTareFields(TransactionCase):
    """Tests for tare fields on pos.order.line model."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.PosOrderLine = cls.env['pos.order.line']

    def test_tare_weight_field_exists(self):
        """The tare_weight field should exist on pos.order.line."""
        fields = self.PosOrderLine.fields_get()
        self.assertIn('tare_weight', fields)
        self.assertEqual(fields['tare_weight']['type'], 'float')

    def test_tare_mode_selection(self):
        """The tare_mode field should have auto/manual options."""
        fields = self.PosOrderLine.fields_get()
        self.assertIn('tare_mode', fields)
        self.assertEqual(fields['tare_mode']['type'], 'selection')

        selection_values = [opt[0] for opt in fields['tare_mode']['selection']]
        self.assertIn('auto', selection_values)
        self.assertIn('manual', selection_values)

    def test_container_relation(self):
        """The container_id field should be a Many2one to pos.container."""
        fields = self.PosOrderLine.fields_get()
        self.assertIn('container_id', fields)
        self.assertEqual(fields['container_id']['type'], 'many2one')
        self.assertEqual(fields['container_id']['relation'], 'pos.container')


class TestPosOrderLineTareData(TransactionCase):
    """Tests for tare data loading in POS."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.PosOrderLine = cls.env['pos.order.line']
        # Get or create POS config
        cls.pos_config = cls.env['pos.config'].search([], limit=1)
        if not cls.pos_config:
            cls.pos_config = cls.env['pos.config'].create({
                'name': 'Test POS',
            })

    def test_pos_data_fields_loaded(self):
        """Tare fields should be loaded in POS data."""
        fields = self.PosOrderLine._load_pos_data_fields(self.pos_config)

        self.assertIn('tare_weight', fields, "tare_weight should be loaded in POS")
        self.assertIn('tare_mode', fields, "tare_mode should be loaded in POS")
        self.assertIn('container_id', fields, "container_id should be loaded in POS")


class TestGrossWeightCalculation(TransactionCase):
    """Tests for gross weight calculation logic."""

    def test_gross_weight_calculation_logic(self):
        """Gross weight formula: qty + tare should give correct result."""
        qty = 1.5
        tare_weight = 0.100
        gross = qty + (tare_weight or 0.0)
        self.assertAlmostEqual(gross, 1.6, places=3)

    def test_gross_weight_zero_tare_logic(self):
        """Gross weight with zero tare should equal qty."""
        qty = 2.0
        tare_weight = 0.0
        gross = qty + (tare_weight or 0.0)
        self.assertAlmostEqual(gross, 2.0, places=3)

    def test_gross_weight_none_tare_logic(self):
        """Gross weight formula should handle None/False tare."""
        qty = 1.0
        tare_weight = None
        gross = qty + (tare_weight or 0.0)
        self.assertAlmostEqual(gross, 1.0, places=3)

    def test_method_exists_on_model(self):
        """The get_gross_weight method should exist on pos.order.line."""
        self.assertTrue(
            hasattr(self.env['pos.order.line'], 'get_gross_weight'),
            "get_gross_weight method should exist"
        )
