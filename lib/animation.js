// SPDX-License-Identifier: GPL-2.0-or-later
//
// Vertical slide when switching Activities.
//
// begin() runs before the old Activity's windows are hidden: it puts
// Clutter.Clones of the windows the user sees into a container stacked right
// above global.window_group (so below the top bar and other chrome). The
// windows are then hidden for real, which does not matter for the clones:
// Clutter keeps painting a clone of an unmapped source (that is how the
// Overview shows minimized windows).
//
// end() runs after the new Activity's windows are shown: the old clones slide
// out vertically while the real window actors of the new Activity slide in
// from the opposite edge (translation only, so input/geometry are untouched
// and everything is back to normal when the transition completes or is
// interrupted). The desktop background stays still.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DURATION_MS = 280;

export class SwitchAnimator {
    /**
     * @param {Gio.Settings} settings
     */
    constructor(settings) {
        this._settings = settings;
        this._container = null;
        this._actors = new Set();
    }

    get enabled() {
        return this._settings.get_string('switch-animation') === 'vertical' &&
            St.Settings.get().enable_animations &&
            !Main.overview.visible;
    }

    /**
     * @param {Meta.Window[]} windows windows visible before the switch
     * @param {number} direction 1 when going to a later Activity, -1 otherwise
     * @returns {object|null} token for end()
     */
    begin(windows, direction) {
        this._finish();
        if (!this.enabled)
            return null;
        try {
            const container = new Clutter.Actor({name: 'activities-layer-switch'});
            const actors = windows.map(w => w.get_compositor_private()).filter(a => a?.visible);
            // global.get_window_actors() is in stacking order, bottom first.
            const order = global.get_window_actors();
            actors.sort((a, b) => order.indexOf(a) - order.indexOf(b));
            for (const actor of actors) {
                container.add_child(new Clutter.Clone({
                    source: actor,
                    x: actor.x,
                    y: actor.y,
                }));
            }
            Main.layoutManager.uiGroup.insert_child_above(container, global.window_group);
            this._container = container;
            return {container, direction};
        } catch (e) {
            console.error(`[activities-layer] switch animation: ${e.message}`);
            this._finish();
            return null;
        }
    }

    /**
     * @param {object} token from begin()
     * @param {Meta.Window[]} windows windows visible after the switch
     */
    end(token, windows) {
        try {
            const distance = global.stage.height;
            const params = {
                duration: DURATION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            };

            token.container.ease({
                ...params,
                translation_y: -token.direction * distance,
                onStopped: () => {
                    token.container.destroy();
                    if (this._container === token.container)
                        this._container = null;
                },
            });

            for (const w of windows) {
                const actor = w.get_compositor_private();
                if (!actor)
                    continue;
                this._actors.add(actor);
                // A window closed mid-animation: forget its (dead) actor.
                actor.connectObject('destroy', () => this._actors.delete(actor), this);
                actor.translation_y = token.direction * distance;
                actor.ease({
                    ...params,
                    translation_y: 0,
                    onStopped: () => {
                        if (!this._actors.delete(actor))
                            return; // destroyed or already reset
                        actor.disconnectObject(this);
                        actor.translation_y = 0;
                    },
                });
            }
        } catch (e) {
            console.error(`[activities-layer] switch animation: ${e.message}`);
            this._finish();
        }
    }

    /** Jumps any running animation to its end state. */
    _finish() {
        const actors = [...this._actors];
        this._actors.clear();
        for (const actor of actors) {
            actor.disconnectObject(this);
            actor.remove_transition('translation-y');
            actor.translation_y = 0;
        }
        if (this._container) {
            this._container.remove_all_transitions();
            this._container?.destroy();
            this._container = null;
        }
    }

    destroy() {
        this._finish();
    }
}
