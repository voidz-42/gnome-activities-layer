// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

export class Keybindings {
    /**
     * @param {Gio.Settings} settings
     * @param {import('./manager.js').ActivityManager} manager
     */
    constructor(settings, manager) {
        this._settings = settings;
        this._manager = manager;
        this._names = [];

        this._add('switch-to-next-activity', () => this._switchRelative(1));
        this._add('switch-to-previous-activity', () => this._switchRelative(-1));
        this._add('new-activity', () => this._newActivity());
        this._add('move-window-to-next-activity', (w, sw) => this._moveRelative(w, sw, 1));
        this._add('move-window-to-previous-activity', (w, sw) => this._moveRelative(w, sw, -1));
        for (let i = 1; i <= 9; i++) {
            this._add(`switch-to-activity-${i}`, () => this._switchIndex(i - 1));
            this._add(`move-window-to-activity-${i}`, (w, sw) => this._moveIndex(w, sw, i - 1));
        }
    }

    destroy() {
        for (const name of this._names)
            Main.wm.removeKeybinding(name);
        this._names = [];
    }

    _add(name, handler) {
        // Handler args: (display, window, event, binding). @window is the
        // focused window, if any.
        Main.wm.addKeybinding(name, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES,
            (_display, window) => handler(window, this._settings.get_boolean('follow-moved-window')));
        this._names.push(name);
    }

    _relative(delta) {
        const list = this._manager.activities;
        const index = list.indexOf(this._manager.current);
        return list[(index + delta + list.length) % list.length];
    }

    _switchRelative(delta) {
        this._manager.switchTo(this._relative(delta));
    }

    _switchIndex(index) {
        const target = this._manager.activities[index];
        if (target)
            this._manager.switchTo(target);
    }

    _newActivity() {
        this._manager.switchTo(this._manager.createActivity());
    }

    _move(window, follow, target) {
        window ??= global.display.focus_window;
        if (!window || !target || target === this._manager.current)
            return;
        this._manager.moveWindow(window, target);
        if (follow)
            this._manager.switchTo(target, {focusWindow: window});
    }

    _moveRelative(window, follow, delta) {
        this._move(window, follow, this._relative(delta));
    }

    _moveIndex(window, follow, index) {
        this._move(window, follow, this._manager.activities[index]);
    }
}
