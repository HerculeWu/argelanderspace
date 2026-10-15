//! Downloads of the page (desktop-app ticket 21): the diagnostics bundle, a PDF original, a manuscript export, a mail
//! attachment — every `<a download>` the page clicks. WebKitGTK has no save flow of its own (desktop-app ticket 02: the
//! file went silently into the shell's working directory), so the shell asks: when WebKit wants the download's
//! destination (`decide-destination`, through Tauri's `on_download`), a GTK save dialog opens over the window, in the
//! user's download folder (else the home directory) with the name the page suggested, and asks before replacing a
//! file. Cancelled, the download is cancelled and nothing is written; a download that then fails is said in a native
//! dialog. The file's name and folder are never recorded (`shell.download` has the outcome only).
//!
//! The dialog runs inside WebKit's signal on the main thread (GTK's own nested loop, as any modal GTK dialog): WebKit
//! waits for the answer, the window stays drawn.

use std::path::{Path, PathBuf};

use gtk::prelude::*;

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

/// Where the dialog starts, and the name it suggests, from the destination WebKit proposed (the download folder, or
/// the shell's working directory — the home directory — with the page's file name).
pub fn start_of(proposed: &Path) -> (Option<PathBuf>, String) {
    let name = proposed
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "download".into());
    (proposed.parent().map(Path::to_path_buf), name)
}

/// Asks where to save: the chosen path, or none when the dialog was cancelled or closed.
pub fn ask_where(
    parent: Option<&gtk::ApplicationWindow>,
    proposed: &Path,
    language: Language,
) -> Option<PathBuf> {
    let text = SaveText::of(language);
    let (folder, name) = start_of(proposed);
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
    if let Some(folder) = folder.filter(|f| f.is_dir()) {
        let _ = dialog.set_current_folder(folder);
    }
    dialog.set_current_name(&name);
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

    #[test]
    fn the_dialog_starts_where_webkit_proposed_with_the_pages_name() {
        assert_eq!(
            start_of(Path::new(
                "/home/u/Downloads/argelanderspace-diagnostics-20261015-120000.zip"
            )),
            (
                Some(PathBuf::from("/home/u/Downloads")),
                "argelanderspace-diagnostics-20261015-120000.zip".into()
            )
        );
        assert_eq!(
            start_of(Path::new("/home/u/paper (1).pdf")),
            (Some(PathBuf::from("/home/u")), "paper (1).pdf".into())
        );
        assert_eq!(start_of(Path::new("/")), (None, "download".into()));
    }
}
