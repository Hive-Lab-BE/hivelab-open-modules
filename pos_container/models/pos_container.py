from odoo import api, fields, models
from odoo.exceptions import ValidationError


class PosContainer(models.Model):
    _name = 'pos.container'
    _inherit = ['pos.load.mixin']
    _description = 'Contenant réutilisable'
    _order = 'name'

    # -------------------------------------------------------------------------
    # EAN13 Barcode Helpers
    # -------------------------------------------------------------------------

    @staticmethod
    def _compute_ean13_check_digit(barcode_12):
        """Calcule le check digit EAN13 pour les 12 premiers chiffres.

        L'algorithme EAN-13:
        - Positions impaires (1,3,5...): poids 1
        - Positions paires (2,4,6...): poids 3
        - Check digit = (10 - (somme % 10)) % 10
        """
        if len(barcode_12) != 12 or not barcode_12.isdigit():
            return None
        total = 0
        for i, digit in enumerate(barcode_12):
            weight = 1 if i % 2 == 0 else 3
            total += int(digit) * weight
        return (10 - (total % 10)) % 10

    @staticmethod
    def _is_valid_ean13(barcode):
        """Vérifie si un code-barres EAN13 est valide (check digit correct)."""
        if len(barcode) != 13 or not barcode.isdigit():
            return False
        expected_check = PosContainer._compute_ean13_check_digit(barcode[:12])
        return expected_check == int(barcode[12])

    # -------------------------------------------------------------------------
    # Fields
    # -------------------------------------------------------------------------

    name = fields.Char(
        string='Nom',
        help='Nom du contenant (ex: Bocal 500ml)'
    )
    barcode = fields.Char(
        string='Code-barres',
        size=13,
        index=True,
        copy=False,
        help='EAN13 valide, doit commencer par 049'
    )
    tare = fields.Float(
        string='Tare (kg)',
        required=True,
        digits=(12, 3),
        help='Poids du contenant vide en kilogrammes'
    )
    deposit_amount = fields.Float(
        string='Consigne',
        digits='Product Price',
        default=0.0,
        help='Montant de la consigne en euros'
    )
    state = fields.Selection([
        ('in_store', 'En magasin'),
        ('with_customer', 'Chez le client'),
    ], string='Statut', default='in_store')

    _barcode_unique = models.Constraint(
        'UNIQUE(barcode)',
        'Un contenant avec ce code-barres existe déjà !'
    )

    @api.constrains('barcode')
    def _check_barcode_prefix(self):
        """Vérifie que le code-barres est un EAN13 valide avec préfixe 049."""
        for record in self:
            if not record.barcode:
                raise ValidationError('Le code-barres est obligatoire.')

            if not record.barcode.startswith('049'):
                raise ValidationError(
                    'Le code-barres doit commencer par "049". '
                    'Code-barres actuel: %s' % record.barcode
                )
            if len(record.barcode) != 13:
                raise ValidationError(
                    'Le code-barres doit faire exactement 13 caractères (EAN13). '
                    'Longueur actuelle: %d' % len(record.barcode)
                )
            if not record.barcode.isdigit():
                raise ValidationError(
                    'Le code-barres doit contenir uniquement des chiffres.'
                )
            if not self._is_valid_ean13(record.barcode):
                expected_check = self._compute_ean13_check_digit(record.barcode[:12])
                raise ValidationError(
                    'Le code-barres EAN13 est invalide (check digit incorrect). '
                    'Code actuel: %s, dernier chiffre attendu: %s' % (
                        record.barcode, expected_check
                    )
                )

    @api.constrains('tare')
    def _check_tare_positive(self):
        """Vérifie que la tare est positive."""
        for record in self:
            if record.tare < 0:
                raise ValidationError(
                    'La tare doit être positive. Valeur actuelle: %s' % record.tare
                )

    # -------------------------------------------------------------------------
    # Actions
    # -------------------------------------------------------------------------

    @api.model
    def _generate_next_barcode(self):
        """Génère le prochain code-barres EAN13 valide avec préfixe 049.

        Utilise une séquence SQL pour éviter les race conditions quand
        plusieurs sessions créent des contenants simultanément.
        """
        self.env.cr.execute(
            "SELECT nextval('pos_container_barcode_seq')"
        )
        num = self.env.cr.fetchone()[0]

        barcode_12 = '049' + str(num).zfill(9)
        check_digit = self._compute_ean13_check_digit(barcode_12)
        return barcode_12 + str(check_digit)

    def action_generate_barcode(self):
        """Action pour régénérer un code-barres valide."""
        for record in self:
            record.barcode = self._generate_next_barcode()
        return True

    @api.model_create_multi
    def create(self, vals_list):
        """Auto-génère le code-barres si non fourni."""
        for vals in vals_list:
            if not vals.get('barcode'):
                vals['barcode'] = self._generate_next_barcode()
        return super().create(vals_list)

    # -------------------------------------------------------------------------
    # POS Data Loading
    # -------------------------------------------------------------------------

    @api.model
    def _load_pos_data_domain(self, data, config):
        """Charge tous les contenants dans le POS."""
        return []

    @api.model
    def _load_pos_data_fields(self, config):
        """Champs à charger dans le POS."""
        return ['id', 'name', 'barcode', 'tare', 'deposit_amount', 'state']
