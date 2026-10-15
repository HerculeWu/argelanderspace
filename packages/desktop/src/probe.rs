//! Test builds only (`--features smoke-probe`; never in a release): after each page load, a fixed script reports what
//! the page can see of Tauri and one call into Tauri is attempted; the answer, with the window's title after the
//! attempt, is appended as one JSON line to the file named by `ARGELANDERSPACE_SHELL_PROBE`. With
//! `ARGELANDERSPACE_SHELL_PROBE_KEEP_ENTRIES=1` the shell leaves Tauri's entry points in the page, to show that a call
//! made through them is refused all the same (docs/engineering.md, desktop shell smoke). With
//! `ARGELANDERSPACE_SHELL_PROBE_NAVIGATE=<address>` the page then tries to go there and reports where it is a moment
//! later (the shell stops navigations away from the local page, `navigation.rs`).
//!
//! Desktop-app ticket 21: `ARGELANDERSPACE_SHELL_PROBE_CONTROL=<file>` is read for lines the smoke appends —
//! `menu <id>` chooses a menu item as a click on it does (`menu.rs` ids), `recent <n>` the n-th recent project of the
//! menu now, `js <script>` runs a script in the page and
//! appends `{"js": <answer>}` to the probe file; `ARGELANDERSPACE_SHELL_PROBE_SAVE_TO=<dir>` saves the page's
//! downloads there without the save dialog (so the files can be checked; the dialog itself is checked without it).

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

/// A line of the control file.
pub enum Command {
    Menu(String),
    Js(String),
    /// `recent <n>`: the n-th recent project of the menu now (from 0), chosen as a click on it (the ids are the host's,
    /// different for each host).
    Recent(usize),
    /// `devtools?`: whether the window's developer tools are open, appended as `{"devtoolsOpen": …}`.
    DevtoolsOpen,
}

/// Reads the control file (when named) from its start, polling for appended lines, and hands each command on.
pub fn control(each: impl Fn(Command) + Send + 'static) {
    let Some(path) = std::env::var_os("ARGELANDERSPACE_SHELL_PROBE_CONTROL") else {
        return;
    };
    std::thread::spawn(move || {
        let mut done = 0usize;
        loop {
            if let Ok(text) = std::fs::read_to_string(&path) {
                let lines: Vec<&str> = text.lines().collect();
                // Only whole lines (the last one has its newline).
                let whole = if text.ends_with('\n') {
                    lines.len()
                } else {
                    lines.len().saturating_sub(1)
                };
                for line in &lines[done.min(whole)..whole] {
                    if let Some(id) = line.strip_prefix("menu ") {
                        each(Command::Menu(id.to_owned()));
                    } else if let Some(code) = line.strip_prefix("js ") {
                        each(Command::Js(code.to_owned()));
                    } else if let Some(n) =
                        line.strip_prefix("recent ").and_then(|n| n.parse().ok())
                    {
                        each(Command::Recent(n));
                    } else if *line == "devtools?" {
                        each(Command::DevtoolsOpen);
                    }
                }
                done = done.max(whole);
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    });
}

/// Where downloads go without the dialog, when the smoke says so.
pub fn save_to() -> Option<std::path::PathBuf> {
    std::env::var_os("ARGELANDERSPACE_SHELL_PROBE_SAVE_TO").map(Into::into)
}

/// Runs `code` (the body of an async function) in the page; its answer is appended to the probe file.
pub fn eval<R: Runtime>(window: &tauri::WebviewWindow<R>, code: String) {
    let Some(out) = std::env::var_os("ARGELANDERSPACE_SHELL_PROBE") else {
        return;
    };
    let _ = window.with_webview(move |platform| {
        platform.inner().call_async_javascript_function(
            &code,
            None,
            None,
            None,
            None::<&gio::Cancellable>,
            move |result| {
                let answer = match result {
                    Ok(value) => serde_json::Value::String(value.to_str().to_string()),
                    Err(error) => serde_json::json!({ "error": error.to_string() }),
                };
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&out)
                {
                    let _ = writeln!(f, "{}", serde_json::json!({ "js": answer }));
                }
            },
        );
    });
}

/// Appends whether the window's developer tools are open to the probe file.
pub fn report_devtools<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Some(out) = std::env::var_os("ARGELANDERSPACE_SHELL_PROBE") else {
        return;
    };
    let open = window.is_devtools_open();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(out)
    {
        let _ = writeln!(f, "{}", serde_json::json!({ "devtoolsOpen": open }));
    }
}

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
