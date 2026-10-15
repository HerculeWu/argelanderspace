//! The desktop shell (desktop-app ticket 20; ADR 0010; docs/architecture.md「桌面壳」). It opens one window on the
//! page of the desktop host it looks after, answers the host's native requests, restarts the host when it leaves for
//! another project, shows a native dialog when it ends unexpectedly, and quits with the window. Everything about
//! projects, ports, settings and logs is the host's: the shell only follows the line protocol (`protocol.rs`), and
//! decides nothing but what `supervisor.rs` says.
//!
//! The page gets nothing of Tauri: no permission, and no entry point (`page_guard.rs`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launch;
mod page_guard;
mod protocol;
mod shell_log;
mod single_instance;
mod supervisor;

#[cfg(feature = "smoke-probe")]
mod probe;

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use launch::HostLauncher;
use protocol::{Language, Request};
use shell_log::ShellLog;
use supervisor::{Action, CrashChoice, Supervisor, QUIT_DEADLINE_MS};

const WINDOW: &str = "main";

enum Ev {
    Line {
        attempt: u32,
        line: String,
    },
    Exited {
        attempt: u32,
        code: Option<i32>,
        signal: Option<i32>,
        ms: f64,
    },
    CloseRequested,
    Raise,
    FolderPicked {
        attempt: u32,
        id: String,
        path: Option<PathBuf>,
    },
    CrashChoice(CrashChoice),
    Deadline(u32),
}

struct Host {
    attempt: u32,
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
}

struct Shell {
    app: AppHandle,
    tx: Sender<Ev>,
    sup: Supervisor,
    log: ShellLog,
    launcher: HostLauncher,
    cwd: PathBuf,
    host: Option<Host>,
    window: Option<WebviewWindow>,
    picking: bool,
    socket: PathBuf,
}

fn main() {
    // Nothing lands where the shell was started from (desktop-app ticket 02); the host starts here too.
    let cwd = launch::shell_working_dir(std::env::var_os("HOME"));
    let _ = std::env::set_current_dir(&cwd);

    let socket = single_instance::default_socket_path();
    let listener = match single_instance::claim(&socket) {
        Ok(single_instance::Instance::First(listener)) => Some(listener),
        Ok(single_instance::Instance::Another) => return,
        // No socket to be had: run without the single-instance guard rather than not at all.
        Err(_) => None,
    };

    let (tx, rx) = mpsc::channel::<Ev>();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .build(tauri::generate_context!())
        .expect("the desktop shell could not start");

    if let Some(listener) = listener {
        let tx = tx.clone();
        single_instance::serve(listener, move || {
            let _ = tx.send(Ev::Raise);
        });
    }

    let handle = app.handle().clone();
    let version = app.package_info().version.to_string();
    let webview = tauri::webview_version().unwrap_or_else(|_| "unknown".into());
    let shell_tx = tx.clone();
    std::thread::spawn(move || {
        let shell = Shell {
            app: handle,
            tx: shell_tx,
            sup: Supervisor::new(),
            log: ShellLog::new(),
            launcher: HostLauncher::development(),
            cwd,
            host: None,
            window: None,
            picking: false,
            socket,
        };
        shell.run(rx, &version, &webview);
    });

    app.run(move |_app, event| {
        if let RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            // The last window went away without the shell asking (it never closes it itself): quit like a close.
            api.prevent_exit();
            let _ = tx.send(Ev::CloseRequested);
        }
    });
}

impl Shell {
    fn run(mut self, rx: Receiver<Ev>, version: &str, webview: &str) {
        let first = self.sup.start(version, webview);
        self.act(first);
        while let Ok(ev) = rx.recv() {
            let actions = match ev {
                Ev::Line { attempt, line } => {
                    if self.host.as_ref().map(|h| h.attempt) != Some(attempt) {
                        continue;
                    }
                    self.sup.on_line(protocol::parse_host_line(&line))
                }
                Ev::Exited {
                    attempt,
                    code,
                    signal,
                    ms,
                } => {
                    if self.host.as_ref().map(|h| h.attempt) != Some(attempt) {
                        continue;
                    }
                    self.host = None;
                    self.sup.on_exit(code, signal, ms)
                }
                Ev::CloseRequested => {
                    if let Some(window) = &self.window {
                        let _ = window.hide();
                    }
                    self.sup.on_close_requested()
                }
                Ev::Raise => {
                    if let Some(window) = &self.window {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    vec![]
                }
                Ev::FolderPicked { attempt, id, path } => {
                    self.picking = false;
                    let path = path
                        .filter(|p| p.is_absolute())
                        .map(|p| p.to_string_lossy().into_owned());
                    self.sup.on_folder_picked(attempt, &id, path.as_deref())
                }
                Ev::CrashChoice(choice) => self.sup.on_crash_choice(choice),
                Ev::Deadline(attempt) => self.sup.on_deadline(attempt),
            };
            self.act(actions);
        }
    }

    fn act(&mut self, actions: Vec<Action>) {
        let mut queue: VecDeque<Action> = actions.into();
        while let Some(action) = queue.pop_front() {
            let more = match action {
                Action::Spawn { project } => self.spawn(project),
                Action::Send(line) => {
                    self.send(&line);
                    vec![]
                }
                Action::ShowPage(url) => {
                    self.show_page(&url);
                    vec![]
                }
                Action::Handle(request) => self.handle(request),
                Action::CrashDialog(language) => {
                    self.crash_dialog(language);
                    vec![]
                }
                Action::OpenFolder(dir) => {
                    let _ = open::that_detached(&dir);
                    vec![]
                }
                Action::WriteEvents { log_dir, events } => {
                    self.log.write(Path::new(&log_dir), &events);
                    vec![]
                }
                Action::ArmDeadline { attempt } => {
                    let tx = self.tx.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(QUIT_DEADLINE_MS));
                        let _ = tx.send(Ev::Deadline(attempt));
                    });
                    vec![]
                }
                Action::Kill => {
                    if let Some(host) = &self.host {
                        let _ = host.child.lock().map(|mut c| c.kill());
                    }
                    vec![]
                }
                Action::Exit => {
                    let _ = std::fs::remove_file(&self.socket);
                    self.app.exit(0);
                    vec![]
                }
            };
            queue.extend(more);
        }
    }

    fn spawn(&mut self, project: Option<String>) -> Vec<Action> {
        let mut command = self.launcher.command(project.as_deref(), &self.cwd);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => return self.sup.spawn_failed(project),
        };
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        self.sup.spawned(project, pid);
        let attempt = self.sup.attempt();
        let child = Arc::new(Mutex::new(child));
        let started = Instant::now();

        // The lines, in order; the end of the output is signalled so that an exit is reported after the last line.
        let (eof_tx, eof_rx) = mpsc::channel::<()>();
        if let Some(stdout) = stdout {
            let tx = self.tx.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if tx.send(Ev::Line { attempt, line }).is_err() {
                        break;
                    }
                }
                let _ = eof_tx.send(());
            });
        }
        let waiter = Arc::clone(&child);
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let status = loop {
                match waiter.lock().map(|mut c| c.try_wait()) {
                    Ok(Ok(Some(status))) => break Some(status),
                    Ok(Ok(None)) => {}
                    _ => break None,
                }
                std::thread::sleep(Duration::from_millis(50));
            };
            // Whatever the host wrote before it ended is read first (a child of its own may hold the output open).
            let _ = eof_rx.recv_timeout(Duration::from_secs(2));
            let (code, signal) = match status {
                Some(status) => {
                    use std::os::unix::process::ExitStatusExt;
                    (status.code(), status.signal())
                }
                None => (None, None),
            };
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            let _ = tx.send(Ev::Exited {
                attempt,
                code,
                signal,
                ms,
            });
        });
        self.host = Some(Host {
            attempt,
            child,
            stdin,
        });
        vec![]
    }

    fn send(&mut self, line: &str) {
        if let Some(stdin) = self.host.as_mut().and_then(|h| h.stdin.as_mut()) {
            let _ = writeln!(stdin, "{line}").and_then(|_| stdin.flush());
        }
    }

    fn show_page(&mut self, url: &str) {
        let Ok(parsed) = tauri::Url::parse(url) else {
            return;
        };
        if let Some(window) = &self.window {
            let _ = window.navigate(parsed);
            return;
        }
        // The window starts blank; the page is loaded once Tauri's scripts are out of the webview (page_guard.rs).
        let Ok(blank) = tauri::Url::parse("about:blank") else {
            return;
        };
        let builder = WebviewWindowBuilder::new(&self.app, WINDOW, WebviewUrl::External(blank))
            .title("ArgelanderSpace")
            .inner_size(1280.0, 820.0)
            .min_inner_size(720.0, 480.0);
        #[cfg(feature = "smoke-probe")]
        let builder = probe::attach(builder);
        let Ok(window) = builder.build() else { return };
        #[cfg(feature = "smoke-probe")]
        let loaded = if probe::keep_entries() {
            window.navigate(parsed)
        } else {
            page_guard::strip_and_load(&window, parsed.to_string())
        };
        #[cfg(not(feature = "smoke-probe"))]
        let loaded = page_guard::strip_and_load(&window, parsed.to_string());
        if loaded.is_err() {
            let _ = window.destroy();
            return;
        }
        let tx = self.tx.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = tx.send(Ev::CloseRequested);
            }
        });
        self.window = Some(window);
    }

    fn handle(&mut self, request: Request) -> Vec<Action> {
        let kind = request.kind();
        match request {
            Request::PickFolder { id } => {
                let attempt = self.sup.attempt();
                if self.picking {
                    // One folder dialog at a time: a second request is answered as cancelled.
                    return self.sup.on_folder_picked(attempt, &id, None);
                }
                self.picking = true;
                let tx = self.tx.clone();
                let mut dialog = self.app.dialog().file();
                if let Some(window) = &self.window {
                    dialog = dialog.set_parent(window);
                }
                dialog.pick_folder(move |folder| {
                    let path = folder.and_then(|f| f.into_path().ok());
                    let _ = tx.send(Ev::FolderPicked { attempt, id, path });
                });
                vec![]
            }
            Request::OpenLogFolder { path } => self.open(kind, &path, true),
            Request::OpenConfigFile { path } => self.open(kind, &path, false),
            // Where the bundled skills are is desktop-app ticket 24; the host sends no path yet.
            Request::OpenSkillsFolder => self.sup.request_failed(kind, "no_path"),
            // Opening the page in the browser and the developer tools are desktop-app ticket 21.
            Request::OpenInBrowser | Request::OpenDevtools => {
                self.sup.request_failed(kind, "not_supported")
            }
        }
    }

    fn open(&mut self, kind: &'static str, path: &str, folder: bool) -> Vec<Action> {
        let p = Path::new(path);
        let there = if folder { p.is_dir() } else { p.is_file() };
        if !there {
            return self.sup.request_failed(kind, "not_found");
        }
        match open::that_detached(p) {
            Ok(()) => vec![],
            Err(_) => self.sup.request_failed(kind, "open_failed"),
        }
    }

    fn crash_dialog(&mut self, language: Language) {
        let text = CrashText::of(language);
        let tx = self.tx.clone();
        let mut dialog = self
            .app
            .dialog()
            .message(text.message)
            .title(text.title)
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                text.restart.into(),
                text.show_logs.into(),
                text.quit.into(),
            ));
        if let Some(window) = &self.window {
            dialog = dialog.parent(window);
        }
        dialog.show_with_result(move |result| {
            let choice = match result {
                MessageDialogResult::Yes => CrashChoice::Restart,
                MessageDialogResult::No => CrashChoice::ShowLogFolder,
                MessageDialogResult::Cancel => CrashChoice::Quit,
                MessageDialogResult::Custom(label) if label == text.restart => CrashChoice::Restart,
                MessageDialogResult::Custom(label) if label == text.show_logs => {
                    CrashChoice::ShowLogFolder
                }
                MessageDialogResult::Custom(label) if label == text.quit => CrashChoice::Quit,
                _ => CrashChoice::Closed,
            };
            let _ = tx.send(Ev::CrashChoice(choice));
        });
    }
}

/// The crash dialog's words (spec User Story 12): what happened, and the three ways on.
struct CrashText {
    title: &'static str,
    message: &'static str,
    restart: &'static str,
    show_logs: &'static str,
    quit: &'static str,
}

impl CrashText {
    fn of(language: Language) -> CrashText {
        match language {
            Language::Chinese => CrashText {
                title: "ArgelanderSpace",
                message: "工作台的后台进程意外退出了。\n\n可以重新启动它；向开发者反馈问题时，可以附上日志文件夹里的日志。",
                restart: "重新启动",
                show_logs: "显示日志文件夹",
                quit: "退出",
            },
            Language::English => CrashText {
                title: "ArgelanderSpace",
                message: "The workbench's background process quit unexpectedly.\n\nYou can restart it. When reporting the problem, you can attach the logs from the log folder.",
                restart: "Restart",
                show_logs: "Show log folder",
                quit: "Quit",
            },
        }
    }
}
