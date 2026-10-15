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
    OpenSkillsFolder,
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
            Request::OpenSkillsFolder => "open_skills_folder",
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
                Some("open_skills_folder") => Some(Request::OpenSkillsFolder),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_with_a_project() {
        let line = r#"{"type":"ready","url":"http://127.0.0.1:1859/","port":1859,"configuredPort":1859,"portFallback":false,"portOccupant":null,"project":"/home/u/My Project","logDir":"/home/u/.local/share/argelanderspace/logs","language":"en"}"#;
        assert_eq!(
            parse_host_line(line),
            HostLine::Ready(Ready {
                url: "http://127.0.0.1:1859/".into(),
                port: 1859,
                project: Some("/home/u/My Project".into()),
                log_dir: Some("/home/u/.local/share/argelanderspace/logs".into()),
                language: Language::English,
                log_level: LogLevel::Info,
            })
        );
        let with_level = line.replace(r#""language":"en""#, r#""language":"en","logLevel":"warn""#);
        let HostLine::Ready(ready) = parse_host_line(&with_level) else {
            panic!("ready")
        };
        assert_eq!(ready.log_level, LogLevel::Warn);
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

    #[test]
    fn ready_line_of_the_welcome_state_and_without_the_newer_fields() {
        let line =
            r#"{"type":"ready","url":"http://127.0.0.1:40000/","port":40000,"project":null}"#;
        assert_eq!(
            parse_host_line(line),
            HostLine::Ready(Ready {
                url: "http://127.0.0.1:40000/".into(),
                port: 40000,
                project: None,
                log_dir: None,
                language: Language::Chinese,
                log_level: LogLevel::Info,
            })
        );
    }

    #[test]
    fn a_ready_line_whose_address_is_not_the_local_page_is_not_taken() {
        for url in [
            "http://example.org/",
            "https://127.0.0.1:1859/",
            "http://127.0.0.1:1860/",
            "http://localhost:1859/",
            "http://127.0.0.1:1859/x",
            "javascript:alert(1)",
        ] {
            let line = json!({"type":"ready","url":url,"port":1859,"project":null}).to_string();
            assert_eq!(parse_host_line(&line), HostLine::Unknown, "{url}");
        }
        // A relative project path or a missing project is a bad shape too.
        let line = json!({"type":"ready","url":"http://127.0.0.1:1/","port":1,"project":"rel"})
            .to_string();
        assert_eq!(parse_host_line(&line), HostLine::Unknown);
        let line = json!({"type":"ready","url":"http://127.0.0.1:1/","port":1}).to_string();
        assert_eq!(parse_host_line(&line), HostLine::Unknown);
        let line =
            json!({"type":"ready","url":"http://127.0.0.1:70000/","port":70000,"project":null})
                .to_string();
        assert_eq!(parse_host_line(&line), HostLine::Unknown);
    }

    #[test]
    fn requests() {
        let cases = [
            (
                r#"{"type":"request","kind":"pick_folder","id":"abc"}"#,
                Request::PickFolder { id: "abc".into() },
            ),
            (
                r#"{"type":"request","kind":"open_in_browser","url":"http://127.0.0.1:1859/"}"#,
                Request::OpenInBrowser {
                    url: "http://127.0.0.1:1859/".into(),
                },
            ),
            (
                r#"{"type":"request","kind":"open_devtools"}"#,
                Request::OpenDevtools,
            ),
            (
                r#"{"type":"request","kind":"open_log_folder","path":"/h/logs"}"#,
                Request::OpenLogFolder {
                    path: "/h/logs".into(),
                },
            ),
            (
                r#"{"type":"request","kind":"open_config_file","path":"/h/config.toml"}"#,
                Request::OpenConfigFile {
                    path: "/h/config.toml".into(),
                },
            ),
            (
                r#"{"type":"request","kind":"open_skills_folder"}"#,
                Request::OpenSkillsFolder,
            ),
        ];
        for (line, request) in cases {
            assert_eq!(parse_host_line(line), HostLine::Request(request));
        }
    }

    #[test]
    fn requests_of_the_wrong_shape_are_ignored() {
        for line in [
            r#"{"type":"request","kind":"pick_folder"}"#,
            r#"{"type":"request","kind":"open_log_folder","path":"relative"}"#,
            r#"{"type":"request","kind":"open_config_file"}"#,
            r#"{"type":"request","kind":"format_disk"}"#,
            // Opening in the browser takes the host's own page address only.
            r#"{"type":"request","kind":"open_in_browser"}"#,
            r#"{"type":"request","kind":"open_in_browser","url":"https://example.org/"}"#,
            r#"{"type":"request","kind":"open_in_browser","url":"http://127.0.0.1:1859/x"}"#,
            r#"{"type":"request","kind":"open_in_browser","url":"file:///etc/passwd"}"#,
            r#"{"type":"request","kind":"open_in_browser","url":"http://127.0.0.1:99999/"}"#,
            r#"{"type":"request"}"#,
        ] {
            assert_eq!(parse_host_line(line), HostLine::Unknown, "{line}");
        }
    }

    #[test]
    fn stopping_stopped_failed() {
        assert_eq!(
            parse_host_line(r#"{"type":"stopping","reason":"switch"}"#),
            HostLine::Stopping {
                reason: "switch".into()
            }
        );
        assert_eq!(
            parse_host_line(r#"{"type":"stopped"}"#),
            HostLine::Stopped { next: None }
        );
        assert_eq!(
            parse_host_line(r#"{"type":"stopped","next":"/p/next"}"#),
            HostLine::Stopped {
                next: Some("/p/next".into())
            }
        );
        assert_eq!(
            parse_host_line(r#"{"type":"stopped","next":"rel"}"#),
            HostLine::Unknown
        );
        assert_eq!(
            parse_host_line(r#"{"type":"failed","stage":"start","logDir":"/l"}"#),
            HostLine::Failed {
                stage: FailedStage::Start,
                log_dir: Some("/l".into())
            }
        );
        assert_eq!(
            parse_host_line(r#"{"type":"failed","stage":"project","logDir":"/l"}"#),
            HostLine::Failed {
                stage: FailedStage::Project,
                log_dir: Some("/l".into())
            }
        );
        // An older host's failed line, without the log directory.
        assert_eq!(
            parse_host_line(r#"{"type":"failed","stage":"start"}"#),
            HostLine::Failed {
                stage: FailedStage::Start,
                log_dir: None
            }
        );
        assert_eq!(
            parse_host_line(r#"{"type":"failed","stage":"boom"}"#),
            HostLine::Unknown
        );
    }

    #[test]
    fn not_lines_of_the_protocol() {
        for line in [
            "",
            "ready",
            "[]",
            "null",
            "{}",
            r#"{"type":"hello"}"#,
            "{\"type\":\"ready\"",
        ] {
            assert_eq!(parse_host_line(line), HostLine::Unknown, "{line}");
        }
    }

    #[test]
    fn menu_lines() {
        let line = r#"{"type":"menu","language":"en","recent":[{"id":"m1-0","label":"alpha — ~/p/alpha","enabled":true},{"id":"m1-1","label":"gone — ~/gone","enabled":false}]}"#;
        assert_eq!(
            parse_host_line(line),
            HostLine::Menu(MenuModel {
                language: Language::English,
                recent: vec![
                    MenuRecent {
                        id: "m1-0".into(),
                        label: "alpha — ~/p/alpha".into(),
                        enabled: true
                    },
                    MenuRecent {
                        id: "m1-1".into(),
                        label: "gone — ~/gone".into(),
                        enabled: false
                    },
                ],
            })
        );
        assert_eq!(
            parse_host_line(r#"{"type":"menu","language":"zh-CN","recent":[]}"#),
            HostLine::Menu(MenuModel {
                language: Language::Chinese,
                recent: vec![]
            })
        );
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
        // Not a menu line: no recent list, or not a list.
        for bad in [r#"{"type":"menu"}"#, r#"{"type":"menu","recent":{}}"#] {
            assert_eq!(parse_host_line(bad), HostLine::Unknown, "{bad}");
        }
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

    #[test]
    fn lines_to_the_host() {
        assert_eq!(
            menu_request_line("open_devtools"),
            r#"{"type":"menu","item":"open_devtools"}"#
        );
        assert_eq!(
            menu_recent_line("m2-0"),
            r#"{"type":"menu","item":"open_recent","id":"m2-0"}"#
        );
        assert_eq!(quit_line(), r#"{"type":"quit"}"#);
        let v: Value = serde_json::from_str(&folder_picked_line("i1", Some("/home/u/p"))).unwrap();
        assert_eq!(
            v,
            json!({"type":"folder_picked","id":"i1","path":"/home/u/p"})
        );
        let v: Value = serde_json::from_str(&folder_picked_line("i2", None)).unwrap();
        assert_eq!(v, json!({"type":"folder_picked","id":"i2","path":null}));
        let mut fields = Map::new();
        fields.insert("pid".into(), json!(12));
        let v: Value =
            serde_json::from_str(&shell_event_line("shell.host_started", &fields)).unwrap();
        assert_eq!(
            v,
            json!({"type":"shell_event","event":"shell.host_started","fields":{"pid":12}})
        );
    }
}
