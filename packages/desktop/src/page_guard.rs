//! The page gets nothing of Tauri (spec「进程结构」: the page calls no Tauri interface; ADR 0010). Two layers:
//!
//! 1. No permission: the app defines no capability (tauri.conf.json `capabilities: []`) and the shell registers no
//!    command, so Tauri refuses every call from the page — checked in the smoke with the entry points left in place
//!    (`smoke-probe`, `ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES=1`): `plugin:window|set_title` answers "not allowed".
//! 2. No entry point: Tauri adds its scripts (`window.__TAURI_INTERNALS__`, `window.isTauri`, `window.ipc`, …) to
//!    every page it loads, as properties the page cannot delete. Before the window loads the local page the shell
//!    takes all user scripts out of the webview and unregisters the `ipc` message handler, so none of it exists in
//!    the page. WebKitGTK only; the other platforms' shells are desktop-app ticket 26.

use tauri::{Runtime, WebviewWindow};
use webkit2gtk::{UserContentManagerExt, WebViewExt};

/// Strips the webview of Tauri's scripts and message handler, then loads `url`.
pub fn strip_and_load<R: Runtime>(window: &WebviewWindow<R>, url: String) -> tauri::Result<()> {
    window.with_webview(move |platform| {
        let view = platform.inner();
        if let Some(manager) = view.user_content_manager() {
            manager.remove_all_scripts();
            manager.unregister_script_message_handler("ipc");
        }
        view.load_uri(&url);
    })
}
