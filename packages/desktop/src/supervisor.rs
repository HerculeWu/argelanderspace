//! What the shell does about the host: when to start one (and for which project), what a line or an exit means,
//! where the shell's own events go. Pure: it hands back `Action`s, and `main.rs` carries them out. No business logic —
//! the host decides everything about projects; this only follows its lines (docs/architecture.md「桌面壳」).

use serde_json::{json, Map, Value};

use crate::protocol::{self, FailedStage, HostLine, Language, LogLevel, Request};

/// How the crash dialog was answered. Closing it without a button is `Quit` (user ruling 3, desktop-app ticket 20):
/// the GTK dialog answers a close as its cancel button, which is the quit button, so the two cannot be told apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashChoice {
    Restart,
    ShowLogFolder,
    Quit,
}

impl CrashChoice {
    fn name(self) -> &'static str {
        match self {
            CrashChoice::Restart => "restart",
            CrashChoice::ShowLogFolder => "show_log_folder",
            CrashChoice::Quit => "quit",
        }
    }
}

/// One of the shell's events, as the host's `SHELL_EVENTS` table names it.
#[derive(Debug, Clone, PartialEq)]
pub struct ShellEvent {
    pub event: &'static str,
    pub level: &'static str,
    pub fields: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Start a host; `project` is its `--project` (none: the host chooses, or the welcome state).
    Spawn {
        project: Option<String>,
    },
    /// Write a line to the running host.
    Send(String),
    /// Show the page at this address (create the window the first time).
    ShowPage(String),
    /// Carry out a native request.
    Handle(Request),
    /// Show the host-crashed dialog.
    CrashDialog(Language),
    OpenFolder(String),
    /// Write these events to the shell's own file in the log directory (no host to give them to).
    WriteEvents {
        log_dir: String,
        events: Vec<ShellEvent>,
    },
    /// Force the running host to end if it is still there after the shutdown limit.
    ArmDeadline {
        attempt: u32,
    },
    Kill,
    Exit,
}

/// How long the shell waits, after its quit line, for the host to shut down before it ends the host (the host's own
/// limit for a shutdown without its shell is the same, server `HOST_STOP_DEADLINE_MS`).
pub const QUIT_DEADLINE_MS: u64 = 10_000;

/// Names a signal the way the host's `shell.host_exited` table does.
pub fn signal_name(signal: i32) -> &'static str {
    match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        6 => "SIGABRT",
        7 => "SIGBUS",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        15 => "SIGTERM",
        _ => "other",
    }
}

/// What happens after a host exits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AfterExit {
    Exit,
    Restart { project: Option<String> },
    CrashDialog,
}

/// The decision itself: the shell asked it to quit → the app ends; it left for another project (`stopped` with
/// `next`) → the next host for that project; the folder given with `--project` was not there → a host without
/// `--project`, which goes to the welcome state (once: a host started without `--project` cannot fail that way); any
/// other exit — a crash, a server that could not start, a stop nobody asked for — is unexpected: the crash dialog.
pub fn after_exit(
    quitting: bool,
    stopped_next: Option<&Option<String>>,
    failed: Option<FailedStage>,
    launched_with_project: bool,
) -> AfterExit {
    if quitting {
        return AfterExit::Exit;
    }
    if let Some(Some(next)) = stopped_next {
        return AfterExit::Restart {
            project: Some(next.clone()),
        };
    }
    if failed == Some(FailedStage::Project) && launched_with_project {
        return AfterExit::Restart { project: None };
    }
    AfterExit::CrashDialog
}

#[derive(Debug, Default)]
struct CurrentHost {
    /// The `--project` it was started with.
    project: Option<String>,
    alive: bool,
    ready: bool,
    stopping: bool,
    stopped_next: Option<Option<String>>,
    failed: Option<FailedStage>,
}

#[derive(Debug)]
pub struct Supervisor {
    /// Hosts started so far by this shell run.
    attempt: u32,
    host: CurrentHost,
    quitting: bool,
    log_dir: Option<String>,
    /// The level the shell's own file is written at: the last one a host reported, else the log's default.
    log_level: LogLevel,
    language: Language,
    /// Events not handed to a host yet: given to the next ready host, or written to the shell's file.
    pending: Vec<ShellEvent>,
    exiting: bool,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Supervisor {
    pub fn new() -> Self {
        Supervisor {
            attempt: 0,
            host: CurrentHost::default(),
            quitting: false,
            log_dir: None,
            log_level: LogLevel::DEFAULT,
            language: Language::Chinese,
            pending: Vec::new(),
            exiting: false,
        }
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    #[cfg(test)]
    fn log_dir(&self) -> Option<&str> {
        self.log_dir.as_deref()
    }

    /// Whether the app is on its way out (the window was closed, or quit was chosen).
    pub fn quitting(&self) -> bool {
        self.quitting
    }

    /// The shell started: its first event and its first host (which chooses the project itself). `unguarded`: why
    /// the shell runs without the single-instance guard (`unavailable`, `foreign_owner`), if it does.
    pub fn start(
        &mut self,
        version: &str,
        webview: &str,
        unguarded: Option<&'static str>,
    ) -> Vec<Action> {
        self.record(
            "shell.started",
            "info",
            [
                ("version", json!(id_value(version))),
                ("webview", json!(id_value(webview))),
            ],
        );
        if let Some(reason) = unguarded {
            self.record(
                "shell.instance_unguarded",
                "warn",
                [("reason", json!(reason))],
            );
        }
        vec![Action::Spawn { project: None }]
    }

    /// The window could not be made (`create`) or Tauri's entry points could not be taken out of it (`guard`): the
    /// page is not loaded, and the app ends as on a close — the host is asked to quit, the limit applies — rather than
    /// staying on without a window and holding the single instance.
    pub fn on_window_failed(&mut self, stage: &'static str) -> Vec<Action> {
        let mut actions = self.record("shell.window_failed", "warn", [("stage", json!(stage))]);
        actions.extend(self.on_close_requested());
        actions
    }

    /// The page tried to go somewhere other than the local page (`scheme`: `http`, `https` or `other`); it was stopped.
    pub fn on_navigation_blocked(&mut self, scheme: &'static str) -> Vec<Action> {
        self.record(
            "shell.navigation_blocked",
            "warn",
            [("scheme", json!(scheme))],
        )
    }

    /// A line of the host's output was skipped (`reason`: `too_long`, `not_utf8`).
    pub fn on_line_rejected(&mut self, reason: &'static str) -> Vec<Action> {
        self.record("shell.line_rejected", "warn", [("reason", json!(reason))])
    }

    /// A host was started (`Spawn` carried out) with this process id.
    pub fn spawned(&mut self, project: Option<String>, pid: u32) {
        self.attempt += 1;
        self.host = CurrentHost {
            project,
            alive: true,
            ..CurrentHost::default()
        };
        self.record(
            "shell.host_started",
            "info",
            [("pid", json!(pid)), ("attempt", json!(self.attempt))],
        );
    }

    /// A host could not even be started (no node, no entry): as if it had crashed at once.
    pub fn spawn_failed(&mut self, project: Option<String>) -> Vec<Action> {
        self.attempt += 1;
        self.host = CurrentHost {
            project,
            ..CurrentHost::default()
        };
        self.record("shell.host_exited", "warn", [("expected", json!("no"))]);
        self.unexpected()
    }

    pub fn on_line(&mut self, line: HostLine) -> Vec<Action> {
        match line {
            HostLine::Ready(ready) => {
                self.host.ready = true;
                if ready.log_dir.is_some() {
                    self.log_dir = ready.log_dir.clone();
                }
                self.language = ready.language;
                self.log_level = ready.log_level;
                let mut actions = vec![Action::ShowPage(ready.url)];
                for event in self.pending.drain(..) {
                    actions.push(Action::Send(protocol::shell_event_line(
                        event.event,
                        &event.fields,
                    )));
                }
                actions
            }
            HostLine::Request(request) => {
                if self.host.stopping || self.quitting {
                    return vec![];
                }
                vec![Action::Handle(request)]
            }
            HostLine::Stopping { .. } => {
                self.host.stopping = true;
                vec![]
            }
            HostLine::Stopped { next } => {
                self.host.stopping = true;
                self.host.stopped_next = Some(next);
                vec![]
            }
            HostLine::Failed { stage, log_dir } => {
                self.host.failed = Some(stage);
                if log_dir.is_some() {
                    self.log_dir = log_dir;
                }
                vec![]
            }
            HostLine::Unknown => vec![],
        }
    }

    /// The host process ended (`signal` when a signal ended it). `duration_ms` since it was started.
    pub fn on_exit(
        &mut self,
        exit_code: Option<i32>,
        signal: Option<i32>,
        duration_ms: f64,
    ) -> Vec<Action> {
        self.host.alive = false;
        self.host.ready = false;
        let decision = after_exit(
            self.quitting,
            self.host.stopped_next.as_ref(),
            self.host.failed,
            self.host.project.is_some(),
        );
        let expected = decision != AfterExit::CrashDialog;
        let mut fields: Vec<(&str, Value)> = Vec::new();
        if let Some(code) = exit_code {
            fields.push(("exit_code", json!(code)));
        }
        if let Some(signal) = signal {
            fields.push(("signal", json!(signal_name(signal))));
        }
        fields.push(("expected", json!(if expected { "yes" } else { "no" })));
        fields.push((
            "duration_ms",
            json!((duration_ms.max(0.0) * 10.0).round() / 10.0),
        ));
        self.record(
            "shell.host_exited",
            if expected { "info" } else { "warn" },
            fields,
        );
        match decision {
            AfterExit::Exit => self.exit(),
            AfterExit::Restart { project } => vec![Action::Spawn { project }],
            AfterExit::CrashDialog => self.unexpected(),
        }
    }

    fn unexpected(&mut self) -> Vec<Action> {
        if self.quitting {
            return self.exit();
        }
        let mut actions = self.flush_to_file();
        actions.push(Action::CrashDialog(self.language));
        actions
    }

    /// The window's close button: quit. The host is asked to shut down and given `QUIT_DEADLINE_MS`.
    pub fn on_close_requested(&mut self) -> Vec<Action> {
        if self.quitting {
            return vec![];
        }
        self.quitting = true;
        if self.host.alive {
            vec![
                Action::Send(protocol::quit_line()),
                Action::ArmDeadline {
                    attempt: self.attempt,
                },
            ]
        } else {
            self.exit()
        }
    }

    /// The shutdown limit passed for host `attempt`.
    pub fn on_deadline(&mut self, attempt: u32) -> Vec<Action> {
        if attempt == self.attempt && self.host.alive {
            vec![Action::Kill]
        } else {
            vec![]
        }
    }

    pub fn on_crash_choice(&mut self, choice: CrashChoice) -> Vec<Action> {
        self.record(
            "shell.dialog_answered",
            "info",
            [
                ("dialog", json!("host_crashed")),
                ("choice", json!(choice.name())),
            ],
        );
        match choice {
            CrashChoice::Restart => vec![Action::Spawn {
                project: self.host.project.clone(),
            }],
            CrashChoice::ShowLogFolder => {
                let mut actions = self.flush_to_file();
                if let Some(dir) = &self.log_dir {
                    actions.push(Action::OpenFolder(dir.clone()));
                }
                actions.push(Action::CrashDialog(self.language));
                actions
            }
            CrashChoice::Quit => {
                self.quitting = true;
                self.exit()
            }
        }
    }

    /// The answer of the folder dialog for host `attempt`'s request `id`: given to that host only.
    pub fn on_folder_picked(&mut self, attempt: u32, id: &str, path: Option<&str>) -> Vec<Action> {
        if attempt != self.attempt || !self.host.alive || self.host.stopping {
            return vec![];
        }
        vec![Action::Send(protocol::folder_picked_line(id, path))]
    }

    /// A native request could not be carried out (`code`: a short fixed word).
    pub fn request_failed(&mut self, request: &'static str, code: &'static str) -> Vec<Action> {
        self.record(
            "shell.request_failed",
            "warn",
            [("request", json!(request)), ("code", json!(code))],
        )
    }

    fn exit(&mut self) -> Vec<Action> {
        if self.exiting {
            return vec![];
        }
        self.exiting = true;
        let mut actions = self.flush_to_file();
        actions.push(Action::Exit);
        actions
    }

    fn flush_to_file(&mut self) -> Vec<Action> {
        if self.pending.is_empty() {
            return vec![];
        }
        // The shell's file follows the log's level, as the host's own records do.
        let level = self.log_level;
        let events: Vec<ShellEvent> = self
            .pending
            .drain(..)
            .filter(|event| level.admits(event.level))
            .collect();
        if events.is_empty() {
            return vec![];
        }
        match &self.log_dir {
            Some(dir) => vec![Action::WriteEvents {
                log_dir: dir.clone(),
                events,
            }],
            // No host ever said where the log is: these events are lost.
            None => vec![],
        }
    }

    /// An event goes to the running, ready host at once; otherwise it waits (next host, or the shell's file).
    fn record<'a>(
        &mut self,
        event: &'static str,
        level: &'static str,
        fields: impl IntoIterator<Item = (&'a str, Value)>,
    ) -> Vec<Action> {
        let fields: Map<String, Value> =
            fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
        let event = ShellEvent {
            event,
            level,
            fields,
        };
        if self.host.alive && self.host.ready && !self.host.stopping {
            vec![Action::Send(protocol::shell_event_line(
                event.event,
                &event.fields,
            ))]
        } else {
            self.pending.push(event);
            vec![]
        }
    }
}

/// An identifier-like value for the log (the host checks it again): ASCII without whitespace or `@`, at most 128
/// characters; anything else is the placeholder the log uses.
pub fn id_value(value: &str) -> String {
    let ok = !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|c| c.is_ascii_graphic() && c != '@');
    if ok {
        value.to_owned()
    } else {
        "<invalid-id>".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{parse_host_line, Ready};

    fn ready(project: Option<&str>) -> HostLine {
        HostLine::Ready(Ready {
            url: "http://127.0.0.1:1859/".into(),
            port: 1859,
            project: project.map(str::to_owned),
            log_dir: Some("/h/logs".into()),
            language: Language::Chinese,
            log_level: LogLevel::Info,
        })
    }

    fn sent_events(actions: &[Action]) -> Vec<String> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Send(line) => {
                    let v: Value = serde_json::from_str(line).unwrap();
                    v.get("event").and_then(Value::as_str).map(str::to_owned)
                }
                _ => None,
            })
            .collect()
    }

    fn written(actions: &[Action]) -> Vec<(&'static str, Map<String, Value>)> {
        actions
            .iter()
            .flat_map(|a| match a {
                Action::WriteEvents { events, .. } => {
                    events.iter().map(|e| (e.event, e.fields.clone())).collect()
                }
                _ => vec![],
            })
            .collect()
    }

    #[test]
    fn the_decision_after_an_exit() {
        assert_eq!(after_exit(true, None, None, false), AfterExit::Exit);
        assert_eq!(
            after_exit(true, Some(&Some("/n".into())), None, false),
            AfterExit::Exit
        );
        assert_eq!(
            after_exit(false, Some(&Some("/n".into())), None, true),
            AfterExit::Restart {
                project: Some("/n".into())
            }
        );
        // The folder named by a switch is gone by the time the next host starts: the welcome state.
        assert_eq!(
            after_exit(false, None, Some(FailedStage::Project), true),
            AfterExit::Restart { project: None }
        );
        // ...but never a loop: a host without --project cannot fail that way, and if it says so it is a crash.
        assert_eq!(
            after_exit(false, None, Some(FailedStage::Project), false),
            AfterExit::CrashDialog
        );
        assert_eq!(
            after_exit(false, None, Some(FailedStage::Start), true),
            AfterExit::CrashDialog
        );
        assert_eq!(after_exit(false, None, None, false), AfterExit::CrashDialog);
        // A stop nobody asked for (someone sent the host SIGTERM): unexpected.
        assert_eq!(
            after_exit(false, Some(&None), None, false),
            AfterExit::CrashDialog
        );
    }

    #[test]
    fn start_ready_then_close() {
        let mut s = Supervisor::new();
        assert_eq!(
            s.start("0.1.0", "2.52.6", None),
            vec![Action::Spawn { project: None }]
        );
        s.spawned(None, 100);
        let actions = s.on_line(ready(Some("/p")));
        assert_eq!(
            actions[0],
            Action::ShowPage("http://127.0.0.1:1859/".into())
        );
        // What happened before the host was ready is handed to it now.
        assert_eq!(
            sent_events(&actions),
            vec!["shell.started", "shell.host_started"]
        );
        let actions = s.on_close_requested();
        assert_eq!(
            actions,
            vec![
                Action::Send(r#"{"type":"quit"}"#.into()),
                Action::ArmDeadline { attempt: 1 }
            ]
        );
        assert!(
            s.on_close_requested().is_empty(),
            "a second close changes nothing"
        );
        s.on_line(parse_host_line(r#"{"type":"stopping","reason":"quit"}"#));
        s.on_line(parse_host_line(r#"{"type":"stopped"}"#));
        let actions = s.on_exit(Some(0), None, 1234.56);
        assert_eq!(actions.last(), Some(&Action::Exit));
        let events = written(&actions);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "shell.host_exited");
        assert_eq!(
            Value::Object(events[0].1.clone()),
            json!({"exit_code":0,"expected":"yes","duration_ms":1234.6})
        );
        assert!(matches!(&actions[0], Action::WriteEvents { log_dir, .. } if log_dir == "/h/logs"));
    }

    #[test]
    fn the_deadline_kills_only_the_host_it_was_set_for() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(None, 1);
        s.on_line(ready(None));
        s.on_close_requested();
        assert_eq!(s.on_deadline(1), vec![Action::Kill]);
        assert!(s.on_deadline(2).is_empty());
        let actions = s.on_exit(None, Some(9), 10_000.0);
        assert_eq!(actions.last(), Some(&Action::Exit));
        let events = written(&actions);
        assert_eq!(
            Value::Object(events[0].1.clone()),
            json!({"signal":"SIGKILL","expected":"yes","duration_ms":10000.0})
        );
        assert!(s.on_deadline(1).is_empty(), "the host is gone");
    }

    #[test]
    fn a_switch_starts_the_next_host_for_next_and_keeps_the_events_for_it() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(None, 1);
        s.on_line(ready(None));
        s.on_line(parse_host_line(r#"{"type":"stopping","reason":"switch"}"#));
        s.on_line(parse_host_line(r#"{"type":"stopped","next":"/p/next"}"#));
        let actions = s.on_exit(Some(0), None, 5.0);
        assert_eq!(
            actions,
            vec![Action::Spawn {
                project: Some("/p/next".into())
            }]
        );
        s.spawned(Some("/p/next".into()), 2);
        let actions = s.on_line(ready(Some("/p/next")));
        assert_eq!(
            actions[0],
            Action::ShowPage("http://127.0.0.1:1859/".into())
        );
        assert_eq!(
            sent_events(&actions),
            vec!["shell.host_exited", "shell.host_started"]
        );
    }

    #[test]
    fn the_next_project_gone_before_its_host_starts_is_the_welcome_state_not_a_crash() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(Some("/p/gone".into()), 1);
        s.on_line(parse_host_line(
            r#"{"type":"failed","stage":"project","logDir":"/h/logs"}"#,
        ));
        let actions = s.on_exit(Some(1), None, 80.0);
        assert_eq!(actions, vec![Action::Spawn { project: None }]);
        assert_eq!(s.log_dir(), Some("/h/logs"));
        s.spawned(None, 2);
        let actions = s.on_line(ready(None));
        let exited: Vec<_> = actions
            .iter()
            .filter_map(|a| match a {
                Action::Send(l) if l.contains("host_exited") => {
                    Some(serde_json::from_str::<Value>(l).unwrap())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            exited[0]["fields"],
            json!({"exit_code":1,"expected":"yes","duration_ms":80.0})
        );
    }

    #[test]
    fn a_crash_shows_the_dialog_and_its_three_answers_act() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(Some("/p".into()), 1);
        s.on_line(ready(Some("/p")));
        let actions = s.on_exit(None, Some(9), 3000.0);
        assert_eq!(
            actions.last(),
            Some(&Action::CrashDialog(Language::Chinese))
        );
        let events = written(&actions);
        assert_eq!(events[0].0, "shell.host_exited");
        assert_eq!(events[0].1["expected"], json!("no"));
        assert_eq!(events[0].1["signal"], json!("SIGKILL"));

        // Show the log folder: the folder opens and the dialog comes back.
        let actions = s.on_crash_choice(CrashChoice::ShowLogFolder);
        assert_eq!(
            actions[1..],
            [
                Action::OpenFolder("/h/logs".into()),
                Action::CrashDialog(Language::Chinese)
            ]
        );
        assert_eq!(written(&actions)[0].1["choice"], json!("show_log_folder"));

        // Restart: the same project again; the answer goes to the new host.
        let actions = s.on_crash_choice(CrashChoice::Restart);
        assert_eq!(
            actions,
            vec![Action::Spawn {
                project: Some("/p".into())
            }]
        );
        s.spawned(Some("/p".into()), 2);
        assert_eq!(
            sent_events(&s.on_line(ready(Some("/p")))),
            vec!["shell.dialog_answered", "shell.host_started"]
        );

        // Crash again, then quit: the app ends and the answer is in the shell's file.
        s.on_exit(Some(1), None, 10.0);
        let actions = s.on_crash_choice(CrashChoice::Quit);
        assert_eq!(actions.last(), Some(&Action::Exit));
        assert_eq!(written(&actions)[0].1["choice"], json!("quit"));
    }

    #[test]
    fn a_server_that_cannot_start_is_a_crash_and_its_failed_line_names_the_log() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(None, 1);
        s.on_line(parse_host_line(
            r#"{"type":"failed","stage":"start","logDir":"/x/logs"}"#,
        ));
        let actions = s.on_exit(Some(1), None, 300.0);
        assert!(
            matches!(&actions[0], Action::WriteEvents { log_dir, events }
            if log_dir == "/x/logs" && events.iter().map(|e| e.event).collect::<Vec<_>>()
                == ["shell.started", "shell.host_started", "shell.host_exited"])
        );
        assert_eq!(
            actions.last(),
            Some(&Action::CrashDialog(Language::Chinese))
        );
    }

    #[test]
    fn no_log_directory_known_the_events_are_dropped() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        let actions = s.spawn_failed(None);
        assert_eq!(actions, vec![Action::CrashDialog(Language::Chinese)]);
        assert_eq!(s.on_crash_choice(CrashChoice::Quit), vec![Action::Exit]);
    }

    #[test]
    fn a_window_that_cannot_be_made_is_recorded_and_the_app_quits() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(None, 1);
        s.on_line(ready(None));
        let actions = s.on_window_failed("guard");
        assert_eq!(
            sent_events(&actions),
            vec!["shell.window_failed"],
            "told to the running host"
        );
        assert_eq!(
            actions[1..],
            [
                Action::Send(r#"{"type":"quit"}"#.into()),
                Action::ArmDeadline { attempt: 1 }
            ]
        );
        assert!(s.quitting());
        let actions = s.on_exit(Some(0), None, 9.0);
        assert_eq!(actions.last(), Some(&Action::Exit));
    }

    #[test]
    fn the_shells_file_follows_the_reported_level() {
        let mut s = Supervisor::new();
        s.start("v", "w", Some("foreign_owner"));
        s.spawned(None, 1);
        let HostLine::Ready(mut r) = ready(None) else {
            unreachable!()
        };
        r.log_level = LogLevel::Warn;
        let actions = s.on_line(HostLine::Ready(r));
        // Handed to a host, every event goes: the host's logger applies its own level.
        assert_eq!(
            sent_events(&actions),
            vec![
                "shell.started",
                "shell.instance_unguarded",
                "shell.host_started"
            ]
        );
        s.on_navigation_blocked("https");
        s.on_line_rejected("not_utf8");
        // Written by the shell itself: only what the level admits (the info-level clean exit is left out).
        s.on_close_requested();
        let actions = s.on_exit(None, Some(9), 10.0);
        let names: Vec<_> = written(&actions).into_iter().map(|(e, _)| e).collect();
        assert_eq!(
            names,
            Vec::<&str>::new(),
            "host_exited after a quit is info"
        );
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(None, 1);
        s.on_line(parse_host_line(
            r#"{"type":"ready","url":"http://127.0.0.1:1/","port":1,"project":null,"logDir":"/l","logLevel":"warn"}"#,
        ));
        let actions = s.on_exit(None, Some(9), 10.0);
        let names: Vec<_> = written(&actions).into_iter().map(|(e, _)| e).collect();
        assert_eq!(names, vec!["shell.host_exited"], "the crash is a warning");
    }

    #[test]
    fn with_no_host_reporting_a_level_the_default_applies() {
        let mut s = Supervisor::new();
        s.start("v", "w", Some("unavailable"));
        s.spawned(None, 1);
        s.on_line(parse_host_line(
            r#"{"type":"failed","stage":"start","logDir":"/x/logs"}"#,
        ));
        let actions = s.on_exit(Some(1), None, 300.0);
        let names: Vec<_> = written(&actions).into_iter().map(|(e, _)| e).collect();
        assert_eq!(
            names,
            vec![
                "shell.started",
                "shell.instance_unguarded",
                "shell.host_started",
                "shell.host_exited"
            ]
        );
    }

    #[test]
    fn navigation_and_line_events_go_to_the_running_host() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(None, 1);
        s.on_line(ready(None));
        let actions = s.on_navigation_blocked("other");
        let Action::Send(line) = &actions[0] else {
            panic!("{actions:?}")
        };
        assert_eq!(
            serde_json::from_str::<Value>(line).unwrap(),
            json!({"type":"shell_event","event":"shell.navigation_blocked","fields":{"scheme":"other"}})
        );
        assert_eq!(
            sent_events(&s.on_line_rejected("too_long")),
            vec!["shell.line_rejected"]
        );
    }

    #[test]
    fn a_folder_answer_goes_only_to_the_host_that_asked() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(None, 1);
        s.on_line(ready(None));
        assert_eq!(
            s.on_folder_picked(1, "i", Some("/f")),
            vec![Action::Send(
                r#"{"type":"folder_picked","id":"i","path":"/f"}"#.into()
            )]
        );
        assert!(s.on_folder_picked(2, "i", None).is_empty());
        s.on_line(parse_host_line(r#"{"type":"stopping","reason":"switch"}"#));
        assert!(
            s.on_folder_picked(1, "i", None).is_empty(),
            "a stopping host takes no answer"
        );
    }

    #[test]
    fn requests_are_handled_unless_the_host_or_the_shell_is_stopping() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(None, 1);
        s.on_line(ready(None));
        let req = parse_host_line(r#"{"type":"request","kind":"open_devtools"}"#);
        assert_eq!(
            s.on_line(req.clone()),
            vec![Action::Handle(Request::OpenDevtools)]
        );
        s.on_close_requested();
        assert!(s.on_line(req).is_empty());
    }

    #[test]
    fn a_failed_request_is_recorded_with_its_kind_and_code() {
        let mut s = Supervisor::new();
        s.start("v", "w", None);
        s.spawned(None, 1);
        s.on_line(ready(None));
        let actions = s.request_failed("open_config_file", "not_found");
        let Action::Send(line) = &actions[0] else {
            panic!("{actions:?}")
        };
        let v: Value = serde_json::from_str(line).unwrap();
        assert_eq!(
            v,
            json!({"type":"shell_event","event":"shell.request_failed","fields":{"request":"open_config_file","code":"not_found"}})
        );
    }

    #[test]
    fn identifier_values() {
        assert_eq!(id_value("2.52.6"), "2.52.6");
        assert_eq!(id_value("0.1.0-beta.1"), "0.1.0-beta.1");
        assert_eq!(id_value("a b"), "<invalid-id>");
        assert_eq!(id_value("me@x"), "<invalid-id>");
        assert_eq!(id_value(""), "<invalid-id>");
        assert_eq!(id_value("版本"), "<invalid-id>");
        assert_eq!(id_value(&"x".repeat(129)), "<invalid-id>");
    }

    #[test]
    fn signal_names() {
        assert_eq!(signal_name(9), "SIGKILL");
        assert_eq!(signal_name(15), "SIGTERM");
        assert_eq!(signal_name(64), "other");
    }
}
