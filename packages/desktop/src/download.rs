//! Downloads of the page (desktop-app ticket 21): the diagnostics bundle, a PDF original, a manuscript export, a mail
//! attachment — every `<a download>` the page clicks. WebKitGTK has no save flow of its own (desktop-app ticket 02: the
//! file went silently into the shell's working directory), so the shell asks: when WebKit wants a download's
//! destination (`decide-destination`), a GTK save dialog opens over the window, in the user's download folder (else the
//! home directory) with the name the page gave, and asks before replacing a file. Cancelled, the download is cancelled
//! and nothing is written; a download that then fails is said in a native dialog. The file's name and folder are never
//! recorded (`shell.download` has the outcome only).
//!
//! The shell connects to WebKit itself (`WebKitWebContext::download-started`, `attach`), not through Tauri's
//! `on_download`: wry 0.57 keeps one `failed` flag for all the downloads of a webview and never clears it (one
//! cancelled or failed download and every later one is reported as failed), and leaves `allow-overwrite` at WebKit's
//! FALSE (a replacement the user confirmed in the dialog then fails). Here each `WebKitDownload` has its own record
//! (`Downloads`, keyed by the shell's own number for it), and a destination the user confirmed may be replaced.
//!
//! No double handling: the window is built without `on_download`, but wry still connects its own handlers to every
//! webview's downloads — its default attributes carry a download-started handler that accepts everything
//! (`wry::WebViewAttributes::default`, `|_, _| true`), so without this module each download would go silently into the
//! download folder, numbered « (1) » when the name is taken. Its `decide-destination` handler, connected before this
//! one (wry connects at the webview's creation), would answer first and end the signal (WebKit stops at the first
//! handler that returns true). So for each download every `decide-destination` handler already connected is blocked
//! before this module connects its own (`block_earlier_deciders`): this one is the only one that answers, and it always
//! answers (returns true), so WebKit's own default is not run either. Should a later wry connect after this module,
//! this handler, then the first, answers and ends the signal before it. wry's `failed` handler stays connected and
//! only touches wry's own flag (wry connects `finished` only with a completed handler, which there is none of without
//! `on_download`); it reports to nobody.
//!
//! The name offered is the page's own (`suggested_name`); no « (1) » is added when a file of that name is there — the
//! dialog asks before replacing it (wry numbered names only to match Windows' WebView2, which never asks).
//!
//! The dialog runs inside WebKit's signal on the main thread (GTK's own nested loop, as any modal GTK dialog): WebKit
//! waits for the answer, the window stays drawn.
//!
//! macOS and Windows (desktop-app ticket 30): WKWebView and WebView2 go through Tauri's `on_download` (`on_download`
//! below; wry's one-flag problem is WebKitGTK's only): when a download asks for its destination, the system's save
//! dialog (rfd: `NSSavePanel`, `IFileSaveDialog`, which both ask before replacing a file) opens over the window, in
//! the folder and with the name wry proposes (the download folder; wry has already numbered the name « (1) » when a
//! file of the page's name is there). Cancelled, the download is refused and reported `cancelled` at once; wry then
//! reports the refused download's end as a failure, which is not reported again (`Refused`, for a short while only).
//! Chosen, the webview writes to a temporary name next to the chosen file (`Staged`; a WKDownload does not replace a
//! file, and WebView2 numbers the name instead), and only a download that finished whole is renamed over the chosen
//! name (which replaces a file the user agreed to replace); a failed one, or one that cannot be renamed, has its
//! temporary file removed and is reported `failed` (the failure dialog), never `cancelled` (review of ticket 30: the
//! file the user agreed to replace was removed before the download, and a failure to remove it was reported as a
//! cancel).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

use crate::protocol::Language;

/// The save dialog's and the failure dialog's words.
pub struct SaveText {
    pub title: &'static str,
    /// The GTK dialog's buttons (Linux); the system dialogs of macOS and Windows have their own.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub cancel: &'static str,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub save: &'static str,
    pub failed_title: &'static str,
    pub failed: &'static str,
}

impl SaveText {
    pub fn of(language: Language) -> SaveText {
        match language {
            Language::Chinese => SaveText {
                title: "保存文件",
                cancel: "取消",
                save: "保存",
                failed_title: "ArgelanderSpace",
                failed: "没能保存文件。可以再试一次，或换一个保存位置。",
            },
            Language::English => SaveText {
                title: "Save File",
                cancel: "Cancel",
                save: "Save",
                failed_title: "ArgelanderSpace",
                failed: "The file could not be saved. You can try again, or choose another place.",
            },
        }
    }
}

/// What happened to one download, as `shell.download` records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Saved,
    /// Cancelled in the save dialog (or by WebKit for the user, as when the page went away).
    Cancelled,
    /// Written nowhere, or not completely: the user is told.
    Failed,
}

impl Outcome {
    pub fn name(self) -> &'static str {
        match self {
            Outcome::Saved => "saved",
            Outcome::Cancelled => "cancelled",
            Outcome::Failed => "failed",
        }
    }
}

/// What WebKit says about one download, in its order: the destination is decided (chosen in the dialog, or not), it
/// may fail (`failed`, before `finished`; a cancel is a failure "by the user"), and it finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub enum Step {
    Decided { chosen: bool },
    Failed { by_user: bool },
    Finished,
}

#[derive(Debug, Default)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct Track {
    declined: bool,
    failed: Option<bool>,
}

/// The downloads under way, each with its own record: what one of them did never colours another's outcome.
#[derive(Debug, Default)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct Downloads {
    next: u64,
    live: HashMap<u64, Track>,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl Downloads {
    /// A download began: its number for the steps that follow.
    pub fn start(&mut self) -> u64 {
        self.next += 1;
        self.live.insert(self.next, Track::default());
        self.next
    }

    /// A step of download `id`; its outcome once it finished (and it is forgotten then).
    pub fn step(&mut self, id: u64, step: Step) -> Option<Outcome> {
        match step {
            Step::Decided { chosen } => {
                if let Some(track) = self.live.get_mut(&id) {
                    track.declined = !chosen;
                }
                None
            }
            Step::Failed { by_user } => {
                if let Some(track) = self.live.get_mut(&id) {
                    track.failed = Some(by_user);
                }
                None
            }
            Step::Finished => {
                let track = self.live.remove(&id)?;
                Some(match (track.declined, track.failed) {
                    (true, _) | (false, Some(true)) => Outcome::Cancelled,
                    (false, Some(false)) => Outcome::Failed,
                    (false, None) => Outcome::Saved,
                })
            }
        }
    }

    /// How many are under way (tests).
    #[cfg(test)]
    fn under_way(&self) -> usize {
        self.live.len()
    }
}

/// The name the dialog offers: the page's name as WebKit gives it — only its last part, never empty.
pub fn suggested_name(suggested: &str) -> String {
    let name = suggested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim();
    if name.is_empty() || name == "." || name == ".." {
        "download".into()
    } else {
        name.to_owned()
    }
}

/// Where the dialog starts: the user's download folder when it is there, else the home directory.
#[cfg(target_os = "linux")]
fn start_folder() -> PathBuf {
    gtk::glib::user_special_dir(gtk::glib::UserDirectory::Downloads)
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(gtk::glib::home_dir)
}

/// Connects the shell's save flow to the webview's downloads (Linux); false when the webview has no context to connect to
/// (the window is then not used, as when its page cannot be guarded). `report` gets each download's outcome.
#[cfg(target_os = "linux")]
pub fn attach(
    view: &webkit2gtk::WebView,
    language: std::sync::Arc<std::sync::Mutex<Language>>,
    report: impl Fn(Outcome) + 'static,
) -> bool {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::Arc;

    use gtk::prelude::*;
    use webkit2gtk::{DownloadError, DownloadExt, WebContextExt, WebViewExt};

    let Some(context) = view.context() else {
        return false;
    };
    let downloads = Rc::new(RefCell::new(Downloads::default()));
    let report = Rc::new(report);
    context.connect_download_started(move |_, download| {
        let id = downloads.borrow_mut().start();
        block_earlier_deciders(download);
        {
            let downloads = Rc::clone(&downloads);
            let language = Arc::clone(&language);
            download.connect_decide_destination(move |download, suggested| {
                let language = language.lock().map(|l| *l).unwrap_or(Language::Chinese);
                let parent = download
                    .web_view()
                    .and_then(|v| v.toplevel())
                    .and_then(|w| w.downcast::<gtk::Window>().ok());
                // No borrow is held while the dialog runs: other downloads' signals may come meanwhile.
                let chosen = destination(parent.as_ref(), suggested, language);
                // Recorded before WebKit is told: a cancel reports its failure and its end at once.
                downloads.borrow_mut().step(
                    id,
                    Step::Decided {
                        chosen: chosen.is_some(),
                    },
                );
                match chosen {
                    Some((path, replace)) => {
                        // The dialog asked before a file of that name was replaced (`ask_where`).
                        download.set_allow_overwrite(replace);
                        download.set_destination(&path.to_string_lossy());
                    }
                    None => download.cancel(),
                }
                true
            });
        }
        {
            let downloads = Rc::clone(&downloads);
            download.connect_failed(move |_, error| {
                let by_user = error.matches(DownloadError::CancelledByUser);
                downloads.borrow_mut().step(id, Step::Failed { by_user });
            });
        }
        {
            let downloads = Rc::clone(&downloads);
            let report = Rc::clone(&report);
            download.connect_finished(move |_| {
                let outcome = downloads.borrow_mut().step(id, Step::Finished);
                if let Some(outcome) = outcome {
                    report(outcome);
                }
            });
        }
    });
    true
}

/// Blocks the `decide-destination` handlers connected to `download` so far (wry's): the shell's, connected next, is
/// the one that decides.
#[cfg(target_os = "linux")]
fn block_earlier_deciders(download: &webkit2gtk::Download) {
    use gtk::glib::translate::{IntoGlib, ToGlibPtr};
    use gtk::glib::{gobject_ffi, StaticType};
    // SAFETY: plain GObject signal calls on a live object WebKit handed over; a null signal id (not found) is skipped.
    unsafe {
        let signal = gobject_ffi::g_signal_lookup(
            c"decide-destination".as_ptr(),
            webkit2gtk::Download::static_type().into_glib(),
        );
        if signal == 0 {
            return;
        }
        let instance: *mut webkit2gtk::ffi::WebKitDownload = download.to_glib_none().0;
        gobject_ffi::g_signal_handlers_block_matched(
            instance as *mut gobject_ffi::GObject,
            gobject_ffi::G_SIGNAL_MATCH_ID,
            signal,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
    }
}

/// Where a download goes, and whether a file there may be replaced; none when the dialog was cancelled or closed.
#[cfg(target_os = "linux")]
fn destination(
    parent: Option<&gtk::Window>,
    suggested: &str,
    language: Language,
) -> Option<(PathBuf, bool)> {
    let name = suggested_name(suggested);
    // Test builds: the smoke's folder, without the dialog (never replacing).
    #[cfg(feature = "smoke-probe")]
    if let Some(dir) = crate::probe::save_to() {
        return Some((dir.join(name), false));
    }
    ask_where(parent, &start_folder(), &name, language).map(|path| (path, true))
}

/// Asks where to save: the chosen path, or none when the dialog was cancelled or closed. The dialog itself asks
/// before a file of that name is replaced, so a path it answers may be replaced.
#[cfg(target_os = "linux")]
pub fn ask_where(
    parent: Option<&gtk::Window>,
    folder: &Path,
    name: &str,
    language: Language,
) -> Option<PathBuf> {
    use gtk::prelude::*;
    let text = SaveText::of(language);
    let dialog = gtk::FileChooserDialog::with_buttons(
        Some(text.title),
        parent,
        gtk::FileChooserAction::Save,
        &[
            (text.cancel, gtk::ResponseType::Cancel),
            (text.save, gtk::ResponseType::Accept),
        ],
    );
    dialog.set_do_overwrite_confirmation(true);
    dialog.set_default_response(gtk::ResponseType::Accept);
    if folder.is_dir() {
        let _ = dialog.set_current_folder(folder);
    }
    dialog.set_current_name(name);
    let answer = dialog.run();
    let chosen = dialog.filename();
    dialog.close();
    match answer {
        gtk::ResponseType::Accept => chosen.filter(|p| p.is_absolute()),
        _ => None,
    }
}

/// How long a refused download's end is waited for: wry reports it at once (the refusal ends it), so an end that never
/// came does not swallow a real failure of the same address later.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub const REFUSED_FOR: std::time::Duration = std::time::Duration::from_secs(10);

/// The downloads refused in the save dialog (macOS, Windows), by address: wry reports each one's end as a failure
/// afterwards, which was reported as `cancelled` already and is not reported again. A refusal is forgotten after
/// `REFUSED_FOR`.
#[derive(Debug, Default)]
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub struct Refused {
    urls: HashMap<String, VecDeque<std::time::Instant>>,
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
impl Refused {
    /// A download of `url` was refused at `now` (reported `cancelled` now).
    pub fn refuse(&mut self, url: &str, now: std::time::Instant) {
        self.urls.entry(url.to_owned()).or_default().push_back(now);
    }

    /// A failed end of a download of `url` at `now`: whether it is the end of one refused (and so not reported).
    pub fn ended(&mut self, url: &str, now: std::time::Instant) -> bool {
        let Some(times) = self.urls.get_mut(url) else {
            return false;
        };
        while times
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) > REFUSED_FOR)
        {
            times.pop_front();
        }
        let refused = times.pop_front().is_some();
        if times.is_empty() {
            self.urls.remove(url);
        }
        refused
    }
}

/// The downloads under way to a temporary name (macOS, Windows), by address, in the order started: the temporary
/// file and the file the user chose.
#[derive(Debug, Default)]
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub struct Staged {
    urls: HashMap<String, VecDeque<(PathBuf, PathBuf)>>,
    count: u64,
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
impl Staged {
    /// A download of `url` to `chosen`: the temporary name, in the same folder, the webview writes to instead.
    pub fn stage(&mut self, url: &str, chosen: PathBuf) -> PathBuf {
        self.count += 1;
        let temp = temporary_name(&chosen, std::process::id(), self.count);
        self.urls
            .entry(url.to_owned())
            .or_default()
            .push_back((temp.clone(), chosen));
        temp
    }

    /// The download of `url` that ended (the earliest started), if one is under way.
    pub fn take(&mut self, url: &str) -> Option<(PathBuf, PathBuf)> {
        let queue = self.urls.get_mut(url)?;
        let next = queue.pop_front();
        if queue.is_empty() {
            self.urls.remove(url);
        }
        next
    }
}

/// `<folder>/.<name>.<pid>-<n>.part`: hidden, next to the chosen file (the same volume, so the rename does not copy).
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn temporary_name(chosen: &Path, pid: u32, n: u64) -> PathBuf {
    let name = chosen
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    chosen.with_file_name(format!(".{name}.{pid}-{n}.part"))
}

/// The end of a staged download: whole, the temporary file is renamed over the chosen one (replacing a file there,
/// which the dialog asked about); otherwise, or when it cannot be renamed, the temporary file is removed and the
/// download failed.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn settle(temp: &Path, chosen: &Path, success: bool) -> Outcome {
    if success && std::fs::rename(temp, chosen).is_ok() {
        return Outcome::Saved;
    }
    let _ = std::fs::remove_file(temp);
    Outcome::Failed
}

/// Tauri's download handler for macOS and Windows: the save dialog for each download, and its outcome to `report`.
#[cfg(not(target_os = "linux"))]
pub fn on_download<R: tauri::Runtime>(
    language: std::sync::Arc<std::sync::Mutex<Language>>,
    report: impl Fn(Outcome) + Send + Sync + 'static,
) -> impl Fn(tauri::Webview<R>, tauri::webview::DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    use std::sync::Mutex;
    use std::time::Instant;
    use tauri::webview::DownloadEvent;
    let refused = Mutex::new(Refused::default());
    let staged = Mutex::new(Staged::default());
    move |webview, event| match event {
        DownloadEvent::Requested { url, destination } => {
            let language = language.lock().map(|l| *l).unwrap_or(Language::Chinese);
            let proposed = destination.clone();
            let chosen = ask_where_native(&webview, &proposed, language);
            match (chosen, staged.lock()) {
                (Some(path), Ok(mut staged)) => {
                    *destination = staged.stage(url.as_str(), path);
                    true
                }
                (Some(_), Err(_)) => {
                    report(Outcome::Failed);
                    false
                }
                (None, _) => {
                    if let Ok(mut refused) = refused.lock() {
                        refused.refuse(url.as_str(), Instant::now());
                    }
                    report(Outcome::Cancelled);
                    false
                }
            }
        }
        DownloadEvent::Finished { url, success, .. } => {
            // A failed end of a refused download is that refusal's (refused downloads end at once, before any staged
            // download of the same address could).
            if !success
                && refused
                    .lock()
                    .is_ok_and(|mut r| r.ended(url.as_str(), Instant::now()))
            {
                return true;
            }
            let entry = staged.lock().ok().and_then(|mut s| s.take(url.as_str()));
            report(match entry {
                Some((temp, chosen)) => settle(&temp, &chosen, success),
                None if success => Outcome::Saved,
                None => Outcome::Failed,
            });
            true
        }
        _ => true,
    }
}

/// The system's save dialog over the window (macOS, Windows), starting where wry proposed; the chosen path, or none
/// when it was cancelled. Test builds with `ARGELANDERSPACE_SHELL_PROBE_SAVE_TO` save there without the dialog.
#[cfg(not(target_os = "linux"))]
fn ask_where_native<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    proposed: &Path,
    language: Language,
) -> Option<PathBuf> {
    let name = suggested_name(
        &proposed
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    #[cfg(feature = "smoke-probe")]
    if let Some(dir) = crate::probe::save_to() {
        return Some(dir.join(name));
    }
    let text = SaveText::of(language);
    let mut dialog = rfd::FileDialog::new()
        .set_title(text.title)
        .set_file_name(&name);
    if let Some(folder) = proposed.parent().filter(|d| d.is_dir()) {
        dialog = dialog.set_directory(folder);
    }
    let dialog = dialog.set_parent(&webview.window());
    // The dialog asked before replacing; the file is replaced only when the download has finished whole (`settle`).
    dialog.save_file().filter(|p| p.is_absolute())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(downloads: &mut Downloads, id: u64, steps: &[Step]) -> Option<Outcome> {
        let mut last = None;
        for step in steps {
            last = downloads.step(id, *step);
        }
        last
    }

    const SAVED: &[Step] = &[Step::Decided { chosen: true }, Step::Finished];
    const CANCELLED: &[Step] = &[
        Step::Decided { chosen: false },
        Step::Failed { by_user: true },
        Step::Finished,
    ];
    const FAILED: &[Step] = &[
        Step::Decided { chosen: true },
        Step::Failed { by_user: false },
        Step::Finished,
    ];

    #[test]
    fn each_download_has_its_own_outcome() {
        let mut d = Downloads::default();
        let a = d.start();
        assert_eq!(run(&mut d, a, SAVED), Some(Outcome::Saved));
        let b = d.start();
        assert_eq!(run(&mut d, b, CANCELLED), Some(Outcome::Cancelled));
        let c = d.start();
        assert_eq!(run(&mut d, c, FAILED), Some(Outcome::Failed));
        // After a cancel and a failure, the next one saved is saved (wry's one flag reported it as failed).
        let e = d.start();
        assert_eq!(run(&mut d, e, SAVED), Some(Outcome::Saved));
        assert_eq!(d.under_way(), 0);
    }

    #[test]
    fn downloads_at_once_do_not_mix() {
        let mut d = Downloads::default();
        let a = d.start();
        let b = d.start();
        assert_ne!(a, b);
        assert_eq!(d.step(a, Step::Decided { chosen: true }), None);
        assert_eq!(d.step(b, Step::Decided { chosen: true }), None);
        assert_eq!(d.step(a, Step::Failed { by_user: false }), None);
        assert_eq!(d.step(b, Step::Finished), Some(Outcome::Saved));
        assert_eq!(d.step(a, Step::Finished), Some(Outcome::Failed));
    }

    #[test]
    fn a_cancel_is_not_a_failure_and_steps_after_the_end_say_nothing() {
        let mut d = Downloads::default();
        // Cancelled by WebKit for the user after a destination was chosen (the page went away): cancelled.
        let a = d.start();
        assert_eq!(
            run(
                &mut d,
                a,
                &[
                    Step::Decided { chosen: true },
                    Step::Failed { by_user: true },
                    Step::Finished
                ]
            ),
            Some(Outcome::Cancelled)
        );
        // Declined in the dialog, whatever error WebKit then gives: cancelled.
        let b = d.start();
        assert_eq!(
            run(
                &mut d,
                b,
                &[
                    Step::Decided { chosen: false },
                    Step::Failed { by_user: false },
                    Step::Finished
                ]
            ),
            Some(Outcome::Cancelled)
        );
        assert_eq!(d.step(a, Step::Finished), None);
        assert_eq!(d.step(99, Step::Finished), None);
    }

    #[test]
    fn a_refused_downloads_end_is_not_reported_again_for_a_while() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mut r = Refused::default();
        r.refuse("http://127.0.0.1:1/a.pdf", t0);
        r.refuse("http://127.0.0.1:1/a.pdf", t0);
        // wry's two failure reports for the two refused downloads: nothing more to say.
        assert!(r.ended("http://127.0.0.1:1/a.pdf", t0 + Duration::from_millis(5)));
        assert!(r.ended("http://127.0.0.1:1/a.pdf", t0 + Duration::from_millis(5)));
        // A later failure of the same address, or one of another, is a failure.
        assert!(!r.ended("http://127.0.0.1:1/a.pdf", t0));
        assert!(!r.ended("http://127.0.0.1:1/b.pdf", t0));
        // A refusal whose end never came is forgotten: a real failure much later is reported.
        r.refuse("http://127.0.0.1:1/c.pdf", t0);
        assert!(!r.ended(
            "http://127.0.0.1:1/c.pdf",
            t0 + REFUSED_FOR + Duration::from_secs(1)
        ));
        assert!(r.urls.is_empty());
    }

    #[test]
    fn staged_downloads_go_to_a_hidden_name_next_to_the_chosen_file_in_order() {
        let mut s = Staged::default();
        let chosen = std::env::temp_dir().join("x").join("paper.pdf");
        let first = s.stage("http://h/a", chosen.clone());
        let second = s.stage("http://h/a", chosen.clone());
        assert_eq!(first.parent(), chosen.parent());
        let name = first.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with(".paper.pdf.") && name.ends_with(".part"),
            "{name}"
        );
        assert_ne!(first, second);
        assert_eq!(s.take("http://h/a"), Some((first, chosen.clone())));
        assert_eq!(s.take("http://h/a"), Some((second, chosen)));
        assert_eq!(s.take("http://h/a"), None);
        assert_eq!(s.take("http://h/b"), None);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aspace-download-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_finished_download_replaces_the_chosen_file_only_when_whole() {
        let dir = scratch("settle");
        let chosen = dir.join("paper.pdf");
        std::fs::write(&chosen, b"old").unwrap();
        // Failed: the file the user agreed to replace is still there, and no temporary file is left.
        let temp = temporary_name(&chosen, 1, 1);
        std::fs::write(&temp, b"half").unwrap();
        assert_eq!(settle(&temp, &chosen, false), Outcome::Failed);
        assert_eq!(std::fs::read(&chosen).unwrap(), b"old");
        assert!(!temp.exists());
        // A failure before anything was written: still failed, nothing to remove.
        assert_eq!(settle(&temp, &chosen, false), Outcome::Failed);
        // Whole: renamed over the chosen file.
        std::fs::write(&temp, b"new").unwrap();
        assert_eq!(settle(&temp, &chosen, true), Outcome::Saved);
        assert_eq!(std::fs::read(&chosen).unwrap(), b"new");
        assert!(!temp.exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_download_that_cannot_be_renamed_failed_and_leaves_no_temporary_file() {
        let dir = scratch("rename");
        // The chosen name is a non-empty folder now: the rename cannot replace it.
        let chosen = dir.join("paper.pdf");
        std::fs::create_dir_all(chosen.join("inside")).unwrap();
        let temp = temporary_name(&chosen, 1, 2);
        std::fs::write(&temp, b"new").unwrap();
        assert_eq!(settle(&temp, &chosen, true), Outcome::Failed);
        assert!(!temp.exists());
        assert!(chosen.join("inside").is_dir());
        // Success reported but the file is not there: failed.
        assert_eq!(
            settle(&dir.join(".gone.part"), &dir.join("gone.pdf"), true),
            Outcome::Failed
        );
        assert!(!dir.join("gone.pdf").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_dialog_offers_the_pages_own_name() {
        assert_eq!(
            suggested_name("argelanderspace-diagnostics-20261015-120000.zip"),
            "argelanderspace-diagnostics-20261015-120000.zip"
        );
        assert_eq!(suggested_name("paper (1).pdf"), "paper (1).pdf");
        assert_eq!(suggested_name("a/b/../c.txt"), "c.txt");
        assert_eq!(suggested_name("x\\y.pdf"), "y.pdf");
        for empty in ["", "  ", "dir/", ".", ".."] {
            assert_eq!(suggested_name(empty), "download", "{empty:?}");
        }
    }
}
