/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { CertifiedScaleScreen } from "../components/scale_screen/certified_scale_screen";
import { _t } from "@web/core/l10n/translation";

/**
 * Patch du PosStore pour:
 * - Injecter le CertifiedScaleScreen comme dialog de pesée (remplace ScaleScreen)
 * - Ajouter isCertified basé sur le checksum Mayam
 * - Capturer le payload de pesée enrichi (poids brut, tare, mode, contenant)
 */
patch(PosStore.prototype, {
    async processServerData() {
        await super.processServerData(...arguments);
        this.config.isCertified = this.isCertified;
        this.config.certificationErrors = this.certificationErrors;
        this.config.showCertificationWarning = !this.isCertified;
    },

    get certificationErrors() {
        const errors = [];
        if (this.config._mayam_checksum !== this.config._mayam_checksum_expected) {
            errors.push(_t("Le checksum ne correspond pas, le code a été modifié et n'est plus certifié"));
        }
        return errors;
    },

    get isCertified() {
        return this.certificationErrors.length === 0;
    },

    /**
     * Override weighProduct to use CertifiedScaleScreen and capture enriched payload.
     */
    async weighProduct() {
        const result = await makeAwaitable(this.env.services.dialog, CertifiedScaleScreen);

        // CertifiedScaleScreen.confirm() returns an enriched payload object
        if (result && typeof result === 'object' && result.weight !== undefined) {
            this._lastWeighData = {
                grossWeight: result.grossWeight ?? 0,
                grossWeightMode: result.grossWeightMode ?? 'auto',
                tareWeight: result.tareWeight ?? 0,
                tareMode: result.tareMode ?? 'auto',
                isManualWeight: result.isManualWeight ?? false,
                container: result.container ?? null,
            };
            return result.weight;
        }

        this._lastWeighData = null;
        // Return 0 instead of null to prevent adding an orderline on cancel
        return result ?? 0;
    },
});
