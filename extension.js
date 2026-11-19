// SPDX-License-Identifier: GPL-2.0-or-later
//
// Activities Layer: groups windows and workspaces into Activities.
// See lib/manager.js for how hiding works.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ActivityManager} from './lib/manager.js';
import {ActivitiesDBus} from './lib/dbus.js';
import {Keybindings} from './lib/keybindings.js';
import {ActivitiesIndicator} from './lib/indicator.js';
import {SwitchAnimator} from './lib/animation.js';

export default class ActivitiesLayerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._manager = new ActivityManager(this._settings);
        this._manager.enable();

        this._dbus = new ActivitiesDBus(this._manager);

        this._animator = new SwitchAnimator(this._settings);
        this._manager.setAnimator(this._animator);

        this._injections = new InjectionManager();
        this._patchShell();

        this._manager.connectObject('current-changed',
            (_m, current) => this._showOsd(current), this);

        // UI that must not exist on the lock screen. Hidden windows stay
        // hidden while locked; see "session-modes" in metadata.json.
        this._keybindings = null;
        this._indicator = null;
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._destroyUserUi();

        this._manager.disconnectObject(this);
        this._manager.setAnimator(null);
        this._animator.destroy();
        this._animator = null;

        this._injections.clear();
        this._injections = null;

        this._dbus.destroy();
        this._dbus = null;

        this._manager.destroy();
        this._manager = null;

        this._settings = null;
    }

    _syncSessionMode() {
        if (Main.sessionMode.isLocked || Main.sessionMode.currentMode !== 'user')
            this._destroyUserUi();
        else
            this._createUserUi();
    }

    _createUserUi() {
        if (!this._keybindings)
            this._keybindings = new Keybindings(this._settings, this._manager);
        if (!this._indicator) {
            this._indicator = new ActivitiesIndicator(this._manager, this, this._settings);
            Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'left');
        }
    }

    _destroyUserUi() {
        this._keybindings?.destroy();
        this._keybindings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    /**
     * Almost all window lists in the Shell already skip hidden windows because
     * they are skip-taskbar (see lib/manager.js). The exception is the
     * "switch windows of an application" cycler (Alt+` by default), which
     * lists app.get_windows() without checking skip-taskbar.
     */
    _patchShell() {
        this._injections.overrideMethod(AltTab.GroupCyclerPopup.prototype, '_getWindows',
            original => function () {
                return original.call(this).filter(w => !w.skip_taskbar);
            });

        // GNOME's horizontal workspace slide: during an Activity switch it
        // only plays when the setting asks for it ('workspace'); with the
        // vertical animation or 'none' the workspace change is instant.
        // WindowManager calls this._workspaceAnimation.animateSwitch() at run
        // time (its signal handler itself is bound at construction, so it
        // cannot be patched).
        const manager = this._manager;
        const settings = this._settings;
        this._injections.overrideMethod(WorkspaceAnimation.WorkspaceAnimationController.prototype,
            'animateSwitch', original => function (from, to, direction, onComplete) {
                if (manager.switching && settings.get_string('switch-animation') !== 'workspace') {
                    onComplete();
                    return;
                }
                original.call(this, from, to, direction, onComplete);
            });

        // Workaround for a handler leak in Shell 50's overview Workspace:
        // _doAddWindow() stores a notify::skip-taskbar handler per window in
        // a Map *without* disconnecting a previous one, and nothing removes it
        // when the window leaves the workspace. A skip-taskbar window that is
        // added to the same workspace repeatedly (exactly what stick()/
        // unstick() of hidden windows does) leaks handlers; after the
        // Workspace actor is destroyed they fire on a disposed object
        // ("this._container.layout_manager is null").
        const dropHandler = (workspace, metaWin) => {
            const id = workspace._skipTaskbarSignals?.get(metaWin);
            if (id) {
                metaWin.disconnect(id);
                workspace._skipTaskbarSignals.delete(metaWin);
            }
        };
        this._injections.overrideMethod(Workspace.Workspace.prototype, '_doAddWindow',
            original => function (metaWin) {
                if (!this.containsMetaWindow(metaWin))
                    dropHandler(this, metaWin);
                return original.call(this, metaWin);
            });
        this._injections.overrideMethod(Workspace.Workspace.prototype, '_doRemoveWindow',
            original => function (metaWin) {
                const result = original.call(this, metaWin);
                // Keep the handler only while the window is still ours (it
                // re-adds the clone when skip-taskbar is turned off again).
                if (!this._isMyWindow(metaWin))
                    dropHandler(this, metaWin);
                return result;
            });
    }

    _showOsd(activity) {
        if (!this._settings.get_boolean('show-osd') || Main.sessionMode.isLocked)
            return;
        const icon = Gio.ThemedIcon.new(this._manager.iconOf(activity));
        Main.osdWindowManager.showAll(icon, activity.name, null);
    }
}
