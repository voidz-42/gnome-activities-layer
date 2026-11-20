#!/usr/bin/python3
"""Shortcut recording dialog of the preferences, driven with a virtual keyboard.

Run with:  AL_TEST_SCRIPT=$PWD/tests/shortcut_dialog.py tests/nested.sh

Checks that combinations already used by GNOME or by this extension reach the
dialog (system shortcuts are inhibited while recording) and that Shift+digit is
stored as the digit, not the shifted symbol.
"""
import os
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as t  # noqa: E402

REPO = os.environ['AL_REPO']
work = tempfile.mkdtemp(prefix='al-shortcut-')
os.makedirs(os.path.join(work, 'lib'))
with open(os.path.join(REPO, 'lib', 'icons.js')) as f, open(os.path.join(work, 'lib', 'icons.js'), 'w') as g:
    g.write(f.read())
src = open(os.path.join(REPO, 'prefs.js')).read()
src = src.replace(
    "import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';",
    'class ExtensionPreferences {}')
with open(os.path.join(work, 'prefs_copy.js'), 'w') as f:
    f.write(src + '\nexport {ShortcutDialog};\n')
with open(os.path.join(work, 'main.js'), 'w') as f:
    f.write('''
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import {ShortcutDialog} from './prefs_copy.js';
const app = new Adw.Application({application_id: 'org.test.ShortcutDialog'});
app.connect('activate', () => {
    const win = new Adw.ApplicationWindow({application: app, title: 'Shortcut test', default_width: 500, default_height: 400});
    win.present();
    const open = () => {
        const dlg = new ShortcutDialog('Test', value => print(`RECORDED ${JSON.stringify(value)}`));
        dlg.connect('closed', () => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { open(); return false; }));
        dlg.present(win);
        print('OPEN');
    };
    open();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40000, () => { app.quit(); return false; });
});
app.run([]);
''')

t.shell_eval('Main.overview.hide()')
t.api('CreateActivity', 'Second')  # so that Super+Ctrl+Down would really switch
time.sleep(1)

proc = subprocess.Popen(['gjs', '-m', os.path.join(work, 'main.js')],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
lines = []
threading.Thread(target=lambda: [lines.append(line.rstrip()) for line in proc.stdout], daemon=True).start()
t.wait_for(lambda: 'OPEN' in lines, timeout=10, what='dialog')
time.sleep(1.5)

# GNOME Shell asks once whether the app may inhibit shortcuts: allow it.
allowed = t.shell_eval('''(async () => {
    const {default: St} = await import('gi://St');
    const found = [];
    const walk = a => {
        if (a instanceof St.Button && /Allow/.test(a.label ?? ''))
            found.push(a);
        a.get_children().forEach(walk);
    };
    walk(Main.uiGroup);
    found.forEach(b => b.emit('clicked', 1));
    return found.length;
})()''')
t.check(allowed == 1, f'Shell asked to allow shortcut inhibition ({allowed} prompt)')
time.sleep(1)
# Focus returns to the app after the prompt closes; settle it with one key.
t.press('Super_L', 'Control_L', 'Alt_L', 'F12')
time.sleep(1)

cases = [
    (('Super_L', 'Control_L', 'Down'), '<Control><Super>Down', 'own shortcut (next Activity)'),
    (('Shift_L', 'Super_L', 'Control_L', 'Up'), '<Shift><Control><Super>Up', 'own shortcut with Shift'),
    (('Control_L', 'Alt_L', 'Up'), '<Control><Alt>Up', 'GNOME shortcut (workspace up)'),
    (('Shift_L', 'Super_L', 'Control_L', 'Alt_L', '1'), '<Shift><Control><Alt><Super>1', 'Shift+digit stored as the digit'),
    (('Super_L', 'Control_L', 'Alt_L', 'k'), '<Control><Alt><Super>k', 'free combination'),
]
for keys, expected, what in cases:
    before = t.api('GetCurrent')
    n = len(lines)
    t.press(*keys)
    time.sleep(1.2)
    recorded = [line[len('RECORDED '):] for line in lines[n:] if line.startswith('RECORDED ')]
    t.check(recorded == [f'["{expected}"]'], f'{what}: {"+".join(keys)} -> {recorded}')
    t.check(t.api('GetCurrent') == before, f'{what}: no Activity switch while recording')
    if not recorded:
        t.press('Escape')
        time.sleep(0.8)

# Close the dialog for good: the app quits on Escape-close via kill, and the
# global shortcuts must work again.
proc.kill()
proc.wait()
time.sleep(1)
before = t.api('GetCurrent')
t.press('Super_L', 'Control_L', 'Down')
t.check(t.api('GetCurrent') != before, f'shortcuts work again once the dialog is gone ({before} -> {t.api("GetCurrent")})')
print('FAILURES:', t.failures if t.failures else 'none')
sys.exit(1 if t.failures else 0)
