#!/usr/bin/bash
# Runs the automated tests inside an isolated, headless GNOME Shell.
#
#  - private D-Bus session (dbus-run-session)
#  - private XDG dirs, so dconf, enabled extensions and state.json of your real
#    session are never touched
#  - headless Wayland compositor with a virtual monitor (no window appears)
#
# usage: tests/nested.sh [--keep] [--shell]
#   --keep   keep the temporary directory (logs) afterwards
#   --shell  instead of running the tests, open an interactive bash inside the
#            environment (WAYLAND_DISPLAY and the bus are set up)
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
UUID=activities-layer@local
KEEP=0
MODE=test
for arg in "$@"; do
    case $arg in
        --keep) KEEP=1 ;;
        --shell) MODE=shell; KEEP=1 ;;
        *) echo "unknown option $arg" >&2; exit 2 ;;
    esac
done

ENV_DIR=$(mktemp -d "${TMPDIR:-/tmp}/activities-layer-test.XXXXXX")
[ $KEEP = 1 ] || trap 'rm -rf "$ENV_DIR"' EXIT

export XDG_CONFIG_HOME=$ENV_DIR/config
export XDG_DATA_HOME=$ENV_DIR/data
export XDG_CACHE_HOME=$ENV_DIR/cache
export XDG_STATE_HOME=$ENV_DIR/state
export XDG_RUNTIME_DIR=$ENV_DIR/run
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" \
         "$XDG_DATA_HOME/gnome-shell/extensions" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

glib-compile-schemas "$REPO/schemas"
ln -s "$REPO" "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
ln -s "$REPO/tests/helper" "$XDG_DATA_HOME/gnome-shell/extensions/al-test-helper@local"

export WAYLAND_DISPLAY=al-test-wayland
export GSETTINGS_SCHEMA_DIR="$REPO/schemas:${GSETTINGS_SCHEMA_DIR:-/usr/share/glib-2.0/schemas}"
export AL_LOG=$ENV_DIR/shell.log
export AL_REPO=$REPO
unset DISPLAY

echo "test environment: $ENV_DIR"

STATUS=0
dbus-run-session -- bash -c '
    set -e
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"activities-layer@local\", \"al-test-helper@local\"]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    gsettings set org.gnome.mutter dynamic-workspaces true

    gnome-shell --headless --virtual-monitor 1280x800 --no-x11 \
        --wayland-display "$WAYLAND_DISPLAY" >"$AL_LOG" 2>&1 &
    SHELL_PID=$!
    trap "kill $SHELL_PID 2>/dev/null; wait $SHELL_PID 2>/dev/null || true" EXIT

    for _ in $(seq 100); do
        gdbus call --session --dest org.gnome.Shell \
            --object-path /org/gnome/Shell/Extensions/ActivitiesLayer \
            --method org.gnome.Shell.Extensions.ActivitiesLayer.GetCurrent \
            >/dev/null 2>&1 && break
        sleep 0.2
    done

    if [ "'$MODE'" = shell ]; then
        echo "Inside the test environment. Shell log: $AL_LOG. Exit to stop."
        bash -i
    else
        python3 -I "${AL_TEST_SCRIPT:-$AL_REPO/tests/run_tests.py}"
    fi
' || STATUS=$?

echo
echo "== messages from the extension in the shell log =="
grep -E "activities-layer|JS ERROR|JS WARNING|Gjs-CRITICAL|Gjs-WARNING.*(activities|extensions)" "$AL_LOG" \
    | grep -v "al-test-helper" || echo "(none)"
[ $KEEP = 1 ] && echo "log kept at $AL_LOG"
exit $STATUS
