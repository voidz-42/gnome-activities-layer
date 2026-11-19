#!/usr/bin/python3
"""Automated tests, run by tests/nested.sh inside an isolated headless shell.

Talks to the extension over its D-Bus API and inspects the Shell through
org.gnome.Shell.Eval (enabled only in the test environment by the helper
extension) to verify what the user would see: Overview, Alt+Tab, dash and
the workspace count.
"""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import time

IFACE = 'org.gnome.Shell.Extensions.ActivitiesLayer'
PATH = '/org/gnome/Shell/Extensions/ActivitiesLayer'
REPO = os.environ['AL_REPO']
TESTWIN = os.path.join(REPO, 'tests', 'testwin.py')

# Reuse the GVariant text parser of the CLI (bin/activity has no .py suffix).
_loader = importlib.machinery.SourceFileLoader('activity_cli', os.path.join(REPO, 'bin', 'activity'))
_spec = importlib.util.spec_from_loader('activity_cli', _loader)
cli = importlib.util.module_from_spec(_spec)
_loader.exec_module(cli)

failures = []
procs = []


def gdbus(dest, path, method, *args):
    out = subprocess.run(
        ['gdbus', 'call', '--session', '--dest', dest, '--object-path', path,
         '--method', method, '--', *[str(a) for a in args]],
        capture_output=True, text=True, timeout=20)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip())
    return cli.parse_gvariant(out.stdout.strip())


def api(method, *args):
    return gdbus('org.gnome.Shell', PATH, f'{IFACE}.{method}', *args)[0]


def api_error(method, *args):
    try:
        api(method, *args)
    except RuntimeError as e:
        return str(e)
    return None


def shell_eval(code):
    ok, result = gdbus('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Eval', code)
    if not ok:
        raise RuntimeError(f'Eval failed: {result}\n{code}')
    return json.loads(result) if result else None


def windows():
    return json.loads(api('ListWindows'))


def win(title):
    for w in windows():
        if w['title'] == title:
            return w
    return None


def wait_for(pred, timeout=10.0, what='condition'):
    end = time.time() + timeout
    while time.time() < end:
        value = pred()
        if value:
            return value
        time.sleep(0.1)
    raise TimeoutError(f'timed out waiting for {what}')


def open_window(app_id, title, delay=0):
    procs.append(subprocess.Popen(
        [sys.executable, '-I', TESTWIN, app_id, title, str(delay)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))


def open_and_wait(app_id, title):
    open_window(app_id, title)
    return wait_for(lambda: win(title), what=f'window {title}')


def check(cond, message):
    print(('  ok   ' if cond else '  FAIL ') + message)
    if not cond:
        failures.append(message)


# --- what the user can see -------------------------------------------------

def n_workspaces():
    return shell_eval('global.workspace_manager.n_workspaces')


def active_workspace():
    return shell_eval('global.workspace_manager.get_active_workspace_index()')


def visible_on_screen():
    """Titles of windows Mutter currently shows (mapped, on the active ws)."""
    return set(shell_eval('''
        global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w => w.showing_on_its_workspace() &&
                         w.located_on_workspace(global.workspace_manager.get_active_workspace()))
            .map(w => w.get_title())'''))


def alt_tab():
    """Titles in the Alt+Tab (window switcher) and app ids in Super+Tab."""
    return shell_eval('''
        (async () => {
            const AltTab = await import('resource:///org/gnome/shell/ui/altTab.js');
            const wp = new AltTab.WindowSwitcherPopup();
            const titles = wp._items.map(i => i.window.get_title());
            wp.destroy();
            const ap = new AltTab.AppSwitcherPopup();
            const apps = ap._items.map(i => i.app.get_id());
            const appWindows = ap._items.flatMap(i => i.cachedWindows.map(w => w.get_title()));
            ap.destroy();
            return {titles, apps, appWindows};
        })()''')


def overview():
    """Window titles shown as previews/thumbnails in the Overview."""
    shell_eval('Main.overview.show()')
    time.sleep(1.2)
    result = shell_eval('''
        (async () => {
            const {WindowPreview} = await import('resource:///org/gnome/shell/ui/windowPreview.js');
            const Thumb = await import('resource:///org/gnome/shell/ui/workspaceThumbnail.js');
            const previews = [], thumbs = [];
            const walk = actor => {
                if (actor instanceof WindowPreview)
                    previews.push(actor.metaWindow.get_title());
                if (actor instanceof Thumb.WorkspaceThumbnail)
                    thumbs.push(...actor._windows.map(c => c.metaWindow.get_title()));
                for (const c of actor.get_children())
                    walk(c);
            };
            walk(Main.layoutManager.overviewGroup);
            return {previews, thumbs};
        })()''')
    shell_eval('Main.overview.hide()')
    time.sleep(0.8)
    return result


def dash_running():
    """Titles of the windows of the apps the dash considers running."""
    return set(shell_eval('''
        Shell.AppSystem.get_default().get_running()
            .flatMap(a => a.get_windows().filter(w => !w.skip_taskbar).map(w => w.get_title()))'''))


def press(*keys):
    """Presses a key combination with a virtual keyboard (keysym names)."""
    names = ', '.join(f'"{k}"' for k in keys)
    shell_eval(f'''(async () => {{
        const {{default: Clutter}} = await import('gi://Clutter');
        const {{default: GLib}} = await import('gi://GLib');
        const seat = Clutter.get_default_backend().get_default_seat();
        globalThis._alKbd ??= seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const dev = globalThis._alKbd;
        const keys = [{names}].map(n => Clutter[`KEY_${{n}}`]);
        for (const k of keys)
            dev.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.PRESSED);
        for (const k of keys.reverse())
            dev.notify_keyval(GLib.get_monotonic_time(), k, Clutter.KeyState.RELEASED);
    }})()''')
    time.sleep(0.6)


def screenshot(name):
    """Saves a screenshot to $AL_SHOTS/<name>.png when AL_SHOTS is set."""
    folder = os.environ.get('AL_SHOTS')
    if not folder:
        return
    os.makedirs(folder, exist_ok=True)
    gdbus('org.gnome.Shell', '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot.Screenshot',
          'false', 'false', os.path.join(folder, f'{name}.png'))


def gnome_extensions(*args):
    subprocess.run(['gnome-extensions', *args], check=True, capture_output=True)


# --- tests --------------------------------------------------------------------

def main():
    print('== 0. extension metadata')
    info = subprocess.run(['gnome-extensions', 'info', 'activities-layer@local'],
                          capture_output=True, text=True).stdout
    print('    ' + info.strip().replace('\n', '\n    '))
    check('ACTIVE' in info, 'gnome-extensions info reports the extension as active')

    print('== 1. basic state')
    check(api('ListActivities') == ['Default'], 'starts with a single "Default" Activity')
    check(api('GetCurrent') == 'Default', 'Default is current')

    print('== 2. windows and switching')
    open_and_wait('org.test.Alpha', 'A1')
    open_and_wait('org.test.Beta', 'B-default')
    check(win('A1')['activity'] == 'Default', 'new window belongs to the active Activity')

    check(api('CreateActivity', 'Work') == 'Work', 'CreateActivity returns the name')
    err = api_error('CreateActivity', 'work')
    check(err is not None and 'already exists' in err, 'duplicate names are rejected (case-insensitive)')
    check(api('SwitchActivity', 'Work') is True, 'SwitchActivity(Work)')
    time.sleep(0.5)
    check(api('GetCurrent') == 'Work', 'Work is current')
    check(win('A1')['hidden'] and win('B-default')['hidden'], 'Default windows are hidden')
    # GNOME keeps at least 2 workspaces (MIN_NUM_WORKSPACES): the empty
    # active one and the trailing empty one.
    check(n_workspaces() == 2, f'new Activity starts empty, GNOME minimum of 2 workspaces (got {n_workspaces()})')
    check(visible_on_screen() == set(), 'nothing visible on screen in the new Activity')
    alt = alt_tab()
    check(not alt['titles'] and not alt['apps'], f'Alt+Tab/Super+Tab are empty ({alt})')
    ov = overview()
    check(not ov['previews'] and not ov['thumbs'], f'Overview shows nothing ({ov})')
    check(dash_running() == set(), f'hidden apps are not "running" in the dash ({dash_running()})')

    open_and_wait('org.test.Gamma', 'G-work')
    check(win('G-work')['activity'] == 'Work', 'window opened in Work belongs to Work')
    # Put it on a second workspace, like a user would.
    shell_eval('''global.get_window_actors().map(a => a.meta_window)
        .find(w => w.get_title() === "G-work").change_workspace_by_index(1, false)''')
    open_and_wait('org.test.Delta', 'D-work')
    time.sleep(0.5)
    check(n_workspaces() == 3, f'Work uses 2 workspaces + 1 empty (got {n_workspaces()})')
    shell_eval('global.workspace_manager.get_workspace_by_index(1).activate(global.get_current_time())')
    time.sleep(0.5)

    print('== 3. switching back restores the previous layout')
    api('SwitchActivity', 'Default')
    time.sleep(0.6)
    check(not win('A1')['hidden'] and not win('B-default')['hidden'], 'Default windows are back')
    check(win('G-work')['hidden'] and win('D-work')['hidden'], 'Work windows are hidden')
    check(n_workspaces() == 2, f'Default has 1 workspace + 1 empty (got {n_workspaces()})')
    check(visible_on_screen() == {'A1', 'B-default'}, f'visible: {visible_on_screen()}')
    alt = alt_tab()
    check(set(alt['titles']) == {'A1', 'B-default'}, f'Alt+Tab lists only Default windows ({alt["titles"]})')
    check(set(alt['appWindows']) == {'A1', 'B-default'},
          f'Super+Tab lists only Default apps/windows ({alt["appWindows"]})')
    ov = overview()
    check(set(ov['previews']) == {'A1', 'B-default'}, f'Overview previews: {ov["previews"]}')
    check(set(ov['thumbs']) <= {'A1', 'B-default'}, f'Overview thumbnails: {ov["thumbs"]}')
    running = dash_running()
    check(running == {'A1', 'B-default'}, f'dash running apps cover only Default windows: {running}')

    api('SwitchActivity', 'Work')
    time.sleep(0.6)
    check(win('G-work')['workspace'] == 1 and win('D-work')['workspace'] == 0,
          f'Work windows are back on their workspaces ({win("G-work")["workspace"]}, {win("D-work")["workspace"]})')
    check(active_workspace() == 1, f'Work active workspace restored (got {active_workspace()})')
    check(n_workspaces() == 3, f'Work again has 3 workspaces (got {n_workspaces()})')
    ov = overview()
    check(set(ov['previews']) <= {'G-work', 'D-work'} and 'G-work' in ov['previews'],
          f'Overview after returning: {ov["previews"]}')
    check(set(ov['thumbs']) == {'G-work', 'D-work'}, f'thumbnails after returning: {ov["thumbs"]}')

    print('== 4. moving windows between Activities')
    d = win('D-work')
    check(api('MoveWindowToActivity', f'uint64 {d["id"]}', 'Default') is True, 'MoveWindowToActivity')
    time.sleep(0.3)
    check(win('D-work')['activity'] == 'Default' and win('D-work')['hidden'], 'moved window is hidden')
    api('SwitchActivity', 'Default')
    time.sleep(0.5)
    check(not win('D-work')['hidden'], 'moved window appears in its new Activity')
    a1 = win('A1')
    api('MoveWindowToActivity', f'uint64 {a1["id"]}', 'Work')
    time.sleep(0.3)
    check(win('A1')['hidden'] and win('A1')['activity'] == 'Work', 'A1 moved away from the current Activity')

    print('== 5. recipe claims (window lands in the target Activity)')
    # The app takes 1.5 s to open its window; the user switches meanwhile.
    claim = api('ExpectWindow', 'Work', 'org.test.epsilon', 0, 'uint32 1', 'uint32 15000')
    open_window('org.test.Epsilon', 'E-claimed', delay=1.5)
    time.sleep(0.2)
    api('SwitchActivity', 'Default')
    wait_for(lambda: win('E-claimed'), what='claimed window')
    time.sleep(0.3)
    check(win('E-claimed')['activity'] == 'Work', 'claimed window belongs to Work although Default was active')
    check(win('E-claimed')['hidden'], 'claimed window is hidden (never shown in Default)')
    info = json.loads(api('GetClaim', f'uint32 {claim}'))
    check(info['done'] and not info['expired'] and len(info['matched']) == 1, f'claim status: {info}')

    # Process reuse: org.test.Alpha already runs (A1); the second invocation
    # forwards to it and exits, so the window comes from another pid.
    claim = api('ExpectWindow', 'Work', 'org.test.alpha', 0, 'uint32 1', 'uint32 15000')
    open_window('org.test.Alpha', 'A2-reused')
    wait_for(lambda: win('A2-reused'), what='reused-process window')
    time.sleep(0.3)
    check(win('A2-reused')['activity'] == 'Work', 'window of a reused process goes to the claimed Activity')
    open_and_wait('org.test.Alpha', 'A3-unclaimed')
    check(win('A3-unclaimed')['activity'] == 'Default', 'without a claim it goes to the active Activity')

    print('== 6. following a hidden window when it is activated')
    shell_eval('''Main.activateWindow(global.get_window_actors().map(a => a.meta_window)
        .find(w => w.get_title() === "G-work"))''')
    time.sleep(0.8)
    check(api('GetCurrent') == 'Work', 'activating a hidden window switches to its Activity')
    check(not win('G-work')['hidden'], 'and the window is shown')

    print('== 7. removing an Activity keeps its windows')
    api('CreateActivity', 'Study')
    s = win('B-default')
    api('MoveWindowToActivity', f'uint64 {s["id"]}', 'Study')
    check(api('RemoveActivity', 'Study') is True, 'RemoveActivity(Study)')
    time.sleep(0.3)
    check(win('B-default')['activity'] == api('GetCurrent') and not win('B-default')['hidden'],
          'windows of a removed Activity move to the active one')
    err = api_error('SwitchActivity', 'Study')
    check(err is not None, 'removed Activity no longer exists')

    print('== 8. rename / reorder / persistence file')
    check(api('RenameActivity', 'Work', 'Trabalho') is True, 'RenameActivity')
    check(api('MoveActivity', 'Trabalho', 0) is True, 'MoveActivity')
    check(api('ListActivities') == ['Trabalho', 'Default'], f'order: {api("ListActivities")}')
    time.sleep(0.6)
    state_file = os.path.join(os.environ['XDG_CONFIG_HOME'], 'activities-layer', 'state.json')
    state = json.load(open(state_file))
    check([a['name'] for a in state['activities']] == ['Trabalho', 'Default'], 'state.json saved')

    print('== 8b. CLI and recipes')
    activity = os.path.join(REPO, 'bin', 'activity')

    def run_cli(*args):
        return subprocess.run([sys.executable, '-I', activity, *args], capture_output=True, text=True, timeout=60)

    recipes = os.path.join(os.environ['XDG_CONFIG_HOME'], 'activities-layer', 'recipes')
    os.makedirs(recipes, exist_ok=True)
    with open(os.path.join(recipes, 'teste.toml'), 'w') as f:
        f.write(f'''
activity = "Estudos"
timeout = 15
[[launch]]
command = ["{sys.executable}", "-I", "{TESTWIN}", "org.test.Recipe", "R-ws0"]
match = "org.test.recipe"
workspace = 0
[[launch]]
# Same unique app: the second process forwards to the first one and exits.
command = ["{sys.executable}", "-I", "{TESTWIN}", "org.test.Recipe", "R-ws1-slow", "1.5"]
match = "org.test.recipe"
workspace = 1
''')
    current = api('GetCurrent')
    r = run_cli('run', 'teste', '--no-switch')
    check(r.returncode == 0, f'activity run teste --no-switch (rc={r.returncode}, {r.stdout.strip()} {r.stderr.strip()})')
    check(api('GetCurrent') == current, 'with --no-switch the current Activity does not change')
    check('Estudos' in api('ListActivities'), 'the recipe created its Activity')
    check(win('R-ws0') and win('R-ws0')['activity'] == 'Estudos' and win('R-ws0')['hidden'],
          f'recipe window 1 is in Estudos, hidden ({win("R-ws0")})')
    check(win('R-ws1-slow') and win('R-ws1-slow')['activity'] == 'Estudos' and win('R-ws1-slow')['hidden'],
          f'recipe window 2 (reused process, slow) is in Estudos, hidden ({win("R-ws1-slow")})')
    r = run_cli('switch', 'Estudos')
    time.sleep(0.5)
    check(r.returncode == 0 and api('GetCurrent') == 'Estudos', 'activity switch Estudos')
    check(win('R-ws0')['workspace'] == 0 and win('R-ws1-slow')['workspace'] == 1,
          f'recipe windows on the requested workspaces ({win("R-ws0")["workspace"]}, {win("R-ws1-slow")["workspace"]})')
    r = run_cli('list')
    check(r.returncode == 0 and '* ' in r.stdout and 'Estudos' in r.stdout, f'activity list:\n{r.stdout}')
    r = run_cli('windows', 'Estudos')
    check(r.returncode == 0 and 'R-ws0' in r.stdout, 'activity windows Estudos')
    rid = win('R-ws0')['id']
    r = run_cli('move', str(rid), 'Default')
    check(r.returncode == 0 and win('R-ws0')['activity'] == 'Default', 'activity move')
    r = run_cli('switch', 'Nope')
    check(r.returncode == 1 and 'No Activity named' in r.stderr, f'errors are reported ({r.stderr.strip()})')
    r = run_cli('run', 'missing-recipe')
    check(r.returncode == 1 and 'recipe not found' in r.stderr, 'missing recipe is reported')
    r = run_cli('switch', current)
    api('RemoveActivity', 'Estudos')

    print('== 9b. shortcuts, indicator and preferences')
    current_before = api('GetCurrent')
    names = api('ListActivities')
    press('Super_L', 'Control_L', 'Alt_L', 'Right')
    expected = names[(names.index(current_before) + 1) % len(names)]
    check(api('GetCurrent') == expected, f'<Super><Ctrl><Alt>Right switches to the next Activity ({api("GetCurrent")})')
    press('Super_L', 'Control_L', 'Alt_L', '1')
    check(api('GetCurrent') == names[0], f'<Super><Ctrl><Alt>1 switches to Activity 1 ({api("GetCurrent")})')
    press('Super_L', 'Control_L', 'Alt_L', 'n')
    check(len(api('ListActivities')) == len(names) + 1 and api('GetCurrent') == 'Activity 3',
          f'<Super><Ctrl><Alt>n creates and switches ({api("ListActivities")}, {api("GetCurrent")})')
    open_and_wait('org.test.Kappa', 'K-mover')
    shell_eval('''Main.activateWindow(global.get_window_actors().map(a => a.meta_window)
        .find(w => w.get_title() === "K-mover"))''')
    time.sleep(0.3)
    press('Shift_L', 'Super_L', 'Control_L', 'Alt_L', '1')
    check(win('K-mover')['activity'] == names[0] and win('K-mover')['hidden'],
          f'<Shift><Super><Ctrl><Alt>1 moves the focused window ({win("K-mover")})')
    api('SwitchActivity', names[0])
    time.sleep(0.4)
    menu = shell_eval('''(() => {
        const ind = Main.panel.statusArea["activities-layer@local"];
        ind.menu.open();
        const labels = ind.menu._getMenuItems().map(i => i.label?.text ?? i.constructor.name);
        return {label: ind._label.text, labels};
    })()''')
    time.sleep(0.5)
    screenshot('indicator-menu')
    shell_eval('Main.panel.statusArea["activities-layer@local"].menu.close()')
    check(menu['label'] == names[0], f'indicator shows the current Activity ({menu["label"]})')
    check(all(n in menu['labels'] for n in api('ListActivities')) and 'New Activity…' in menu['labels'],
          f'indicator menu lists Activities and actions ({menu["labels"]})')
    api('RemoveActivity', 'Activity 3')

    prefs = subprocess.Popen(['gnome-extensions', 'prefs', 'activities-layer@local'],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    def prefs_window():
        return shell_eval('''global.get_window_actors().map(a => a.meta_window)
            .some(w => (w.get_title() ?? "").includes("Activities Layer"))''')
    try:
        wait_for(prefs_window, timeout=15, what='preferences window')
        time.sleep(1.5)
        screenshot('prefs-activities')
        check(True, 'preferences window opens')
    except TimeoutError:
        check(False, 'preferences window opens')
    procs.append(prefs)

    print('== 9c. lock screen keeps Activities hidden')
    hidden_before = sorted(w['title'] for w in windows() if w['hidden'])
    shell_eval('Main.screenShield.lock(false)')
    try:
        wait_for(lambda: shell_eval('Main.sessionMode.isLocked'), timeout=10, what='lock')
        time.sleep(0.8)
        hidden_locked = sorted(w['title'] for w in windows() if w['hidden'])
        check(hidden_locked == hidden_before and hidden_before, f'windows stay hidden while locked ({hidden_locked})')
        ind = shell_eval('Object.keys(Main.panel.statusArea).includes("activities-layer@local")')
        check(not ind, 'indicator removed while locked')
        shell_eval('Main.screenShield.deactivate(false)')
        wait_for(lambda: not shell_eval('Main.sessionMode.isLocked'), timeout=10, what='unlock')
        time.sleep(0.8)
        ind = shell_eval('Object.keys(Main.panel.statusArea).includes("activities-layer@local")')
        check(ind, 'indicator back after unlock')
        before_switch = api('GetCurrent')
        press('Super_L', 'Control_L', 'Alt_L', 'Right')
        check(api('GetCurrent') != before_switch, 'shortcuts work again after unlock')
        api('SwitchActivity', before_switch)
    except TimeoutError as e:
        check(False, f'lock screen test: {e}')

    print('== 9. disable/enable cycles')
    before = {w['title']: (w['activity'], w['hidden']) for w in windows()}
    for i in range(3):
        gnome_extensions('disable', 'activities-layer@local')
        time.sleep(0.6)
        vis = visible_on_screen()
        hidden_any = shell_eval('''global.get_window_actors().map(a => a.meta_window)
            .some(w => w.is_mapped_inhibited() || w.is_skip_taskbar() || w.is_on_all_workspaces())''')
        check(not hidden_any, f'cycle {i}: disable leaves no window inhibited/skip-taskbar/sticky')
        n_ws = n_workspaces()
        check(n_ws >= 3, f'cycle {i}: hidden Activities laid out on extra workspaces (n={n_ws}, visible={sorted(vis)})')
        leftovers = shell_eval('''(() => {
            const names = ["switch-to-next-activity", "new-activity"];
            return {
                indicator: Object.keys(Main.panel.statusArea).includes("activities-layer@local"),
                dbus: false,
            };
        })()''')
        check(not leftovers['indicator'], f'cycle {i}: indicator removed')
        err = api_error('GetCurrent')
        check(err is not None, f'cycle {i}: D-Bus object unexported')

        gnome_extensions('enable', 'activities-layer@local')
        wait_for(lambda: api_error('GetCurrent') is None, what='extension re-enabled')
        time.sleep(0.6)
        after = {w['title']: (w['activity'], w['hidden']) for w in windows()}
        check(after == before, f'cycle {i}: assignment restored after re-enable')
        check(n_workspaces() <= 3, f'cycle {i}: extra workspaces collapsed (n={n_workspaces()})')

    print('== 10. closing windows')
    shell_eval('''global.get_window_actors().map(a => a.meta_window)
        .filter(w => !w.is_override_redirect())
        .forEach(w => w.delete(global.get_current_time()))''')
    # The prefs app is D-Bus activated (not our child); match its exact path.
    subprocess.run(['pkill', '-f', '^/usr/bin/gjs -m /usr/share/gnome-shell/org[.]gnome[.]Shell[.]Extensions$'],
                   check=False)
    for p in procs:
        p.terminate()
    try:
        wait_for(lambda: not windows(), what='windows to close')
    except TimeoutError:
        print('  left open:', [(w['title'], w['wm_class'], w['hidden']) for w in windows()])
        raise
    check(windows() == [], 'closed windows are forgotten')

    print()
    if failures:
        print(f'{len(failures)} FAILURE(S):')
        for f in failures:
            print('  -', f)
        return 1
    print('all checks passed')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    finally:
        for p in procs:
            p.kill()
