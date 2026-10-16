//! The desktop shell (desktop-app ticket 20; ADR 0010; docs/architecture.md「桌面壳」). It opens one window on the
//! page of the desktop host it looks after, answers the host's native requests, restarts the host when it leaves for
//! another project, shows a native dialog when it ends unexpectedly, and quits with the window. Everything about
//! projects, ports, settings and logs is the host's: the shell only follows the line protocol (`protocol.rs`), and
//! decides nothing but what `supervisor.rs` says.
//!
//! The page gets nothing of Tauri: no permission, and no entry point (`page_guard.rs`); it cannot leave the local page
//! either (`navigation.rs`): its links to other sites open in the system browser (desktop-app ticket 21). Its
//! downloads go through a save dialog (`download.rs`), and the window has the shell's menu (`menu.rs`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The smoke probe is for test builds only (docs/engineering.md「桌面壳」): a release build with it does not compile.
#[cfg(all(feature = "smoke-probe", not(debug_assertions)))]
compile_error!("the smoke-probe feature is for debug test builds only, never a release");

mod download;
mod launch;
mod menu;
mod navigation;
mod page_guard;
mod protocol;
mod shell_log;
mod single_instance;
mod supervisor;

#[cfg(feature = "smoke-probe")]
mod probe;

use std::collections::VecDeque;
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use launch::HostLauncher;
use menu::MenuText;
use navigation::Verdict;
use protocol::{HostLine, Language, LineRead, MenuModel, Request};
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
    /// The window could not be made ready for the page (`page_guard.rs`, from the webview's thread).
    WindowFailed(&'static str),
    /// A navigation away from the local page, or a new window, was stopped (`navigation.rs`): the scheme's category,
    /// and `navigation` or `new_window`.
    NavigationBlocked(&'static str, &'static str),
    /// An `http`/`https` link for the system browser (`navigation` or `new_window`).
    OpenLink(tauri::Url, &'static str),
    /// A download ended: `saved`, `cancelled`, `failed`.
    Download(&'static str),
    /// A menu item's id (`menu.rs`).
    Menu(String),
    /// Test builds only: a script to run in the page (the smoke's control file, `probe.rs`).
    #[cfg(feature = "smoke-probe")]
    ProbeJs(String),
    #[cfg(feature = "smoke-probe")]
    ProbeDevtools,
    #[cfg(feature = "smoke-probe")]
    ProbeRecent(usize),
    /// A line of host `attempt`'s output was skipped (`too_long`, `not_utf8`).
    LineRejected {
        attempt: u32,
        reason: &'static str,
    },
}

struct Host {
    attempt: u32,
    /// Its process group or job object (launch.rs): the forced end takes its children too.
    group: Option<launch::HostGroup>,
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
    /// The single-instance socket file this shell made, removed at its end while it is still that file.
    instance: Option<single_instance::Owned>,
    /// The page the window shows now: navigations stay on its origin (`navigation.rs`).
    page: Arc<Mutex<Option<tauri::Url>>>,
    /// The language of the shell's own words now (the save dialog asks it from WebKit's signal).
    language: Arc<Mutex<Language>>,
    /// The version shown in "about" (packages/app/package.json through tauri.conf.json, as the CLI's `--version`).
    version: String,
    /// Test builds: the ids of the menu's recent projects now (the probe's `recent <n>`).
    #[cfg(feature = "smoke-probe")]
    recent_ids: Vec<String>,
}

fn main() {
    // Nothing lands where the shell was started from (desktop-app ticket 02); the host starts here too.
    let cwd = launch::shell_working_dir(launch::home_var());
    let _ = std::env::set_current_dir(&cwd);

    let socket = single_instance::default_socket_path();
    // No socket to be had, or the file in its place is not this user's: run without the single-instance guard rather
    // than not at all (recorded as `shell.instance_unguarded`).
    let (listener, instance, unguarded) = match single_instance::claim(&socket) {
        Ok(single_instance::Instance::First(listener, owned)) => {
            (Some(listener), Some(owned), None)
        }
        Ok(single_instance::Instance::Another) => return,
        Ok(single_instance::Instance::Foreign) => (None, None, Some("foreign_owner")),
        Err(_) => (None, None, Some("unavailable")),
    };

    let (tx, rx) = mpsc::channel::<Ev>();
    let menu_tx = tx.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(move |_app, event| {
            let _ = menu_tx.send(Ev::Menu(event.id().0.clone()));
        })
        .build(tauri::generate_context!())
        .expect("the desktop shell could not start");

    if let Some(listener) = listener {
        let tx = tx.clone();
        single_instance::serve(listener, move || {
            let _ = tx.send(Ev::Raise);
        });
    }

    #[cfg(feature = "smoke-probe")]
    probe::control({
        let tx = tx.clone();
        move |command| {
            let _ = tx.send(match command {
                probe::Command::Menu(id) => Ev::Menu(id),
                probe::Command::Js(code) => Ev::ProbeJs(code),
                probe::Command::DevtoolsOpen => Ev::ProbeDevtools,
                probe::Command::Recent(n) => Ev::ProbeRecent(n),
            });
        }
    });

    let launcher = host_launcher(&app);
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
            launcher,
            cwd,
            host: None,
            window: None,
            picking: false,
            instance,
            page: Arc::new(Mutex::new(None)),
            language: Arc::new(Mutex::new(Language::Chinese)),
            version: version.clone(),
            #[cfg(feature = "smoke-probe")]
            recent_ids: vec![],
        };
        shell.run(rx, &version, &webview, unguarded);
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

/// Which host to run: the bundle's own (a packaged build, `--features packaged`) or the repository's build.
#[cfg(feature = "packaged")]
fn host_launcher(app: &tauri::App) -> HostLauncher {
    use tauri::Manager;
    // No resource directory to be had: a path that does not exist, so the host fails to start and the crash dialog
    // says so, instead of quietly running something else.
    let resources = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("/nonexistent/argelanderspace-resources"));
    HostLauncher::packaged(&resources)
}

#[cfg(not(feature = "packaged"))]
fn host_launcher(_app: &tauri::App) -> HostLauncher {
    HostLauncher::development()
}

impl Shell {
    fn run(
        mut self,
        rx: Receiver<Ev>,
        version: &str,
        webview: &str,
        unguarded: Option<&'static str>,
    ) {
        let mut first = self.sup.start(version, webview, unguarded);
        // The menu before any host has said more: its own words, no recent projects yet.
        first.insert(
            0,
            Action::SetMenu(MenuModel {
                language: self.sup.language(),
                recent: vec![],
            }),
        );
        self.act(first);
        while let Ok(ev) = rx.recv() {
            let actions = match ev {
                Ev::Line { attempt, line } => {
                    if self.host.as_ref().map(|h| h.attempt) != Some(attempt) {
                        continue;
                    }
                    let line = protocol::parse_host_line(&line);
                    // A host told where the log is: the shell's own file may be tried again there.
                    if matches!(&line, HostLine::Ready(r) if r.log_dir.is_some())
                        || matches!(
                            &line,
                            HostLine::Failed {
                                log_dir: Some(_),
                                ..
                            }
                        )
                    {
                        self.log.retry();
                    }
                    self.sup.on_line(line)
                }
                Ev::LineRejected { attempt, reason } => {
                    if self.host.as_ref().map(|h| h.attempt) != Some(attempt) {
                        continue;
                    }
                    self.sup.on_line_rejected(reason)
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
                // On the way out the hidden window is not brought back.
                Ev::Raise if self.sup.quitting() => vec![],
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
                Ev::WindowFailed(stage) => {
                    if let Some(window) = self.window.take() {
                        let _ = window.destroy();
                    }
                    self.sup.on_window_failed(stage)
                }
                Ev::NavigationBlocked(scheme, source) => {
                    self.sup.on_navigation_blocked(scheme, source)
                }
                Ev::OpenLink(url, source) => {
                    // Only http/https reach here (navigation.rs); one argument to the system's opener, no shell.
                    #[cfg(feature = "smoke-probe")]
                    let opened = probe::record_opened(url.as_str(), source)
                        || open::that_detached(url.as_str()).is_ok();
                    #[cfg(not(feature = "smoke-probe"))]
                    let opened = open::that_detached(url.as_str()).is_ok();
                    self.sup.on_link_opened(source, opened)
                }
                Ev::Download(outcome) => self.sup.on_download(outcome),
                Ev::Menu(id) => match menu::choice(&id) {
                    Some(choice) => {
                        // Quit is closing the window: it goes away at once, as on its close button.
                        if choice == menu::MenuChoice::Quit && !self.sup.quitting() {
                            if let Some(window) = &self.window {
                                let _ = window.hide();
                            }
                        }
                        self.sup.on_menu(choice)
                    }
                    None => vec![],
                },
                #[cfg(feature = "smoke-probe")]
                Ev::ProbeRecent(n) => match self.recent_ids.get(n) {
                    Some(id) => match menu::choice(&menu::recent_id(id)) {
                        Some(choice) => self.sup.on_menu(choice),
                        None => vec![],
                    },
                    None => vec![],
                },
                #[cfg(feature = "smoke-probe")]
                Ev::ProbeDevtools => {
                    if let Some(window) = &self.window {
                        probe::report_devtools(window);
                    }
                    vec![]
                }
                #[cfg(feature = "smoke-probe")]
                Ev::ProbeJs(code) => {
                    if let Some(window) = &self.window {
                        probe::eval(window, code);
                    }
                    vec![]
                }
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
                Action::ShowPage(url) => self.show_page(&url),
                Action::Handle(request) => self.handle(request),
                Action::CrashDialog(language) => {
                    self.crash_dialog(language);
                    vec![]
                }
                Action::SetMenu(model) => {
                    #[cfg(feature = "smoke-probe")]
                    {
                        self.recent_ids = model.recent.iter().map(|r| r.id.clone()).collect();
                    }
                    if let Ok(mut language) = self.language.lock() {
                        *language = model.language;
                    }
                    if let Ok(menu) = menu::build(&self.app, &model) {
                        let _ = self.app.set_menu(menu);
                    }
                    vec![]
                }
                Action::About(language) => {
                    self.about(language);
                    vec![]
                }
                Action::DownloadFailedDialog(language) => {
                    self.download_failed(language);
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
                    // The host's whole process group or job (launch.rs): its own children go with it.
                    if let Some(host) = &self.host {
                        if !host.group.as_ref().is_some_and(|g| g.kill()) {
                            let _ = host.child.lock().map(|mut c| c.kill());
                        }
                    }
                    vec![]
                }
                Action::Exit => {
                    if let Some(instance) = self.instance.take() {
                        instance.release();
                    }
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
        let group = launch::HostGroup::of(&child);
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
                // At most the host's own line limit; a line too long or not UTF-8 is skipped, and reading goes on.
                protocol::read_lines(BufReader::new(stdout), protocol::LINE_MAX_BYTES, |read| {
                    let ev = match read {
                        LineRead::Line(line) => Ev::Line { attempt, line },
                        LineRead::TooLong => Ev::LineRejected {
                            attempt,
                            reason: "too_long",
                        },
                        LineRead::NotUtf8 => Ev::LineRejected {
                            attempt,
                            reason: "not_utf8",
                        },
                    };
                    tx.send(ev).is_ok()
                });
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
                #[cfg(unix)]
                Some(status) => {
                    use std::os::unix::process::ExitStatusExt;
                    (status.code(), status.signal())
                }
                // No signals on Windows: a forced end is an exit code.
                #[cfg(not(unix))]
                Some(status) => (status.code(), None),
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
            group,
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

    fn show_page(&mut self, url: &str) -> Vec<Action> {
        // The supervisor only passes addresses `protocol::is_local_page` accepted, which parse.
        let Ok(parsed) = tauri::Url::parse(url) else {
            return vec![];
        };
        // Before the load: the navigation to it is checked against it.
        if let Ok(mut page) = self.page.lock() {
            *page = Some(parsed.clone());
        }
        if let Some(window) = &self.window {
            let _ = window.navigate(parsed);
            return vec![];
        }
        // The window starts blank; the page is loaded once Tauri's scripts are out of the webview (page_guard.rs).
        let Ok(blank) = tauri::Url::parse("about:blank") else {
            return vec![];
        };
        let page = Arc::clone(&self.page);
        let tx = self.tx.clone();
        let new_window_tx = self.tx.clone();
        let builder = WebviewWindowBuilder::new(&self.app, WINDOW, WebviewUrl::External(blank))
            .title("ArgelanderSpace")
            .inner_size(1280.0, 820.0)
            .min_inner_size(720.0, 480.0)
            .on_navigation(move |target| {
                let shown = page.lock().ok().and_then(|p| p.clone());
                link_verdict(
                    &tx,
                    navigation::on_navigation(target, shown.as_ref()),
                    "navigation",
                )
            })
            // `target=_blank` and `window.open`: never a second window; http(s) to the system browser.
            .on_new_window(move |target, _features| {
                link_verdict(
                    &new_window_tx,
                    navigation::on_new_window(&target),
                    "new_window",
                );
                NewWindowResponse::Deny
            });
        // Linux: no `on_download`, the shell connects to WebKit's downloads itself (download.rs), before the page loads.
        // macOS and Windows: Tauri's `on_download` with the system's save dialog (download.rs).
        #[cfg(not(target_os = "linux"))]
        let builder = {
            let tx = self.tx.clone();
            builder.on_download(download::on_download(
                Arc::clone(&self.language),
                move |outcome: download::Outcome| {
                    let _ = tx.send(Ev::Download(outcome.name()));
                },
            ))
        };
        #[cfg(feature = "smoke-probe")]
        let builder = probe::attach(builder);
        // No window, or no way to keep Tauri out of it: no page, and the app quits (supervisor `on_window_failed`).
        let Ok(window) = builder.build() else {
            return self.sup.on_window_failed("create");
        };
        #[cfg(target_os = "linux")]
        {
            let tx = self.tx.clone();
            let language = Arc::clone(&self.language);
            let attached = window.with_webview(move |platform| {
                let report_tx = tx.clone();
                let report = move |outcome: download::Outcome| {
                    let _ = report_tx.send(Ev::Download(outcome.name()));
                };
                // No context to take the downloads from: the window is not used (as an unguarded page is not).
                if !download::attach(&platform.inner(), language, report) {
                    let _ = tx.send(Ev::WindowFailed("guard"));
                }
            });
            if attached.is_err() {
                let _ = window.destroy();
                return self.sup.on_window_failed("guard");
            }
        }
        let tx = self.tx.clone();
        let on_failed = move || {
            let _ = tx.send(Ev::WindowFailed("guard"));
        };
        #[cfg(feature = "smoke-probe")]
        let loaded = if probe::keep_entries() {
            window.navigate(parsed)
        } else {
            page_guard::strip_and_load(&window, parsed.to_string(), on_failed)
        };
        #[cfg(not(feature = "smoke-probe"))]
        let loaded = page_guard::strip_and_load(&window, parsed.to_string(), on_failed);
        if loaded.is_err() {
            let _ = window.destroy();
            return self.sup.on_window_failed("guard");
        }
        let tx = self.tx.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = tx.send(Ev::CloseRequested);
            }
        });
        self.window = Some(window);
        vec![]
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
            // The bundled skills (desktop-app ticket 24): the folder the host found next to its bundle.
            Request::OpenSkillsFolder { path } => self.open(kind, &path, true),
            // The host's own page address (protocol.rs checked its form): the same page in the system browser.
            Request::OpenInBrowser { url } => match open::that_detached(&url) {
                Ok(()) => vec![],
                Err(_) => self.sup.request_failed(kind, "open_failed"),
            },
            // Release builds too (the `devtools` feature): spec User Story 74.
            Request::OpenDevtools => match &self.window {
                Some(window) => {
                    window.open_devtools();
                    vec![]
                }
                None => self.sup.request_failed(kind, "no_window"),
            },
        }
    }

    /// "About": the name and the version, in a native message dialog. Its title is "About ArgelanderSpace"; the body
    /// is the name and the version only (not the title again, as the dialog plugin's would put it: user ruling 2).
    /// Linux: a GTK message dialog with the version as its secondary text.
    #[cfg(target_os = "linux")]
    fn about(&mut self, language: Language) {
        let text = MenuText::of(language);
        let (name, version) = text.about_body(&self.version);
        let (title, ok) = (text.about_title, text.ok);
        let window = self.window.clone();
        let _ = self.app.run_on_main_thread(move || {
            let parent = window.as_ref().and_then(|w| w.gtk_window().ok());
            menu::show_about(parent.as_ref(), title, name, &version, ok);
        });
    }

    /// macOS and Windows: the system's message dialog (the dialog plugin), the name and the version on two lines.
    #[cfg(not(target_os = "linux"))]
    fn about(&mut self, language: Language) {
        let text = MenuText::of(language);
        let (name, version) = text.about_body(&self.version);
        let mut dialog = self
            .app
            .dialog()
            .message(format!("{name}\n{version}"))
            .title(text.about_title)
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCustom(text.ok.into()));
        if let Some(window) = &self.window {
            dialog = dialog.parent(window);
        }
        dialog.show(|_| {});
    }

    /// A download that could not be saved: said in a native dialog (where it was to go is not said or recorded).
    fn download_failed(&mut self, language: Language) {
        let text = download::SaveText::of(language);
        let mut dialog = self
            .app
            .dialog()
            .message(text.failed)
            .title(text.failed_title)
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCustom(
                MenuText::of(language).ok.into(),
            ));
        if let Some(window) = &self.window {
            dialog = dialog.parent(window);
        }
        dialog.show(|_| {});
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
                MessageDialogResult::Custom(label) if label == text.restart => CrashChoice::Restart,
                MessageDialogResult::Custom(label) if label == text.show_logs => {
                    CrashChoice::ShowLogFolder
                }
                // The quit button, and closing the dialog (GTK answers a close as cancel): quit (user ruling 3).
                _ => CrashChoice::Quit,
            };
            let _ = tx.send(Ev::CrashChoice(choice));
        });
    }
}

/// What the window does with an address (`navigation.rs`): stays for the local page; an http(s) link goes to the
/// system browser and a stopped one is recorded, by the shell's thread.
fn link_verdict(tx: &Sender<Ev>, verdict: Verdict, source: &'static str) -> bool {
    match verdict {
        Verdict::Stay => true,
        Verdict::Browser(url) => {
            let _ = tx.send(Ev::OpenLink(url, source));
            false
        }
        Verdict::Blocked(scheme) => {
            let _ = tx.send(Ev::NavigationBlocked(scheme, source));
            false
        }
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
