//! The shell's own small log file, for its events while no host runs to take them (before the first host is ready,
//! after the last one ended, around the crash dialog). It sits in the user log directory the host reported, named
//! like every other log file there (`<UTC time to the millisecond>-shell-<pid>.jsonl`), so the host's cleanup at
//! its next start counts and prunes it and the diagnostics bundle takes it. Records have the host's form —
//! `{"t","level","event",…fields}` — and carry only the shell's own events with the fields its supervisor builds:
//! fixed words, numbers, durations and the version strings (docs/contracts.md「用户日志」; no paths, no names).
//!
//! Created exclusively (an existing file or link of that name is neither appended to nor followed), mode 0600, at
//! most `SHELL_LOG_MAX_BYTES`; nothing here fails the shell: a file that cannot be written loses its records.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::supervisor::ShellEvent;

/// A shell run writes at most this much; records past it are dropped.
pub const SHELL_LOG_MAX_BYTES: u64 = 64 * 1024;

/// A UTC time, to the millisecond, as `(ISO 8601 for the record, compact form for the file name)`.
pub fn utc_stamps(millis_since_epoch: u128) -> (String, String) {
    let millis = (millis_since_epoch % 1000) as u32;
    let secs = (millis_since_epoch / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    (
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z"),
        format!("{y:04}{mo:02}{d:02}T{h:02}{m:02}{s:02}{millis:03}Z"),
    )
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// One record, as a line without its newline.
pub fn record_line(iso_time: &str, event: &ShellEvent) -> String {
    let mut record = Map::new();
    record.insert("t".into(), Value::String(iso_time.to_owned()));
    record.insert("level".into(), Value::String(event.level.to_owned()));
    record.insert("event".into(), Value::String(event.event.to_owned()));
    for (key, value) in &event.fields {
        record.insert(key.clone(), value.clone());
    }
    Value::Object(record).to_string()
}

/// The file's name for a run started at `compact_time` by process `pid`.
pub fn file_name(compact_time: &str, pid: u32) -> String {
    format!("{compact_time}-shell-{pid}.jsonl")
}

/// The shell's log file for this run: opened at the first write, in the directory given then.
#[derive(Default)]
pub struct ShellLog {
    file: Option<(PathBuf, File)>,
    written: u64,
    failed: bool,
}

impl ShellLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends the events. The directory is the user log directory (the host made it, 0700).
    pub fn write(&mut self, log_dir: &Path, events: &[ShellEvent]) {
        if self.failed {
            return;
        }
        if self.file.as_ref().is_some_and(|(dir, _)| dir != log_dir) {
            // The log directory moved (config.toml changed between hosts): a new file there.
            self.file = None;
            self.written = 0;
        }
        if self.file.is_none() {
            match open_new(log_dir) {
                Some(file) => self.file = Some((log_dir.to_path_buf(), file)),
                None => {
                    self.failed = true;
                    return;
                }
            }
        }
        let Some((_, file)) = self.file.as_mut() else {
            return;
        };
        for event in events {
            let (iso, _) = utc_stamps(now_millis());
            let line = format!("{}\n", record_line(&iso, event));
            if self.written + line.len() as u64 > SHELL_LOG_MAX_BYTES {
                return;
            }
            if file.write_all(line.as_bytes()).is_err() {
                return;
            }
            self.written += line.len() as u64;
        }
    }
}

fn open_new(dir: &Path) -> Option<File> {
    let (_, compact) = utc_stamps(now_millis());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(dir.join(file_name(&compact, std::process::id())))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(name: &'static str, fields: Value) -> ShellEvent {
        let Value::Object(fields) = fields else {
            panic!()
        };
        ShellEvent {
            event: name,
            level: "warn",
            fields,
        }
    }

    #[test]
    fn stamps() {
        assert_eq!(
            utc_stamps(0),
            (
                "1970-01-01T00:00:00.000Z".into(),
                "19700101T000000000Z".into()
            )
        );
        // 2026-10-15T11:52:01.123Z
        assert_eq!(
            utc_stamps(1_792_065_121_123),
            (
                "2026-10-15T11:52:01.123Z".into(),
                "20261015T115201123Z".into()
            )
        );
        // A leap day.
        assert_eq!(utc_stamps(951_782_400_000).0, "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn the_file_name_is_a_log_file_name_the_host_prunes() {
        // infra log/files.ts: /^\d{8}T\d{9}Z-[a-z][a-z0-9]*-\d+(?:-\d+)?\.jsonl$/
        let name = file_name(&utc_stamps(1_792_065_121_123).1, 4242);
        assert_eq!(name, "20261015T115201123Z-shell-4242.jsonl");
        let (stamp, rest) = name.split_at(19);
        assert!(stamp[..8].chars().all(|c| c.is_ascii_digit()) && &stamp[8..9] == "T");
        assert!(stamp[9..18].chars().all(|c| c.is_ascii_digit()) && &stamp[18..] == "Z");
        assert_eq!(rest, "-shell-4242.jsonl");
    }

    #[test]
    fn a_record_has_the_hosts_form() {
        let line = record_line(
            "2026-10-15T11:52:01.123Z",
            &event(
                "shell.host_exited",
                json!({"signal":"SIGKILL","expected":"no","duration_ms":3.5}),
            ),
        );
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            v,
            json!({"t":"2026-10-15T11:52:01.123Z","level":"warn","event":"shell.host_exited","signal":"SIGKILL","expected":"no","duration_ms":3.5})
        );
        assert!(
            line.starts_with(r#"{"t":"#),
            "the time first, as the host writes it"
        );
    }

    #[test]
    fn writes_one_new_0600_file_and_stops_at_the_limit() {
        let dir = std::env::temp_dir().join(format!("aspace-shell-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut log = ShellLog::new();
        log.write(&dir, &[event("shell.started", json!({"version":"0.1.0"}))]);
        log.write(
            &dir,
            &[event("shell.host_exited", json!({"expected":"no"}))],
        );
        let files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1);
        let text = std::fs::read_to_string(&files[0]).unwrap();
        assert_eq!(text.lines().count(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&files[0]).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let many: Vec<_> = (0..2000)
            .map(|_| event("shell.request_failed", json!({"code":"x"})))
            .collect();
        log.write(&dir, &many);
        assert!(std::fs::metadata(&files[0]).unwrap().len() <= SHELL_LOG_MAX_BYTES);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_directory_that_is_not_there_loses_the_records_quietly() {
        let mut log = ShellLog::new();
        log.write(
            Path::new("/nonexistent/aspace/logs"),
            &[event("shell.started", json!({}))],
        );
        log.write(
            Path::new("/nonexistent/aspace/logs"),
            &[event("shell.started", json!({}))],
        );
    }
}
