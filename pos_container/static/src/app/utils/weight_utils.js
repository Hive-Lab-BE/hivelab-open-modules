/** @odoo-module */

// Weight formatting utilities for pos_container.

import { _t } from "@web/core/l10n/translation";
import { formatFloat } from "@web/core/utils/numbers";

export function getWeightDigits(posModels) {
    const dp = posModels["decimal.precision"]?.find((d) => d.name === "Product Unit");
    return dp?.digits ?? 3;
}

export function formatWeight(weight, posModels) {
    return formatFloat(weight || 0, { digits: [0, getWeightDigits(posModels)] });
}

export function showPendingContainerNotification(container, notification, posModels) {
    notification.add(
        _t("Contenant en attente pour le prochain produit pesé"),
        {
            type: "info",
            sticky: false,
            title: _t("%(name)s (%(tare)s kg)", {
                name: container.name,
                tare: formatWeight(container.tare, posModels),
            }),
        }
    );
}

export function showUnknownContainerNotification(barcode, notification) {
    notification.add(
        _t("Code-barres contenant inconnu: %(barcode)s", { barcode }),
        {
            type: "warning",
            sticky: false,
            title: _t("Contenant non trouvé"),
        }
    );
}
