/** @odoo-module */

import { registry } from "@web/core/registry";
import { Base } from "@point_of_sale/app/models/related_models";
import { formatWeight } from "../utils/weight_utils";

export class PosContainer extends Base {
    static pythonModel = "pos.container";

    get displayName() {
        return this.name ? `${this.name} (${this.barcode})` : this.barcode;
    }

    get tareFormatted() {
        return `${formatWeight(this.tare, this.models)} kg`;
    }
}

registry.category("pos_available_models").add(PosContainer.pythonModel, PosContainer);
