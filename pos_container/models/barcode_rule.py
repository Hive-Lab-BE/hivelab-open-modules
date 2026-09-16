from odoo import fields, models


class BarcodeRule(models.Model):
    _inherit = 'barcode.rule'

    type = fields.Selection(
        selection_add=[('container', 'Contenant')],
        ondelete={'container': 'set default'}
    )
