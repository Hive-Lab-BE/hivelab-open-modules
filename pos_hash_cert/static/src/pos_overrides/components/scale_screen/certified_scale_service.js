/** @odoo-module */

// Certified copy of the POS Scale Service — Enterprise-compatible architecture
// with Mayam extensions (containers, auto-confirm, manual override, tare).

import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { formatFloat, roundDecimals } from "@web/core/utils/numbers";
import { Reactive } from "@web/core/utils/reactive";

// Certified inline — decimal precision for weights
function getWeightDigits(posModels) {
    const dp = posModels["decimal.precision"]?.find((d) => d.name === "Product Unit");
    return dp?.digits ?? 3;
}

function formatWeight(weight, posModels) {
    return formatFloat(weight || 0, { digits: [0, getWeightDigits(posModels)] });
}

const TARE_TIMEOUT_MS = 3000;
const AUTO_CONFIRM_THRESHOLD = 0.020; // 20g minimum for auto-confirm
const ZERO_THRESHOLD = 0.005;         // 5g = considered zero
const DEFAULT_UNIT_OF_MEASURE = "kg";
const READ_WEIGHT_TIMEOUT_MS = 5000;  // 5s timeout for scale reads
const LONGPOLL_MAX_ERRORS = 3;        // fallback to polling after N consecutive errors
const FALLBACK_POLL_INTERVAL_MS = 2000;

export class CertifiedScaleService extends Reactive {
    constructor(env, deps) {
        super(...arguments);
        this.setup(env, deps);
    }

    setup(env, deps) {
        this.env = env;
        this.hardwareProxy = deps.hardware_proxy;
        // Enterprise pattern: iotHttpService baked-in from hardwareProxy
        this.iotHttpService = deps.hardware_proxy.iotHttp;
        this.lastWeight = null;
        this.weight = 0;
        this.autoConfirmCallback = null;
        this._listeningForMessages = false;
        this._longpollErrors = 0;
        this.reset();
    }

    // Enterprise-compatible: device controller for the scale
    get _scaleDevice() {
        return this.hardwareProxy.deviceControllers?.scale;
    }

    get isManualMeasurement() {
        return this._scaleDevice?.manual_measurement || false;
    }

    start(errorCallback) {
        console.log("[SCALE] start — tare=", this.tare, "productWasWeighed=", this.productWasWeighed);
        this.onError = errorCallback;
        this.weight = 0;
        this.productWasWeighed = false;
        this.lastDisplayedWeight = 0;
        this.lastWeight = 0;  // Reset lastWeight so isWeightValid works for same-weight products
        this.isWeightOverridden = false;
        this.isDisconnected = false;
        this.manualWeight = 0;
        this.isTareManual = false;
        this.autoConfirmInProgress = false;
        this._sendScaleAction("weigh");
        if (!this.isManualMeasurement) {
            this.isMeasuring = true;
            this._readWeightContinuously();
        }
    }

    reset() {
        console.log("[SCALE] reset");
        this._sendScaleAction("stop");
        this._listeningForMessages = false;
        this._scaleDevice?.removeListener?.();
        this.tare = 0;
        this.tareRequested = false;
        this.loading = false;
        this.isMeasuring = false;
        this.product = null;
        this.onError = null;
        // Container/tare state
        this.currentContainer = null;
        this.productWasWeighed = false;
        this.lastDisplayedWeight = 0;
        this.isWeightOverridden = false;
        this.isDisconnected = false;
        this.manualWeight = 0;
        this.isTareManual = false;
        this.autoConfirmInProgress = false;
        // Note: autoConfirmCallback is managed by the screen
    }

    /**
     * Sets the callback for auto-confirm (product removed from scale).
     * @param {Function|null} callback
     */
    setAutoConfirmCallback(callback) {
        this.autoConfirmCallback = callback;
    }

    // ========================================================================
    // WEIGHT READING — Enterprise-compatible (iotHttpService)
    // ========================================================================

    /**
     * Enterprise pattern: event-driven continuous reading via onMessage.
     * Each onMessage call is ONE-SHOT; we re-subscribe after each event.
     */
    async _readWeightContinuously() {
        if (!this.isMeasuring) {
            return;
        }
        const mode = (this.iotHttpService && this._scaleDevice) ? "longpoll" : "polling";
        console.log("[SCALE] _readWeightContinuously mode=", mode);
        if (mode === "longpoll") {
            // Pas de read_once initial: la state machine weigh émettra le poids
            // via long-poll. Un read_once ici corrompt la transaction Dialog 06.
            this._listenForScaleMessages();
        } else {
            await this.readWeight();
            if (this.isMeasuring) {
                setTimeout(() => this._readWeightContinuously(), 500);
            }
        }
    }

    _listenForScaleMessages() {
        if (!this.isMeasuring || this.isWeightOverridden || !this.iotHttpService) {
            console.log("[SCALE] _listenForScaleMessages SKIP measuring=", this.isMeasuring, "overridden=", this.isWeightOverridden);
            return;
        }
        const device = this._scaleDevice;
        if (!device) {
            console.log("[SCALE] _listenForScaleMessages SKIP no device");
            return;
        }
        this._listeningForMessages = true;
        this.iotHttpService.onMessage(
            device.iotId,
            device.identifier,
            (data) => this._handleScaleMessage(data),
            (error) => this._handleScaleError(error)
        );
    }

    /**
     * Enterprise pattern: handle incoming scale message from onMessage.
     * Format: { status: { status: "connected" }, result: weight }
     * null = timeout (no event), re-subscribe silently.
     */
    _handleScaleMessage(data) {
        if (!this.isMeasuring || this.isWeightOverridden) {
            this._listeningForMessages = false;
            return;
        }
        this._longpollErrors = 0; // reset on success
        if (data === null) {
            console.log("[SCALE] _handleScaleMessage timeout → re-subscribe");
            this._listenForScaleMessages();
            return;
        }
        if (data.result != null) {
            console.log("[SCALE] _handleScaleMessage weight=", data.result,
                          "productWasWeighed=", this.productWasWeighed,
                          "lastDisplayedWeight=", this.lastDisplayedWeight);
            this.weight = data.result;
            this._clearLastWeightIfValid();
            this.loading = false;
            this._setTareIfRequested();
            if (this.netWeight > ZERO_THRESHOLD) {
                this.lastDisplayedWeight = this.netWeight;
            }
            this._checkAutoConfirm();
        }
        // Re-subscribe for next event (ONE-SHOT pattern)
        this._listenForScaleMessages();
    }

    _handleScaleError(error) {
        console.log("[SCALE] _handleScaleError", error, "consecutive=", this._longpollErrors + 1);
        if (!this.isMeasuring) {
            this._listeningForMessages = false;
            return;
        }
        this._longpollErrors++;
        if (this._longpollErrors >= LONGPOLL_MAX_ERRORS) {
            // Long-poll unreliable — fallback to periodic polling
            this._listeningForMessages = false;
            this._fallbackPolling();
            return;
        }
        this.onError?.(error);
        // Re-subscribe after error
        setTimeout(() => this._listenForScaleMessages(), 1500);
    }

    /**
     * Fallback polling loop when long-poll fails repeatedly.
     * Reads weight via hardwareProxy.message every FALLBACK_POLL_INTERVAL_MS,
     * then attempts to re-establish long-polling.
     */
    async _fallbackPolling() {
        while (this.isMeasuring && !this.isWeightOverridden) {
            try {
                await this.readWeight();
            } catch {
                // ignore — readWeight already calls onError
            }
            // Try to re-establish long-poll
            if (this.iotHttpService && this._scaleDevice) {
                this._longpollErrors = 0;
                this._listenForScaleMessages();
                return;
            }
            await new Promise((r) => setTimeout(r, FALLBACK_POLL_INTERVAL_MS));
        }
    }

    /**
     * Enterprise pattern: one-shot read via iotHttpService.action.
     * Format: { status: { status: "connected" }, result: weight }
     */
    async _getWeightFromScale() {
        const device = this._scaleDevice;
        if (!device || !this.iotHttpService) {
            // Fallback to direct hardwareProxy message
            const { weight } = await this.hardwareProxy.message("scale_read");
            return weight;
        }
        return new Promise((resolve, reject) => {
            this.iotHttpService.action(
                device.iotId,
                device.identifier,
                { action: "read_once" },
                (data) => resolve(data?.result ?? 0),
                (error) => reject(new Error(error))
            );
        });
    }

    /**
     * Reads weight with timeout protection and auto-confirm check.
     */
    async readWeight() {
        if (!this.product || this.isWeightOverridden) {
            return;
        }
        console.log("[SCALE] readWeight start");

        try {
            await Promise.race([
                this._doReadWeight(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Scale read timeout")), READ_WEIGHT_TIMEOUT_MS)
                ),
            ]);
        } catch (error) {
            if (error.message === "Scale read timeout") {
                this.loading = false;
                if (this.onError) {
                    this.onError("Balance timeout - pas de réponse");
                }
                return;
            }
            throw error;
        }

        // Guard after async - state may have changed
        if (!this.isMeasuring || this.isWeightOverridden || !this.product) {
            return;
        }

        if (this.netWeight > ZERO_THRESHOLD) {
            this.lastDisplayedWeight = this.netWeight;
        }

        this._checkAutoConfirm();
    }

    /**
     * Core weight reading logic (extracted for timeout wrapping).
     */
    async _doReadWeight() {
        this.loading = true;
        try {
            this.weight = await this._getWeightFromScale();
            this._clearLastWeightIfValid();
        } catch (error) {
            this.isMeasuring = false;
            this.onError?.(error?.message ?? "Erreur de connexion avec la balance");
            this.loading = false;
            return;
        }
        this.loading = false;
        this._setTareIfRequested();
    }

    // ========================================================================
    // WEIGHT CONFIRMATION
    // ========================================================================

    /**
     * Confirms the weight. If overridden manually, returns effective net weight.
     * If current weight is ~0 (product removed), uses last displayed weight.
     */
    confirmWeight() {
        const weightToReturn = this.isWeightOverridden
            ? this.effectiveNetWeight
            : (this.netWeight > ZERO_THRESHOLD ? this.netWeight : this.lastDisplayedWeight);
        console.log("[SCALE] confirmWeight=", weightToReturn, "override=", this.isWeightOverridden);
        this._sendScaleAction("stop");
        if (this.isWeightOverridden) {
            return this.effectiveNetWeight;
        }

        this.lastWeight = this.weight;
        return this.netWeight > ZERO_THRESHOLD
            ? this.netWeight
            : this.lastDisplayedWeight;
    }

    // ========================================================================
    // PRODUCT
    // ========================================================================

    setProduct(product, decimalAccuracy, unitPrice) {
        this.product = {
            name: product.display_name || _t("Unnamed Product"),
            unitOfMeasure: product.product_tmpl_id?.uom_id?.name || "kg",
            decimalAccuracy,
            unitPrice,
        };
    }

    // ========================================================================
    // TARE MANAGEMENT
    // ========================================================================

    /**
     * Called when tare is measured from scale (button "Tare").
     * Resets productWasWeighed to prevent immediate auto-confirm.
     */
    _setTareIfRequested() {
        if (this.tareRequested) {
            // this.weight est net (avec ancienne tare), le brut réel = weight + ancienne tare
            const currentGross = this.weight + (this.tare || 0);
            console.log("[SCALE] _setTareIfRequested currentGross=", currentGross);
            this.tare = currentGross;
            this.tareRequested = false;
            this.isTareManual = false;
            this.productWasWeighed = false;
            this.autoConfirmInProgress = false;
            // Envoyer la tare à la balance (fire-and-forget)
            this._sendTareToScale(currentGross).catch(() => {});
        }
    }

    requestTare() {
        this.tareRequested = true;
        if (this.isManualMeasurement && !this.loading) {
            this.readWeight();
        } else {
            setTimeout(() => this._setTareIfRequested(), TARE_TIMEOUT_MS);
        }
    }

    /**
     * Sets tare value manually (user edited the input).
     * @param {number} tare
     */
    setTareValueManually(tare) {
        const parsed = parseFloat(tare);
        this.tare = Number.isFinite(parsed) ? parsed : 0;
        this.isTareManual = true;
        this.productWasWeighed = false;
        this.autoConfirmInProgress = false;
        if (this.tare > 0) {
            this._sendTareToScale(this.tare).catch(() => {});
        } else {
            this._resetTareOnScale().catch(() => {});
        }
    }

    // ========================================================================
    // MANUAL WEIGHT
    // ========================================================================

    /**
     * Sets a manual gross weight (user typed via numpad).
     * @param {string|number} weight
     */
    setManualWeight(weight) {
        const parsed = parseFloat(weight);
        this.manualWeight = Number.isFinite(parsed) ? parsed : 0;
        this.isWeightOverridden = true;
    }

    clearWeightOverride() {
        this.isWeightOverridden = false;
        this.manualWeight = 0;
    }

    /**
     * Updates disconnection state. If disconnected, activates manual override.
     * @param {boolean} disconnected
     */
    setDisconnected(disconnected) {
        this.isDisconnected = disconnected;
        if (disconnected) {
            this.isWeightOverridden = true;
        }
    }

    // ========================================================================
    // CONTAINER MANAGEMENT
    // ========================================================================

    /**
     * Sets tare and associated container (from barcode scan).
     * @param {number} tare
     * @param {Object} container
     */
    setTareWithContainer(tare, container) {
        this.tare = tare;
        this.currentContainer = container;
        this.isTareManual = false;
        this._sendTareToScale(tare).catch(() => {});
    }

    /**
     * Consumes and returns the current container.
     * @returns {Object|null}
     */
    consumeContainer() {
        const container = this.currentContainer;
        this.currentContainer = null;
        return container;
    }

    // ========================================================================
    // SCALE ACTION HELPERS
    // ========================================================================

    /**
     * Fire-and-forget: sends an action to the scale (weigh, tare_set).
     * @param {string} actionName
     */
    _sendScaleAction(actionName) {
        console.log("[SCALE] _sendScaleAction", actionName);
        const device = this._scaleDevice;
        if (!device || !this.iotHttpService) {
            return;
        }
        this.iotHttpService.action(
            device.iotId,
            device.identifier,
            { action: actionName },
            () => {},
            () => {}
        );
    }

    // ========================================================================
    // SCALE TARE COMMUNICATION (Dialog 06)
    // ========================================================================

    /**
     * Sends a tare preset value to the scale via tare_set action.
     * @param {number} tareValue - Tare value in kg
     */
    async _sendTareToScale(tareValue) {
        console.log("[SCALE] _sendTareToScale", Math.round(tareValue * 1000), "g");
        const device = this._scaleDevice;
        if (!device || !this.iotHttpService) {
            return;
        }
        return new Promise((resolve, reject) => {
            this.iotHttpService.action(
                device.iotId,
                device.identifier,
                { action: "tare_set", weight: Math.round(tareValue * 1000) },
                (data) => resolve(data),
                (error) => reject(new Error(error))
            );
        });
    }

    /**
     * Resets the tare on the scale to 0.
     */
    async _resetTareOnScale() {
        const device = this._scaleDevice;
        if (!device || !this.iotHttpService) {
            return;
        }
        return new Promise((resolve, reject) => {
            this.iotHttpService.action(
                device.iotId,
                device.identifier,
                { action: "tare_set", weight: 0 },
                (data) => resolve(data),
                (error) => reject(new Error(error))
            );
        });
    }

    // ========================================================================
    // AUTO-CONFIRM
    // ========================================================================

    /**
     * Checks if conditions are met for automatic confirmation
     * (product was weighed then removed from scale).
     */
    _checkAutoConfirm() {
        if (this.autoConfirmInProgress || this.isWeightOverridden) {
            return;
        }

        const currentNet = this.netWeight;

        if (currentNet > AUTO_CONFIRM_THRESHOLD) {
            this.productWasWeighed = true;
        }

        if (
            this.productWasWeighed &&
            currentNet <= ZERO_THRESHOLD &&
            this.autoConfirmCallback
        ) {
            console.log("[SCALE] _checkAutoConfirm → TRIGGERED netWeight=", currentNet);
            this.autoConfirmInProgress = true;
            this.autoConfirmCallback();
        } else {
            console.log("[SCALE] _checkAutoConfirm netWeight=", currentNet,
                          "productWasWeighed=", this.productWasWeighed,
                          "autoConfirmInProgress=", this.autoConfirmInProgress);
        }
    }

    // ========================================================================
    // INTERNAL HELPERS
    // ========================================================================

    _clearLastWeightIfValid() {
        if (this.lastWeight && this.isWeightValid) {
            this.lastWeight = null;
        }
    }

    // ========================================================================
    // GETTERS (with defensive guards)
    // ========================================================================

    get _safeDecimalAccuracy() {
        return getWeightDigits(this.env.services.pos.data.models);
    }

    get _safeUnitOfMeasure() {
        return this.product?.unitOfMeasure ?? DEFAULT_UNIT_OF_MEASURE;
    }

    get _safeUnitPrice() {
        return this.product?.unitPrice ?? 0;
    }

    get isWeightValid() {
        if (!this.product) {
            return true;
        }
        return (
            !this.lastWeight ||
            roundDecimals(this.weight, this._safeDecimalAccuracy) !==
                roundDecimals(this.lastWeight, this._safeDecimalAccuracy)
        );
    }

    get netWeight() {
        // La balance retourne déjà le poids net (tare soustraite par la balance)
        return roundDecimals(this.weight, this._safeDecimalAccuracy);
    }

    get effectiveGrossWeight() {
        if (this.isWeightOverridden) return this.manualWeight;
        // Reconstruire le brut : net + tare
        return roundDecimals(this.weight + (this.tare || 0), this._safeDecimalAccuracy);
    }

    get effectiveNetWeight() {
        if (this.isWeightOverridden) {
            // Mode manuel : calcul logiciel inchangé
            return roundDecimals(Math.max(0, this.manualWeight - (this.tare || 0)), this._safeDecimalAccuracy);
        }
        // Mode auto : weight est déjà net
        return roundDecimals(Math.max(0, this.weight), this._safeDecimalAccuracy);
    }

    get effectiveNetWeightString() {
        return `${formatWeight(this.effectiveNetWeight, this.env.services.pos.data.models)} ${this._safeUnitOfMeasure}`;
    }

    get netWeightString() {
        return `${formatWeight(this.netWeight, this.env.services.pos.data.models)} ${this._safeUnitOfMeasure}`;
    }

    get tareWeightString() {
        return `${formatWeight(this.tare || 0, this.env.services.pos.data.models)} ${this._safeUnitOfMeasure}`;
    }

    get grossWeightString() {
        const gross = this.isWeightOverridden
            ? this.manualWeight
            : this.weight + (this.tare || 0);
        return `${formatWeight(gross, this.env.services.pos.data.models)} ${this._safeUnitOfMeasure}`;
    }

    get unitPriceString() {
        const priceString = this.env.utils.formatCurrency(this._safeUnitPrice);
        return `${priceString} / ${this._safeUnitOfMeasure}`;
    }

    get totalPriceString() {
        return this.env.utils.formatCurrency(this.effectiveNetWeight * this._safeUnitPrice);
    }
}

const certifiedPosScaleService = {
    dependencies: ["hardware_proxy"],
    start(env, deps) {
        return new CertifiedScaleService(env, deps);
    },
};

export { certifiedPosScaleService };
registry.category("services").add("pos_scale", certifiedPosScaleService, { force: true });
