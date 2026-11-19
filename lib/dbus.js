// SPDX-License-Identifier: GPL-2.0-or-later
//
// D-Bus API, exported on GNOME Shell's own session-bus connection, i.e.
//   bus name:    org.gnome.Shell
//   object path: /org/gnome/Shell/Extensions/ActivitiesLayer
//   interface:   org.gnome.Shell.Extensions.ActivitiesLayer
//
// Any process of the user's session can call it (same trust level as the
// session itself; there is no extra authorization).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const BUS_NAME = 'org.gnome.Shell';
export const OBJECT_PATH = '/org/gnome/Shell/Extensions/ActivitiesLayer';
export const INTERFACE = 'org.gnome.Shell.Extensions.ActivitiesLayer';

export const INTERFACE_XML = `
<node>
  <interface name="${INTERFACE}">
    <method name="ListActivities">
      <arg type="as" direction="out" name="names"/>
    </method>
    <method name="GetCurrent">
      <arg type="s" direction="out" name="name"/>
    </method>
    <method name="SwitchActivity">
      <arg type="s" direction="in" name="name"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="CreateActivity">
      <arg type="s" direction="in" name="name"/>
      <arg type="s" direction="out" name="created"/>
    </method>
    <method name="RemoveActivity">
      <arg type="s" direction="in" name="name"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="RenameActivity">
      <arg type="s" direction="in" name="name"/>
      <arg type="s" direction="in" name="new_name"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="MoveActivity">
      <arg type="s" direction="in" name="name"/>
      <arg type="i" direction="in" name="position"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="MoveWindowToActivity">
      <arg type="t" direction="in" name="window_id"/>
      <arg type="s" direction="in" name="name"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="GetState">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="ListWindows">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="ExpectWindow">
      <arg type="s" direction="in" name="activity"/>
      <arg type="s" direction="in" name="match"/>
      <arg type="i" direction="in" name="workspace"/>
      <arg type="u" direction="in" name="count"/>
      <arg type="u" direction="in" name="timeout_ms"/>
      <arg type="u" direction="out" name="claim_id"/>
    </method>
    <method name="GetClaim">
      <arg type="u" direction="in" name="claim_id"/>
      <arg type="s" direction="out" name="json"/>
    </method>
    <signal name="ActivityChanged">
      <arg type="s" name="current"/>
      <arg type="s" name="previous"/>
    </signal>
    <signal name="ActivitiesChanged"/>
  </interface>
</node>`;

function invalidArgs(message) {
    return new GLib.Error(Gio.DBusError, Gio.DBusError.INVALID_ARGS, message);
}

function failed(message) {
    return new GLib.Error(Gio.DBusError, Gio.DBusError.FAILED, message);
}

export class ActivitiesDBus {
    /**
     * @param {import('./manager.js').ActivityManager} manager
     */
    constructor(manager) {
        this._manager = manager;
        this._impl = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._impl.export(Gio.DBus.session, OBJECT_PATH);

        manager.connectObject(
            'current-changed', (_m, current, previous) => {
                this._impl.emit_signal('ActivityChanged',
                    new GLib.Variant('(ss)', [current.name, previous?.name ?? '']));
            },
            'activities-changed', () => this._impl.emit_signal('ActivitiesChanged', null),
            this);
    }

    destroy() {
        this._manager.disconnectObject(this);
        this._impl.unexport();
        this._impl = null;
        this._manager = null;
    }

    _activity(name) {
        const activity = this._manager.findByName(name);
        if (!activity)
            throw invalidArgs(`No Activity named "${name}"`);
        return activity;
    }

    _wrap(fn) {
        try {
            return fn();
        } catch (e) {
            if (e instanceof GLib.Error)
                throw e;
            throw failed(e.message);
        }
    }

    // --- methods (names must match the XML) ---

    ListActivities() {
        return this._manager.activities.map(a => a.name);
    }

    GetCurrent() {
        return this._manager.current.name;
    }

    SwitchActivity(name) {
        return this._manager.switchTo(this._activity(name));
    }

    CreateActivity(name) {
        return this._wrap(() => this._manager.createActivity(name).name);
    }

    RemoveActivity(name) {
        const activity = this._activity(name);
        return this._wrap(() => {
            this._manager.removeActivity(activity);
            return true;
        });
    }

    RenameActivity(name, newName) {
        const activity = this._activity(name);
        return this._wrap(() => {
            this._manager.renameActivity(activity, newName);
            return true;
        });
    }

    MoveActivity(name, position) {
        this._manager.moveActivity(this._activity(name), position);
        return true;
    }

    MoveWindowToActivity(windowId, name) {
        const activity = this._activity(name);
        const window = this._manager.findWindowById(windowId);
        if (!window)
            throw invalidArgs(`No managed window with id ${windowId}`);
        return this._manager.moveWindow(window, activity);
    }

    GetState() {
        const m = this._manager;
        return JSON.stringify({
            current: m.current.name,
            activities: m.activities.map(a => ({
                name: a.name,
                current: a === m.current,
                windows: m.windowCount(a),
            })),
        });
    }

    ListWindows() {
        return JSON.stringify(this._manager.describeWindows());
    }

    ExpectWindow(activityName, match, workspace, count, timeoutMs) {
        const activity = this._activity(activityName);
        return this._wrap(() =>
            this._manager.expectWindows(activity, match, workspace, count, timeoutMs));
    }

    GetClaim(id) {
        const claim = this._manager.describeClaim(id);
        if (!claim)
            throw invalidArgs(`Unknown or expired claim ${id}`);
        return JSON.stringify(claim);
    }
}
