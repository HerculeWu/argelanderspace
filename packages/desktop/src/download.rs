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
//! this handler, then the first, answers and ends the signal before it. wry's `failed` and `finished` handlers stay
//! connected and only touch wry's own flag; without `on_download` they report to nobody.
//!
//! The name offered is the page's own (`suggested_name`); no « (1) » is added when a file of that name is there — the
//! dialog asks before replacing it (wry numbered names only to match Windows' WebView2, which never asks).
//!
//! The dialog runs inside WebKit's signal on the main thread (GTK's own nested loop, as any modal GTK dialog): WebKit
//! waits for the answer, the window stays drawn.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use gtk::prelude::*;
use webkit2gtk::{DownloadError, DownloadExt, WebContextExt, WebViewExt};

use crate::protocol::Language;

/// The save dialog's and the failure dialog's words.
pub struct SaveText {
    pub title: &'static str,
    pub cancel: &'static str,
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
pub enum Step {
    Decided { chosen: bool },
    Failed { by_user: bool },
    Finished,
}

#[derive(Debug, Default)]
struct Track {
    declined: bool,
    failed: Option<bool>,
}

/// The downloads under way, each with its own record: what one of them did never colours another's outcome.
#[derive(Debug, Default)]
pub struct Downloads {
    next: u64,
    live: HashMap<u64, Track>,
}

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
fn start_folder() -> PathBuf {
    gtk::glib::user_special_dir(gtk::glib::UserDirectory::Downloads)
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(gtk::glib::home_dir)
}

/// Connects the shell's save flow to the webview's downloads; false when the webview has no context to connect to
/// (the window is then not used, as when its page cannot be guarded). `report` gets each download's outcome.
pub fn attach(
    view: &webkit2gtk::WebView,
    language: Arc<Mutex<Language>>,
    report: impl Fn(Outcome) + 'static,
) -> bool {
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
pub fn ask_where(
    parent: Option<&gtk::Window>,
    folder: &Path,
    name: &str,
    language: Language,
) -> Option<PathBuf> {
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
