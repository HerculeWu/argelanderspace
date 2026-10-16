//! The page gets nothing of Tauri (spec「进程结构」: the page calls no Tauri interface; ADR 0010). Two layers:
//!
//! 1. No permission: the app defines no capability (tauri.conf.json `capabilities: []`) and the shell registers no
//!    command, so Tauri refuses every call from the page — checked in the smoke with the entry points left in place
//!    (`smoke-probe`, `ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES=1`): `plugin:window|set_title` answers "not allowed".
//! 2. No entry point: Tauri adds its scripts (`window.__TAURI_INTERNALS__`, `window.isTauri`, `window.ipc`, …) to
//!    every page it loads, as properties the page cannot delete. Before the window loads the local page the shell
//!    takes them out of the webview, so none of it exists in the page:
//!    - Linux (WebKitGTK): all user scripts out of the webview's user content manager, and the `ipc` script message
//!      handler unregistered.
//!    - macOS (WKWebView, desktop-app ticket 30): the same on the webview's `WKUserContentController`
//!      (`removeAllUserScripts`, `removeScriptMessageHandlerForName:@"ipc"`).
//!    - Windows (WebView2, desktop-app ticket 30): wry adds Tauri's scripts with `AddScriptToExecuteOnDocumentCreated`
//!      and keeps no record of their ids. The shell adds one script of its own, reads its id, and removes that id and
//!      every id below it: WebView2 numbers the scripts of a webview `1`, `2`, … in the order added (an id that is not
//!      such a number: fail-closed, below). `chrome.webview.postMessage`, which Tauri's `ipc` calls, is turned off
//!      (`IsWebMessageEnabled` false).
//!
//! Fail-closed: when the scripts cannot be taken out (no user content manager or controller, an id that is not a
//! number, a WebView2 call that fails, including the removal of any one id), the page is not loaded and `on_failed` is called (the shell records
//! `shell.window_failed` `guard` and quits, `main.rs`).
//!
//! This leans on how wry 0.57 puts Tauri's scripts in (above): after an upgrade of tauri or wry, or of the system's
//! WebView2, the smoke's probe must be run again on each platform (docs/engineering.md「桌面壳」).

use tauri::{Runtime, WebviewWindow};

/// Strips the webview of Tauri's scripts and message handler, then loads `url`; when it cannot strip them, loads
/// nothing and calls `on_failed`. An `Err` means the work could not even be handed to the webview (nothing loaded).
pub fn strip_and_load<R: Runtime>(
    window: &WebviewWindow<R>,
    url: String,
    on_failed: impl FnOnce() + Send + 'static,
) -> tauri::Result<()> {
    #[cfg(not(target_os = "linux"))]
    let loader = window.clone();
    window.with_webview(move |platform| {
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::{UserContentManagerExt, WebViewExt};
            let view = platform.inner();
            let Some(manager) = view.user_content_manager() else {
                on_failed();
                return;
            };
            manager.remove_all_scripts();
            manager.unregister_script_message_handler("ipc");
            view.load_uri(&url);
        }
        #[cfg(not(target_os = "linux"))]
        {
            if !strip(&platform) {
                on_failed();
                return;
            }
            let Ok(parsed) = tauri::Url::parse(&url) else {
                on_failed();
                return;
            };
            if loader.navigate(parsed).is_err() {
                on_failed();
            }
        }
    })
}

/// macOS: Tauri's user scripts and the `ipc` message handler out of the webview's `WKUserContentController`.
#[cfg(target_os = "macos")]
fn strip(platform: &tauri::webview::PlatformWebview) -> bool {
    use objc2_foundation::NSString;
    use objc2_web_kit::WKUserContentController;
    let manager = platform.controller() as *const WKUserContentController;
    // SAFETY: wry hands out its live WKUserContentController (retained by the webview's configuration) on the main
    // thread, where this runs; a null pointer is refused.
    let Some(manager) = (unsafe { manager.as_ref() }) else {
        return false;
    };
    unsafe {
        manager.removeAllUserScripts();
        manager.removeScriptMessageHandlerForName(&NSString::from_str("ipc"));
    }
    true
}

/// Windows: every document-created script up to one the shell adds itself, and the web messages Tauri's `ipc` uses.
#[cfg(windows)]
fn strip(platform: &tauri::webview::PlatformWebview) -> bool {
    use std::cell::RefCell;
    use std::rc::Rc;
    use webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler;
    use windows_core::HSTRING;

    // SAFETY: plain WebView2 COM calls on the live controller wry hands out, on the main thread where this runs.
    unsafe {
        let Ok(webview) = platform.controller().CoreWebView2() else {
            return false;
        };
        let Ok(settings) = webview.Settings() else {
            return false;
        };
        if settings.SetIsWebMessageEnabled(false).is_err() {
            return false;
        }
        let marker: Rc<RefCell<Option<String>>> = Rc::default();
        let slot = Rc::clone(&marker);
        let added = AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                webview
                    .AddScriptToExecuteOnDocumentCreated(&HSTRING::from(";"), &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |result, id| {
                *slot.borrow_mut() = Some(id);
                result
            }),
        );
        if added.is_err() {
            return false;
        }
        let Some(last) = marker.borrow().as_deref().and_then(script_number) else {
            return false;
        };
        let Ok(webview) = platform.controller().CoreWebView2() else {
            return false;
        };
        // Every id from 1 to the shell's own names a script added before it; one that cannot be removed may be one of
        // Tauri's left in the page, so any failure fails closed.
        for id in 1..=last {
            if webview
                .RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id.to_string()))
                .is_err()
            {
                return false;
            }
        }
    }
    true
}

/// The number of a WebView2 document-created script's id (`"1"`, `"2"`, …); none for an id of any other form, or an
/// implausibly large one (the shell then fails closed rather than guess which scripts are Tauri's).
#[cfg_attr(not(windows), allow(dead_code))]
fn script_number(id: &str) -> Option<u32> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    id.parse::<u32>().ok().filter(|n| (1..=10_000).contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_script_numbers_are_taken() {
        assert_eq!(script_number("1"), Some(1));
        assert_eq!(script_number("17"), Some(17));
        for other in [
            "",
            "0",
            "-3",
            "+3",
            " 3",
            "3a",
            "{8A6C8E95-0000-0000-0000-000000000000}",
            "99999999999",
            "10001",
        ] {
            assert_eq!(script_number(other), None, "{other:?}");
        }
    }
}
