/** @odoo-module */

import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { patch } from "@web/core/utils/patch";
import { ContainerButton } from "./container_button/container_button";

// Add ContainerButton to the components
patch(ControlButtons, {
    components: {
        ...ControlButtons.components,
        ContainerButton,
    },
});
