//! The line protocol with the desktop host (docs/architecture.md「桌面宿主」): one JSON object per line on the
//! host's stdout (host → shell) and stdin (shell → host). Parsing and writing only; what the shell does with a line
//! is decided in `supervisor.rs` and carried out in `main.rs`.

use std::io::BufRead;

use serde_json::{json, Map, Value};

/// A line from the host is at most this long, as a line to the host is (server `HOST_LINE_MAX_BYTES`).
pub const LINE_MAX_BYTES: usize = 64 * 1024;

/// The user log's levels, lowest first (contracts `SETTINGS_LOG_LEVELS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    /// The level a log starts with when config.toml names none (infra `DEFAULT_LOG_LEVEL`); the shell's file uses it
    /// until a host reports its level.
    pub const DEFAULT: LogLevel = LogLevel::Info;

    pub fn parse(name: &str) -> Option<LogLevel> {
        match name {
            "debug" => Some(LogLevel::Debug),
            "info" => Some(LogLevel::Info),
            "warn" => Some(LogLevel::Warn),
            "error" => Some(LogLevel::Error),
            _ => None,
        }
    }

    /// Whether a record of `level` (one of the names above) is written at this level.
    pub fn admits(self, level: &str) -> bool {
        LogLevel::parse(level).is_some_and(|l| l >= self)
    }
}

/// The language the host reported (config.toml `[ui] language` when it started), for the shell's native dialogs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Chinese,
    English,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ready {
    /// The page's address: always `http://127.0.0.1:<port>/` (checked by `is_local_page`).
    pub url: String,
    pub port: u16,
    /// The project folder (canonical path), or none in the welcome state.
    pub project: Option<String>,
    pub log_dir: Option<String>,
    pub language: Language,
    /// The user log's level when the host was ready (default when the line has none).
    pub log_level: LogLevel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    PickFolder {
        id: String,
    },
    /// The host's own page address (`http://127.0.0.1:<port>/`; checked by `is_loopback_page`).
    OpenInBrowser {
        url: String,
    },
    OpenDevtools,
    OpenLogFolder {
        path: String,
    },
    OpenConfigFile {
        path: String,
    },
    /// The skills that ship with the app (desktop-app ticket 24): the host's own path, as for the log folder.
    OpenSkillsFolder {
        path: String,
    },
}

impl Request {
    /// The request's kind as the protocol and the log name it.
    pub fn kind(&self) -> &'static str {
        match self {
            Request::PickFolder { .. } => "pick_folder",
            Request::OpenInBrowser { .. } => "open_in_browser",
            Request::OpenDevtools => "open_devtools",
            Request::OpenLogFolder { .. } => "open_log_folder",
            Request::OpenConfigFile { .. } => "open_config_file",
            Request::OpenSkillsFolder { .. } => "open_skills_folder",
        }
    }
}

/// A recent project in the shell's menu (desktop-app ticket 21): the label to show, and the host's id for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuRecent {
    pub id: String,
    pub label: String,
    pub enabled: bool,
}

/// What the shell's menu shows, as the host's `menu` line says (desktop-app ticket 21).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuModel {
    pub language: Language,
    pub recent: Vec<MenuRecent>,
}

/// At most this many recent projects are shown (the host sends no more, server `HOST_MENU_RECENT_MAX`).
pub const MENU_RECENT_MAX: usize = 10;
/// A menu id or label longer than this is not taken: that entry is left out (the host shortens its labels to far less,
/// server `HOST_MENU_LABEL_MAX`).
const MENU_TEXT_MAX: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailedStage {
    /// The server could not start.
    Start,
    /// The folder given with `--project` is not there (or not a folder).
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostLine {
    Ready(Ready),
    Request(Request),
    /// The graceful shutdown began; the reason as the host wrote it.
    Stopping {
        reason: String,
    },
    /// The graceful shutdown ended; `next` is the project to start the next host for (a switch).
    Stopped {
        next: Option<String>,
    },
    Failed {
        stage: FailedStage,
        log_dir: Option<String>,
    },
    Menu(MenuModel),
    /// Anything else: not JSON, an unknown type, a known type of the wrong shape. Ignored.
    Unknown,
}

fn string(m: &Map<String, Value>, key: &str) -> Option<String> {
    m.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn is_absolute(path: &str) -> bool {
    std::path::Path::new(path).is_absolute()
}

fn absolute(m: &Map<String, Value>, key: &str) -> Option<String> {
    string(m, key).filter(|p| is_absolute(p))
}

/// The page address the window may load: plain http on the loopback address the host listens on, nothing else.
pub fn is_local_page(url: &str, port: u16) -> bool {
    url == format!("http://127.0.0.1:{port}/")
}

/// Whether `url` is a page address of the host's form, `http://127.0.0.1:<port>/`, for any port.
pub fn is_loopback_page(url: &str) -> bool {
    url.strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.strip_suffix('/'))
        .and_then(|port| port.parse::<u16>().ok())
        .is_some_and(|port| is_local_page(url, port))
}

fn language_of(m: &Map<String, Value>) -> Language {
    match m.get("language").and_then(Value::as_str) {
        Some("en") => Language::English,
        _ => Language::Chinese,
    }
}

fn menu_model(m: &Map<String, Value>) -> Option<MenuModel> {
    let short = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= MENU_TEXT_MAX)
            .map(str::to_owned)
    };
    // An entry that is not of the form (or too long) is left out; the others are still shown.
    let recent = m
        .get("recent")?
        .as_array()?
        .iter()
        .filter_map(|item| {
            let item = item.as_object()?;
            Some(MenuRecent {
                id: short(item.get("id"))?,
                label: short(item.get("label"))?,
                enabled: item.get("enabled")?.as_bool()?,
            })
        })
        .take(MENU_RECENT_MAX)
        .collect();
    Some(MenuModel {
        language: language_of(m),
        recent,
    })
}

/// One line from the host's stdout (without its newline).
pub fn parse_host_line(line: &str) -> HostLine {
    let Ok(Value::Object(m)) = serde_json::from_str::<Value>(line) else {
        return HostLine::Unknown;
    };
    match m.get("type").and_then(Value::as_str) {
        Some("ready") => {
            let port = m
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok());
            let url = string(&m, "url");
            let project = match m.get("project") {
                Some(Value::Null) => Some(None),
                Some(Value::String(p)) if is_absolute(p) => Some(Some(p.clone())),
                _ => None,
            };
            let language = language_of(&m);
            match (port, url, project) {
                (Some(port), Some(url), Some(project)) if is_local_page(&url, port) => {
                    HostLine::Ready(Ready {
                        url,
                        port,
                        project,
                        log_dir: absolute(&m, "logDir"),
                        language,
                        log_level: m
                            .get("logLevel")
                            .and_then(Value::as_str)
                            .and_then(LogLevel::parse)
                            .unwrap_or(LogLevel::DEFAULT),
                    })
                }
                _ => HostLine::Unknown,
            }
        }
        Some("request") => {
            let request = match m.get("kind").and_then(Value::as_str) {
                Some("pick_folder") => string(&m, "id").map(|id| Request::PickFolder { id }),
                Some("open_in_browser") => string(&m, "url")
                    .filter(|url| is_loopback_page(url))
                    .map(|url| Request::OpenInBrowser { url }),
                Some("open_devtools") => Some(Request::OpenDevtools),
                Some("open_log_folder") => {
                    absolute(&m, "path").map(|path| Request::OpenLogFolder { path })
                }
                Some("open_config_file") => {
                    absolute(&m, "path").map(|path| Request::OpenConfigFile { path })
                }
                Some("open_skills_folder") => {
                    absolute(&m, "path").map(|path| Request::OpenSkillsFolder { path })
                }
                _ => None,
            };
            request.map_or(HostLine::Unknown, HostLine::Request)
        }
        Some("stopping") => {
            string(&m, "reason").map_or(HostLine::Unknown, |reason| HostLine::Stopping { reason })
        }
        Some("stopped") => match m.get("next") {
            None => HostLine::Stopped { next: None },
            Some(Value::String(next)) if is_absolute(next) => HostLine::Stopped {
                next: Some(next.clone()),
            },
            Some(_) => HostLine::Unknown,
        },
        Some("failed") => {
            let stage = match m.get("stage").and_then(Value::as_str) {
                Some("start") => Some(FailedStage::Start),
                Some("project") => Some(FailedStage::Project),
                _ => None,
            };
            stage.map_or(HostLine::Unknown, |stage| HostLine::Failed {
                stage,
                log_dir: absolute(&m, "logDir"),
            })
        }
        Some("menu") => menu_model(&m).map_or(HostLine::Unknown, HostLine::Menu),
        _ => HostLine::Unknown,
    }
}

/// What reading the host's output gives, line by line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineRead {
    /// A line (without its newline, nor a `\r` before it).
    Line(String),
    /// A line longer than the limit: skipped up to its end.
    TooLong,
    /// A line that is not UTF-8: skipped.
    NotUtf8,
}

/// Reads the host's output to its end: each line, or why a line was skipped, goes to `each` (which returns false to
/// stop). A line longer than `max` bytes is not kept in memory past `max`; reading goes on after it, as after a line
/// that is not UTF-8. A read error ends the reading.
pub fn read_lines<R: BufRead>(mut reader: R, max: usize, mut each: impl FnMut(LineRead) -> bool) {
    let mut line: Vec<u8> = Vec::new();
    let mut skipping = false;
    let finish = |line: &mut Vec<u8>| {
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        match String::from_utf8(std::mem::take(line)) {
            Ok(text) => LineRead::Line(text),
            Err(_) => LineRead::NotUtf8,
        }
    };
    loop {
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        if available.is_empty() {
            if !skipping && !line.is_empty() {
                each(finish(&mut line));
            }
            return;
        }
        let newline = available.iter().position(|&b| b == b'\n');
        let part = &available[..newline.unwrap_or(available.len())];
        let mut go_on = true;
        if !skipping {
            if line.len() + part.len() > max {
                skipping = true;
                line.clear();
                go_on = each(LineRead::TooLong);
            } else {
                line.extend_from_slice(part);
            }
        }
        let used = newline.map_or(available.len(), |i| i + 1);
        reader.consume(used);
        if !go_on {
            return;
        }
        if newline.is_some() {
            if skipping {
                skipping = false;
            } else if !each(finish(&mut line)) {
                return;
            }
        }
    }
}

/// `{"type":"quit"}`: shut down gracefully.
pub fn quit_line() -> String {
    json!({ "type": "quit" }).to_string()
}

/// The answer to a `pick_folder` request: the folder chosen (absolute), or null when the dialog was cancelled.
pub fn folder_picked_line(id: &str, path: Option<&str>) -> String {
    json!({ "type": "folder_picked", "id": id, "path": path }).to_string()
}

/// A menu item for the host to carry out as the page's request of that kind (`pick_folder`, `open_in_browser`,
/// `open_devtools`; desktop-app ticket 21).
pub fn menu_request_line(item: &str) -> String {
    json!({ "type": "menu", "item": item }).to_string()
}

/// A recent project of the menu, by the id of the host's last `menu` line.
pub fn menu_recent_line(id: &str) -> String {
    json!({ "type": "menu", "item": "open_recent", "id": id }).to_string()
}

/// One of the shell's own events, for the host to write into the user log (its `SHELL_EVENTS` table decides what is
/// written).
pub fn shell_event_line(event: &str, fields: &Map<String, Value>) -> String {
    json!({ "type": "shell_event", "event": event, "fields": fields }).to_string()
}

/// Tests: parses a test line written with Unix paths (`"/h/logs"`) as this platform's host would write it (`"C:/h/logs"`
/// on Windows, where `/h/logs` is not absolute), and gives the result back with the test's own paths. The same as
/// `parse_host_line` elsewhere.
#[cfg(test)]
pub(crate) fn parse_test_line(line: &str) -> HostLine {
    if !cfg!(windows) {
        return parse_host_line(line);
    }
    let unix = |p: String| p.strip_prefix("C:").map(str::to_owned).unwrap_or(p);
    match parse_host_line(&line.replace("\":\"/", "\":\"C:/")) {
        HostLine::Ready(mut r) => {
            r.project = r.project.map(unix);
            r.log_dir = r.log_dir.map(unix);
            HostLine::Ready(r)
        }
        HostLine::Stopped { next } => HostLine::Stopped {
            next: next.map(unix),
        },
        HostLine::Failed { stage, log_dir } => HostLine::Failed {
            stage,
            log_dir: log_dir.map(unix),
        },
        HostLine::Request(Request::OpenLogFolder { path }) => {
            HostLine::Request(Request::OpenLogFolder { path: unix(path) })
        }
        HostLine::Request(Request::OpenConfigFile { path }) => {
            HostLine::Request(Request::OpenConfigFile { path: unix(path) })
        }
        HostLine::Request(Request::OpenSkillsFolder { path }) => {
            HostLine::Request(Request::OpenSkillsFolder { path: unix(path) })
        }
        other => other,
    }
}

/// Tests: the line protocol's fixture corpus, which the host's tests read too (server
/// `tests/fixtures/desktop-line-protocol.json`; docs/architecture.md「桌面壳」). Read when the test runs, from the
/// repository's source tree: not built from anything, so `cargo test` needs nothing of the pnpm workspace.
#[cfg(test)]
pub(crate) fn corpus() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../server/tests/fixtures/desktop-line-protocol.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("the corpus {}: {error}", path.display()));
    serde_json::from_str(&text).expect("the corpus is JSON")
}

/// Tests: a corpus record's line as it goes over the protocol: `raw` as it is, else `line` written compactly.
#[cfg(test)]
pub(crate) fn corpus_line(record: &Value) -> String {
    match record.get("raw").and_then(Value::as_str) {
        Some(raw) => raw.to_owned(),
        None => serde_json::to_string(&record["line"]).expect("a JSON line"),
    }
}

/// Tests: the records of one direction of the corpus (`toShell`, `toHost`).
#[cfg(test)]
pub(crate) fn corpus_records<'a>(corpus: &'a Value, direction: &str) -> &'a [Value] {
    corpus[direction]
        .as_array()
        .unwrap_or_else(|| panic!("the corpus has no {direction}"))
}

#[cfg(test)]
/// Tests: every request the shell knows, one of each: the `match` stops compiling when a kind is added and not listed.
pub(crate) fn every_request() -> Vec<Request> {
    let all = vec![
        Request::PickFolder { id: "i".into() },
        Request::OpenInBrowser { url: "u".into() },
        Request::OpenDevtools,
        Request::OpenLogFolder { path: "p".into() },
        Request::OpenConfigFile { path: "p".into() },
        Request::OpenSkillsFolder { path: "p".into() },
    ];
    for request in &all {
        match request {
            Request::PickFolder { .. }
            | Request::OpenInBrowser { .. }
            | Request::OpenDevtools
            | Request::OpenLogFolder { .. }
            | Request::OpenConfigFile { .. }
            | Request::OpenSkillsFolder { .. } => {}
        }
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;
    // The test lines are written with Unix paths (`parse_test_line`).
    use super::parse_test_line as parse_host_line;

    fn language_name(language: Language) -> &'static str {
        match language {
            Language::Chinese => "chinese",
            Language::English => "english",
        }
    }

    fn level_name(level: LogLevel) -> &'static str {
        match level {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }

    /// What the shell made of a line, in the corpus's own words (its `shell` of a line to the shell).
    fn corpus_view(line: &HostLine) -> Value {
        match line {
            HostLine::Ready(r) => json!({"ready": {
                "url": r.url,
                "port": r.port,
                "project": r.project,
                "logDir": r.log_dir,
                "language": language_name(r.language),
                "logLevel": level_name(r.log_level),
            }}),
            HostLine::Request(request) => {
                let mut view = Map::new();
                view.insert("kind".into(), json!(request.kind()));
                match request {
                    Request::PickFolder { id } => {
                        view.insert("id".into(), json!(id));
                    }
                    Request::OpenInBrowser { url } => {
                        view.insert("url".into(), json!(url));
                    }
                    Request::OpenDevtools => {}
                    Request::OpenLogFolder { path }
                    | Request::OpenConfigFile { path }
                    | Request::OpenSkillsFolder { path } => {
                        view.insert("path".into(), json!(path));
                    }
                }
                json!({ "request": view })
            }
            HostLine::Stopping { reason } => json!({"stopping": {"reason": reason}}),
            HostLine::Stopped { next } => json!({"stopped": {"next": next}}),
            HostLine::Failed { stage, log_dir } => json!({"failed": {
                "stage": match stage {
                    FailedStage::Start => "start",
                    FailedStage::Project => "project",
                },
                "logDir": log_dir,
            }}),
            HostLine::Menu(model) => json!({"menu": {
                "language": language_name(model.language),
                "recent": model.recent.iter().map(|r| json!({
                    "id": r.id,
                    "label": r.label,
                    "enabled": r.enabled,
                })).collect::<Vec<_>>(),
            }}),
            HostLine::Unknown => json!("unknown"),
        }
    }

    #[test]
    fn the_corpus_constants_are_the_shells() {
        let corpus = corpus();
        let c = &corpus["constants"];
        assert_eq!(c["lineMaxBytes"], json!(LINE_MAX_BYTES));
        let levels: Vec<&str> = [
            LogLevel::Debug,
            LogLevel::Info,
            LogLevel::Warn,
            LogLevel::Error,
        ]
        .into_iter()
        .map(level_name)
        .collect();
        assert_eq!(c["logLevels"], json!(levels), "the levels, lowest first");
        for (i, name) in levels.iter().enumerate() {
            let level = LogLevel::parse(name).expect(name);
            assert_eq!(level_name(level), *name);
            // Lowest first: each level admits its own records and those above it, not those below.
            for (j, other) in levels.iter().enumerate() {
                assert_eq!(level.admits(other), j >= i, "{name} admits {other}");
            }
        }
        assert_eq!(c["defaultLogLevel"], json!(level_name(LogLevel::DEFAULT)));
        assert_eq!(c["menuRecentMax"], json!(MENU_RECENT_MAX));
        // The host's labels (characters) always fit the shell's limit (bytes): four bytes at most per character.
        let label_max = c["menuLabelMaxChars"].as_u64().expect("menuLabelMaxChars") as usize;
        assert!(
            4 * label_max <= MENU_TEXT_MAX,
            "{label_max} characters within {MENU_TEXT_MAX} bytes"
        );
        let language_of_line = |line: Value| match parse_host_line(&line.to_string()) {
            HostLine::Menu(model) => language_name(model.language),
            other => panic!("{other:?}"),
        };
        let languages = c["languages"].as_object().expect("languages");
        for (code, name) in languages {
            assert_eq!(
                json!(language_of_line(
                    json!({"type":"menu","language":code,"recent":[]})
                )),
                *name,
                "{code}"
            );
        }
        // A line that names no language (or one of no table) is in the default one.
        let default = &languages[c["defaultLanguage"].as_str().expect("defaultLanguage")];
        assert_eq!(
            json!(language_of_line(json!({"type":"menu","recent":[]}))),
            *default
        );
        assert_eq!(
            json!(language_of_line(
                json!({"type":"menu","language":"fr","recent":[]})
            )),
            *default
        );
        let kinds: Vec<&str> = every_request().iter().map(Request::kind).collect();
        assert_eq!(c["requestKinds"], json!(kinds));
        // A line one byte over the limit is skipped, one at the limit is read (made here, not stored in the corpus).
        let max = c["lineMaxBytes"].as_u64().expect("lineMaxBytes") as usize;
        for (len, read) in [
            (max + 1, LineRead::TooLong),
            (max, LineRead::Line("x".repeat(max))),
        ] {
            let mut input = "x".repeat(len).into_bytes();
            input.push(b'\n');
            let mut seen = Vec::new();
            read_lines(&input[..], LINE_MAX_BYTES, |l| {
                seen.push(l);
                true
            });
            assert_eq!(seen, vec![read], "{len} bytes");
        }
    }

    #[test]
    fn lines_from_the_host_are_read_as_the_corpus_says() {
        let corpus = corpus();
        let records = corpus_records(&corpus, "toShell");
        assert!(!records.is_empty());
        for record in records {
            let id = &record["id"];
            assert_eq!(
                corpus_view(&parse_host_line(&corpus_line(record))),
                record["shell"],
                "{id}"
            );
        }
        // Every stop reason the host gives is in a line the shell reads.
        for reason in corpus["constants"]["stopReasons"]
            .as_array()
            .expect("stopReasons")
        {
            assert!(
                records.iter().any(|r| r["valid"] == json!(true)
                    && r["shell"] == json!({"stopping": {"reason": reason}})),
                "{reason}"
            );
        }
    }

    #[test]
    fn lines_to_the_host_are_written_as_the_corpus_says() {
        let corpus = corpus();
        let mut written = 0;
        for record in corpus_records(&corpus, "toHost") {
            let id = &record["id"];
            let shell = &record["shell"];
            let line = if let Some(event) = shell.get("event").and_then(Value::as_str) {
                let fields = record["line"]["fields"].as_object().expect("fields");
                shell_event_line(event, fields)
            } else if let Some(writer) = shell.get("writer").and_then(Value::as_str) {
                let arg = |i: usize| shell["args"][i].as_str();
                match writer {
                    "quit_line" => quit_line(),
                    "folder_picked_line" => folder_picked_line(arg(0).expect("id"), arg(1)),
                    "menu_request_line" => menu_request_line(arg(0).expect("item")),
                    "menu_recent_line" => menu_recent_line(arg(0).expect("id")),
                    other => panic!("{id}: no writer {other}"),
                }
            } else {
                // A line the shell does not write (the host's rejections and placeholders).
                assert_eq!(*shell, Value::Null, "{id}");
                assert_eq!(record["valid"], json!(false), "{id}");
                continue;
            };
            assert_eq!(record["valid"], json!(true), "{id}");
            let line: Value = serde_json::from_str(&line).expect("a JSON line");
            assert_eq!(line, record["line"], "{id}");
            written += 1;
        }
        assert!(written > 0);
    }

    #[test]
    fn log_levels() {
        assert!(LogLevel::Info.admits("info"));
        assert!(LogLevel::Info.admits("warn"));
        assert!(!LogLevel::Warn.admits("info"));
        assert!(LogLevel::Debug.admits("info"));
        assert!(!LogLevel::Error.admits("warn"));
        assert!(!LogLevel::Debug.admits("loud"));
        assert_eq!(LogLevel::parse("verbose"), None);
    }

    fn read_all(input: &[u8], max: usize) -> Vec<LineRead> {
        let mut out = Vec::new();
        // A small buffer, so that lines arrive in pieces.
        read_lines(std::io::BufReader::with_capacity(4, input), max, |l| {
            out.push(l);
            true
        });
        out
    }

    #[test]
    fn reading_lines_with_a_limit_and_bytes_that_are_not_utf8() {
        let mut input = b"one\r\n".to_vec();
        input.extend_from_slice(&[b'x'; 20]);
        input.extend_from_slice(b"\n\xff\xfe\nexact-16-bytes!!\ntwo\nlast");
        assert_eq!(
            read_all(&input, 16),
            vec![
                LineRead::Line("one".into()),
                LineRead::TooLong,
                LineRead::NotUtf8,
                LineRead::Line("exact-16-bytes!!".into()),
                LineRead::Line("two".into()),
                LineRead::Line("last".into()),
            ]
        );
        // A long line at the end, without a newline, is reported once and not kept.
        assert_eq!(read_all(&[b'y'; 40], 16), vec![LineRead::TooLong]);
        assert_eq!(read_all(b"", 16), vec![]);
        // `each` returning false stops the reading.
        let mut seen = 0;
        read_lines(&b"a\nb\nc\n"[..], 16, |_| {
            seen += 1;
            seen < 2
        });
        assert_eq!(seen, 2);
    }

    /// The shell's own rules for a menu line (the lines themselves are the corpus's): at most the limit, and an entry
    /// not of the form left out alone.
    #[test]
    fn menu_lines_over_the_limit_or_with_entries_not_of_the_form() {
        // More than the limit: the first ten.
        let many: Vec<Value> = (0..14)
            .map(|i| json!({"id": format!("m-{i}"), "label": "x", "enabled": true}))
            .collect();
        let HostLine::Menu(model) =
            parse_host_line(&json!({"type":"menu","recent": many}).to_string())
        else {
            panic!("menu")
        };
        assert_eq!(model.recent.len(), MENU_RECENT_MAX);
        // An entry not of the form, or with a label too long, is left out; the good ones stay.
        let long = "y".repeat(MENU_TEXT_MAX + 1);
        let good = json!({"id":"ok","label":"alpha","enabled":true});
        let line = json!({"type":"menu","recent":[
            {"id":"a","label":"b"},
            {"id":"","label":"b","enabled":true},
            {"id":1,"label":"b","enabled":true},
            {"id":"a","label":long,"enabled":true},
            "x",
            good,
        ]});
        let HostLine::Menu(model) = parse_host_line(&line.to_string()) else {
            panic!("menu")
        };
        assert_eq!(
            model.recent,
            vec![MenuRecent {
                id: "ok".into(),
                label: "alpha".into(),
                enabled: true
            }]
        );
    }

    #[test]
    fn loopback_page_addresses() {
        assert!(is_loopback_page("http://127.0.0.1:1859/"));
        assert!(is_loopback_page("http://127.0.0.1:40000/"));
        for bad in [
            "http://127.0.0.1:1859",
            "http://127.0.0.1:/",
            "http://127.0.0.1:01859/",
            "http://127.0.0.1:1859/x",
            "http://localhost:1859/",
            "https://127.0.0.1:1859/",
            "http://127.0.0.1:65536/",
        ] {
            assert!(!is_loopback_page(bad), "{bad}");
        }
    }
}
