/** @odoo-module */

import { PosScaleService } from "@point_of_sale/app/screens/scale_screen/scale_service";
import { patch } from "@web/core/utils/patch";
import { roundDecimals } from "@web/core/utils/numbers";
import { formatWeight, getWeightDigits } from "../utils/weight_utils";

// Seuils pour la validation automatique
const AUTO_CONFIRM_THRESHOLD = 0.020; // 20g minimum pour activer l'auto-confirm
const ZERO_THRESHOLD = 0.005;         // 5g = considéré comme zéro

// Valeurs par défaut quand product est null (évite les crashes)
const DEFAULT_UNIT_OF_MEASURE = "kg";

// Timeout pour readWeight (évite blocage UI si balance déconnectée)
const READ_WEIGHT_TIMEOUT_MS = 5000;  // 5 secondes

// Long-polling IoT (utilisé quand hivelab_iot_pos est installé)
const LONGPOLL_MAX_ERRORS = 3;
const FALLBACK_POLL_INTERVAL_MS = 2000;

/**
 * Patch du service de balance pour supporter les contenants, la validation automatique
 * et la saisie manuelle du poids.
 *
 * Modèle conceptuel unifié:
 * - La tare vit toujours dans `this.tare` (bouton Tare, contenant, ou numpad)
 * - Le poids brut vient soit de la balance (`this.weight`) soit de l'utilisateur (`this.manualWeight`)
 * - `isWeightOverridden` indique si l'utilisateur a tapé un poids via numpad
 * - `isDisconnected` indique si la balance est déconnectée
 *
 * Ajoute:
 * - currentContainer: référence au contenant associé au pesage en cours
 * - setTareWithContainer: méthode pour définir tare + contenant
 * - consumeContainer: récupère et efface le contenant courant
 * - productWasWeighed: flag indiquant si un poids significatif a été atteint (pour auto-confirm)
 * - autoConfirmCallback: callback pour déclencher la validation auto quand le produit est retiré
 * - isWeightOverridden: true si l'utilisateur a tapé un poids via numpad
 * - isDisconnected: true si la balance est déconnectée
 * - manualWeight: poids brut saisi manuellement
 */
patch(PosScaleService.prototype, {
    setup(env, deps) {
        super.setup(env, deps);
        this.hardwareProxy = deps.hardware_proxy;
        this.iotHttpService = deps.hardware_proxy.iotHttp;
        this._initPatchState();
    },

    /**
     * Initialise les états ajoutés par le patch.
     * Séparé pour pouvoir être appelé depuis reset().
     */
    _initPatchState() {
        this.currentContainer = null;
        this.productWasWeighed = false;  // Flag: un poids significatif a été atteint
        this.autoConfirmCallback = null;
        this.lastDisplayedWeight = 0;

        // Poids manuel
        this.isWeightOverridden = false;  // true quand l'utilisateur a tapé un poids via numpad
        this.isDisconnected = false;      // true quand la balance est déconnectée
        this.manualWeight = 0;

        // Mode de saisie de la tare
        // true = tare saisie/modifiée manuellement par l'utilisateur
        // false = tare définie automatiquement (bouton Tare ou scan contenant)
        this.isTareManual = false;

        // Lock pour éviter les auto-confirm multiples
        this.autoConfirmInProgress = false;

        // IoT long-polling state
        this._longpollErrors = 0;
        this._listeningForMessages = false;
    },

    /**
     * Reset complet incluant tous les états du patch.
     * Appelé par onWillUnmount du ScaleScreen.
     */
    reset() {
        console.log("[SCALE] reset");
        this._sendScaleAction("stop");
        // Nettoyage long-poll AVANT super.reset()
        this._listeningForMessages = false;
        this._longpollErrors = 0;
        this._scaleDevice?.removeListener?.();

        super.reset();
        this.currentContainer = null;
        this.productWasWeighed = false;
        this.lastDisplayedWeight = 0;
        this.isWeightOverridden = false;
        this.isDisconnected = false;
        this.manualWeight = 0;
        this.isTareManual = false;
        this.autoConfirmInProgress = false;
        // Note: autoConfirmCallback est géré par le screen (setAutoConfirmCallback(null))
    },

    /**
     * Définit le callback pour la validation automatique.
     * @param {Function|null} callback - Callback à appeler quand le produit est retiré
     */
    setAutoConfirmCallback(callback) {
        this.autoConfirmCallback = callback;
    },

    /**
     * Réinitialise les poids au démarrage de la balance.
     */
    start(errorCallback) {
        console.log("[SCALE] start — tare=", this.tare, "productWasWeighed=", this.productWasWeighed);
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
        super.start(errorCallback);
    },

    /**
     * Définit le poids brut saisi manuellement.
     * Active automatiquement isWeightOverridden.
     * @param {string|number} weight - Poids brut en kg
     */
    setManualWeight(weight) {
        const parsed = parseFloat(weight);
        this.manualWeight = Number.isFinite(parsed) ? parsed : 0;
        this.isWeightOverridden = true;
    },

    /**
     * Réinitialise le poids manuel et désactive l'override.
     */
    clearWeightOverride() {
        this.isWeightOverridden = false;
        this.manualWeight = 0;
    },

    /**
     * Met à jour l'état de déconnexion de la balance.
     * Si déconnectée, active automatiquement isWeightOverridden.
     * @param {boolean} disconnected - true si la balance est déconnectée
     */
    setDisconnected(disconnected) {
        this.isDisconnected = disconnected;
        if (disconnected) {
            this.isWeightOverridden = true;
        }
    },

    // ========================================================================
    // ENTERPRISE DEVICE ACCESS
    // ========================================================================

    /**
     * Enterprise-compatible: device controller for the scale.
     */
    get _scaleDevice() {
        return this.hardwareProxy?.deviceControllers?.scale;
    },

    /**
     * Enterprise-compatible: manual measurement mode.
     */
    get isManualMeasurement() {
        return this._scaleDevice?.manual_measurement || false;
    },

    // ========================================================================
    // GESTION DE LA TARE (BOUTON "TARE")
    // ========================================================================

    /**
     * Surcharge de _setTareIfRequested pour reset productWasWeighed quand l'utilisateur
     * clique sur le bouton "Tare". Cela empêche l'auto-confirm de se déclencher
     * immédiatement si le poids net devient ~0 après application de la tare.
     *
     * IMPORTANT: Cette méthode est appelée uniquement par le bouton "Tare".
     * Le scan d'un contenant utilise setTareWithContainer() qui ne reset PAS le flag.
     */
    _setTareIfRequested() {
        if (this.tareRequested) {
            // this.weight est net (avec ancienne tare), le brut réel = weight + ancienne tare
            const currentGross = this.weight + (this.tare || 0);
            console.log("[SCALE] _setTareIfRequested currentGross=", currentGross);
            this.tare = currentGross;
            this.tareRequested = false;

            // Bouton Tare = tare automatique
            this.isTareManual = false;

            // Reset le flag d'auto-confirm (l'utilisateur a cliqué "Tare")
            this.productWasWeighed = false;
            this.autoConfirmInProgress = false;

            // Envoyer la tare à la balance (fire-and-forget)
            this._sendTareToScale(currentGross).catch(() => {});
        }
    },

    /**
     * Définit la tare manuellement (modification de l'input par l'utilisateur).
     * Marque la tare comme manuelle.
     * @param {number} tare - Valeur de la tare
     */
    setTareValueManually(tare) {
        const parsed = parseFloat(tare);
        this.tare = Number.isFinite(parsed) ? parsed : 0;
        this.isTareManual = true;

        // Reset le flag d'auto-confirm (l'utilisateur ajuste la tare)
        this.productWasWeighed = false;
        this.autoConfirmInProgress = false;

        if (this.tare > 0) {
            this._sendTareToScale(this.tare).catch(() => {});
        } else {
            this._resetTareOnScale().catch(() => {});
        }
    },

    // ========================================================================
    // GETTERS AVEC GUARDS DÉFENSIFS
    // ========================================================================

    /**
     * Retourne la précision décimale pour les poids.
     */
    get _safeDecimalAccuracy() {
        return getWeightDigits(this.env.services.pos.data.models);
    },

    /**
     * Retourne l'unité de mesure du produit, ou la valeur par défaut.
     */
    get _safeUnitOfMeasure() {
        return this.product?.unitOfMeasure ?? DEFAULT_UNIT_OF_MEASURE;
    },

    /**
     * Retourne le prix unitaire du produit, ou 0.
     */
    get _safeUnitPrice() {
        return this.product?.unitPrice ?? 0;
    },

    /**
     * isWeightValid avec guard défensif.
     * LNE requires that the weight changes from the previously
     * added value before another product is allowed to be added.
     */
    get isWeightValid() {
        if (!this.product) {
            return true;
        }
        return (
            !this.lastWeight ||
            roundDecimals(this.weight, this._safeDecimalAccuracy) !==
                roundDecimals(this.lastWeight, this._safeDecimalAccuracy)
        );
    },

    /**
     * netWeight — la balance retourne déjà le poids net (tare soustraite par la balance).
     */
    get netWeight() {
        return roundDecimals(this.weight, this._safeDecimalAccuracy);
    },

    /**
     * Retourne le poids brut effectif (reconstruire : net + tare).
     */
    get effectiveGrossWeight() {
        if (this.isWeightOverridden) return this.manualWeight;
        return roundDecimals(this.weight + (this.tare || 0), this._safeDecimalAccuracy);
    },

    /**
     * Retourne le poids net effectif (auto ou manuel).
     * Toujours >= 0 pour éviter les prix négatifs.
     */
    get effectiveNetWeight() {
        if (this.isWeightOverridden) {
            // Mode manuel : calcul logiciel inchangé
            return roundDecimals(Math.max(0, this.manualWeight - (this.tare || 0)), this._safeDecimalAccuracy);
        }
        // Mode auto : weight est déjà net
        return roundDecimals(Math.max(0, this.weight), this._safeDecimalAccuracy);
    },

    /**
     * Retourne le poids net effectif formaté avec l'unité.
     */
    get effectiveNetWeightString() {
        return `${formatWeight(this.effectiveNetWeight, this.env.services.pos.data.models)} ${this._safeUnitOfMeasure}`;
    },

    /**
     * netWeightString avec guard défensif.
     */
    get netWeightString() {
        return `${formatWeight(this.netWeight, this.env.services.pos.data.models)} ${this._safeUnitOfMeasure}`;
    },

    /**
     * tareWeightString avec guard défensif.
     */
    get tareWeightString() {
        return `${formatWeight(this.tare || 0, this.env.services.pos.data.models)} ${this._safeUnitOfMeasure}`;
    },

    /**
     * grossWeightString — reconstruire le brut : net + tare.
     */
    get grossWeightString() {
        const gross = this.isWeightOverridden
            ? this.manualWeight
            : this.weight + (this.tare || 0);
        return `${formatWeight(gross, this.env.services.pos.data.models)} ${this._safeUnitOfMeasure}`;
    },

    /**
     * unitPriceString avec guard défensif.
     */
    get unitPriceString() {
        const priceString = this.env.utils.formatCurrency(this._safeUnitPrice);
        return `${priceString} / ${this._safeUnitOfMeasure}`;
    },

    /**
     * totalPriceString avec guard défensif.
     */
    get totalPriceString() {
        return this.env.utils.formatCurrency(this.effectiveNetWeight * this._safeUnitPrice);
    },

    // ========================================================================
    // SCALE ACTION HELPERS
    // ========================================================================

    /**
     * Fire-and-forget: envoie une action à la balance (weigh, tare_set).
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
    },

    // ========================================================================
    // COMMUNICATION TARE BALANCE (Dialog 06)
    // ========================================================================

    /**
     * Envoie une valeur de tare preset à la balance via action tare_set.
     * @param {number} tareValue - Valeur de tare en kg
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
    },

    /**
     * Remet la tare à 0 sur la balance.
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
    },

    // ========================================================================
    // LECTURE DU POIDS — Enterprise-compatible (iotHttpService)
    // ========================================================================

    /**
     * Enterprise pattern: one-shot read via iotHttpService.action.
     * Fallback to Community hardwareProxy.message if no Enterprise device.
     */
    async _getWeightFromScale() {
        const device = this._scaleDevice;
        if (!device || !this.iotHttpService) {
            // Fallback Community
            return super._getWeightFromScale();
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
    },

    // ========================================================================
    // LONG-POLLING IOT
    // ========================================================================

    /**
     * Override: lecture continue avec support long-polling IoT.
     * Si iotHttpService et _scaleDevice sont disponibles → long-polling.
     * Sinon → polling standard 500ms (comportement Odoo de base).
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
    },

    /**
     * S'abonne aux messages de la balance via iotHttpService (one-shot).
     * Chaque appel onMessage est un seul événement, on se réabonne après.
     */
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
    },

    /**
     * Traite un message de la balance reçu via long-poll.
     * null = timeout (pas d'événement), on se réabonne silencieusement.
     */
    _handleScaleMessage(data) {
        if (!this.isMeasuring || this.isWeightOverridden) {
            this._listeningForMessages = false;
            return;
        }
        this._longpollErrors = 0; // reset on success
        if (data === null) {
            // Timeout — re-subscribe
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
        // Re-subscribe pour le prochain événement (pattern ONE-SHOT)
        this._listenForScaleMessages();
    },

    /**
     * Gère une erreur long-poll. Après LONGPOLL_MAX_ERRORS erreurs consécutives,
     * bascule en fallback polling.
     */
    _handleScaleError(error) {
        console.log("[SCALE] _handleScaleError", error, "consecutive=", this._longpollErrors + 1);
        if (!this.isMeasuring) {
            this._listeningForMessages = false;
            return;
        }
        this._longpollErrors++;
        if (this._longpollErrors >= LONGPOLL_MAX_ERRORS) {
            // Long-poll non fiable → fallback polling périodique
            this._listeningForMessages = false;
            this._fallbackPolling();
            return;
        }
        this.onError?.(error);
        // Re-subscribe après erreur
        setTimeout(() => this._listenForScaleMessages(), 1500);
    },

    /**
     * Boucle de polling de secours quand le long-poll échoue.
     * Lit le poids toutes les FALLBACK_POLL_INTERVAL_MS ms.
     * Tente de rétablir le long-poll à chaque tour.
     */
    async _fallbackPolling() {
        while (this.isMeasuring && !this.isWeightOverridden) {
            try {
                await this.readWeight();
            } catch {
                // ignore — readWeight appelle déjà onError
            }
            // Tenter de rétablir le long-poll
            if (this.iotHttpService && this._scaleDevice) {
                this._longpollErrors = 0;
                this._listenForScaleMessages();
                return;
            }
            await new Promise((r) => setTimeout(r, FALLBACK_POLL_INTERVAL_MS));
        }
    },

    // ========================================================================
    // LECTURE UNITAIRE + AUTO-CONFIRM
    // ========================================================================

    /**
     * Lit le poids et vérifie si on doit déclencher l'auto-confirm.
     * Inclut un timeout pour éviter le blocage de l'UI si la balance
     * ne répond pas (déconnexion, problème matériel).
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
    },

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
    },

    _clearLastWeightIfValid() {
        if (this.lastWeight && this.isWeightValid) {
            this.lastWeight = null;
        }
    },

    /**
     * Vérifie si les conditions sont réunies pour la validation automatique.
     * Ne déclenche PAS si le poids est overridden manuellement.
     */
    _checkAutoConfirm() {
        // Lock pour éviter les appels multiples
        if (this.autoConfirmInProgress) {
            return;
        }

        // Pas d'auto-confirm si poids tapé manuellement
        if (this.isWeightOverridden) {
            return;
        }

        const currentNet = this.netWeight;

        // Marquer que le produit a été pesé (poids significatif atteint)
        if (currentNet > AUTO_CONFIRM_THRESHOLD) {
            this.productWasWeighed = true;
        }

        // Déclencher l'auto-confirm si le produit a été posé puis retiré
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
    },

    // ========================================================================
    // GESTION DES CONTENANTS
    // ========================================================================

    /**
     * Définit la tare et le contenant associé.
     * Scan contenant = tare automatique.
     * @param {number} tare - Valeur de la tare
     * @param {Object} container - Le contenant associé
     */
    setTareWithContainer(tare, container) {
        this.tare = tare;
        this.currentContainer = container;
        // Scan contenant = tare automatique
        this.isTareManual = false;
        this._sendTareToScale(tare).catch(() => {});
    },

    /**
     * Confirme le poids et retourne le poids net.
     * Si isWeightOverridden, retourne le poids net calculé à partir de manualWeight et tare.
     * Si le poids actuel est ~0 (produit retiré), utilise le dernier poids affiché.
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
        // Si le poids actuel est ~0, utiliser le dernier poids affiché
        return this.netWeight > ZERO_THRESHOLD
            ? this.netWeight
            : this.lastDisplayedWeight;
    },

    /**
     * Récupère et consomme le contenant courant.
     * @returns {Object|null}
     */
    consumeContainer() {
        const container = this.currentContainer;
        this.currentContainer = null;
        return container;
    },
});
