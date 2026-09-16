/** @odoo-module */

import { Orderline } from "@point_of_sale/app/components/orderline/orderline";
import { patch } from "@web/core/utils/patch";
import { formatCurrency } from "@web/core/currency";
import { formatFloat } from "@web/core/utils/numbers";
import { formatWeight, getWeightDigits } from "@pos_container/app/utils/weight_utils";
import { localization } from "@web/core/l10n/localization";
import { _t } from "@web/core/l10n/translation";

/**
 * Extend Orderline component to include tare information in the display.
 */
patch(Orderline.prototype, {
    /**
     * Check if a product is weighed (sold by weight).
     * A product is weighed if:
     * - product.to_weight is true (marked as "to weigh" in Odoo)
     * - OR uom_id is a weight unit (kg, g, etc.)
     */
    _isWeighedProduct(line) {
        const product = line.product_id;
        if (!product) return false;

        // Check if product is marked as "to_weight"
        if (product.to_weight) return true;

        // Check if UoM is a weight unit (category = Weight)
        const uom = product.uom_id;
        if (uom) {
            // Weight UoM category typically has id 2 in Odoo, but we check by name pattern
            const weightUnits = ['kg', 'g', 'lb', 'oz', 'kilogram', 'gram'];
            const uomName = (uom.name || '').toLowerCase();
            return weightUnits.some(unit => uomName.includes(unit));
        }

        return false;
    },

    /**
     * Override lineScreenValues to add tare-related display values.
     */
    get lineScreenValues() {
        const vals = super.lineScreenValues;
        const line = this.line;

        // Prevent rendering if the line is not yet linked to an order
        if (!line.order_id) {
            return vals;
        }

        // Detect if product is weighed
        vals.isWeighed = this._isWeighedProduct(line);

        // Add tare-related values if the line has tare or gross_weight
        const hasTare = (line.tare_weight && line.tare_weight > 0) || (line.gross_weight && line.gross_weight > 0);
        if (hasTare) {
            const netWeight = line.getQuantity();
            const tareWeight = line.tare_weight || 0;
            const grossWeight = line.gross_weight || (netWeight + tareWeight);

            const posModels = this.env.services.pos.data.models;
            vals.hasTare = true;
            vals.tareWeight = formatWeight(tareWeight, posModels);
            vals.grossWeight = formatWeight(grossWeight, posModels);
            vals.netWeight = formatWeight(netWeight, posModels);
            vals.unitName = line.product_id?.uom_id?.name || 'kg';

            // Mode de pesée global : manuel si l'un des deux est manuel
            const isManualWeighing = line.gross_weight_mode === 'manual' || line.tare_mode === 'manual';
            vals.weighingMode = isManualWeighing ? _t('manuelle') : _t('automatique');
        } else {
            vals.hasTare = false;
        }

        // Add unit price for weighed products
        if (vals.isWeighed) {
            const netWeight = line.getQuantity();
            const posModels = this.env.services.pos.data.models;
            vals.netWeight = vals.netWeight || formatWeight(netWeight, posModels);

            // Override main quantity display to always show configured decimals
            // (metrological compliance — standard quantityStr may use fewer)
            const decimalPoint = localization.decimalPoint || ",";
            const formattedQty = formatFloat(netWeight, { digits: [0, getWeightDigits(posModels)] });
            const qtyParts = formattedQty.split(decimalPoint);
            vals.unitPart = qtyParts[0];
            vals.decimalPart = decimalPoint + (qtyParts[1] || "000");

            // Get unit price and format it
            const unitPrice = line.price_unit;
            vals.unitPriceRaw = unitPrice;
            vals.unitPriceFormatted = formatCurrency(unitPrice, line.currency?.id);
        }

        return vals;
    },
});
