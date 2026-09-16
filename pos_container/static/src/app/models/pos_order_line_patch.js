/** @odoo-module */

import { PosOrderline } from "@point_of_sale/app/models/pos_order_line";
import { patch } from "@web/core/utils/patch";

/**
 * Patch du modèle PosOrderline pour stocker les informations de pesée
 * et les données de tare/contenant.
 *
 * Ajoute les champs:
 * - gross_weight: Poids brut en kg
 * - gross_weight_mode: 'auto' ou 'manual'
 * - tare_weight: Tare en kg
 * - tare_mode: 'auto' ou 'manual'
 * - is_manual_weight: true si pesée manuelle
 * - container_id: référence au contenant utilisé
 */
patch(PosOrderline.prototype, {
    setup(vals) {
        super.setup(vals);

        // Champs de pesée
        this.gross_weight = vals.gross_weight ?? 0;
        this.gross_weight_mode = vals.gross_weight_mode ?? 'auto';
        this.tare_weight = vals.tare_weight ?? 0;
        this.tare_mode = vals.tare_mode ?? null;
        this.is_manual_weight = vals.is_manual_weight ?? false;

        // Champs de consigne
        this.is_deposit_line = vals.is_deposit_line ?? false;
    },

    get productProductPrice() {
        if (typeof this.product_id?.getPrice !== 'function') {
            return this.price_unit;
        }
        return super.productProductPrice;
    },

    /**
     * Définit les informations de pesée sur la ligne.
     * @param {Object} weighData - Données de pesée
     */
    setWeighData(weighData) {
        if (!weighData) return;

        this.gross_weight = weighData.grossWeight ?? this.gross_weight ?? 0;
        this.gross_weight_mode = weighData.grossWeightMode ?? this.gross_weight_mode ?? 'auto';
        this.tare_weight = weighData.tareWeight ?? this.tare_weight ?? 0;
        this.tare_mode = weighData.tareMode ?? this.tare_mode ?? null;
        this.is_manual_weight = weighData.isManualWeight ?? this.is_manual_weight ?? false;

        if (weighData.container !== undefined) {
            this.container_id = weighData.container;
        }
    },

    /**
     * Gets the current tare weight.
     * @returns {number} The tare weight
     */
    getTare() {
        return this.tare_weight || 0;
    },

    /**
     * Check if this line has tare applied.
     * @returns {boolean}
     */
    hasTare() {
        return this.getTare() > 0;
    },

    /**
     * Override canBeMergedWith to prevent merging lines with different tare.
     */
    canBeMergedWith(orderline) {
        if (this.hasTare() || orderline.hasTare?.()) {
            return false;
        }
        return super.canBeMergedWith(orderline);
    },
});
