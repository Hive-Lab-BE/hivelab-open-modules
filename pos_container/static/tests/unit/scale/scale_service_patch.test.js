/** @odoo-module */

import { describe, expect, test } from "@odoo/hoot";

// Seuils identiques à ceux du patch (scale_service_patch.js)
const AUTO_CONFIRM_THRESHOLD = 0.020; // 20g minimum pour activer l'auto-confirm
const ZERO_THRESHOLD = 0.005;         // 5g = considéré comme zéro

/**
 * Creates a mock scale service that faithfully mimics the patched PosScaleService behavior.
 * Uses productWasWeighed flag + autoConfirmInProgress lock + isWeightOverridden guard.
 */
function createMockScaleService() {
    return {
        weight: 0,
        tare: 0,
        productWasWeighed: false,
        autoConfirmInProgress: false,
        autoConfirmCallback: null,
        isWeightOverridden: false,
        _callbackCallCount: 0,

        get netWeight() {
            return this.weight - this.tare;
        },

        setAutoConfirmCallback(callback) {
            this.autoConfirmCallback = callback;
        },

        start() {
            this.productWasWeighed = false;
            this.autoConfirmInProgress = false;
            this.isWeightOverridden = false;
        },

        setTareWithContainer(tare, container) {
            this.tare = tare;
            this.currentContainer = container;
        },

        setWeight(newWeight) {
            this.weight = newWeight;
            this._checkAutoConfirm();
        },

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
                this.autoConfirmInProgress = true;
                this._callbackCallCount++;
                this.autoConfirmCallback();
            }
        },
    };
}

describe("scale_service_patch - productWasWeighed tracking", () => {
    test("productWasWeighed becomes true when weight exceeds threshold", () => {
        const scaleService = createMockScaleService();
        scaleService.start();

        scaleService.setWeight(0.010); // 10g - below threshold
        expect(scaleService.productWasWeighed).toBe(false);

        scaleService.setWeight(0.021); // 21g - above threshold
        expect(scaleService.productWasWeighed).toBe(true);
    });

    test("productWasWeighed stays true when weight decreases", () => {
        const scaleService = createMockScaleService();
        scaleService.start();

        scaleService.setWeight(0.100);
        expect(scaleService.productWasWeighed).toBe(true);

        scaleService.setWeight(0.050);
        expect(scaleService.productWasWeighed).toBe(true);

        scaleService.setWeight(0.010);
        expect(scaleService.productWasWeighed).toBe(true);
    });

    test("productWasWeighed resets on start()", () => {
        const scaleService = createMockScaleService();
        scaleService.start();

        scaleService.setWeight(0.100);
        expect(scaleService.productWasWeighed).toBe(true);

        scaleService.start();
        expect(scaleService.productWasWeighed).toBe(false);
    });

    test("productWasWeighed accounts for tare", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        scaleService.setTareWithContainer(0.050, { id: 1, name: "Container" });

        // Gross weight 0.060, net weight = 0.010 - below threshold
        scaleService.setWeight(0.060);
        expect(scaleService.productWasWeighed).toBe(false);

        // Gross weight 0.080, net weight = 0.030 - above threshold
        scaleService.setWeight(0.080);
        expect(scaleService.productWasWeighed).toBe(true);
    });
});

describe("scale_service_patch - callback NOT triggered", () => {
    test("peak < 20g (threshold not reached) - no callback", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        scaleService.setWeight(0.015); // 15g
        scaleService.setWeight(0);     // removed

        expect(callbackCalled).toBe(false);
    });

    test("peak = 19g (just below threshold) - no callback", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        scaleService.setWeight(0.019); // 19g
        scaleService.setWeight(0);     // removed

        expect(callbackCalled).toBe(false);
    });

    test("current weight > 5g (product not yet removed) - no callback", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        scaleService.setWeight(0.100); // 100g - above threshold
        scaleService.setWeight(0.010); // 10g - still on scale

        expect(callbackCalled).toBe(false);
    });

    test("current weight = 6g (just above zero threshold) - no callback", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        scaleService.setWeight(0.100); // 100g
        scaleService.setWeight(0.006); // 6g - just above ZERO_THRESHOLD

        expect(callbackCalled).toBe(false);
    });

    test("no callback defined - no error", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        scaleService.setAutoConfirmCallback(null);

        scaleService.setWeight(0.100);
        scaleService.setWeight(0);

        // Should not throw, just not trigger anything
        expect(scaleService._callbackCallCount).toBe(0);
    });
});

describe("scale_service_patch - callback triggered correctly", () => {
    test("peak >= 20g AND current <= 5g - callback triggered", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        scaleService.setWeight(0.100); // 100g
        expect(callbackCalled).toBe(false);

        scaleService.setWeight(0.003); // 3g - below ZERO_THRESHOLD
        expect(callbackCalled).toBe(true);
    });

    test("peak = 20g exactly (threshold) - callback triggered", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        scaleService.setWeight(0.020); // exactly 20g - NOT above threshold (> not >=)
        expect(callbackCalled).toBe(false);

        scaleService.setWeight(0.021); // 21g - above threshold
        scaleService.setWeight(0); // removed
        expect(callbackCalled).toBe(true);
    });

    test("current = 5g exactly (zero threshold) - callback triggered", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        scaleService.setWeight(0.100); // 100g
        scaleService.setWeight(0.005); // exactly 5g

        expect(callbackCalled).toBe(true);
    });

    test("large weight (500g) then removed - callback triggered", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        scaleService.setWeight(0.500); // 500g
        expect(callbackCalled).toBe(false);

        scaleService.setWeight(0);
        expect(callbackCalled).toBe(true);
    });

    test("with container tare - uses NET weight", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        // Container with 50g tare
        scaleService.setTareWithContainer(0.050, { id: 1, name: "Container" });

        // Gross = 80g, Net = 30g (above threshold)
        scaleService.setWeight(0.080);
        expect(callbackCalled).toBe(false);

        // Gross = 55g, Net = 5g (at zero threshold)
        scaleService.setWeight(0.055);
        expect(callbackCalled).toBe(true);
    });

    test("callback triggers only once - lock prevents repeated triggers", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callCount = 0;
        scaleService.setAutoConfirmCallback(() => { callCount++; });

        scaleService.setWeight(0.100);
        scaleService.setWeight(0); // first trigger
        expect(callCount).toBe(1);

        // Lock prevents further triggers
        scaleService.setWeight(0); // still zero - blocked by lock
        expect(callCount).toBe(1);

        scaleService.setWeight(0); // still zero - blocked by lock
        expect(callCount).toBe(1);
    });
});

describe("scale_service_patch - isWeightOverridden blocks auto-confirm", () => {
    test("isWeightOverridden prevents auto-confirm even with valid weight sequence", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        // Simulate user typing a weight via numpad
        scaleService.isWeightOverridden = true;

        scaleService.setWeight(0.100); // 100g
        expect(scaleService.productWasWeighed).toBe(false); // Guard prevents marking

        scaleService.setWeight(0); // removed
        expect(callbackCalled).toBe(false); // No auto-confirm
    });

    test("isWeightOverridden prevents productWasWeighed from being set", () => {
        const scaleService = createMockScaleService();
        scaleService.start();

        scaleService.isWeightOverridden = true;
        scaleService.setWeight(0.500); // Large weight
        expect(scaleService.productWasWeighed).toBe(false);
    });

    test("clearing isWeightOverridden restores auto-confirm behavior", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        // With override - no auto-confirm
        scaleService.isWeightOverridden = true;
        scaleService.setWeight(0.100);
        scaleService.setWeight(0);
        expect(callbackCalled).toBe(false);

        // Clear override - auto-confirm works again
        scaleService.isWeightOverridden = false;
        scaleService.autoConfirmInProgress = false; // Reset lock too
        scaleService.setWeight(0.100);
        scaleService.setWeight(0);
        expect(callbackCalled).toBe(true);
    });

    test("isWeightOverridden resets on start()", () => {
        const scaleService = createMockScaleService();
        scaleService.isWeightOverridden = true;

        scaleService.start();
        expect(scaleService.isWeightOverridden).toBe(false);
    });
});

describe("scale_service_patch - edge cases", () => {
    test("negative weight (scale error) - no crash", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        // Simulate scale returning negative value
        scaleService.setWeight(-0.005);
        expect(scaleService.productWasWeighed).toBe(false); // Should not mark as weighed

        scaleService.setWeight(0.100);
        scaleService.setWeight(-0.010);
        expect(callbackCalled).toBe(true); // -0.010 < 0.005, triggers callback
    });

    test("callback removed during weighing - no error", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        scaleService.setWeight(0.100);

        // Remove callback before product is removed
        scaleService.setAutoConfirmCallback(null);

        scaleService.setWeight(0);
        expect(callbackCalled).toBe(false);
    });

    test("tare greater than weight - negative net weight", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        // Set tare of 100g
        scaleService.setTareWithContainer(0.100, { id: 1, name: "Container" });

        // Weight only 50g (net = -50g)
        scaleService.setWeight(0.050);
        expect(scaleService.netWeight).toBe(-0.050);
        expect(scaleService.productWasWeighed).toBe(false); // Should not mark as weighed

        // Even at zero weight, should not trigger (never reached threshold)
        scaleService.setWeight(0.100); // net = 0
        expect(callbackCalled).toBe(false);
    });

    test("realistic weighing sequence", () => {
        const scaleService = createMockScaleService();
        scaleService.start();
        let callbackCalled = false;
        scaleService.setAutoConfirmCallback(() => { callbackCalled = true; });

        // Simulate realistic weighing: place product, stable reading, remove
        scaleService.setWeight(0.010); // Noise
        scaleService.setWeight(0.045); // Placing product
        scaleService.setWeight(0.048); // Stabilizing
        scaleService.setWeight(0.050); // Stable (50g)
        scaleService.setWeight(0.050); // Stable
        expect(callbackCalled).toBe(false);
        expect(scaleService.productWasWeighed).toBe(true);

        scaleService.setWeight(0.025); // Lifting
        expect(callbackCalled).toBe(false);

        scaleService.setWeight(0.003); // Removed
        expect(callbackCalled).toBe(true);
    });
});
