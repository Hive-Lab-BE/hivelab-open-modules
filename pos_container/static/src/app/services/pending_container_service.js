/** @odoo-module */

import { Reactive } from "@web/core/utils/reactive";
import { registry } from "@web/core/registry";

/**
 * Service pour gérer le contenant en attente.
 *
 * Workflow:
 * - Scan AVANT sélection produit → stocke le contenant en attente
 * - Scan PENDANT/APRÈS sélection produit pesé → applique directement la tare
 * - Le contenant en attente est consommé lors de l'ouverture du ScaleScreen
 */
export class PendingContainerService extends Reactive {
    constructor() {
        super();
        this.container = null;
    }

    /**
     * Définit le contenant en attente.
     * @param {Object} container - Le contenant à stocker
     */
    set(container) {
        this.container = container;
    }

    /**
     * Récupère le contenant en attente sans le consommer.
     * @returns {Object|null}
     */
    get() {
        return this.container;
    }

    /**
     * Récupère et consomme le contenant en attente.
     * @returns {Object|null}
     */
    consume() {
        const container = this.container;
        this.container = null;
        return container;
    }

    /**
     * Efface le contenant en attente.
     */
    clear() {
        this.container = null;
    }

    /**
     * Vérifie si un contenant est en attente.
     * @returns {boolean}
     */
    get hasPending() {
        return this.container !== null;
    }
}

export const pendingContainerService = {
    start() {
        return new PendingContainerService();
    },
};

registry.category("services").add("pending_container", pendingContainerService);
