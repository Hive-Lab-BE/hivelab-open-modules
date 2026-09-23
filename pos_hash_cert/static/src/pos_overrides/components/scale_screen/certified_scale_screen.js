/** @odoo-module */

// This is a certified copy of the POS ScaleScreen component with Mayam
// container/tare extensions merged in. Having a separate copy allows us to
// keep a certified version that will only change if absolutely necessary,
// whilst the base component is free to change.
//
// DO NOT MODIFY without updating the LNE certification checksum.

import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { useService } from "@web/core/utils/hooks";
import { formatFloat } from "@web/core/utils/numbers";
import { _t } from "@web/core/l10n/translation";
import { useBarcodeReader } from "@point_of_sale/app/hooks/barcode_reader_hook";
import { Numpad } from "@point_of_sale/app/components/numpad/numpad";

// Certified inline — decimal precision for weights
function getWeightDigits(posModels) {
    const dp = posModels["decimal.precision"]?.find((d) => d.name === "Product Unit");
    return dp?.digits ?? 3;
}

function formatWeight(weight, posModels) {
    return formatFloat(weight || 0, { digits: [0, getWeightDigits(posModels)] });
}
import { handleContainerBarcode } from "@pos_container/app/utils/container_barcode";

const RECONNECT_POLLING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_INTEGER_DIGITS = 6;

export class CertifiedScaleScreen extends Component {
    static template = "pos_hash_cert.CertifiedScaleScreen";
    static components = { Dialog, Numpad };
    static props = {
        getPayload: Function,
        close: Function,
    };

    setup() {
        this.scale = useState(useService("pos_scale"));
        this.dialog = useService("dialog");
        this.pendingContainerService = useService("pending_container");
        this.notification = useService("notification");
        this.pos = useService("pos");
        this.hardwareProxy = useService("hardware_proxy");

        // UI state
        this.manualState = useState({
            manualWeightInput: "",
            tareInput: "",
            activeNumpadField: null,
        });

        useBarcodeReader({
            container: this._onContainerBarcode.bind(this),
        });

        // Reconnect polling references
        this._reconnectPollingInterval = null;
        this._reconnectPollingTimeout = null;

        onMounted(() => {
            this.scale.start(this.onError.bind(this));
            this._applyPendingContainer();
            this.scale.setAutoConfirmCallback(() => this._autoConfirm());

            // Pre-fill manual weight input if service already has a value
            if (this.scale.isWeightOverridden && this.scale.manualWeight > 0) {
                this.manualState.manualWeightInput = this.scale.manualWeight.toFixed(
                    getWeightDigits(this.pos.data.models)
                );
            }
        });

        onWillUnmount(() => {
            this.scale.setAutoConfirmCallback(null);
            this._stopReconnectPolling();
            this.scale.reset();
        });
    }

    // ========================================================================
    // PENDING CONTAINER
    // ========================================================================

    _applyPendingContainer() {
        const pending = this.pendingContainerService.get();
        if (pending) {
            this.scale.setTareWithContainer(pending.tare, pending);
            this.pendingContainerService.consume();

            this.notification.add(
                _t("Tare pré-remplie: %(tare)s kg", {
                    tare: formatWeight(pending.tare, this.pos.data.models),
                }),
                {
                    type: "info",
                    sticky: false,
                    title: _t("Contenant: %(name)s", { name: pending.name }),
                }
            );
        }
    }

    // ========================================================================
    // BARCODE HANDLING
    // ========================================================================

    _onContainerBarcode(code) {
        handleContainerBarcode(code, {
            posModels: this.pos.models,
            dialog: this.dialog,
            notification: this.notification,
            onFound: (container) => {
                this.scale.setTareWithContainer(container.tare, container);
                this.manualState.tareInput = container.tare.toFixed(getWeightDigits(this.pos.data.models));
                this.notification.add(
                    _t("Tare mise à jour: %(tare)s kg", {
                        tare: formatWeight(container.tare, this.pos.data.models),
                    }),
                    {
                        type: "success",
                        sticky: false,
                        title: _t("Contenant: %(name)s", { name: container.name }),
                    }
                );
            },
        });
    }

    // ========================================================================
    // AUTO-CONFIRM
    // ========================================================================

    _autoConfirm() {
        this.notification.add(
            _t("Pesée validée automatiquement"),
            { type: "success", sticky: false }
        );
        this.confirm();
    }

    // ========================================================================
    // ERROR / DISCONNECTION HANDLING
    // ========================================================================

    onError(message) {
        if (this.scale.isDisconnected) {
            return;
        }

        this.scale.setDisconnected(true);
        this._startReconnectPolling();

        this.notification.add(
            _t("Balance déconnectée - Saisie manuelle activée"),
            { type: "warning", sticky: false }
        );
    }

    _startReconnectPolling() {
        if (this._reconnectPollingInterval) {
            return;
        }

        this._reconnectPollingInterval = setInterval(() => {
            const connectionInfo = this.hardwareProxy.connectionInfo;
            if (connectionInfo.status === "connected" &&
                connectionInfo.drivers?.scale?.status === "connected") {
                this._onScaleReconnected();
            }
        }, 2000);

        this._reconnectPollingTimeout = setTimeout(() => {
            if (this._reconnectPollingInterval) {
                this._stopReconnectPolling();
                this.notification.add(
                    _t("Polling balance arrêté après 30 minutes"),
                    { type: "info", sticky: false }
                );
            }
        }, RECONNECT_POLLING_TIMEOUT_MS);
    }

    _stopReconnectPolling() {
        if (this._reconnectPollingInterval) {
            clearInterval(this._reconnectPollingInterval);
            this._reconnectPollingInterval = null;
        }
        if (this._reconnectPollingTimeout) {
            clearTimeout(this._reconnectPollingTimeout);
            this._reconnectPollingTimeout = null;
        }
    }

    _onScaleReconnected() {
        this._stopReconnectPolling();
        this.scale.setDisconnected(false);

        if (!this.manualState.manualWeightInput) {
            this.scale.clearWeightOverride();
            this.manualState.manualWeightInput = "";
            this.manualState.activeNumpadField = null;

            if (this.scale.product) {
                this.scale.isMeasuring = true;
                this.scale._sendScaleAction("weigh");
                this.scale._readWeightContinuously();
            }
        }

        this.notification.add(
            _t("Balance reconnectée"),
            { type: "success", sticky: false }
        );
    }

    // ========================================================================
    // MANUAL INPUT HANDLERS
    // ========================================================================

    onManualWeightChange(ev) {
        this.manualState.manualWeightInput = ev.target.value;
        this.scale.setManualWeight(ev.target.value);
    }

    onTareInputChange(ev) {
        this.manualState.tareInput = ev.target.value;
        const value = parseFloat(ev.target.value) || 0;
        this.scale.setTareValueManually(value);
    }

    // ========================================================================
    // NUMPAD
    // ========================================================================

    toggleNumpad(field) {
        if (this.manualState.activeNumpadField === field) {
            this.manualState.activeNumpadField = null;
        } else {
            if (field === "weight" && !this.manualState.manualWeightInput && !this.scale.isWeightOverridden) {
                if (this.scale.weight > 0) {
                    this.manualState.manualWeightInput = this.scale.weight.toFixed(getWeightDigits(this.pos.data.models));
                }
            }
            if (field === "tare" && !this.manualState.tareInput) {
                if (this.scale.tare > 0) {
                    this.manualState.tareInput = this.scale.tare.toFixed(getWeightDigits(this.pos.data.models));
                }
            }
            this.manualState.activeNumpadField = field;
        }
    }

    getSimpleNumpadButtons() {
        return [
            { value: "1" }, { value: "2" }, { value: "3" },
            { value: "4" }, { value: "5" }, { value: "6" },
            { value: "7" }, { value: "8" }, { value: "9" },
            { value: "C", text: "C", class: "o_colorlist_item_numpad_color_1" },
            { value: "0" },
            { value: "." },
        ];
    }

    onNumpadClick(key) {
        const field = this.manualState.activeNumpadField;
        if (!field) return;

        const stateKey = field === "weight" ? "manualWeightInput" : "tareInput";
        let current = this.manualState[stateKey] || "";

        if (key === "C") {
            current = "";
        } else if (key === "Backspace") {
            current = current.slice(0, -1);
        } else if (key === ".") {
            if (!current.includes(".")) {
                current += key;
            }
        } else if (key >= "0" && key <= "9") {
            const dotIndex = current.indexOf(".");
            if (dotIndex === -1) {
                if (current.length < MAX_INTEGER_DIGITS) {
                    current += key;
                }
            } else {
                const decimalPart = current.substring(dotIndex + 1);
                if (decimalPart.length < getWeightDigits(this.pos.data.models)) {
                    current += key;
                }
            }
        }

        this.manualState[stateKey] = current;

        if (field === "weight") {
            this.scale.setManualWeight(current);
        } else {
            this.scale.setTareValueManually(parseFloat(current) || 0);
        }
    }

    // ========================================================================
    // ORDER VALIDATION
    // ========================================================================

    get isOrderValid() {
        if (this.scale.effectiveNetWeight <= 0) {
            return false;
        }
        if (!this.scale.isWeightOverridden) {
            return this.scale.isWeightValid;
        }
        return true;
    }

    // ========================================================================
    // CONFIRM
    // ========================================================================

    confirm() {
        const isWeightOverridden = this.scale.isWeightOverridden;
        const container = this.scale.consumeContainer();

        let grossWeight, tareWeight, netWeight, grossWeightMode, tareMode;

        if (isWeightOverridden) {
            grossWeight = this.scale.manualWeight;
            tareWeight = this.scale.tare || 0;
            netWeight = this.scale.effectiveNetWeight;
            grossWeightMode = 'manual';
            tareMode = this.scale.isTareManual ? 'manual' : 'auto';
        } else {
            // Auto mode: compute gross weight from net weight + tare
            // We only get net weight from the scale, so gross = net + tare
            netWeight = this.scale.confirmWeight();
            tareWeight = this.scale.tare || 0;
            grossWeight = netWeight + tareWeight;
            grossWeightMode = 'auto';
            tareMode = this.scale.isTareManual ? 'manual' : 'auto';
        }

        const payload = {
            weight: netWeight,
            grossWeight: grossWeight,
            grossWeightMode: grossWeightMode,
            tareWeight: tareWeight,
            tareMode: tareMode,
            isManualWeight: grossWeightMode === 'manual' || tareMode === 'manual',
            container: container,
        };

        this.props.getPayload(payload);
        this.props.close();
    }
}
