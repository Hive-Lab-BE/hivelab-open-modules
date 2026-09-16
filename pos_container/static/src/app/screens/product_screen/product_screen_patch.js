/** @odoo-module */

import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { patch } from "@web/core/utils/patch";
import { useBarcodeReader } from "@point_of_sale/app/hooks/barcode_reader_hook";
import { useService } from "@web/core/utils/hooks";
import { showPendingContainerNotification } from "../../utils/weight_utils";
import { handleContainerBarcode } from "../../utils/container_barcode";

/**
 * Patch ProductScreen pour:
 * - Exposer pendingContainer au template (pour le badge)
 * - Gérer les scans de codes-barres contenant
 *
 * Flow simplifié: Le contenant scanné est toujours stocké en attente (pending)
 * et sera appliqué au prochain produit pesé.
 */
patch(ProductScreen.prototype, {
    setup() {
        super.setup(...arguments);
        this.notification = useService("notification");
        this.dialog = useService("dialog");

        // Exposé au template product_screen_patch.xml pour le badge
        this.pendingContainer = useService("pending_container");

        useBarcodeReader({
            container: this._onContainerBarcode,
        });
    },

    /**
     * Gère le scan d'un code-barres de contenant.
     */
    _onContainerBarcode(code) {
        handleContainerBarcode(code, {
            posModels: this.pos.models,
            dialog: this.dialog,
            notification: this.notification,
            onFound: (container) => {
                this.pendingContainer.set(container);
                showPendingContainerNotification(container, this.notification, this.pos.data.models);
            },
        });
    },
});
