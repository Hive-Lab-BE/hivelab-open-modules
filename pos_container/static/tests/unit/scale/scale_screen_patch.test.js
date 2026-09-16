/** @odoo-module */

import { describe, expect, test } from "@odoo/hoot";

/**
 * Creates a mock ScaleScreen component that mimics the patched behavior.
 * This allows testing the auto-confirm integration in isolation.
 */
function createMockScaleScreen(options = {}) {
    const notifications = [];

    const mockScale = {
        autoConfirmCallback: null,
        tare: 0,
        currentContainer: null,

        setAutoConfirmCallback(callback) {
            this.autoConfirmCallback = callback;
        },

        setTareWithContainer(tare, container) {
            this.tare = tare;
            this.currentContainer = container;
        },

        triggerAutoConfirm() {
            if (this.autoConfirmCallback) {
                this.autoConfirmCallback();
            }
        },
    };

    const mockPendingContainerService = {
        _pending: options.pendingContainer || null,

        get() {
            return this._pending;
        },

        consume() {
            const pending = this._pending;
            this._pending = null;
            return pending;
        },

        set(container) {
            this._pending = container;
        },
    };

    const mockNotification = {
        add(message, opts = {}) {
            notifications.push({ message, ...opts });
        },
    };

    const screen = {
        scale: mockScale,
        pendingContainerService: mockPendingContainerService,
        notification: mockNotification,
        _autoConfirmTriggered: false,
        _notifications: notifications,
        _confirmCalled: false,

        confirm() {
            this._confirmCalled = true;
        },

        mount() {
            this._applyPendingContainer();
            this.scale.setAutoConfirmCallback(() => this._autoConfirm());
        },

        unmount() {
            this.scale.setAutoConfirmCallback(null);
        },

        _applyPendingContainer() {
            const pending = this.pendingContainerService.get();
            if (pending) {
                this.scale.setTareWithContainer(pending.tare, pending);
                this.pendingContainerService.consume();
                this.notification.add(
                    `Tare pré-remplie: ${pending.tare.toFixed(3)} kg`,
                    {
                        type: "info",
                        sticky: false,
                        title: `Contenant: ${pending.name}`,
                    }
                );
            }
        },

        _autoConfirm() {
            if (this._autoConfirmTriggered) {
                return;
            }
            this._autoConfirmTriggered = true;

            this.notification.add(
                "Pesée validée automatiquement",
                { type: "success", sticky: false }
            );

            this.confirm();
        },
    };

    return screen;
}

describe("scale_screen_patch - callback lifecycle", () => {
    test("callback is registered on mount", () => {
        const screen = createMockScaleScreen();

        expect(screen.scale.autoConfirmCallback).toBe(null);

        screen.mount();

        expect(screen.scale.autoConfirmCallback).not.toBe(null);
        expect(typeof screen.scale.autoConfirmCallback).toBe("function");
    });

    test("callback is cleaned up (null) on unmount", () => {
        const screen = createMockScaleScreen();
        screen.mount();

        expect(screen.scale.autoConfirmCallback).not.toBe(null);

        screen.unmount();

        expect(screen.scale.autoConfirmCallback).toBe(null);
    });

    test("callback is properly bound to screen instance", () => {
        const screen = createMockScaleScreen();
        screen.mount();

        // Trigger callback directly
        screen.scale.triggerAutoConfirm();

        expect(screen._confirmCalled).toBe(true);
    });
});

describe("scale_screen_patch - _autoConfirm behavior", () => {
    test("_autoConfirm() calls confirm()", () => {
        const screen = createMockScaleScreen();
        screen.mount();

        screen._autoConfirm();

        expect(screen._confirmCalled).toBe(true);
    });

    test("_autoConfirm() shows a notification", () => {
        const screen = createMockScaleScreen();
        screen.mount();

        screen._autoConfirm();

        expect(screen._notifications.length).toBe(1);
        expect(screen._notifications[0].message).toBe("Pesée validée automatiquement");
        expect(screen._notifications[0].type).toBe("success");
    });

    test("_autoConfirmTriggered flag prevents multiple calls", () => {
        const screen = createMockScaleScreen();
        screen.mount();

        // First call
        screen._autoConfirm();
        expect(screen._notifications.length).toBe(1);

        // Reset confirm tracking
        screen._confirmCalled = false;

        // Second call - should be blocked
        screen._autoConfirm();
        expect(screen._notifications.length).toBe(1); // No new notification
        expect(screen._confirmCalled).toBe(false);    // confirm() not called again
    });

    test("_autoConfirmTriggered flag blocks even when triggered from scale", () => {
        const screen = createMockScaleScreen();
        screen.mount();

        // First trigger from scale
        screen.scale.triggerAutoConfirm();
        expect(screen._confirmCalled).toBe(true);

        screen._confirmCalled = false;

        // Second trigger from scale - should be blocked
        screen.scale.triggerAutoConfirm();
        expect(screen._confirmCalled).toBe(false);
    });
});

describe("scale_screen_patch - pending_container integration", () => {
    test("pending container tare is applied on mount", () => {
        const pendingContainer = {
            id: 1,
            name: "Bocal 500ml",
            barcode: "0490000000016",
            tare: 0.250,
        };

        const screen = createMockScaleScreen({ pendingContainer });
        screen.mount();

        expect(screen.scale.tare).toBe(0.250);
        expect(screen.scale.currentContainer).toEqual(pendingContainer);
    });

    test("pending container is consumed after apply", () => {
        const pendingContainer = {
            id: 1,
            name: "Bocal 500ml",
            barcode: "0490000000016",
            tare: 0.250,
        };

        const screen = createMockScaleScreen({ pendingContainer });

        expect(screen.pendingContainerService.get()).not.toBe(null);

        screen.mount();

        expect(screen.pendingContainerService.get()).toBe(null);
    });

    test("notification is shown when pending container is applied", () => {
        const pendingContainer = {
            id: 1,
            name: "Bocal 500ml",
            barcode: "0490000000016",
            tare: 0.250,
        };

        const screen = createMockScaleScreen({ pendingContainer });
        screen.mount();

        expect(screen._notifications.length).toBe(1);
        expect(screen._notifications[0].message).toBe("Tare pré-remplie: 0.250 kg");
        expect(screen._notifications[0].title).toBe("Contenant: Bocal 500ml");
        expect(screen._notifications[0].type).toBe("info");
    });

    test("no action when no pending container", () => {
        const screen = createMockScaleScreen({ pendingContainer: null });
        screen.mount();

        expect(screen.scale.tare).toBe(0);
        expect(screen.scale.currentContainer).toBe(null);
        expect(screen._notifications.length).toBe(0);
    });
});

describe("scale_screen_patch - full integration scenario", () => {
    test("complete flow: pending container + auto-confirm", () => {
        const pendingContainer = {
            id: 2,
            name: "Sac tissu",
            barcode: "0490000000023",
            tare: 0.050,
        };

        const screen = createMockScaleScreen({ pendingContainer });

        // Mount screen
        screen.mount();

        // Verify pending container was applied
        expect(screen.scale.tare).toBe(0.050);
        expect(screen._notifications.length).toBe(1);
        expect(screen._notifications[0].type).toBe("info");

        // Verify callback is set
        expect(screen.scale.autoConfirmCallback).not.toBe(null);

        // Simulate product removal triggering auto-confirm
        screen.scale.triggerAutoConfirm();

        // Verify auto-confirm happened
        expect(screen._confirmCalled).toBe(true);
        expect(screen._notifications.length).toBe(2);
        expect(screen._notifications[1].type).toBe("success");

        // Unmount
        screen.unmount();
        expect(screen.scale.autoConfirmCallback).toBe(null);
    });

    test("mount without pending + auto-confirm", () => {
        const screen = createMockScaleScreen();

        screen.mount();

        // No pending container notifications
        expect(screen._notifications.length).toBe(0);
        expect(screen.scale.tare).toBe(0);

        // Auto-confirm still works
        screen.scale.triggerAutoConfirm();

        expect(screen._confirmCalled).toBe(true);
        expect(screen._notifications.length).toBe(1);
    });

    test("rapid mount/unmount cycles", () => {
        for (let i = 0; i < 5; i++) {
            const screen = createMockScaleScreen();
            screen.mount();
            expect(screen.scale.autoConfirmCallback).not.toBe(null);
            screen.unmount();
            expect(screen.scale.autoConfirmCallback).toBe(null);
        }
    });
});
