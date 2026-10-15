//! The shell's menu (desktop-app ticket 21; spec User Stories 9, 15, 16, 74, 75): open a folder, the recent projects,
//! open the page in the browser, the developer tools (F12), about. What an item does is the host's business: every
//! item but "about" goes back to the host as a `menu` line (protocol.rs), which carries it out as the page's request
//! of that kind or as opening that recent project — the same paths, prompts and records (desktop-app ticket 19). The
//! recent projects, their labels and ids, and the language come from the host's `menu` line; the shell only shows them.
//!
//! The words are written here in both languages, as the crash dialog's are (main.rs); the language is the one the
//! host reports now (config.toml `[ui] language`, followed while it runs).

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

use crate::protocol::{Language, MenuModel};

/// The menu's words in one language.
pub struct MenuText {
    pub file: &'static str,
    pub open_folder: &'static str,
    pub open_recent: &'static str,
    pub no_recent: &'static str,
    pub view: &'static str,
    pub open_in_browser: &'static str,
    pub devtools: &'static str,
    pub help: &'static str,
    pub about: &'static str,
    pub about_title: &'static str,
    pub version: &'static str,
    pub ok: &'static str,
}

impl MenuText {
    pub fn of(language: Language) -> MenuText {
        match language {
            Language::Chinese => MenuText {
                file: "文件",
                open_folder: "打开文件夹…",
                open_recent: "最近项目",
                no_recent: "没有其他最近项目",
                view: "视图",
                open_in_browser: "在浏览器中打开",
                devtools: "开发者工具",
                help: "帮助",
                about: "关于 ArgelanderSpace",
                about_title: "关于 ArgelanderSpace",
                version: "版本",
                ok: "好",
            },
            Language::English => MenuText {
                file: "File",
                open_folder: "Open Folder…",
                open_recent: "Open Recent",
                no_recent: "No other recent projects",
                view: "View",
                open_in_browser: "Open in Browser",
                devtools: "Developer Tools",
                help: "Help",
                about: "About ArgelanderSpace",
                about_title: "About ArgelanderSpace",
                version: "Version",
                ok: "OK",
            },
        }
    }

    /// The about dialog's text: the name and the version (packages/app/package.json, as the CLI's `--version`).
    pub fn about_message(&self, version: &str) -> String {
        format!("ArgelanderSpace\n\n{} {version}", self.version)
    }
}

/// What a menu item asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuChoice {
    OpenFolder,
    /// A recent project, by the host's id for it.
    OpenRecent(String),
    OpenInBrowser,
    OpenDevtools,
    About,
}

impl MenuChoice {
    /// The item as `shell.menu_chosen` records it (never the recent project's id or label).
    pub fn name(&self) -> &'static str {
        match self {
            MenuChoice::OpenFolder => "open_folder",
            MenuChoice::OpenRecent(_) => "open_recent",
            MenuChoice::OpenInBrowser => "open_in_browser",
            MenuChoice::OpenDevtools => "open_devtools",
            MenuChoice::About => "about",
        }
    }
}

const ID_OPEN_FOLDER: &str = "open_folder";
const ID_OPEN_IN_BROWSER: &str = "open_in_browser";
const ID_DEVTOOLS: &str = "open_devtools";
const ID_ABOUT: &str = "about";
const ID_NO_RECENT: &str = "no_recent";
const RECENT_PREFIX: &str = "recent:";

/// The menu item an id of this menu names; none for anything else (the disabled "no recent projects" line).
pub fn choice(id: &str) -> Option<MenuChoice> {
    match id {
        ID_OPEN_FOLDER => Some(MenuChoice::OpenFolder),
        ID_OPEN_IN_BROWSER => Some(MenuChoice::OpenInBrowser),
        ID_DEVTOOLS => Some(MenuChoice::OpenDevtools),
        ID_ABOUT => Some(MenuChoice::About),
        _ => id
            .strip_prefix(RECENT_PREFIX)
            .filter(|rest| !rest.is_empty())
            .map(|rest| MenuChoice::OpenRecent(rest.to_owned())),
    }
}

/// A label shown as it is: `&` would otherwise mark a mnemonic (muda).
fn literal(label: &str) -> String {
    label.replace('&', "&&")
}

/// The menu for this model: File (open folder, recent projects), View (open in browser, developer tools), Help
/// (about). F12 opens the developer tools, Ctrl+O the folder dialog.
pub fn build<R: Runtime>(app: &AppHandle<R>, model: &MenuModel) -> tauri::Result<Menu<R>> {
    let text = MenuText::of(model.language);
    let mut recent = SubmenuBuilder::new(app, text.open_recent);
    if model.recent.is_empty() {
        recent = recent.item(
            &MenuItemBuilder::with_id(ID_NO_RECENT, text.no_recent)
                .enabled(false)
                .build(app)?,
        );
    }
    for item in &model.recent {
        recent = recent.item(
            &MenuItemBuilder::with_id(format!("{RECENT_PREFIX}{}", item.id), literal(&item.label))
                .enabled(item.enabled)
                .build(app)?,
        );
    }
    let file = SubmenuBuilder::new(app, text.file)
        .item(
            &MenuItemBuilder::with_id(ID_OPEN_FOLDER, text.open_folder)
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&recent.build()?)
        .build()?;
    let view = SubmenuBuilder::new(app, text.view)
        .item(&MenuItemBuilder::with_id(ID_OPEN_IN_BROWSER, text.open_in_browser).build(app)?)
        .item(
            &MenuItemBuilder::with_id(ID_DEVTOOLS, text.devtools)
                .accelerator("F12")
                .build(app)?,
        )
        .build()?;
    let help = SubmenuBuilder::new(app, text.help)
        .item(&MenuItemBuilder::with_id(ID_ABOUT, text.about).build(app)?)
        .build()?;
    MenuBuilder::new(app).items(&[&file, &view, &help]).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_name_their_items() {
        assert_eq!(choice("open_folder"), Some(MenuChoice::OpenFolder));
        assert_eq!(choice("open_in_browser"), Some(MenuChoice::OpenInBrowser));
        assert_eq!(choice("open_devtools"), Some(MenuChoice::OpenDevtools));
        assert_eq!(choice("about"), Some(MenuChoice::About));
        assert_eq!(
            choice("recent:m3-1"),
            Some(MenuChoice::OpenRecent("m3-1".into()))
        );
        for none in ["recent:", "no_recent", "", "quit", "Recent:m1"] {
            assert_eq!(choice(none), None, "{none}");
        }
        assert_eq!(MenuChoice::OpenRecent("m3-1".into()).name(), "open_recent");
    }

    #[test]
    fn labels_are_literal_and_both_languages_say_the_version() {
        assert_eq!(literal("R&D — ~/p/R&D"), "R&&D — ~/p/R&&D");
        assert_eq!(
            MenuText::of(Language::Chinese).about_message("0.1.0"),
            "ArgelanderSpace\n\n版本 0.1.0"
        );
        assert_eq!(
            MenuText::of(Language::English).about_message("0.1.0"),
            "ArgelanderSpace\n\nVersion 0.1.0"
        );
    }
}
