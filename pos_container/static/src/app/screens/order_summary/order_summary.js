/** @odoo-module */

import { OrderSummary } from "@point_of_sale/app/screens/product_screen/order_summary/order_summary";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { ScaleScreen } from "@point_of_sale/app/screens/scale_screen/scale_screen";
import { _t } from "@web/core/l10n/translation";
import { onWillUnmount } from "@odoo/owl";
import { formatWeight, getWeightDigits } from "../../utils/weight_utils";

patch(OrderSummary.prototype, {
    setup() {
        super.setup(...arguments);
        this.notification = useService("notification");
        this.scale = useService("pos_scale");
        
        // Double-click tracking for weight products
        this._lastClickedLineUuid = null;
        this._clickCount = 0;
        this._clickTimeout = null;

        // Clean up timeout on unmount
        onWillUnmount(() => {
            this._resetClickTracking();
        });
    },

    /**
     * Override clickLine pour ouvrir le popup contenant sur les produits pesés.
     * Requires double-click to open scale screen on weight products.
     * Single click: select the line, or deselect if already selected
     * Double click: open scale screen for editing
     */
    async clickLine(ev, orderline) {
        ev.stopPropagation();
        this.numberBuffer.reset();

        const isWeightProduct = orderline.product_id?.to_weight;
        const isBeingSelected = !orderline.isSelected();

        // Non-weight products: standard single-click behavior
        if (!isWeightProduct) {
            if (!orderline.isSelected()) {
                this.pos.selectOrderLine(this.currentOrder, orderline);
            } else {
                this.pos.getOrder().uiState.selected_orderline_uuid = null;
            }
            return;
        }

        // Weight products: double-click to edit, single-click on selected to deselect
        const sameLineAsLastClick = this._lastClickedLineUuid === orderline.uuid;
        
        // Double-click detected: open scale screen
        if (sameLineAsLastClick && this._clickCount === 1) {
            clearTimeout(this._clickTimeout);
            this._resetClickTracking();
            await this._reopenScaleForLine(orderline);
            return;
        }

        // Reset any previous click tracking
        clearTimeout(this._clickTimeout);
        
        // First click on unselected line - select and track for double-click
        if (isBeingSelected) {
            this.pos.selectOrderLine(this.currentOrder, orderline);
            this._lastClickedLineUuid = orderline.uuid;
            this._clickCount = 1;

            // After 500ms without second click, just reset tracking (keep line selected)
            this._clickTimeout = setTimeout(() => {
                this._resetClickTracking();
            }, 500);
            return;
        }

        // Clicking an already-selected line: track for potential double-click
        // If timeout expires without second click, deselect it
        this._lastClickedLineUuid = orderline.uuid;
        this._clickCount = 1;

        this._clickTimeout = setTimeout(() => {
            // Single click on selected line -> deselect
            this.pos.getOrder().uiState.selected_orderline_uuid = null;
            this._resetClickTracking();
        }, 500);
    },

    /**
     * Reset double-click tracking state.
     */
    _resetClickTracking() {
        if (this._clickTimeout) {
            clearTimeout(this._clickTimeout);
            this._clickTimeout = null;
        }
        this._lastClickedLineUuid = null;
        this._clickCount = 0;
    },

    /**
     * Ouvre le ScaleScreen Odoo pour modifier une ligne pesée existante.
     * Pré-remplit la tare et le contenant depuis la ligne, puis applique
     * le résultat retourné par le ScaleScreen.
     */
    async _reopenScaleForLine(orderline) {
        // 1. Configurer le scale service avec le produit de la ligne
        const product = orderline.product_id;
        const decimalAccuracy = getWeightDigits(this.pos.data.models);
        const unitPrice = orderline.price_unit;
        this.scale.setProduct(product, decimalAccuracy, unitPrice);

        // 2. Pré-remplir tare et contenant
        if (orderline.container_id) {
            this.scale.setTareWithContainer(
                orderline.container_id.tare || 0,
                orderline.container_id
            );
        } else if (orderline.tare_weight > 0) {
            this.scale.tare = orderline.tare_weight;
            this.scale.isTareManual = orderline.tare_mode === 'manual';
        }

        // 2b. Pré-remplir le poids brut si disponible
        if (orderline.gross_weight > 0) {
            this.scale.setManualWeight(orderline.gross_weight);
        }

        // 3. Ouvrir le ScaleScreen
        const result = await makeAwaitable(this.dialog, ScaleScreen);

        if (!result) return;  // Annulé

        // 4. Appliquer les modifications à la ligne existante
        orderline.gross_weight = result.grossWeight;
        orderline.gross_weight_mode = result.grossWeightMode;
        orderline.tare_weight = result.tareWeight;
        orderline.tare_mode = result.tareMode;
        orderline.is_manual_weight = result.isManualWeight;
        orderline.container_id = result.container;

        // Mettre à jour la quantité (poids net)
        orderline.setQuantity(result.weight);

        // Gérer la ligne de consigne
        if (result.container?.deposit_amount > 0) {
            await this._addOrUpdateDepositLine(this.currentOrder, orderline, result.container);
        } else {
            this._removeDepositLine(this.currentOrder, orderline);
        }

        // Notification de confirmation
        const modeText = result.isManualWeight ? " (MANUEL)" : "";
        this.notification.add(
            _t("Poids net: %(net)s kg%(mode)s", {
                net: formatWeight(result.weight, this.pos.data.models),
                mode: modeText,
            }),
            {
                type: "success",
                sticky: false,
                title: _t("Pesée mise à jour"),
            }
        );
    },

    /**
     * Ajoute ou met à jour une ligne de consigne liée à une ligne produit.
     * @param {Object} order - La commande en cours
     * @param {Object} productLine - La ligne produit pesée
     * @param {Object} container - Le contenant avec deposit_amount
     */
    async _addOrUpdateDepositLine(order, productLine, container) {
        const depositProduct = this.pos.config.deposit_product_id;
        if (!depositProduct) {
            return;
        }

        // Chercher une ligne de consigne existante liée à cette ligne produit
        const existingDeposit = order.lines.find(
            (line) => line.is_deposit_line && line.deposit_for_line_id?.uuid === productLine.uuid
        );

        if (existingDeposit) {
            // Mettre à jour le prix (changement de contenant)
            existingDeposit.price_unit = container.deposit_amount;
            existingDeposit.container_id = container;
        } else {
            // Créer une nouvelle ligne de consigne
            const depositLine = await this.pos.addLineToOrder(
                { product_id: depositProduct, qty: 1, price_unit: container.deposit_amount },
                {},
                false
            );
            if (depositLine) {
                depositLine.is_deposit_line = true;
                depositLine.deposit_for_line_id = productLine;
                depositLine.container_id = container;
            }
        }
    },

    /**
     * Supprime la ligne de consigne liée à une ligne produit.
     * @param {Object} order - La commande en cours
     * @param {Object} productLine - La ligne produit
     */
    _removeDepositLine(order, productLine) {
        const existingDeposit = order.lines.find(
            (line) => line.is_deposit_line && line.deposit_for_line_id?.uuid === productLine.uuid
        );
        if (existingDeposit) {
            order.removeOrderline(existingDeposit);
        }
    },
});
