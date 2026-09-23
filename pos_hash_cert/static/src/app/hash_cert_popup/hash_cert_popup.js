/** @odoo-module */

import { Component, useState, onWillStart } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";

/**
 * Popup component to display module hash certifications.
 * Single server-side hash covering all certified code (POS + driver).
 * Aligned with Odoo Enterprise certification model.
 */
export class HashCertPopup extends Component {
    static template = "pos_hash_cert.HashCertPopup";
    static components = { Dialog };
    static props = {
        close: Function,
        certificationStatus: { type: Object, optional: true },
        errors: { type: Array, optional: true },
    };

    setup() {
        this.pos = usePos();
        this.notification = useService("notification");

        const details = this.pos.config._mayam_certification_details || {};

        this.state = useState({
            loading: true,
            error: null,
            // Server hash
            globalHash: null,
            expectedHash: null,
            serverCertified: false,
            // System info (metadata)
            posName: details.pos_name || "Mayam Point de Vente",
            vendor: details.vendor || "Mayam",
            certificateNumber: details.certificate_number || "",
            odooVersion: details.odoo_version || odoo.info?.server_version || "Unknown",
            posAppVersion: details.pos_app_version || "",
            iotImage: details.iot_image || "",
        });

        onWillStart(async () => {
            this.loadServerHashes();
        });
    }

    get hasErrors() {
        return this.props.errors && this.props.errors.length > 0;
    }

    get isCertified() {
        return this.pos.config._mayam_checksum === this.pos.config._mayam_checksum_expected;
    }

    loadServerHashes() {
        const config = this.pos.config;
        if (config._mayam_checksum) {
            this.state.globalHash = config._mayam_checksum;
            this.state.expectedHash = config._mayam_checksum_expected;
            this.state.serverCertified = this.isCertified;
        } else {
            this.state.error = _t("Données de certification non disponibles");
        }
        this.state.loading = false;
    }

    get title() {
        return _t("Certification Modules (LNE)");
    }

    get overallCertified() {
        return this.state.serverCertified;
    }

    get overallStatusClass() {
        return this.overallCertified ? 'text-success' : 'text-danger';
    }

    get overallStatusIcon() {
        return this.overallCertified ? 'fa-check-circle' : 'fa-times-circle';
    }

    get overallStatusText() {
        return this.overallCertified
            ? _t("Système Certifié")
            : _t("Système Non Certifié");
    }

    copyHash(hash) {
        if (navigator.clipboard && hash) {
            navigator.clipboard.writeText(hash).then(() => {
                this.notification.add(_t("Hash copié dans le presse-papier"), { type: "success" });
            }).catch(() => {
                this.notification.add(_t("Impossible de copier le hash"), { type: "warning" });
            });
        }
    }

    copyReport() {
        const lines = [
            `Hash: ${this.state.globalHash || 'N/A'}`,
            `Expected: ${this.state.expectedHash || 'N/A'}`,
            `Certifié: ${this.state.serverCertified ? 'Oui' : 'Non'}`,
        ];

        const text = lines.join("\n");
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
                this.notification.add(_t("Rapport copié dans le presse-papier"), { type: "success" });
            }).catch(() => {
                this.notification.add(_t("Impossible de copier le rapport"), { type: "warning" });
            });
        }
    }
}
