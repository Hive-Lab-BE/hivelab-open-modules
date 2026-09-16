/** @odoo-module */

/**
 * Mock data for pos.container model used in tests.
 */
export const containerData = {
    _records: [
        { id: 1, name: "Bocal 500ml", barcode: "0490000000016", tare: 0.250 },
        { id: 2, name: "Sac tissu", barcode: "0490000000023", tare: 0.050 },
        { id: 3, name: "Boîte métal", barcode: "0490000000030", tare: 0.150 },
    ],

    /**
     * Get a container by ID.
     * @param {number} id
     * @returns {Object|undefined}
     */
    getById(id) {
        return this._records.find((c) => c.id === id);
    },

    /**
     * Get a container by barcode.
     * @param {string} barcode
     * @returns {Object|undefined}
     */
    getByBarcode(barcode) {
        return this._records.find((c) => c.barcode === barcode);
    },

    /**
     * Get all containers.
     * @returns {Array}
     */
    getAll() {
        return [...this._records];
    },
};
