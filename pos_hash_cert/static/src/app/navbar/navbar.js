/** @odoo-module */

import { Navbar } from "@point_of_sale/app/components/navbar/navbar";
import { patch } from "@web/core/utils/patch";
import { HashCertPopup } from "@pos_hash_cert/app/hash_cert_popup/hash_cert_popup";
import { useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";

/**
 * Extend Navbar to add Hash Certification button with status indicator.
 * Icon is green when server checksum matches expected, red otherwise.
 * Certification depends only on server-side hash (like Odoo Enterprise).
 */
patch(Navbar.prototype, {
    setup() {
        super.setup(...arguments);
        this.dialogService = useService("dialog");

        this.certificationStatus = useState({
            isCertified: !!this.pos.isCertified,
            tooltip: this.pos.isCertified
                ? _t("Certification Hash (LNE) - Certifié")
                : _t("Certification Hash (LNE) - Non Certifié"),
        });
    },

    /**
     * Open the hash certification popup.
     */
    showHashCertification() {
        this.dialogService.add(HashCertPopup, {
            certificationStatus: this.certificationStatus,
            errors: this.pos.certificationErrors,
        });
    },
});
