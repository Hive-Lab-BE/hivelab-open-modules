/** @odoo-module */

import { showUnknownContainerNotification } from "./weight_utils";
import { ContainerAddForm } from "../screens/container_add/container_add";

export const CONTAINER_BARCODE_PREFIX = "049";

/**
 * Gère un scan de code-barres contenant : lookup, création si 049 inconnu, notification sinon.
 *
 * @param {Object} code - Objet code-barres du barcode reader
 * @param {Object} options
 * @param {Object} options.posModels - Les modèles POS (this.pos.models)
 * @param {Object} options.dialog - Le service dialog
 * @param {Object} options.notification - Le service notification
 * @param {Function} options.onFound - Callback appelé avec le contenant trouvé ou créé
 */
export function handleContainerBarcode(code, { posModels, dialog, notification, onFound }) {
    const barcode = code.base_code || code.code;
    const container = posModels["pos.container"]?.getBy("barcode", barcode);

    if (container) {
        onFound(container);
        return;
    }

    if (barcode.startsWith(CONTAINER_BARCODE_PREFIX)) {
        dialog.add(ContainerAddForm, {
            initialBarcode: barcode,
            onSave: () => {},
            onCancel: () => {},
        });
    } else {
        showUnknownContainerNotification(barcode, notification);
    }
}
