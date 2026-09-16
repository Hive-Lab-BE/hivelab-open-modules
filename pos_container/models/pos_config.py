from odoo import fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    deposit_product_id = fields.Many2one(
        'product.product',
        string='Produit Consigne',
        help='Produit utilisé pour facturer la consigne des contenants réutilisables'
    )
