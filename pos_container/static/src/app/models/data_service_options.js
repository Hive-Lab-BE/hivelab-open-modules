/** @odoo-module */

import { DataServiceOptions } from "@point_of_sale/app/models/data_service_options";
import { patch } from "@web/core/utils/patch";

/**
 * Ajoute un index sur le champ barcode de pos.container
 * pour permettre la recherche rapide par code-barres.
 */
patch(DataServiceOptions.prototype, {
    get databaseIndex() {
        const indexes = super.databaseIndex;
        indexes["pos.container"] = ["barcode"];
        return indexes;
    },
});
