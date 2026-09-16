/** @odoo-module */

import { Component, useState, onMounted, onWillUnmount } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { formatWeight } from "../../utils/weight_utils";

const WEIGHT_POLL_INTERVAL_MS = 500;
// Seuil en kg pour considérer qu'il y a un poids significatif sur la balance
const WEIGHT_THRESHOLD = 0.005;
// Nombre d'erreurs longpoll consécutives avant fallback en polling
const LONGPOLL_MAX_ERRORS = 3;

export class ContainerAddForm extends Component {
    static template = "pos_container.ContainerAddForm";
    static components = { Dialog };
    static props = {
        onSave: Function,
        onCancel: Function,
        initialBarcode: { type: String, optional: true },
        close: { type: Function, optional: true },
    };

    setup() {
        this.pos = usePos();
        this.hardwareProxy = useService("hardware_proxy");
        this.notification = useService("notification");
        // Poids précédent pour détecter la transition poids > 0 → poids = 0
        this.previousWeight = 0;
        // Flag pour éviter les sauvegardes multiples
        this.autoSaveTriggered = false;
        // Poids maximal atteint pendant la session (pour validation)
        this.maxWeightReached = 0;
        // IoT long-polling state
        this._longpollErrors = 0;
        this._listeningForMessages = false;

        this.state = useState({
            weight: 0.000,
            name: "Contenant",
            barcode: this.props.initialBarcode || "",
            depositValue: 0.00,
            isPolling: false,
            scaleConnected: false,
            scaleInitializing: true,
        });

        onMounted(() => {
            this._sendScaleAction("weigh");
            this.startWeightPolling();
        });
        onWillUnmount(() => {
            this._sendScaleAction("stop");
            this.stopWeightPolling();
        });
    }

    get _iotHttpService() {
        return this.hardwareProxy.iotHttp;
    }

    get _scaleDevice() {
        return this.hardwareProxy?.deviceControllers?.scale;
    }

    _sendScaleAction(actionName) {
        const device = this._scaleDevice;
        if (!device || !this._iotHttpService) {
            return;
        }
        this._iotHttpService.action(
            device.iotId,
            device.identifier,
            { action: actionName },
            () => {},
            () => {}
        );
    }

    startWeightPolling() {
        this.state.isPolling = true;
        if (this._iotHttpService && this._scaleDevice) {
            console.log("[CONTAINER] startWeightPolling mode=longpoll");
            this._listenForScaleMessages();
            // Sécurité : si aucun poids reçu en 5s, basculer en polling community
            this._longpollFallbackTimer = setTimeout(() => {
                if (!this.state.scaleConnected && this.state.isPolling) {
                    console.log("[CONTAINER] longpoll timeout → fallback polling");
                    this.state.scaleInitializing = false;
                    this._listeningForMessages = false;
                    this._scaleDevice?.removeListener?.();
                    this._pollWeight();
                }
            }, 5000);
        } else {
            console.log("[CONTAINER] startWeightPolling mode=polling");
            this._pollWeight();
        }
    }

    async _pollWeight() {
        if (!this.state.isPolling) return;

        try {
            const result = await this.hardwareProxy.message("scale_read");
            if (result?.weight !== undefined) {
                await this._processWeight(result.weight);
            }
        } catch (error) {
            console.error("Scale poll error:", error);
            if (this.state.scaleConnected) {
                this.notification.add(
                    _t("Balance déconnectée"),
                    { type: "warning" },
                );
            }
            this.state.scaleConnected = false;
        }

        this.weightInterval = setTimeout(() => this._pollWeight(), WEIGHT_POLL_INTERVAL_MS);
    }

    /**
     * Traite un nouveau poids reçu (depuis polling ou longpoll).
     * Met à jour l'état, détecte le retrait du contenant, déclenche l'auto-save.
     * @param {number} newWeight - Poids brut en kg
     */
    async _processWeight(newWeight) {
        if (this._longpollFallbackTimer) {
            clearTimeout(this._longpollFallbackTimer);
            this._longpollFallbackTimer = null;
        }
        this.state.scaleInitializing = false;
        this.state.weight = newWeight;
        this.state.scaleConnected = true;

        // Mémoriser le poids max atteint
        if (newWeight > this.maxWeightReached) {
            this.maxWeightReached = newWeight;
        }

        // Détecter la transition: poids significatif → poids nul (retrait du contenant)
        // Conditions:
        // - Poids précédent > seuil
        // - Poids actuel <= seuil (quasi-zéro)
        // - Un poids significatif a été atteint (évite les faux positifs au démarrage)
        // - Pas déjà déclenché
        if (
            this.previousWeight > WEIGHT_THRESHOLD &&
            newWeight <= WEIGHT_THRESHOLD &&
            this.maxWeightReached > WEIGHT_THRESHOLD &&
            !this.autoSaveTriggered
        ) {
            // Utiliser le poids précédent comme tare (dernier poids stable)
            this.state.weight = this.previousWeight;
            this.autoSaveTriggered = true;
            await this._autoSaveContainer();
        }

        this.previousWeight = newWeight;
    }

    // ========================================================================
    // LONG-POLLING IOT
    // ========================================================================

    /**
     * S'abonne aux messages de la balance via iotHttpService (one-shot).
     * Chaque appel onMessage est un seul événement, on se réabonne après.
     */
    _listenForScaleMessages() {
        if (!this.state.isPolling || !this._iotHttpService) {
            console.log("[CONTAINER] _listenForScaleMessages SKIP polling=", this.state.isPolling);
            return;
        }
        const device = this._scaleDevice;
        if (!device) {
            console.log("[CONTAINER] _listenForScaleMessages SKIP no device");
            return;
        }
        this._listeningForMessages = true;
        this._iotHttpService.onMessage(
            device.iotId,
            device.identifier,
            (data) => this._handleScaleMessage(data),
            (error) => this._handleScaleError(error)
        );
    }

    /**
     * Traite un message de la balance reçu via long-poll.
     * null = timeout (pas d'événement), on se réabonne silencieusement.
     */
    _handleScaleMessage(data) {
        if (!this.state.isPolling) {
            this._listeningForMessages = false;
            return;
        }
        this._longpollErrors = 0;
        if (data === null) {
            console.log("[CONTAINER] _handleScaleMessage timeout → re-subscribe");
            this._listenForScaleMessages();
            return;
        }
        if (data.result != null) {
            console.log("[CONTAINER] _handleScaleMessage weight=", data.result);
            this._processWeight(data.result);
        }
        // Re-subscribe pour le prochain événement (pattern ONE-SHOT)
        this._listenForScaleMessages();
    }

    /**
     * Gère une erreur long-poll. Après LONGPOLL_MAX_ERRORS erreurs consécutives,
     * bascule en fallback polling.
     */
    _handleScaleError(error) {
        console.log("[CONTAINER] _handleScaleError", error, "consecutive=", this._longpollErrors + 1);
        if (!this.state.isPolling) {
            this._listeningForMessages = false;
            return;
        }
        this._longpollErrors++;
        if (this._longpollErrors >= LONGPOLL_MAX_ERRORS) {
            // Long-poll non fiable → fallback polling périodique
            this._listeningForMessages = false;
            this.notification.add(
                _t("Balance: basculement en mode polling"),
                { type: "warning" },
            );
            this._pollWeight();
            return;
        }
        // Re-subscribe après erreur
        setTimeout(() => this._listenForScaleMessages(), 1500);
    }

    stopWeightPolling() {
        this.state.isPolling = false;
        // Nettoyage fallback timer
        if (this._longpollFallbackTimer) {
            clearTimeout(this._longpollFallbackTimer);
            this._longpollFallbackTimer = null;
        }
        // Nettoyage polling
        if (this.weightInterval) {
            clearTimeout(this.weightInterval);
            this.weightInterval = null;
        }
        // Nettoyage long-poll
        this._listeningForMessages = false;
        this._longpollErrors = 0;
        this._scaleDevice?.removeListener?.();
    }

    get weightDisplay() {
        return formatWeight(this.state.weight, this.pos.data.models);
    }

    /**
     * Calcule le check digit EAN13 pour les 12 premiers chiffres.
     * @param {string} barcode12 - Les 12 premiers chiffres du code-barres
     * @returns {number|null} - Le check digit attendu, ou null si invalide
     */
    _computeEan13CheckDigit(barcode12) {
        if (barcode12.length !== 12 || !/^\d+$/.test(barcode12)) {
            return null;
        }
        let total = 0;
        for (let i = 0; i < 12; i++) {
            const weight = i % 2 === 0 ? 1 : 3;
            total += parseInt(barcode12[i]) * weight;
        }
        return (10 - (total % 10)) % 10;
    }

    /**
     * Vérifie si un EAN13 est valide.
     * @param {string} barcode - Le code-barres complet (13 chiffres)
     * @returns {boolean} - true si le code-barres est valide
     */
    _isValidEan13(barcode) {
        if (barcode.length !== 13 || !/^\d+$/.test(barcode)) {
            return false;
        }
        const expectedCheck = this._computeEan13CheckDigit(barcode.slice(0, 12));
        return expectedCheck === parseInt(barcode[12]);
    }

    /**
     * Valide le format du barcode (049 + EAN13 valide).
     * @returns {{valid: boolean, message: string}} - Résultat de la validation
     */
    get barcodeValidation() {
        const barcode = this.state.barcode;
        if (!barcode) {
            return { valid: true, message: "" };  // Optionnel si vide
        }
        if (!barcode.startsWith("049")) {
            return { valid: false, message: "Doit commencer par 049" };
        }
        if (barcode.length !== 13) {
            return { valid: false, message: "Doit faire 13 caractères" };
        }
        if (!/^\d+$/.test(barcode)) {
            return { valid: false, message: "Chiffres uniquement" };
        }
        if (!this._isValidEan13(barcode)) {
            const expected = this._computeEan13CheckDigit(barcode.slice(0, 12));
            return { valid: false, message: `Check digit invalide (attendu: ${expected})` };
        }
        return { valid: true, message: "" };
    }

    /**
     * Vérifie si un code-barres existe déjà parmi les contenants.
     * @param {string} barcode - Le code-barres à vérifier
     * @returns {boolean} - true si le code-barres existe déjà
     */
    _barcodeExists(barcode) {
        if (!barcode) return false;
        const containers = this.pos.data.models["pos.container"]?.getAll() || [];
        return containers.some(c => c.barcode === barcode);
    }

    /**
     * Handler pour la modification du champ barcode.
     * Filtre pour ne garder que les chiffres.
     */
    onBarcodeChange(ev) {
        const value = ev.target.value.replace(/\D/g, '').slice(0, 13);
        this.state.barcode = value;
    }

    /**
     * Handler pour la modification du champ consigne (deposit value).
     */
    onDepositChange(ev) {
        this.state.depositValue = parseFloat(ev.target.value) || 0;
    }

    get canSave() {
        const hasWeight = this.state.weight > 0;
        const barcodeOk = !this.state.barcode || this.barcodeValidation.valid;
        return hasWeight && barcodeOk;
    }

    async saveContainer() {
        if (this.state.weight <= 0) {
            this.notification.add(_t("Posez le contenant sur la balance"), { type: "warning" });
            return;
        }

        // Vérifier si le code-barres existe déjà
        if (this.state.barcode && this._barcodeExists(this.state.barcode)) {
            this.notification.add(
                _t("Un contenant avec ce code-barres existe déjà"),
                { type: "warning" }
            );
            return;
        }

        this._sendScaleAction("stop");

        try {
            // Préparer les données du contenant
            const containerData = {
                name: this.state.name.trim(),
                tare: this.state.weight,
                deposit_amount: this.state.depositValue || 0,
                state: "in_store",
            };

            // Ajouter le barcode si fourni (scan 049 inconnu)
            if (this.state.barcode) {
                containerData.barcode = this.state.barcode;
            }

            // Create the container via RPC
            const containerId = await this.pos.data.call("pos.container", "create", [containerData]);

            // Reload containers from server to get the full record with barcode
            await this.pos.data.read("pos.container", [containerId]);

            this.props.onSave(containerId);

            // Fermer le dialog si ouvert via dialog.add()
            if (this.props.close) {
                this.props.close();
            }
        } catch (error) {
            console.error("Container create error:", error);
            this.notification.add(_t("Erreur lors de la création du contenant"), { type: "danger" });
        }
    }

    /**
     * Sauvegarde automatique déclenchée quand le contenant est retiré de la balance.
     * Utilise le poids précédent (avant retrait) comme tare.
     */
    async _autoSaveContainer() {
        // Bloquer l'auto-save si le barcode est invalide
        if (this.state.barcode && !this.barcodeValidation.valid) {
            this.notification.add(
                _t("Code-barres invalide: %(message)s", { message: this.barcodeValidation.message }),
                { type: "warning", sticky: false }
            );
            this.autoSaveTriggered = false;
            return;
        }

        // Vérifier si le code-barres existe déjà
        if (this.state.barcode && this._barcodeExists(this.state.barcode)) {
            this.notification.add(
                _t("Un contenant avec ce code-barres existe déjà"),
                { type: "warning", sticky: false }
            );
            this.autoSaveTriggered = false;
            return;
        }

        this._sendScaleAction("stop");

        try {
            const containerData = {
                name: this.state.name.trim(),
                tare: this.state.weight,
                deposit_amount: this.state.depositValue || 0,
                state: "in_store",
            };

            if (this.state.barcode) {
                containerData.barcode = this.state.barcode;
            }

            const containerId = await this.pos.data.call("pos.container", "create", [containerData]);
            await this.pos.data.read("pos.container", [containerId]);

            this.notification.add(
                _t("Contenant \"%(name)s\" créé (%(tare)s kg). Scannez-le à nouveau pour l'utiliser.", {
                    name: this.state.name.trim(),
                    tare: formatWeight(this.state.weight, this.pos.data.models),
                }),
                { type: "success", sticky: false }
            );

            this.props.onSave(containerId);

            // Fermer le dialog si disponible
            if (this.props.close) {
                this.props.close();
            }
        } catch (error) {
            console.error("Container auto-save error:", error);
            this.notification.add(_t("Erreur lors de la sauvegarde automatique"), { type: "danger" });
            // Reset le flag pour permettre une nouvelle tentative
            this.autoSaveTriggered = false;
        }
    }

    cancel() {
        this.props.onCancel();
        // Fermer le dialog si ouvert via dialog.add()
        if (this.props.close) {
            this.props.close();
        }
    }
}
