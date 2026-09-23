from odoo import fields, models, release

from odoo.addons.pos_hash_cert.controllers.checksum import calculate_checksum
from odoo.addons.pos_hash_cert.controllers.expected_checksum import EXPECTED_CHECKSUM


class PosConfig(models.Model):
    """Extend POS Config with hash certification settings."""

    _inherit = 'pos.config'

    hash_cert_enabled = fields.Boolean(
        string='Activer la Certification Hash',
        default=True,
        help='Afficher la certification hash dans le PdV (conformité LNE)',
    )
    hash_cert_certificate_number = fields.Char(
        string='N° Certificat',
        default='LNE-33018-3',
        help='Numéro de certificat LNE pour la certification métrologique',
    )
    hash_cert_vendor = fields.Char(
        string='Éditeur',
        default='Mayam',
        help="Nom de l'éditeur pour l'affichage de la certification",
    )

    def _get_display_device_ip(self):
        """Override to disable IoT polling mode for the customer display.

        The base implementation returns proxy_ip, which causes the customer
        display JS service to poll http://localhost:8069/hw_proxy/... (IoT Box
        mode).  On a remote server this always fails because localhost points
        to the client machine, not the IoT Box.

        Returning an empty string makes the customer display use
        BroadcastChannel + Bus service instead, which works across networks.
        The POS itself still uses proxy_ip normally for scale / IoT
        communication.
        """
        self.ensure_one()
        return ""

    def _load_pos_data_read(self, records, config):
        read_records = super()._load_pos_data_read(records, config)
        if read_records and config.hash_cert_enabled:
            read_records[0]["_mayam_checksum"] = calculate_checksum()[0]
            read_records[0]["_mayam_checksum_expected"] = EXPECTED_CHECKSUM
            read_records[0]["_mayam_certification_details"] = config._get_certification_details()
        return read_records

    def _get_certification_details(self):
        self.ensure_one()
        iot_image = ""
        if hasattr(self, 'iface_scale_id') and self.iface_scale_id and self.iface_scale_id.iot_id:
            iot_image = self.iface_scale_id.iot_id.version or ""
        return {
            "pos_name": "Mayam Point de Vente",
            "odoo_version": release.major_version,
            "certificate_number": self.hash_cert_certificate_number or "",
            "vendor": self.hash_cert_vendor or "Mayam",
            "pos_app_version": self.env["ir.module.module"]._get("pos_hash_cert").installed_version or "",
            "iot_image": iot_image,
        }
