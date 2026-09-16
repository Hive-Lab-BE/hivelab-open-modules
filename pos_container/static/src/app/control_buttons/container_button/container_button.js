/** @odoo-module */

import { Component } from "@odoo/owl";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";
import { useService } from "@web/core/utils/hooks";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { ContainerListPopup } from "../container_list_popup/container_list_popup";
import { showPendingContainerNotification } from "../../utils/weight_utils";

export class ContainerButton extends Component {
    static template = "pos_container.ContainerButton";
    static props = {
        class: { type: String, optional: true },
    };

    setup() {
        this.pos = usePos();
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.pendingContainer = useService("pending_container");
    }

    async onClick() {
        const containers = this.pos.models["pos.container"]?.getAll() || [];
        const selectedContainer = await makeAwaitable(this.dialog, ContainerListPopup, {
            containers,
        });

        if (selectedContainer) {
            this._applyContainer(selectedContainer);
        }
    }

    _applyContainer(container) {
        this.pendingContainer.set(container);
        showPendingContainerNotification(container, this.notification, this.pos.data.models);
    }
}
