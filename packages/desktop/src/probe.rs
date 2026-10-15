//! Test builds only (`--features smoke-probe`; never in a release): after each page load, a fixed script reports what
//! the page can see of Tauri and one call into Tauri is attempted; the answer, with the window's title after the
//! attempt, is appended as one JSON line to the file named by `ARGELANDERSPACE_SHELL_PROBE`. With
//! `ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES=1` the shell leaves Tauri's entry points in the page, to show that a call
//! made through them is refused all the same (docs/engineering.md, desktop shell smoke). With
//! `ARGELANDERSPACE_SHELL_PROBE_NAVIGATE=<address>` the page then tries to go there and reports where it is a moment
//! later (the shell stops navigations away from the local page, `navigation.rs`).

use std::io::Write;
use std::time::Duration;

use javascriptcore::ValueExt;
use tauri::webview::PageLoadEvent;
use tauri::{Runtime, WebviewWindowBuilder};
use webkit2gtk::WebViewExt;

const PROBE: &str = r##"
for (let i = 0; i < 80 && !document.querySelector("#root [data-ui]"); i++) {
  await new Promise((done) => setTimeout(done, 100));
}
const r = { href: location.href };
r.tauri = typeof window.__TAURI__;
r.internals = typeof window.__TAURI_INTERNALS__;
r.ipc = typeof window.ipc;
r.names = Object.getOwnPropertyNames(window).filter((k) => /tauri|^ipc$/i.test(k));
r.webkitIpcHandler = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc);
r.welcome = !!document.querySelector('[data-ui="welcome-page"]');
r.title = document.title;
r.dataUi = [...new Set([...document.querySelectorAll("#root [data-ui]")].map((e) => e.dataset.ui))].slice(0, 30);
if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {
  try {
    await window.__TAURI_INTERNALS__.invoke("plugin:window|set_title", { label: "main", value: "PROBE" });
    r.invoke = "resolved";
  } catch (e) {
    r.invoke = "rejected: " + String(e).slice(0, 300);
  }
} else {
  r.invoke = "no entry";
}
try {
  const res = await fetch("ipc://localhost/plugin%3Awindow%7Cset_title", {
    method: "POST",
    body: JSON.stringify({ label: "main", value: "PROBE" }),
    headers: { "Content-Type": "application/json" },
  });
  r.ipcFetch = res.status + " " + (await res.text()).slice(0, 300);
} catch (e) {
  r.ipcFetch = "error: " + String(e).slice(0, 300);
}
const NAVIGATE = __NAVIGATE__;
if (NAVIGATE) {
  location.href = NAVIGATE;
  await new Promise((done) => setTimeout(done, 1500));
  r.navigate = { tried: NAVIGATE, after: location.href };
}
return JSON.stringify(r);
"##;

/// Whether the shell should leave Tauri's entry points in the page (to show calls are refused anyway).
pub fn keep_entries() -> bool {
    std::env::var("ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES").is_ok_and(|v| v == "1")
}

pub fn attach<R: Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    let Some(out) = std::env::var_os("ARGELANDERSPACE_SHELL_PROBE") else {
        return builder;
    };
    let navigate = std::env::var("ARGELANDERSPACE_SHELL_PROBE_NAVIGATE").ok();
    let script = PROBE.replace(
        "__NAVIGATE__",
        &serde_json::to_string(&navigate).unwrap_or_else(|_| "null".into()),
    );
    builder.on_page_load(move |webview, payload| {
        if payload.event() != PageLoadEvent::Finished || payload.url().scheme() == "about" {
            return;
        }
        let out = out.clone();
        let script = script.clone();
        let window = webview.clone();
        let _ = webview.with_webview(move |platform| {
            let view = platform.inner();
            view.call_async_javascript_function(
                &script,
                None,
                None,
                None,
                None::<&gio::Cancellable>,
                move |result| {
                    let answer = match result {
                        Ok(value) => value.to_str().to_string(),
                        Err(error) => serde_json::json!({ "error": error.to_string() }).to_string(),
                    };
                    std::thread::spawn(move || {
                        // The title after the attempted call: unchanged when the call was refused.
                        std::thread::sleep(Duration::from_millis(500));
                        let title = window.title().unwrap_or_default();
                        let line =
                            serde_json::json!({ "page": answer, "windowTitle": title }).to_string();
                        if let Ok(mut f) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&out)
                        {
                            let _ = writeln!(f, "{line}");
                        }
                    });
                },
            );
        });
    })
}
