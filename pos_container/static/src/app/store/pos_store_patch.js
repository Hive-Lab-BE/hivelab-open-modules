/** @odoo-module */

import { PosStore } from "@point_of_sale/app/services/pos_store";
import { patch } from "@web/core/utils/patch";
import { roundDecimals } from "@web/core/utils/numbers";
import { ScaleScreen } from "@point_of_sale/app/screens/scale_screen/scale_screen";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { getWeightDigits } from "../utils/weight_utils";

/**
 * Patch du PosStore pour:
 * - Ouvrir le ScaleScreen patché pour la pesée avec tare/contenant
 * - Associer le contenant à la ligne de commande
 * - Appliquer automatiquement la tare du contenant en attente (mode sans balance)
 * - Stocker les données de pesée enrichies sur les lignes de commande
 *
 * Quand pos_hash_cert est installé, son propre patch de weighProduct()
 * surcharge celui-ci (ouvre CertifiedScaleScreen à la place).
 */
patch(PosStore.prototype, {
    setup() {
        super.setup(...arguments);
        // Stockage temporaire des données de pesée
        this._lastWeighData = null;
    },

    /**
     * Ouvre le ScaleScreen (patché par pos_container) pour peser un produit.
     * Capture le payload enrichi (poids brut, tare, mode, contenant).
     *
     * Quand pos_hash_cert est installé, ce weighProduct() est surchargé
     * pour ouvrir CertifiedScaleScreen à la place.
     */
    async weighProduct() {
        const result = await makeAwaitable(this.env.services.dialog, ScaleScreen);

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
        return result ?? 0;
    },

    /**
     * Vérifie si la balance électronique est disponible (config + connexion).
     * @returns {boolean}
     */
    _isScaleAvailable() {
        if (!this.config.iface_electronic_scale) {
            return false;
        }
        const hwProxy = this.hardwareProxy;
        if (!hwProxy || hwProxy.connectionInfo?.status !== "connected") {
            return false;
        }
        return hwProxy.connectionInfo.drivers?.scale?.status === "connected";
    },

    /**
     * Override addLineToOrder pour:
     * - Appliquer la tare du contenant en attente si pas de balance
     * - Associer le contenant à la ligne créée
     */
    async addLineToOrder(vals, order, opts = {}, configure = true) {
        if (typeof vals.product_tmpl_id === "number") {
            vals.product_tmpl_id = this.data.models["product.template"].get(vals.product_tmpl_id);
        }

        const productTemplate = vals.product_tmpl_id;
        const isToWeight = productTemplate?.to_weight;
        const scaleAvailable = this._isScaleAvailable();

        // Si produit pesé, pas de balance, et contenant en attente → appliquer la tare
        const pendingContainer = this.env.services.pending_container?.get();
        if (!isToWeight && pendingContainer) {
            this.env.services.pending_container.clear();
        }
        if (isToWeight && configure && !scaleAvailable && pendingContainer) {
            const tare = pendingContainer.tare || 0;
            const defaultQty = vals.qty ?? 1;
            const digits = getWeightDigits(this.data.models);
            vals.qty = roundDecimals(Math.max(0, defaultQty - tare), digits);

            this.env.services.pos_scale?.setTareWithContainer(tare, pendingContainer);
            this.env.services.pending_container.consume();
        }

        // Pre-load product on scale service so readWeight() guard passes
        // even if user weighed first then selected the product.
        if (isToWeight && configure) {
            const scaleService = this.env.services.pos_scale;
            if (scaleService) {
                scaleService.product = {
                    name: productTemplate.display_name || "Produit",
                    unitOfMeasure: productTemplate.uom_id?.name || "kg",
                    decimalAccuracy: getWeightDigits(this.data.models),
                    unitPrice: productTemplate.list_price || 0,
                };
            }
        }

        const line = await super.addLineToOrder(vals, order, opts, configure);

        // Associer le contenant si présent sur le scale service
        if (line && this.env.services.pos_scale?.currentContainer) {
            const container = this.env.services.pos_scale.consumeContainer();
            if (container) {
                line.container_id = container;
                line.tare_weight = container.tare;
                line.tare_mode = "auto";
            }
        }

        // Appliquer les infos de pesée si disponibles
        if (line && this._lastWeighData) {
            if (line.setWeighData) {
                line.setWeighData(this._lastWeighData);
            } else {
                line.gross_weight = this._lastWeighData.grossWeight ?? 0;
                line.gross_weight_mode = this._lastWeighData.grossWeightMode ?? 'auto';
                line.tare_weight = this._lastWeighData.tareWeight ?? 0;
                line.tare_mode = this._lastWeighData.tareMode ?? 'auto';
                line.is_manual_weight = this._lastWeighData.isManualWeight ?? false;
            }

            this._lastWeighData = null;
        }

        return line;
    },
});
