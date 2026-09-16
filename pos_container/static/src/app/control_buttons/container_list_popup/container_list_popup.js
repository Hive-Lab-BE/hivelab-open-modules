/** @odoo-module */

import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { _t } from "@web/core/l10n/translation";
import { formatFloat } from "@web/core/utils/numbers";
import { formatWeight as formatWeightUtil } from "../../utils/weight_utils";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";

export class ContainerListPopup extends Component {
    static template = "pos_container.ContainerListPopup";
    static components = { Dialog };
    static props = {
        title: { type: String, optional: true },
        containers: { type: Array, optional: true },
        getPayload: Function,
        close: Function,
    };
    static defaultProps = {
        title: _t("Sélectionner un contenant"),
        containers: [],
    };

    setup() {
        this.pos = usePos();
        this.state = useState({
            searchTerm: "",
        });
    }

    get filteredContainers() {
        const searchTerm = this.state.searchTerm.toLowerCase().trim();
        if (!searchTerm) {
            return this.props.containers;
        }
        return this.props.containers.filter((container) => {
            const name = (container.name || "").toLowerCase();
            const barcode = (container.barcode || "").toLowerCase();
            return name.includes(searchTerm) || barcode.includes(searchTerm);
        });
    }

    onSearchInput(event) {
        this.state.searchTerm = event.target.value;
    }

    selectContainer(container) {
        this.props.getPayload(container);
        this.props.close();
    }

    formatWeight(weight) {
        return formatWeightUtil(weight, this.pos.data.models);
    }

    formatDeposit(amount) {
        const dp = this.pos.data.models["decimal.precision"]?.find((d) => d.name === "Product Price");
        return formatFloat(amount || 0, { digits: [0, dp?.digits ?? 2] });
    }

    cancel() {
        this.props.close();
    }

}
