// TEST ONLY. Enables unsafe mode (org.gnome.Shell.Eval) inside the isolated
// headless test shell started by tests/nested.sh.
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class TestHelper extends Extension {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
