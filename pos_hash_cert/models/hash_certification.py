from odoo import api, fields, models


class PosHashCertification(models.Model):
    """
    Model to store hash certification records for audit purposes.
    Each record represents a hash verification at a specific point in time.
    """
    _name = 'pos.hash.certification'
    _description = 'Certification Hash Module POS'
    _order = 'create_date desc'

    name = fields.Char(
        string='Nom du Module',
        required=True,
        index=True,
    )
    version = fields.Char(
        string='Version',
    )
    hash_value = fields.Char(
        string='Hash SHA256',
        size=64,
    )
    hash_algorithm = fields.Char(
        string='Algorithme',
        default='SHA256',
    )
    verified_by = fields.Many2one(
        'res.users',
        string='Vérifié par',
        default=lambda self: self.env.user,
    )
    verification_date = fields.Datetime(
        string='Date de Vérification',
        default=fields.Datetime.now,
    )
    pos_config_id = fields.Many2one(
        'pos.config',
        string='Config PdV',
        help='Configuration PdV où la vérification a été effectuée',
    )
    status = fields.Selection([
        ('verified', 'Vérifié'),
        ('mismatch', 'Incohérent'),
        ('not_found', 'Introuvable'),
    ], string='Statut', default='verified')
    notes = fields.Text(
        string='Notes',
    )

    @api.model
    def create_certification_record(self, module_info, pos_config_id=None):
        """
        Create a certification record for audit purposes.

        :param module_info: dict with name, version, hash
        :param pos_config_id: optional POS config ID
        :return: created record
        """
        return self.create({
            'name': module_info.get('name'),
            'version': module_info.get('version'),
            'hash_value': module_info.get('hash'),
            'hash_algorithm': module_info.get('hash_algorithm', 'SHA256'),
            'pos_config_id': pos_config_id,
            'status': 'verified' if module_info.get('hash') else 'not_found',
        })
