#!/usr/bin/python3
"""Test window for the nested-shell tests.

usage: testwin.py APP_ID TITLE [DELAY_SECONDS]

It is a *unique* Gtk.Application: a second invocation with the same APP_ID
forwards its command line to the running instance and exits, which then opens
the window. This mimics Firefox/VS Code reusing one process.
"""
import sys

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gio, GLib, Gtk  # noqa: E402


def on_command_line(app, cmdline):
    args = cmdline.get_arguments()[1:]
    title = args[1] if len(args) > 1 else 'window'
    delay = float(args[2]) if len(args) > 2 else 0

    def open_window():
        win = Gtk.ApplicationWindow(application=app, title=title)
        win.set_default_size(320, 200)
        win.set_child(Gtk.Label(label=title))
        win.present()
        return GLib.SOURCE_REMOVE

    app.hold()
    GLib.timeout_add(int(delay * 1000), lambda: (open_window(), app.release())[0])
    return 0


app = Gtk.Application(application_id=sys.argv[1],
                      flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
app.connect('command-line', on_command_line)
app.run(sys.argv)
