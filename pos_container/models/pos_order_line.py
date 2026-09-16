from odoo import api, fields, models
from odoo.exceptions import ValidationError

MAX_GROSS_WEIGHT_KG = 100.0
MAX_TARE_WEIGHT_KG = 10.0
MIN_WEIGHT_KG = 0.0


class PosOrderLine(models.Model):
    _inherit = 'pos.order.line'

    gross_weight = fields.Float(
        string='Poids Brut (kg)',
        digits=(12, 3),
        help='Poids brut avant déduction de la tare'
    )
    gross_weight_mode = fields.Selection([
        ('auto', 'Automatique'),
        ('manual', 'Manuel'),
    ], string='Mode Poids Brut', default='auto')

    tare_weight = fields.Float(
        string='Tare (kg)',
        digits=(12, 3),
        help='Poids de la tare (contenant)'
    )
    tare_mode = fields.Selection([
        ('auto', 'Automatique'),
        ('manual', 'Manuel'),
    ], string='Mode Tare')
    container_id = fields.Many2one(
        'pos.container',
        string='Contenant',
        ondelete='set null',
        help='Contenant utilisé pour la tare automatique'
    )

    is_deposit_line = fields.Boolean(
        string='Ligne de consigne',
        default=False,
        help='Indique que cette ligne est une consigne automatique'
    )
    deposit_for_line_id = fields.Many2one(
        'pos.order.line',
        string='Ligne produit associée',
        ondelete='cascade',
        help='Ligne produit à laquelle cette consigne est liée'
    )

    is_manual_weight = fields.Boolean(
        string='Poids Manuel',
        compute='_compute_is_manual_weight',
        store=True,
        help='Indique si le poids ou la tare a été saisi manuellement'
    )

    @api.depends('gross_weight_mode', 'tare_mode')
    def _compute_is_manual_weight(self):
        for line in self:
            line.is_manual_weight = (
                line.gross_weight_mode == 'manual' or
                line.tare_mode == 'manual'
            )

    @api.constrains('gross_weight')
    def _check_gross_weight_limits(self):
        """Validate gross weight is within plausible limits."""
        for line in self:
            if line.gross_weight is None:
                continue
            if line.gross_weight < MIN_WEIGHT_KG:
                raise ValidationError(
                    'Le poids brut ne peut pas être négatif. '
                    'Valeur actuelle: %.3f kg' % line.gross_weight
                )
            if line.gross_weight > MAX_GROSS_WEIGHT_KG:
                raise ValidationError(
                    'Le poids brut dépasse la limite maximale de %.1f kg. '
                    'Valeur actuelle: %.3f kg. '
                    'Vérifiez que vous n\'avez pas saisi une valeur en grammes.'
                    % (MAX_GROSS_WEIGHT_KG, line.gross_weight)
                )

    @api.constrains('tare_weight')
    def _check_tare_weight_limits(self):
        """Validate tare weight is within plausible limits."""
        for line in self:
            if line.tare_weight is None:
                continue
            if line.tare_weight < MIN_WEIGHT_KG:
                raise ValidationError(
                    'La tare ne peut pas être négative. '
                    'Valeur actuelle: %.3f kg' % line.tare_weight
                )
            if line.tare_weight > MAX_TARE_WEIGHT_KG:
                raise ValidationError(
                    'La tare dépasse la limite maximale de %.1f kg. '
                    'Valeur actuelle: %.3f kg' % (MAX_TARE_WEIGHT_KG, line.tare_weight)
                )

    @api.model
    def _load_pos_data_fields(self, config):
        """Ajoute les champs de pesée aux données chargées dans le POS."""
        fields_list = super()._load_pos_data_fields(config)
        fields_list.extend([
            'gross_weight',
            'gross_weight_mode',
            'tare_weight',
            'tare_mode',
            'is_manual_weight',
            'container_id',
            'is_deposit_line',
            'deposit_for_line_id',
        ])
        return fields_list

    def get_gross_weight(self):
        """Return the gross weight (quantity + tare)."""
        self.ensure_one()
        return self.qty + (self.tare_weight or 0.0)
