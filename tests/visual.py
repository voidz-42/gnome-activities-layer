#!/usr/bin/python3
"""Visual features: Activity icons, hidden top-bar label, vertical switch animation.

Run with:
  AL_FORCE_ANIMATIONS=1 AL_SHOTS=/tmp/shots AL_TEST_SCRIPT=$PWD/tests/visual.py tests/nested.sh
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as t  # noqa: E402

IND = 'Main.panel.statusArea["activities-layer@local"]'


def state():
    return {a['name']: a for a in json.loads(t.api('GetState'))['activities']}


def gsettings(key, value):
    t.shell_eval(f'''(async () => {{
        const {{default: Gio}} = await import('gi://Gio');
        const s = Main.extensionManager.lookup("activities-layer@local");
        const settings = new Gio.Settings({{
            settings_schema: Gio.SettingsSchemaSource.new_from_directory(
                s.path + "/schemas", Gio.SettingsSchemaSource.get_default(), false)
                .lookup("org.gnome.shell.extensions.activities-layer", false)}});
        settings.{value}
    }})()''')
    time.sleep(0.3)


# GNOME opens the Overview at session start; animations are skipped while it
# is visible (by GNOME and by us).
t.shell_eval('Main.overview.hide()')
time.sleep(1)

print('== icons')
t.check(state()['Default']['icon'] == 'view-grid-symbolic', 'default icon')
t.api('CreateActivity', 'Work')
t.check(t.api('SetActivityIcon', 'Work', 'applications-engineering-symbolic') is True, 'SetActivityIcon')
err = t.api_error('SetActivityIcon', 'Work', 'bad name/../x')
t.check(err is not None and 'Invalid icon' in err, 'invalid icon names rejected')
st = state()
t.check(st['Work']['icon'] == 'applications-engineering-symbolic' and st['Work']['custom_icon'],
        'GetState reports the icon')
time.sleep(0.6)
saved = json.load(open(os.path.join(os.environ['XDG_CONFIG_HOME'], 'activities-layer', 'state.json')))
t.check(any(a.get('icon') == 'applications-engineering-symbolic' for a in saved['activities']),
        'icon persisted in state.json')

t.api('SwitchActivity', 'Work')
time.sleep(0.6)
ind = t.shell_eval(f'({{icon: {IND}._icon.icon_name, label: {IND}._label.text, visible: {IND}._label.visible}})')
t.check(ind == {'icon': 'applications-engineering-symbolic', 'label': 'Work', 'visible': True},
        f'indicator shows icon and name ({ind})')
t.screenshot('icon-with-label')

print('== hide label')
gsettings('show-indicator-label', 'set_boolean("show-indicator-label", false)')
vis = t.shell_eval(f'{IND}._label.visible')
t.check(vis is False, 'label hidden when show-indicator-label is false')
t.shell_eval(f'{IND}.menu.open()')
time.sleep(0.5)
t.screenshot('icon-only-and-menu')
items = t.shell_eval(f'{IND}.menu._getMenuItems().filter(i => i._icon).map(i => [i.label.text, i._icon.icon_name])')
t.check(['Work', 'applications-engineering-symbolic'] in items, f'menu items have icons ({items})')

print('== icon grid and name switch in the panel menu')
sub = t.shell_eval(f'''(() => {{
    const items = {IND}.menu._getMenuItems();
    const sub = items.find(i => i.label?.text?.startsWith("Icon of"));
    const sw = items.find(i => i.label?.text === "Show Name in Top Bar");
    sub.setSubmenuShown(true);
    return {{sub: sub?.label.text ?? null, switchState: sw?.state ?? null}};
}})()''')
time.sleep(0.5)
t.screenshot('menu-icon-grid')
t.check(sub['sub'] == 'Icon of “Work”', f'"Icon of" submenu present ({sub})')
t.check(sub['switchState'] is False, 'menu switch reflects the hidden label')
t.shell_eval(f'''(() => {{
    const items = {IND}.menu._getMenuItems();
    const sub = items.find(i => i.label?.text?.startsWith("Icon of"));
    const buttons = [];
    const walk = a => {{ if (a.accessible_name === "starred") buttons.push(a); a.get_children().forEach(walk); }};
    walk(sub.menu.actor);
    buttons[0].emit("clicked", 1);
}})()''')
time.sleep(0.5)
t.check(state()['Work']['icon'] == 'starred-symbolic', f'clicking an icon in the menu sets it ({state()["Work"]["icon"]})')
t.check(t.shell_eval(f'{IND}._icon.icon_name') == 'starred-symbolic', 'panel icon updated')
t.shell_eval(f'''(() => {{
    {IND}.menu.open();
    const sw = {IND}.menu._getMenuItems().find(i => i.label?.text === "Show Name in Top Bar");
    sw.toggle();
}})()''')
time.sleep(0.4)
t.check(t.shell_eval(f'{IND}._label.visible') is True, 'menu switch shows the name again')
t.shell_eval(f'{IND}.menu.close()')
t.api('SetActivityIcon', 'Work', 'applications-engineering-symbolic')

print('== vertical animation')
t.check(t.shell_eval("(async () => (await import('gi://St')).default.Settings.get().enable_animations)()"), 'animations enabled (needs AL_FORCE_ANIMATIONS=1)')
t.open_and_wait('org.test.WorkWin', 'WORK')
t.api('SwitchActivity', 'Default')
time.sleep(0.5)
t.open_and_wait('org.test.DefWin', 'DEFAULT')
# Put the Default window on another workspace than Work's, so GNOME would
# normally also play its horizontal workspace slide.
t.shell_eval('''global.get_window_actors().map(a => a.meta_window)
    .find(w => w.get_title() === "DEFAULT").change_workspace_by_index(1, false)''')
t.shell_eval('global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time())')
time.sleep(1.5)
t.shell_eval("(async () => { (await import('gi://St')).default.Settings.get().slow_down_factor = 8; })()")
t.api('SwitchActivity', 'Work')
time.sleep(0.35)
mid = t.shell_eval('''(() => {
    const c = Main.layoutManager.uiGroup.get_children().find(a => a.name === "activities-layer-switch");
    const work = global.get_window_actors().find(a => a.meta_window.get_title() === "WORK");
    return {
        container: !!c,
        clones: c ? c.get_n_children() : 0,
        containerY: c ? c.translation_y : null,
        workY: work.translation_y,
        horizontal: Main.wm._switchInProgress === true,
    };
})()''')
t.screenshot('animation-mid')
t.check(mid['container'] and mid['clones'] == 1, f'old window cloned into the slide container ({mid})')
t.check(mid['containerY'] is not None and mid['containerY'] < 0, 'old Activity slides up when going forward')
t.check(mid['workY'] > 0, 'new window slides in from below')
t.check(not mid['horizontal'], 'GNOME horizontal workspace slide suppressed')
time.sleep(3.5)
after = t.shell_eval('''(() => ({
    container: Main.layoutManager.uiGroup.get_children().some(a => a.name === "activities-layer-switch"),
    ys: global.get_window_actors().map(a => a.translation_y),
}))()''')
t.check(not after['container'] and all(y == 0 for y in after['ys']), f'animation cleaned up ({after})')
t.screenshot('animation-done')

t.api('SwitchActivity', 'Default')   # backwards: direction reversed
time.sleep(0.3)
back = t.shell_eval('''(() => {
    const c = Main.layoutManager.uiGroup.get_children().find(a => a.name === "activities-layer-switch");
    return c ? c.translation_y : null;
})()''')
t.check(back is not None and back > 0, f'going back, the old Activity slides down ({back})')
time.sleep(3.5)

print('== interrupted animation')
t.api('SwitchActivity', 'Work')
time.sleep(0.1)
t.api('SwitchActivity', 'Default')
time.sleep(0.1)
t.api('SwitchActivity', 'Work')
time.sleep(4)
after = t.shell_eval('''(() => ({
    containers: Main.layoutManager.uiGroup.get_children().filter(a => a.name === "activities-layer-switch").length,
    ys: global.get_window_actors().map(a => a.translation_y),
}))()''')
t.check(after['containers'] == 0 and all(y == 0 for y in after['ys']), f'rapid switches leave nothing behind ({after})')

print('== animation "none" and "workspace"')
t.shell_eval("(async () => { (await import('gi://St')).default.Settings.get().slow_down_factor = 1; })()")
gsettings('switch-animation', 'set_string("switch-animation", "none")')
t.api('SwitchActivity', 'Default')
time.sleep(0.05)
none = t.shell_eval('''(() => ({
    container: Main.layoutManager.uiGroup.get_children().some(a => a.name === "activities-layer-switch"),
    horizontal: Main.wm._switchInProgress === true,
}))()''')
t.check(not none['container'] and not none['horizontal'], f'"none": no animation at all ({none})')
gsettings('switch-animation', 'set_string("switch-animation", "workspace")')
# Make sure the switch changes workspace: keep a window on ws 0 in Default
# and leave Default looking at ws 1.
t.open_and_wait('org.test.Keep', 'KEEP')
t.shell_eval('''global.get_window_actors().map(a => a.meta_window)
    .find(w => w.get_title() === "DEFAULT").change_workspace_by_index(1, false)''')
t.shell_eval('global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time())')
time.sleep(1)
t.check(t.active_workspace() == 1 and t.win('WORK')['workspace'] == 0, 'setup: Default on ws 1, Work on ws 0')
t.shell_eval("(async () => { (await import('gi://St')).default.Settings.get().slow_down_factor = 8; })()")
t.api('SwitchActivity', 'Work')
time.sleep(0.05)
ws = t.shell_eval('''(() => ({
    container: Main.layoutManager.uiGroup.get_children().some(a => a.name === "activities-layer-switch"),
    horizontal: Main.wm._switchInProgress === true,
}))()''')
t.check(not ws['container'] and ws['horizontal'], f'"workspace": GNOME slide plays ({ws})')
time.sleep(1)

print('== disable/enable with visuals')
t.gnome_extensions('disable', 'activities-layer@local')
time.sleep(0.5)
patched = t.shell_eval('''(async () => {
    const WA = await import('resource:///org/gnome/shell/ui/workspaceAnimation.js');
    return Object.prototype.hasOwnProperty.call(WA.WorkspaceAnimationController.prototype, 'animateSwitch') &&
        WA.WorkspaceAnimationController.prototype.animateSwitch.toString().includes('manager.switching');
})()''')
t.check(not patched, 'animateSwitch patch removed on disable')
t.gnome_extensions('enable', 'activities-layer@local')
t.wait_for(lambda: t.api_error('GetCurrent') is None, what='re-enabled')
t.check(state()['Work']['icon'] == 'applications-engineering-symbolic', 'icon survives disable/enable')

for p in t.procs:
    p.kill()
print('FAILURES:', t.failures if t.failures else 'none')
sys.exit(1 if t.failures else 0)
