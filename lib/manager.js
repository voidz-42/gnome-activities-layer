// SPDX-License-Identifier: GPL-2.0-or-later
//
// ActivityManager: the core of the extension.
//
// How windows of inactive Activities are hidden (GNOME Shell 50 / Mutter 50)
// -------------------------------------------------------------------------
// Mutter has no notion of hidden workspaces or window groups, but Mutter 50
// exposes two primitives that do most of the work for us:
//
//  * Meta.Window.inhibit_mapped() / uninhibit_mapped()
//      Unmaps the window without minimizing it. Mutter treats it as "not
//      showing" (meta_window_showing_on_its_workspace() returns FALSE), so it
//      is not painted, cannot receive input and is skipped for default focus.
//      The client is not told it was minimized, so the user's own minimized
//      state is preserved untouched.
//
//  * Meta.Window.hide_from_window_list() / show_in_window_list()
//      Forces MetaWindow:skip-taskbar to TRUE. GNOME Shell already honours
//      skip-taskbar everywhere that matters:
//        - Overview (workspace.js: Workspace._isOverviewWindow and its
//          notify::skip-taskbar handler removes existing clones),
//        - workspace thumbnails (WorkspaceThumbnail._isOverviewWindow),
//        - Alt+Tab / Super+Tab (altTab.js getWindows() filters skip_taskbar),
//        - dash / app grid running state: ShellApp counts only windows that
//          are not skip-taskbar ("interesting_windows"); when an app has no
//          interesting windows left it becomes STOPPED, so it disappears from
//          the dash, loses its running dot, and clicking it launches a new
//          window (in the current Activity) instead of raising a hidden one.
//
// The dynamic-workspace tracker (windowManager.js WorkspaceTracker) counts every
// window that is not on all workspaces, hidden or not. To let it collapse the
// workspaces of the inactive Activity we stick() hidden windows (on all
// workspaces) and remember the workspace index they came from. On restore we
// unstick() and move them back with change_workspace_by_index().
//
// Ordering matters: when showing, we first undo skip-taskbar and the mapped
// inhibition and only then unstick/move the window. Mutter computes the
// visibility lazily (META_QUEUE_CALC_SHOWING runs after our JS returns), so the
// window never flashes on the wrong workspace, while the Overview/thumbnail
// window-added handlers (which run synchronously) already see a showable
// window.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import * as Store from './store.js';

const MANAGED_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
    Meta.WindowType.TOOLBAR,
    Meta.WindowType.MENU,
    Meta.WindowType.SPLASHSCREEN,
]);

// How long a new window with no app id yet is held invisible while a recipe
// claim is pending (Wayland clients send xdg_toplevel.set_app_id right after
// creating the toplevel, normally within a few milliseconds).
const CLASS_WAIT_MS = 1500;
// How long finished/expired claims stay queryable over D-Bus.
const CLAIM_KEEP_MS = 60 * 1000;
const SAVE_DELAY_MS = 300;
const DEFAULT_NAME = 'Default';

/**
 * @typedef {object} Activity
 * @property {string} id stable id (survives renames)
 * @property {string} name unique, user-visible
 * @property {number} activeWorkspace workspace index active when last left
 * @property {Meta.Window|null} focusWindow window focused when last left
 */

/**
 * @typedef {object} WindowInfo
 * @property {string} activityId
 * @property {boolean} hidden we hid it (inhibited + skip-taskbar)
 * @property {boolean} stuck we called stick() on it
 * @property {number} workspace workspace index to restore (-1: none)
 * @property {number} unmanagedId signal handler id
 */

export class ActivityManager extends Signals.EventEmitter {
    /**
     * @param {Gio.Settings} settings
     */
    constructor(settings) {
        super();
        this._settings = settings;

        /** @type {Activity[]} */
        this._activities = [];
        this._currentId = null;

        /** @type {Map<Meta.Window, WindowInfo>} */
        this._windows = new Map();
        /** Windows held invisible until their app id is known. */
        this._holds = new Map();

        this._claims = new Map();
        this._nextClaimId = 1;

        this._switching = 0;
        this._saveId = 0;
        this._focusIdleId = 0;
    }

    // ---------------------------------------------------------------- lifecycle

    enable() {
        this._loadState();
        const session = this._loadSession();

        // Adopt existing windows. Roots first so transients can inherit.
        const windows = global.get_window_actors()
            .map(a => a.get_meta_window())
            .filter(w => this._isManageable(w));
        windows.sort((a, b) => (a.get_transient_for() ? 1 : 0) - (b.get_transient_for() ? 1 : 0));

        Main.wm.blockWorkspaceUpdates();
        try {
            for (const w of windows) {
                const saved = session?.windows?.[String(w.get_id())];
                const parent = this._managedRoot(w);
                let activityId = this._currentId;
                let workspace = -1;
                if (parent)
                    activityId = this._windows.get(parent).activityId;
                else if (saved && this._get(saved.activity))
                    ({activity: activityId, workspace} = saved);
                this._assign(w, activityId, activityId === this._currentId ? -1 : workspace);
            }
            if (session?.activities) {
                for (const a of this._activities)
                    a.activeWorkspace = session.activities[a.id]?.activeWorkspace ?? 0;
            }
        } finally {
            Main.wm.unblockWorkspaceUpdates();
        }

        global.display.connectObject(
            'window-created', (_d, w) => this._onWindowCreated(w),
            this);
    }

    destroy() {
        global.display.disconnectObject(this);

        if (this._focusIdleId) {
            GLib.source_remove(this._focusIdleId);
            this._focusIdleId = 0;
        }

        for (const w of [...this._holds.keys()])
            this._releaseHold(w, 'drop');

        for (const claim of this._claims.values())
            this._clearClaimTimers(claim);
        this._claims.clear();

        // Remember the assignment for the rest of this login session.
        this._saveSession();

        // Undo everything: reveal hidden windows, laying out the workspaces of
        // each inactive Activity after the ones currently in use so that no
        // window ends up stacked on top of another Activity's windows.
        Main.wm.blockWorkspaceUpdates();
        try {
            let base = 0;
            for (const [w, info] of this._windows) {
                if (!info.hidden && !w.is_on_all_workspaces())
                    base = Math.max(base, (w.get_workspace()?.index() ?? 0) + 1);
            }
            for (const activity of this._activities) {
                const roots = this._windowsOf(activity.id)
                    .filter(w => this._windows.get(w).hidden && this._isRoot(w));
                if (roots.length === 0)
                    continue;
                let span = 0;
                for (const w of roots) {
                    const info = this._windows.get(w);
                    if (info.workspace >= 0) {
                        span = Math.max(span, info.workspace + 1);
                        info.workspace += base;
                    }
                }
                this._showWindows(this._windowsOf(activity.id));
                base += span;
            }
        } finally {
            Main.wm.unblockWorkspaceUpdates();
        }

        for (const [w, info] of this._windows) {
            w.disconnect(info.unmanagedId);
            w.disconnect(info.userTimeId);
        }
        this._windows.clear();

        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._saveState();
        }
    }

    // ------------------------------------------------------------ persistence

    _loadState() {
        const data = Store.readJson(Store.stateFile());
        const seen = new Set();
        for (const a of data?.activities ?? []) {
            if (typeof a?.id !== 'string' || typeof a?.name !== 'string')
                continue;
            const name = a.name.trim();
            if (!name || seen.has(name.toLowerCase()))
                continue;
            seen.add(name.toLowerCase());
            this._activities.push(this._newActivity(name, a.id));
        }
        if (this._activities.length === 0)
            this._activities.push(this._newActivity(DEFAULT_NAME));
        this._currentId = this._get(data?.current)?.id ?? this._activities[0].id;
    }

    _scheduleSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._saveState();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveState() {
        Store.writeJson(Store.stateFile(), {
            version: 1,
            current: this._currentId,
            activities: this._activities.map(({id, name}) => ({id, name})),
        });
    }

    _sessionKey() {
        // Window ids are only unique within one compositor instance; the Shell
        // pid identifies it (on Wayland the Shell cannot restart in-session).
        return `${new Gio.Credentials().get_unix_pid()}`;
    }

    _loadSession() {
        const data = Store.readJson(Store.sessionFile());
        if (data?.shell !== this._sessionKey())
            return null;
        return data;
    }

    _saveSession() {
        const windows = {};
        for (const [w, info] of this._windows) {
            if (!this._isRoot(w))
                continue;
            let workspace = info.workspace;
            if (!info.hidden)
                workspace = w.is_on_all_workspaces() ? -1 : (w.get_workspace()?.index() ?? 0);
            windows[String(w.get_id())] = {activity: info.activityId, workspace};
        }
        const activities = {};
        for (const a of this._activities) {
            activities[a.id] = {
                activeWorkspace: a.id === this._currentId
                    ? global.workspace_manager.get_active_workspace_index()
                    : a.activeWorkspace,
            };
        }
        Store.writeJson(Store.sessionFile(), {shell: this._sessionKey(), windows, activities});
    }

    // ------------------------------------------------------------ activities

    _newActivity(name, id = null) {
        return {
            id: id ?? GLib.uuid_string_random().slice(0, 8),
            name,
            activeWorkspace: 0,
            focusWindow: null,
        };
    }

    /** @returns {Activity[]} */
    get activities() {
        return [...this._activities];
    }

    /** @returns {Activity} */
    get current() {
        return this._get(this._currentId);
    }

    _get(id) {
        return this._activities.find(a => a.id === id) ?? null;
    }

    findByName(name) {
        const n = String(name ?? '').trim().toLowerCase();
        return this._activities.find(a => a.name.toLowerCase() === n) ?? null;
    }

    /**
     * Number of top-level windows that belong to @activity.
     *
     * @param {Activity} activity
     */
    windowCount(activity) {
        return this._windowsOf(activity.id).filter(w => this._isRoot(w)).length;
    }

    _uniqueName() {
        for (let i = this._activities.length + 1; ; i++) {
            const name = `Activity ${i}`;
            if (!this.findByName(name))
                return name;
        }
    }

    /**
     * @param {string} [name] empty for an automatic name
     * @returns {Activity}
     */
    createActivity(name) {
        name = String(name ?? '').trim() || this._uniqueName();
        if (this.findByName(name))
            throw new Error(`An Activity named "${name}" already exists`);
        const activity = this._newActivity(name);
        this._activities.push(activity);
        this._scheduleSave();
        this.emit('activities-changed');
        return activity;
    }

    renameActivity(activity, newName) {
        newName = String(newName ?? '').trim();
        if (!newName)
            throw new Error('The name cannot be empty');
        const other = this.findByName(newName);
        if (other && other !== activity)
            throw new Error(`An Activity named "${newName}" already exists`);
        activity.name = newName;
        this._scheduleSave();
        this.emit('activities-changed');
    }

    moveActivity(activity, position) {
        const from = this._activities.indexOf(activity);
        const to = Math.max(0, Math.min(position, this._activities.length - 1));
        if (from < 0 || from === to)
            return;
        this._activities.splice(from, 1);
        this._activities.splice(to, 0, activity);
        this._scheduleSave();
        this.emit('activities-changed');
    }

    /**
     * Removes @activity. Its windows are moved to the active Activity
     * (nothing is closed). Removing the active one first switches to a
     * neighbour.
     *
     * @param {Activity} activity
     */
    removeActivity(activity) {
        if (this._activities.length <= 1)
            throw new Error('Cannot remove the last Activity');
        const index = this._activities.indexOf(activity);
        if (index < 0)
            return;
        if (activity.id === this._currentId) {
            const neighbour = this._activities[index + 1] ?? this._activities[index - 1];
            this.switchTo(neighbour);
        }

        const windows = this._windowsOf(activity.id);
        for (const w of windows)
            this._windows.get(w).activityId = this._currentId;
        Main.wm.blockWorkspaceUpdates();
        try {
            this._ensureWorkspacesFor(windows);
            this._showWindows(windows);
        } finally {
            Main.wm.unblockWorkspaceUpdates();
        }

        this._activities.splice(this._activities.indexOf(activity), 1);
        for (const claim of this._claims.values()) {
            if (claim.activityId === activity.id)
                claim.activityId = this._currentId;
        }
        this._scheduleSave();
        this.emit('activities-changed');
    }

    /**
     * Makes @target the active Activity.
     *
     * @param {Activity} target
     * @param {object} [params]
     * @param {Meta.Window} [params.focusWindow] window to focus afterwards
     * @returns {boolean}
     */
    switchTo(target, {focusWindow = null} = {}) {
        if (!target || !this._get(target.id))
            return false;
        const time = global.get_current_time();
        if (target.id === this._currentId) {
            if (focusWindow)
                Main.activateWindow(focusWindow, time);
            return true;
        }

        const previous = this.current;
        const wm = global.workspace_manager;

        this._switching++;
        Main.wm.blockWorkspaceUpdates();
        try {
            previous.activeWorkspace = wm.get_active_workspace_index();
            const focused = global.display.focus_window;
            previous.focusWindow = focused && this._activityIdOf(focused) === previous.id
                ? focused : null;

            this._hideWindows(this._windowsOf(previous.id));
            this._currentId = target.id;

            // Windows the user put on all workspaces are global: they follow
            // the active Activity (and belong to it if later unstuck).
            for (const [w, info] of this._windows) {
                if (!info.hidden && info.activityId !== target.id)
                    info.activityId = target.id;
            }

            const windows = this._windowsOf(target.id);
            this._ensureWorkspaces(target.activeWorkspace + 1);
            this._ensureWorkspacesFor(windows);
            this._showWindows(windows);

            let focus = focusWindow ?? target.focusWindow;
            if (focus && (!this._windows.has(focus) || this._activityIdOf(focus) !== target.id ||
                focus.minimized))
                focus = null;
            let index = Math.min(target.activeWorkspace, wm.n_workspaces - 1);
            if (focus && !focus.is_on_all_workspaces())
                index = focus.get_workspace().index();
            const workspace = wm.get_workspace_by_index(index);
            if (focus)
                workspace.activate_with_focus(focus, time);
            else if (!workspace.active)
                workspace.activate(time);
            else
                global.display.focus_default_window(time);
        } finally {
            Main.wm.unblockWorkspaceUpdates();
            this._switching--;
        }

        this._scheduleSave();
        this.emit('current-changed', target, previous);
        return true;
    }

    /**
     * Moves @window (and its transients) to @target.
     *
     * @param {Meta.Window} window
     * @param {Activity} target
     * @returns {boolean}
     */
    moveWindow(window, target) {
        const root = this._managedRoot(window) ?? window;
        const info = this._windows.get(root);
        if (!info || !target || !this._get(target.id))
            return false;
        if (info.activityId === target.id && !(target.id === this._currentId && info.hidden))
            return true;

        const group = [...this._windows.keys()]
            .filter(w => w === root || this._managedRoot(w) === root);

        Main.wm.blockWorkspaceUpdates();
        try {
            if (target.id === this._currentId) {
                for (const w of group)
                    this._windows.get(w).activityId = target.id;
                if (info.hidden) {
                    // Bring it to the workspace the user is looking at.
                    info.workspace = info.workspace < 0
                        ? -1 : global.workspace_manager.get_active_workspace_index();
                    this._showWindows(group);
                }
            } else {
                if (!info.hidden) {
                    if (this._isUserSticky(root))
                        root.unstick();
                    this._hideWindows(group);
                }
                for (const w of group)
                    this._windows.get(w).activityId = target.id;
                // Keep it within the target's current set of workspaces.
                if (info.workspace >= 0) {
                    const span = this._workspaceSpan(target.id, root);
                    info.workspace = Math.min(info.workspace, span);
                }
            }
        } finally {
            Main.wm.unblockWorkspaceUpdates();
        }
        this.emit('windows-changed');
        return true;
    }

    // --------------------------------------------------------------- windows

    _isManageable(w) {
        return w && !w.is_override_redirect() && MANAGED_TYPES.has(w.get_window_type());
    }

    _isRoot(w) {
        return !this._managedRoot(w);
    }

    /** Topmost managed ancestor of @w other than itself, or null. */
    _managedRoot(w) {
        const root = w.find_root_ancestor();
        return root && root !== w && this._windows.has(root) ? root : null;
    }

    _activityIdOf(w) {
        const root = this._managedRoot(w) ?? w;
        return this._windows.get(root)?.activityId ?? null;
    }

    _windowsOf(activityId) {
        return [...this._windows].filter(([, i]) => i.activityId === activityId).map(([w]) => w);
    }

    /**
     * A window the user made visible on all workspaces ("Always on Visible
     * Workspace"). With workspaces-only-on-primary, windows on secondary
     * monitors are also on all workspaces; those are not user-sticky.
     *
     * @param {Meta.Window} w
     */
    _isUserSticky(w) {
        if (!w.is_on_all_workspaces() || w.is_always_on_all_workspaces())
            return false;
        if (Meta.prefs_get_workspaces_only_on_primary() && !w.is_on_primary_monitor())
            return false;
        return true;
    }

    _workspaceSpan(activityId, except) {
        let span = 0;
        for (const w of this._windowsOf(activityId)) {
            const info = this._windows.get(w);
            if (w !== except && info.hidden && info.workspace >= 0)
                span = Math.max(span, info.workspace + 1);
        }
        return span;
    }

    _ensureWorkspaces(n) {
        const wm = global.workspace_manager;
        while (wm.n_workspaces < n)
            wm.append_new_workspace(false, global.get_current_time());
    }

    _ensureWorkspacesFor(windows) {
        let n = 0;
        for (const w of windows) {
            const info = this._windows.get(w);
            if (info?.hidden && info.workspace >= 0)
                n = Math.max(n, info.workspace + 1);
        }
        this._ensureWorkspaces(n);
    }

    /**
     * Starts tracking @w as part of @activityId.
     *
     * @param {Meta.Window} w
     * @param {string} activityId
     * @param {number} workspace workspace index to place it on, or -1
     */
    _assign(w, activityId, workspace = -1) {
        if (this._windows.has(w))
            return;
        const info = {
            activityId,
            hidden: false,
            stuck: false,
            workspace: -1,
            unmanagedId: w.connect('unmanaged', () => this._forget(w)),
            // meta_window_activate*() bumps the user time even when it cannot
            // focus the window because it is unmapped. ShellApp raising
            // sibling windows does not, so this identifies real activations.
            userTimeId: w.connect('notify::user-time', () => this._onUserTime(w)),
        };
        this._windows.set(w, info);

        if (activityId !== this._currentId) {
            this._hideWindows([w]);
            if (info.stuck && workspace >= 0)
                info.workspace = workspace;
        } else if (workspace >= 0 && this._isRoot(w) && !w.is_on_all_workspaces()) {
            this._ensureWorkspaces(workspace + 1);
            w.change_workspace_by_index(workspace, false);
        }
        this.emit('windows-changed');
    }

    _forget(w) {
        const info = this._windows.get(w);
        if (!info)
            return;
        w.disconnect(info.unmanagedId);
        w.disconnect(info.userTimeId);
        this._windows.delete(w);
        for (const a of this._activities) {
            if (a.focusWindow === w)
                a.focusWindow = null;
        }
        this.emit('windows-changed');
    }

    _hideWindows(windows) {
        // Decide everything before touching any window: stick() propagates to
        // transients, which would otherwise look user-sticky afterwards.
        const plan = [];
        for (const w of windows) {
            const info = this._windows.get(w);
            if (!info || info.hidden)
                continue;
            const root = this._managedRoot(w) ?? w;
            if (this._isUserSticky(root))
                continue; // global window, never hidden
            const isRoot = root === w;
            const workspace = isRoot && !w.is_on_all_workspaces()
                ? (w.get_workspace()?.index() ?? 0) : -1;
            plan.push({w, info, isRoot, workspace});
        }

        for (const {w, info, isRoot, workspace} of plan) {
            w.inhibit_mapped();
            w.hide_from_window_list();
            info.hidden = true;
            if (isRoot)
                info.workspace = workspace;
        }
        for (const {w, info, isRoot, workspace} of plan) {
            if (isRoot && workspace >= 0) {
                w.stick();
                info.stuck = true;
            }
        }
    }

    _showWindows(windows) {
        const shown = windows.filter(w => this._windows.get(w)?.hidden);

        // 1. Make them showable again (see the header comment for why first).
        for (const w of shown) {
            const info = this._windows.get(w);
            w.show_in_window_list();
            w.uninhibit_mapped();
            info.hidden = false;
        }

        // 2. Put roots back on their workspace (transients follow).
        for (const w of shown) {
            const info = this._windows.get(w);
            if (info.stuck) {
                w.unstick();
                info.stuck = false;
            }
            if (info.workspace >= 0 && !w.is_on_all_workspaces()) {
                this._ensureWorkspaces(info.workspace + 1);
                w.change_workspace_by_index(info.workspace, false);
            }
            info.workspace = -1;
        }
    }

    _onWindowCreated(w) {
        if (!this._isManageable(w))
            return;

        // The Activity active *now*, at creation time.
        const creationActivity = this._currentId;

        const parent = this._managedRoot(w);
        if (parent) {
            this._assign(w, this._windows.get(parent).activityId);
            return;
        }

        if (this._hasPendingClaims()) {
            if (this._windowKeys(w).length === 0) {
                this._holdUntilIdentified(w, creationActivity);
                return;
            }
            const claim = this._takeClaim(w);
            if (claim) {
                this._assign(w, claim.activityId, claim.workspace);
                return;
            }
        }
        this._assign(w, creationActivity);
    }

    /**
     * Wayland toplevels are created before the client sends its app id. When a
     * recipe is waiting for a window we keep the new window unmapped until we
     * know which app it is, so it never flashes in the wrong Activity.
     *
     * @param {Meta.Window} w
     * @param {string} creationActivity
     */
    _holdUntilIdentified(w, creationActivity) {
        w.inhibit_mapped();
        const hold = {
            creationActivity,
            timeoutId: GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLASS_WAIT_MS, () => {
                hold.timeoutId = 0;
                this._releaseHold(w, 'assign');
                return GLib.SOURCE_REMOVE;
            }),
        };
        w.connectObject(
            'notify::wm-class', () => this._releaseHold(w, 'assign'),
            'notify::gtk-application-id', () => this._releaseHold(w, 'assign'),
            'unmanaged', () => this._releaseHold(w, 'gone'),
            hold);
        this._holds.set(w, hold);
    }

    /**
     * @param {Meta.Window} w
     * @param {string} how 'assign' (decide its Activity), 'gone' (window is
     *   being unmanaged) or 'drop' (extension is being disabled)
     */
    _releaseHold(w, how) {
        const hold = this._holds.get(w);
        if (!hold)
            return;
        this._holds.delete(w);
        w.disconnectObject(hold);
        if (hold.timeoutId)
            GLib.source_remove(hold.timeoutId);
        if (how === 'gone')
            return;
        if (how === 'drop') {
            w.uninhibit_mapped();
            return;
        }
        const claim = this._takeClaim(w);
        const activityId = claim?.activityId ??
            (this._get(hold.creationActivity) ? hold.creationActivity : this._currentId);
        // Assign (which may inhibit again) before dropping our own inhibition
        // so the window is never mapped in between.
        this._assign(w, activityId, claim?.workspace ?? -1);
        w.uninhibit_mapped();
    }

    /**
     * A hidden window was activated: by a notification, by the app itself
     * through xdg-activation, by the D-Bus API... Like GNOME does for windows
     * on other workspaces, follow it to its Activity.
     *
     * @param {Meta.Window} w
     */
    _onUserTime(w) {
        if (this._switching || this._focusIdleId)
            return;
        const root = this._managedRoot(w) ?? w;
        const info = this._windows.get(root);
        if (!info?.hidden || !this._settings.get_boolean('switch-on-hidden-window-activation'))
            return;
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            const activity = this._get(this._windows.get(root)?.activityId);
            if (this._windows.get(root)?.hidden && activity)
                this.switchTo(activity, {focusWindow: w});
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * @returns {object[]} plain description of all managed top-level windows
     */
    describeWindows() {
        const tracker = Shell.WindowTracker.get_default();
        const result = [];
        for (const [w, info] of this._windows) {
            if (!this._isRoot(w))
                continue;
            let workspace = info.workspace;
            if (!info.hidden)
                workspace = w.is_on_all_workspaces() ? -1 : (w.get_workspace()?.index() ?? -1);
            result.push({
                id: w.get_id(),
                title: w.get_title() ?? '',
                wm_class: w.get_wm_class() ?? '',
                app_id: tracker.get_window_app(w)?.get_id() ?? '',
                activity: this._get(info.activityId)?.name ?? '',
                workspace,
                hidden: info.hidden,
                sticky: !info.hidden && this._isUserSticky(w),
                minimized: w.minimized,
            });
        }
        return result;
    }

    findWindowById(id) {
        for (const w of this._windows.keys()) {
            if (String(w.get_id()) === String(id))
                return w;
        }
        return null;
    }

    // ------------------------------------------------- claims (for recipes)
    //
    // A recipe launches an app and wants its next window to land in a given
    // Activity even if the user switches Activity while the app starts, and
    // even when the launched process just forwards the request to an already
    // running instance (Firefox, VS Code...), so the pid is useless. The CLI
    // therefore registers a claim *before* launching: "the next N windows whose
    // app id / WM_CLASS matches X belong to Activity A, workspace W". Claims
    // are checked at window creation and win over the active Activity.

    /**
     * @param {Activity} activity
     * @param {string} match case-insensitive substring of wm_class/app id
     * @param {number} workspace target workspace index or -1
     * @param {number} count number of windows to claim
     * @param {number} timeoutMs
     * @returns {number} claim id
     */
    expectWindows(activity, match, workspace, count, timeoutMs) {
        match = String(match ?? '').trim().toLowerCase();
        if (match.length < 2)
            throw new Error('The match string must have at least 2 characters');
        const claim = {
            id: this._nextClaimId++,
            activityId: activity.id,
            match,
            workspace: Math.max(-1, workspace | 0),
            remaining: Math.max(1, count | 0),
            matched: [],
            expired: false,
            timeoutId: 0,
            cleanupId: 0,
        };
        claim.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            Math.max(1000, Math.min(timeoutMs | 0, 10 * 60 * 1000)), () => {
                claim.timeoutId = 0;
                claim.expired = claim.remaining > 0;
                claim.remaining = 0;
                this._scheduleClaimCleanup(claim);
                return GLib.SOURCE_REMOVE;
            });
        this._claims.set(claim.id, claim);
        return claim.id;
    }

    describeClaim(id) {
        const claim = this._claims.get(id);
        if (!claim)
            return null;
        return {
            id: claim.id,
            activity: this._get(claim.activityId)?.name ?? '',
            match: claim.match,
            matched: [...claim.matched],
            remaining: claim.remaining,
            expired: claim.expired,
            done: claim.remaining === 0,
        };
    }

    _hasPendingClaims() {
        for (const c of this._claims.values()) {
            if (c.remaining > 0)
                return true;
        }
        return false;
    }

    _windowKeys(w) {
        const keys = [
            w.get_wm_class(),
            w.get_wm_class_instance(),
            w.get_gtk_application_id(),
            w.get_sandboxed_app_id(),
        ];
        return keys.filter(k => k).map(k => k.toLowerCase());
    }

    _takeClaim(w) {
        const keys = this._windowKeys(w);
        const app = Shell.WindowTracker.get_default().get_window_app(w);
        if (app && !app.is_window_backed())
            keys.push(app.get_id().toLowerCase().replace(/\.desktop$/, ''));
        for (const claim of this._claims.values()) {
            if (claim.remaining <= 0 || !keys.some(k => k.includes(claim.match)))
                continue;
            claim.remaining--;
            claim.matched.push(w.get_id());
            if (!this._get(claim.activityId))
                claim.activityId = this._currentId;
            if (claim.remaining === 0) {
                if (claim.timeoutId)
                    GLib.source_remove(claim.timeoutId);
                claim.timeoutId = 0;
                this._scheduleClaimCleanup(claim);
            }
            return claim;
        }
        return null;
    }

    _scheduleClaimCleanup(claim) {
        claim.cleanupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLAIM_KEEP_MS, () => {
            claim.cleanupId = 0;
            this._claims.delete(claim.id);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearClaimTimers(claim) {
        if (claim.timeoutId)
            GLib.source_remove(claim.timeoutId);
        if (claim.cleanupId)
            GLib.source_remove(claim.cleanupId);
        claim.timeoutId = claim.cleanupId = 0;
    }
}
