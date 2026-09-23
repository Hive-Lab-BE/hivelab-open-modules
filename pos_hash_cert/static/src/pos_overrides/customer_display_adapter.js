/** @odoo-module */
import { patch } from "@web/core/utils/patch";
import { CustomerDisplayPosAdapter } from "@point_of_sale/app/customer_display/customer_display_adapter";

patch(CustomerDisplayPosAdapter.prototype, {
    dispatch(pos) {
        this.data.showCertificationWarning = pos.config.showCertificationWarning;
        return super.dispatch(...arguments);
    },
});
