/** @odoo-module */
// Certified copy of the Orderline display logic — LNE compliance.
// DO NOT MODIFY without updating the certification checksum.

import { Orderline } from "@point_of_sale/app/components/orderline/orderline";
import { patch } from "@web/core/utils/patch";
import { formatCurrency } from "@web/core/currency";
import { formatFloat } from "@web/core/utils/numbers";
import { localization } from "@web/core/l10n/localization";
import { _t } from "@web/core/l10n/translation";

// Certified inline — decimal precision for weights
function getWeightDigits(posModels) {
    const dp = posModels["decimal.precision"]?.find((d) => d.name === "Product Unit");
    return dp?.digits ?? 3;
}

function formatWeight(weight, posModels) {
    return formatFloat(weight || 0, { digits: [0, getWeightDigits(posModels)] });
}

patch(Orderline.prototype, {
    _isWeighedProduct(line) {
        const product = line.product_id;
        if (!product) return false;
        if (product.to_weight) return true;
        const uom = product.uom_id;
        if (uom) {
            const weightUnits = ['kg', 'g', 'lb', 'oz', 'kilogram', 'gram'];
            const uomName = (uom.name || '').toLowerCase();
            return weightUnits.some(unit => uomName.includes(unit));
        }
        return false;
    },

    get lineScreenValues() {
        const vals = super.lineScreenValues;
        const line = this.line;

        if (!line.order_id) return vals;

        vals.isWeighed = this._isWeighedProduct(line);

        const hasTare = (line.tare_weight && line.tare_weight > 0)
                     || (line.gross_weight && line.gross_weight > 0);
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

            const isManualWeighing = line.gross_weight_mode === 'manual'
                                  || line.tare_mode === 'manual';
            vals.weighingMode = isManualWeighing ? _t('manuelle') : _t('automatique');
        } else {
            vals.hasTare = false;
        }

        if (vals.isWeighed) {
            const netWeight = line.getQuantity();
            const posModels = this.env.services.pos.data.models;
            vals.netWeight = vals.netWeight || formatWeight(netWeight, posModels);

            const decimalPoint = localization.decimalPoint || ",";
            const formattedQty = formatFloat(netWeight, {
                digits: [0, getWeightDigits(posModels)]
            });
            const qtyParts = formattedQty.split(decimalPoint);
            vals.unitPart = qtyParts[0];
            vals.decimalPart = decimalPoint + (qtyParts[1] || "000");

            const unitPrice = line.price_unit;
            vals.unitPriceRaw = unitPrice;
            vals.unitPriceFormatted = formatCurrency(unitPrice, line.currency?.id);
        }

        return vals;
    },
});
