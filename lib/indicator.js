// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/** Small dialog asking for an Activity name. */
const NameDialog = GObject.registerClass(
class ActivitiesLayerNameDialog extends ModalDialog.ModalDialog {
    _init(title, initialText, onAccept) {
        super._init({styleClass: 'activities-layer-dialog'});
        this._onAccept = onAccept;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'activities-layer-dialog-content',
        });
        box.add_child(new St.Label({text: title, style_class: 'activities-layer-dialog-title'}));
        this._entry = new St.Entry({
            text: initialText,
            hint_text: 'Activity name',
            can_focus: true,
            style_class: 'activities-layer-dialog-entry',
        });
        this._entry.clutter_text.connect('activate', () => this._accept());
        box.add_child(this._entry);
        this._error = new St.Label({style_class: 'activities-layer-dialog-error', visible: false});
        box.add_child(this._error);
        this.contentLayout.add_child(box);

        this.addButton({label: 'Cancel', action: () => this.close(), key: Clutter.KEY_Escape});
        this.addButton({label: 'OK', action: () => this._accept(), default: true});
        this.setInitialKeyFocus(this._entry.clutter_text);
        this._entry.clutter_text.set_selection(0, -1);
    }

    _accept() {
        try {
            this._onAccept(this._entry.get_text());
            this.close();
        } catch (e) {
            this._error.text = e.message;
            this._error.show();
        }
    }
});

export const ActivitiesIndicator = GObject.registerClass(
class ActivitiesLayerIndicator extends PanelMenu.Button {
    /**
     * @param {import('./manager.js').ActivityManager} manager
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
     * @param {Gio.Settings} settings
     */
    _init(manager, extension, settings) {
        super._init(0.0, 'Activities Layer');
        this._manager = manager;
        this._extension = extension;
        this._dialog = null;
        this._targetWindow = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        box.add_child(this._icon);
        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'activities-layer-label',
        });
        box.add_child(this._label);
        this.add_child(box);
        settings.bind('show-indicator-label', this._label, 'visible', Gio.SettingsBindFlags.GET);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                // Remember which window had focus before the menu took it.
                this._targetWindow = global.display.focus_window;
                this._rebuildMenu();
            }
        });
        manager.connectObject(
            'current-changed', () => this._sync(),
            'activities-changed', () => this._sync(),
            this);
        this._sync();
        this._rebuildMenu();
    }

    _onDestroy() {
        this._manager.disconnectObject(this);
        this._dialog?.close();
        this._dialog = null;
        super._onDestroy();
    }

    _sync() {
        const current = this._manager.current;
        this._label.text = current.name;
        this._icon.icon_name = this._manager.iconOf(current);
        // With the label hidden the name is still available to screen readers.
        this.accessible_name = `Activity: ${current.name}`;
        if (this.menu.isOpen)
            this._rebuildMenu();
    }

    _rebuildMenu() {
        const manager = this._manager;
        const current = manager.current;
        this.menu.removeAll();

        for (const activity of manager.activities) {
            const item = new PopupMenu.PopupImageMenuItem(activity.name,
                manager.iconOf(activity));
            item.setOrnament(activity === current
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            const count = manager.windowCount(activity);
            item.add_child(new St.Label({
                text: count ? String(count) : '',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                style_class: 'activities-layer-count',
            }));
            item.connect('activate', () => manager.switchTo(activity));
            this.menu.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction('New Activity…', () => {
            this._askName('New Activity', '', name =>
                manager.switchTo(manager.createActivity(name)));
        });
        this.menu.addAction('Rename Current Activity…', () => {
            this._askName('Rename Activity', current.name, name =>
                manager.renameActivity(current, name));
        });
        const remove = this.menu.addAction(`Remove “${current.name}”`,
            () => manager.removeActivity(current));
        remove.setSensitive(manager.activities.length > 1);

        const window = this._targetWindow;
        const others = manager.activities.filter(a => a !== current);
        if (window && others.length > 0 && manager.findWindowById(window.get_id())) {
            const sub = new PopupMenu.PopupSubMenuMenuItem('Move Focused Window To');
            for (const activity of others) {
                sub.menu.addAction(activity.name, () => {
                    if (!window.get_compositor_private())
                        return; // closed meanwhile
                    manager.moveWindow(window, activity);
                });
            }
            this.menu.addMenuItem(sub);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Activities Settings', () => this._extension.openPreferences());
    }

    _askName(title, initial, onAccept) {
        this._dialog?.close();
        this._dialog = new NameDialog(title, initial, onAccept);
        this._dialog.connect('closed', () => {
            this._dialog = null;
        });
        this._dialog.open();
    }
});
