/** @odoo-module */

import { ScaleScreen } from "@point_of_sale/app/screens/scale_screen/scale_screen";
import { patch } from "@web/core/utils/patch";
import { useBarcodeReader } from "@point_of_sale/app/hooks/barcode_reader_hook";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { onMounted, onWillUnmount, useState } from "@odoo/owl";
import { formatWeight, getWeightDigits } from "../utils/weight_utils";
import { handleContainerBarcode } from "../utils/container_barcode";
import { Numpad } from "@point_of_sale/app/components/numpad/numpad";

// Timeout maximum pour le polling de reconnexion (30 minutes)
const RECONNECT_POLLING_TIMEOUT_MS = 30 * 60 * 1000;

// Limites pour la saisie manuelle du poids
const MAX_INTEGER_DIGITS = 6;  // Max 6 chiffres avant la virgule (999999 kg)

/**
 * Patch du ScaleScreen pour:
 * - Pré-remplir la tare si un contenant est en attente
 * - Écouter les scans de contenants pendant le pesage
 * - Support de la saisie manuelle avec numpad toujours disponible
 * - Layout unifié (pas de mode manuel séparé)
 */
patch(ScaleScreen.prototype, {
    setup() {
        super.setup(...arguments);

        this.pendingContainerService = useService("pending_container");
        this.notification = useService("notification");
        this.pos = useService("pos");
        this.dialog = useService("dialog");

        // État UI simplifié
        this.manualState = useState({
            manualWeightInput: "",     // string pour numpad poids
            tareInput: "",             // string pour numpad tare
            activeNumpadField: null,   // 'weight' | 'tare' | null
        });

        useBarcodeReader({
            container: this._onContainerBarcode.bind(this),
        });

        // Référence au hardwareProxy pour observer les changements de connexion
        this.hardwareProxy = useService("hardware_proxy");

        // Intervalle de polling pour vérifier la reconnexion (null quand inactif)
        this._reconnectPollingInterval = null;
        // Timeout pour arrêter le polling après 30 minutes
        this._reconnectPollingTimeout = null;

        onMounted(() => {
            this._applyPendingContainer();
            this.scale.setAutoConfirmCallback(() => this._autoConfirm());

            // Pré-remplir l'input poids brut si le service a déjà une valeur
            if (this.scale.isWeightOverridden && this.scale.manualWeight > 0) {
                this.manualState.manualWeightInput = this.scale.manualWeight.toFixed(
                    getWeightDigits(this.pos.data.models)
                );
            }
        });

        onWillUnmount(() => {
            this.scale.setAutoConfirmCallback(null);
            this._stopReconnectPolling();
        });
    },

    /**
     * Applique le contenant en attente au démarrage du ScaleScreen.
     */
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
    },

    /**
     * Gère le scan d'un contenant pendant le pesage.
     */
    _onContainerBarcode(code) {
        handleContainerBarcode(code, {
            posModels: this.pos.models,
            dialog: this.dialog,
            notification: this.notification,
            onFound: (container) => {
                this.scale.setTareWithContainer(container.tare, container);
                // Mettre à jour l'input tare si le numpad tare est ouvert
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
    },

    /**
     * Validation automatique quand le produit est retiré de la balance.
     * Appelé par le scale service quand le poids revient à zéro après avoir atteint un seuil.
     */
    _autoConfirm() {
        this.notification.add(
            _t("Pesée validée automatiquement"),
            { type: "success", sticky: false }
        );

        this.confirm();
    },

    /**
     * Surcharge de onError pour gérer la déconnexion de la balance.
     * @param {string} message - Message d'erreur de la balance
     */
    onError(message) {
        // Si déjà déconnecté, ignorer
        if (this.scale.isDisconnected) {
            return;
        }

        this.scale.setDisconnected(true);

        // Démarrer le polling de reconnexion
        this._startReconnectPolling();

        this.notification.add(
            _t("Balance déconnectée - Saisie manuelle activée"),
            { type: "warning", sticky: false }
        );
    },

    /**
     * Démarre le polling rapide (2s) pour vérifier la reconnexion de la balance.
     * S'arrête automatiquement après 30 minutes.
     */
    _startReconnectPolling() {
        if (this._reconnectPollingInterval) {
            return; // Déjà en cours
        }

        this._reconnectPollingInterval = setInterval(() => {
            const connectionInfo = this.hardwareProxy.connectionInfo;
            if (connectionInfo.status === "connected" &&
                connectionInfo.drivers?.scale?.status === "connected") {
                this._onScaleReconnected();
            }
        }, 2000);

        // Set a timeout to stop polling after 30 minutes
        this._reconnectPollingTimeout = setTimeout(() => {
            if (this._reconnectPollingInterval) {
                this._stopReconnectPolling();
                this.notification.add(
                    _t("Polling balance arrêté après 30 minutes"),
                    { type: "info", sticky: false }
                );
            }
        }, RECONNECT_POLLING_TIMEOUT_MS);
    },

    /**
     * Arrête le polling de reconnexion.
     */
    _stopReconnectPolling() {
        if (this._reconnectPollingInterval) {
            clearInterval(this._reconnectPollingInterval);
            this._reconnectPollingInterval = null;
        }
        if (this._reconnectPollingTimeout) {
            clearTimeout(this._reconnectPollingTimeout);
            this._reconnectPollingTimeout = null;
        }
    },

    /**
     * Appelé quand la balance se reconnecte après une déconnexion.
     * Restaure le mode automatique si l'utilisateur n'a rien tapé.
     */
    _onScaleReconnected() {
        this._stopReconnectPolling();
        this.scale.setDisconnected(false);

        // Si l'utilisateur n'a pas tapé de poids, revenir en mode auto
        if (!this.manualState.manualWeightInput) {
            this.scale.clearWeightOverride();
            this.manualState.manualWeightInput = "";
            this.manualState.activeNumpadField = null;

            // Redémarrer la lecture de la balance
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
    },

    /**
     * Handler pour le changement du poids brut manuel.
     * @param {Event} ev - Événement input
     */
    onManualWeightChange(ev) {
        this.manualState.manualWeightInput = ev.target.value;
        this.scale.setManualWeight(ev.target.value);
    },

    /**
     * Handler unifié pour le changement de la tare via input direct.
     * @param {Event} ev - Événement input
     */
    onTareInputChange(ev) {
        this.manualState.tareInput = ev.target.value;
        const value = parseFloat(ev.target.value) || 0;
        this.scale.setTareValueManually(value);
    },

    /**
     * Vérifie si la commande est valide (poids net > 0).
     */
    get isOrderValid() {
        // Toujours exiger un poids net positif (quel que soit le mode)
        if (this.scale.effectiveNetWeight <= 0) {
            return false;
        }
        // En mode auto, vérifier aussi la conformité LNE (poids changé depuis dernière pesée)
        if (!this.scale.isWeightOverridden) {
            return this.scale.isWeightValid;
        }
        return true;
    },

    /**
     * Toggle l'affichage du numpad pour un champ donné.
     * Pré-remplit les valeurs quand on ouvre.
     * @param {string} field - 'weight' ou 'tare'
     */
    toggleNumpad(field) {
        if (this.manualState.activeNumpadField === field) {
            this.manualState.activeNumpadField = null;
        } else {
            // Pré-remplir quand on ouvre
            if (field === "weight" && !this.manualState.manualWeightInput && !this.scale.isWeightOverridden) {
                // Pré-remplir avec la valeur balance si disponible et non-nulle
                if (this.scale.weight > 0) {
                    this.manualState.manualWeightInput = this.scale.weight.toFixed(getWeightDigits(this.pos.data.models));
                }
            }
            if (field === "tare" && !this.manualState.tareInput) {
                // Pré-remplir avec la tare actuelle si disponible
                if (this.scale.tare > 0) {
                    this.manualState.tareInput = this.scale.tare.toFixed(getWeightDigits(this.pos.data.models));
                }
            }
            this.manualState.activeNumpadField = field;
        }
    },

    /**
     * Retourne les boutons du numpad simplifié.
     */
    getSimpleNumpadButtons() {
        return [
            { value: "1" }, { value: "2" }, { value: "3" },
            { value: "4" }, { value: "5" }, { value: "6" },
            { value: "7" }, { value: "8" }, { value: "9" },
            { value: "C", text: "C", class: "o_colorlist_item_numpad_color_1" },
            { value: "0" },
            { value: "." },
        ];
    },

    /**
     * Handler pour les clics sur le numpad.
     * @param {string} key - Touche pressée
     */
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
            // Enforce digit limits
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

        // Mettre à jour le scale service
        if (field === "weight") {
            this.scale.setManualWeight(current);
        } else {
            this.scale.setTareValueManually(parseFloat(current) || 0);
        }
    },

    /**
     * Surcharge de confirm() pour passer toutes les infos de pesée.
     */
    confirm() {
        const isWeightOverridden = this.scale.isWeightOverridden;
        const container = this.scale.consumeContainer();

        // Calculer les poids et modes
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
            
            // Debug logging to ensure values are correct
            console.log("[SCALE] confirm() auto-mode:", {
                netWeight: netWeight,
                tareWeight: tareWeight,
                calculatedGross: grossWeight,
                weight: this.scale.weight,
                manualWeight: this.scale.manualWeight,
                tare: this.scale.tare,
            });
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
    },
});

// Ajouter le composant Numpad aux composants du ScaleScreen
ScaleScreen.components = { ...ScaleScreen.components, Numpad };
