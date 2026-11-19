// SPDX-License-Identifier: GPL-2.0-or-later
//
// Preferences: Activities list (through the extension's D-Bus API, since the
// extension owns that state), shortcuts and behaviour (GSettings).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUS_NAME = 'org.gnome.Shell';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/ActivitiesLayer';
const INTERFACE = 'org.gnome.Shell.Extensions.ActivitiesLayer';

// Symbolic icons shipped with the Adwaita icon theme (checked on Fedora 44).
// Any other themed icon name can be typed in the dialog.
const ICONS = [
    'view-grid-symbolic', 'starred-symbolic', 'user-home-symbolic', 'user-bookmarks-symbolic',
    'folder-symbolic', 'folder-documents-symbolic', 'x-office-document-symbolic',
    'x-office-calendar-symbolic', 'x-office-spreadsheet-symbolic', 'x-office-presentation-symbolic',
    'mail-unread-symbolic', 'accessories-text-editor-symbolic', 'document-edit-symbolic',
    'accessories-dictionary-symbolic', 'help-browser-symbolic', 'web-browser-symbolic',
    'utilities-terminal-symbolic', 'applications-engineering-symbolic', 'applications-science-symbolic',
    'applications-system-symbolic', 'applications-utilities-symbolic', 'computer-symbolic',
    'network-workgroup-symbolic', 'system-users-symbolic', 'avatar-default-symbolic',
    'call-start-symbolic', 'phone-symbolic', 'security-high-symbolic',
    'applications-graphics-symbolic', 'camera-photo-symbolic', 'folder-pictures-symbolic',
    'applications-multimedia-symbolic', 'audio-headphones-symbolic', 'folder-music-symbolic',
    'folder-videos-symbolic', 'media-playback-start-symbolic', 'applications-games-symbolic',
    'input-gaming-symbolic', 'emoji-activities-symbolic', 'emoji-food-symbolic',
    'emoji-nature-symbolic', 'emoji-objects-symbolic', 'emoji-travel-symbolic',
    'emoji-flags-symbolic', 'emoji-people-symbolic', 'weather-clear-symbolic',
    'weather-clear-night-symbolic', 'night-light-symbolic',
];

/** Dialog to pick an Activity icon. onDone('') resets to the default. */
const IconDialog = GObject.registerClass(
class ActivitiesLayerIconDialog extends Adw.Dialog {
    _init(activityName, current, onDone) {
        super._init({title: `Icon for “${activityName}”`, content_width: 460, content_height: 520});
        const view = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const reset = new Gtk.Button({label: 'Default'});
        reset.connect('clicked', () => {
            onDone('');
            this.close();
        });
        header.pack_start(reset);
        view.add_top_bar(header);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 8,
            min_children_per_line: 6,
            homogeneous: true,
            row_spacing: 6,
            column_spacing: 6,
        });
        for (const icon of ICONS) {
            const button = new Gtk.Button({
                child: new Gtk.Image({icon_name: icon, pixel_size: 24}),
                tooltip_text: icon.replace(/-symbolic$/, ''),
                css_classes: icon === current ? ['suggested-action'] : ['flat'],
            });
            button.connect('clicked', () => {
                onDone(icon);
                this.close();
            });
            flow.append(button);
        }
        box.append(new Gtk.ScrolledWindow({
            child: flow,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));

        // Free-form themed icon name, validated against the icon theme.
        const entry = new Adw.EntryRow({
            title: 'Other icon name (e.g. org.gnome.Nautilus-symbolic)',
            show_apply_button: true,
            text: ICONS.includes(current) ? '' : current,
        });
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        entry.connect('apply', () => {
            const name = entry.text.trim();
            if (!name || !theme.has_icon(name)) {
                entry.add_css_class('error');
                return;
            }
            onDone(name);
            this.close();
        });
        entry.connect('changed', () => entry.remove_css_class('error'));
        const list = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
        list.append(entry);
        box.append(list);

        view.set_content(box);
        this.set_child(view);
    }
});

const SHORTCUT_GROUPS = [
    ['Switch Activity', [
        ['switch-to-next-activity', 'Next Activity'],
        ['switch-to-previous-activity', 'Previous Activity'],
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => [`switch-to-activity-${i}`, `Activity ${i}`]),
        ['new-activity', 'New Activity'],
    ]],
    ['Move Focused Window', [
        ['move-window-to-next-activity', 'To Next Activity'],
        ['move-window-to-previous-activity', 'To Previous Activity'],
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => [`move-window-to-activity-${i}`, `To Activity ${i}`]),
    ]],
];

/** Dialog that records one key combination. */
const ShortcutDialog = GObject.registerClass(
class ActivitiesLayerShortcutDialog extends Adw.Dialog {
    _init(title, onDone) {
        super._init({title, content_width: 400, content_height: 220});
        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar());
        view.set_content(new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            description: 'Press the new shortcut, Esc to cancel or Backspace to disable it.',
        }));
        this.set_child(view);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            let mask = state & Gtk.accelerator_get_default_mod_mask();
            mask &= ~Gdk.ModifierType.LOCK_MASK;
            if (mask === 0 && keyval === Gdk.KEY_Escape) {
                this.close();
                return Gdk.EVENT_STOP;
            }
            if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
                onDone([]);
                this.close();
                return Gdk.EVENT_STOP;
            }
            if (!Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;
            onDone([Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask)]);
            this.close();
            return Gdk.EVENT_STOP;
        });
        this.add_controller(controller);
    }
});

function shortcutRow(settings, key, title, window) {
    const row = new Adw.ActionRow({title, activatable: true});
    const label = new Adw.ShortcutLabel({
        disabled_text: 'Disabled',
        valign: Gtk.Align.CENTER,
    });
    const sync = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.add_suffix(label);

    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: 'Reset to default',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset(key));
    row.add_suffix(reset);

    row.connect('activated', () => {
        new ShortcutDialog(title, value => settings.set_strv(key, value)).present(window);
    });
    return row;
}

export default class ActivitiesLayerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);

        window.add(this._activitiesPage(window));
        window.add(this._shortcutsPage(settings, window));
        window.add(this._behaviourPage(settings));
    }

    // ---------------------------------------------------------- Activities

    _activitiesPage(window) {
        const page = new Adw.PreferencesPage({
            title: 'Activities',
            icon_name: 'view-grid-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Activities',
            description: 'The order here is the order of the “Activity 1…9” shortcuts.',
        });
        page.add(group);

        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'New Activity',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        group.set_header_suffix(add);

        let rows = [];
        let proxy = null;

        const call = (method, params) => new Promise((resolve, reject) => {
            proxy.call(method, params, Gio.DBusCallFlags.NONE, -1, null, (p, res) => {
                try {
                    resolve(p.call_finish(res).deep_unpack());
                } catch (e) {
                    reject(e);
                }
            });
        });

        const showError = e => {
            if (e instanceof GLib.Error)
                Gio.DBusError.strip_remote_error(e);
            window.add_toast(new Adw.Toast({title: e.message, timeout: 4}));
        };
        const logError = e => console.error(e);

        const askName = (heading, initial, onAccept) => {
            const dialog = new Adw.AlertDialog({heading, close_response: 'cancel'});
            const entry = new Gtk.Entry({text: initial, activates_default: true});
            dialog.set_extra_child(entry);
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('ok', 'OK');
            dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);
            dialog.set_default_response('ok');
            dialog.connect('response', (_d, response) => {
                if (response === 'ok')
                    onAccept(entry.get_text());
            });
            dialog.present(window);
        };

        const refresh = async () => {
            for (const row of rows)
                group.remove(row);
            rows = [];
            let state;
            try {
                [state] = await call('GetState', null);
                state = JSON.parse(state);
            } catch {
                const row = new Adw.ActionRow({
                    title: 'The extension is not running',
                    subtitle: 'Enable Activities Layer to manage Activities here.',
                });
                group.add(row);
                rows.push(row);
                add.sensitive = false;
                return;
            }
            add.sensitive = true;

            state.activities.forEach((activity, index) => {
                const n = activity.windows;
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(activity.name, -1),
                    subtitle: `${activity.current ? 'Current · ' : ''}${n} window${n === 1 ? '' : 's'}`,
                });
                const button = (icon, tooltip, sensitive, cb) => {
                    const b = new Gtk.Button({
                        icon_name: icon,
                        tooltip_text: tooltip,
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat'],
                        sensitive,
                    });
                    b.connect('clicked', () => cb().catch(showError));
                    row.add_suffix(b);
                };
                const name = new GLib.Variant('s', activity.name);

                const iconButton = new Gtk.Button({
                    child: new Gtk.Image({icon_name: activity.icon, pixel_size: 16}),
                    tooltip_text: 'Change icon',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                iconButton.connect('clicked', () => {
                    new IconDialog(activity.name, activity.custom_icon ? activity.icon : '', icon =>
                        call('SetActivityIcon', new GLib.Variant('(ss)', [activity.name, icon]))
                            .catch(showError)).present(window);
                });
                row.add_prefix(iconButton);
                button('go-up-symbolic', 'Move up', index > 0, () =>
                    call('MoveActivity', new GLib.Variant('(si)', [activity.name, index - 1])));
                button('go-down-symbolic', 'Move down', index < state.activities.length - 1, () =>
                    call('MoveActivity', new GLib.Variant('(si)', [activity.name, index + 1])));
                button('document-edit-symbolic', 'Rename', true, async () => {
                    askName('Rename Activity', activity.name, newName =>
                        call('RenameActivity', new GLib.Variant('(ss)', [activity.name, newName]))
                            .catch(showError));
                });
                button('user-trash-symbolic', 'Remove (its windows move to the current Activity)',
                    state.activities.length > 1, () =>
                        call('RemoveActivity', GLib.Variant.new_tuple([name])));
                if (!activity.current) {
                    row.activatable = true;
                    row.connect('activated', () =>
                        call('SwitchActivity', GLib.Variant.new_tuple([name])).catch(showError));
                }
                group.add(row);
                rows.push(row);
            });
        };

        add.connect('clicked', () => {
            askName('New Activity', '', name =>
                call('CreateActivity', new GLib.Variant('(s)', [name])).catch(showError));
        });

        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            null, BUS_NAME, OBJECT_PATH, INTERFACE, null, (_o, res) => {
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    showError(e);
                    return;
                }
                proxy.connect('g-signal', () => refresh().catch(logError));
                // GNOME Shell restarting its D-Bus name (extension re-enabled).
                proxy.connect('notify::g-name-owner', () => refresh().catch(logError));
                refresh().catch(logError);
            });
        // Window counts change without signals; refresh when shown again.
        page.connect('map', () => proxy && refresh().catch(logError));

        return page;
    }

    // ----------------------------------------------------------- Shortcuts

    _shortcutsPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: 'Shortcuts',
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });
        for (const [title, keys] of SHORTCUT_GROUPS) {
            const group = new Adw.PreferencesGroup({title});
            for (const [key, label] of keys)
                group.add(shortcutRow(settings, key, label, window));
            page.add(group);
        }
        return page;
    }

    // ----------------------------------------------------------- Behaviour

    _behaviourPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Behavior',
            icon_name: 'preferences-system-symbolic',
        });
        const toggle = (group, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(appearance);
        toggle(appearance, 'show-indicator-label', 'Show Activity Name in the Top Bar',
            'When off, only the Activity icon is shown.');
        toggle(appearance, 'show-osd', 'Show Activity Name When Switching');

        const animations = [
            ['vertical', 'Vertical Slide'],
            ['workspace', 'GNOME Workspace Slide'],
            ['none', 'None'],
        ];
        const animationRow = new Adw.ComboRow({
            title: 'Switch Animation',
            subtitle: 'The GNOME slide is horizontal and only plays when the workspace changes.',
            model: Gtk.StringList.new(animations.map(([, label]) => label)),
        });
        const syncAnimation = () => {
            const i = animations.findIndex(([nick]) => nick === settings.get_string('switch-animation'));
            animationRow.selected = Math.max(0, i);
        };
        syncAnimation();
        settings.connect('changed::switch-animation', syncAnimation);
        animationRow.connect('notify::selected', () =>
            settings.set_string('switch-animation', animations[animationRow.selected][0]));
        appearance.add(animationRow);

        const group = new Adw.PreferencesGroup({title: 'Windows'});
        page.add(group);
        toggle(group, 'follow-moved-window', 'Follow Moved Windows',
            'After moving a window with a shortcut, switch to its new Activity.');
        toggle(group, 'switch-on-hidden-window-activation', 'Follow Activated Windows',
            'When a window of another Activity is activated (e.g. from a notification), switch to that Activity.');
        return page;
    }
}
