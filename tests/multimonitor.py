#!/usr/bin/python3
"""Two-monitor test (workspaces only on the primary monitor).

Run with:  AL_SECOND_MONITOR=1 AL_TEST_SCRIPT=tests/multimonitor.py tests/nested.sh
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as t  # noqa: E402

t.shell_eval('Main.layoutManager.monitors.length') == 2 or sys.exit('needs two monitors')
t.shell_eval('''(async () => {
    const {default: Gio} = await import('gi://Gio');
    new Gio.Settings({schema_id: 'org.gnome.mutter'}).set_boolean('workspaces-only-on-primary', true);
})()''')
t.open_and_wait('org.test.Primary', 'P1')
t.open_and_wait('org.test.Secondary', 'S1')
S1 = 'global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === "S1")'
t.wait_for(lambda: t.shell_eval(f'{S1}.get_frame_rect().width') > 0, what='S1 placed')
time.sleep(0.3)
t.shell_eval(f'{S1}.move_frame(true, 1500, 200)')
print('monitors', t.shell_eval('Main.layoutManager.monitors.map(m => [m.x, m.y, m.width, m.height])'),
      'S1 monitor', t.shell_eval('global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === "S1").get_monitor()'),
      'only-primary', t.shell_eval('(async () => (await import("gi://Meta")).default.prefs_get_workspaces_only_on_primary())()'))
t.check(t.win('S1')['workspace'] == -1, f'S1 on the secondary monitor is on all workspaces ({t.win("S1")})')
t.api('CreateActivity', 'Other')
t.api('SwitchActivity', 'Other')
time.sleep(0.5)
t.check(t.win('S1')['hidden'] and t.win('P1')['hidden'], 'both windows hidden in the other Activity')
t.check(t.visible_on_screen() == set(), f'nothing visible ({t.visible_on_screen()})')
t.api('SwitchActivity', 'Default')
time.sleep(0.5)
t.check(not t.win('S1')['hidden'], 'S1 is back')
mon = t.shell_eval('''global.get_window_actors().map(a => a.meta_window)
    .find(w => w.get_title() === "S1").get_monitor()''')
t.check(mon == 1, f'S1 is still on the secondary monitor ({mon})')
t.check(t.visible_on_screen() == {'P1', 'S1'}, f'visible: {t.visible_on_screen()}')
t.shell_eval('''global.get_window_actors().map(a => a.meta_window)
    .find(w => w.get_title() === "S1").stick()''')  # user makes it sticky... on a secondary monitor
for p in t.procs:
    p.kill()
print('FAILURES:', t.failures if t.failures else 'none')
sys.exit(1 if t.failures else 0)
