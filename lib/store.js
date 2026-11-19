// SPDX-License-Identifier: GPL-2.0-or-later
//
// Small JSON persistence helpers.
//
// Two files are used:
//  - ~/.config/activities-layer/state.json      (durable: Activity ids, names,
//                                               order and the current one)
//  - $XDG_RUNTIME_DIR/activities-layer/session.json
//                                              (lives only as long as the login
//                                               session: window id -> Activity
//                                               map, so that disabling and
//                                               re-enabling the extension, e.g.
//                                               after an update, does not lose
//                                               the assignment. Window ids are
//                                               meaningless after logout, which
//                                               is why this goes to the runtime
//                                               dir and is never restored
//                                               across sessions.)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const APP_DIR = 'activities-layer';

export function configDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), APP_DIR]);
}

export function stateFile() {
    return GLib.build_filenamev([configDir(), 'state.json']);
}

export function sessionFile() {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), APP_DIR, 'session.json']);
}

/**
 * Reads and parses a JSON file. Returns null when it does not exist or is
 * not valid JSON (the error is logged, never thrown).
 *
 * Synchronous on purpose: the files are tiny and only read once in enable().
 *
 * @param {string} path
 * @returns {object|null}
 */
export function readJson(path) {
    const file = Gio.File.new_for_path(path);
    try {
        const [, bytes] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn(`[activities-layer] Could not read ${path}: ${e.message}`);
        return null;
    }
}

/**
 * Atomically writes @data as JSON to @path, creating parent directories.
 *
 * @param {string} path
 * @param {object} data
 */
export function writeJson(path, data) {
    const file = Gio.File.new_for_path(path);
    try {
        const parent = file.get_parent();
        if (!parent.query_exists(null))
            parent.make_directory_with_parents(null);
        const bytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
        // replace_contents writes to a temp file and renames it into place.
        file.replace_contents(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) {
        console.warn(`[activities-layer] Could not write ${path}: ${e.message}`);
    }
}

/**
 * Deletes @path if it exists.
 *
 * @param {string} path
 */
export function removeFile(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch {
        // Not existing is fine.
    }
}
