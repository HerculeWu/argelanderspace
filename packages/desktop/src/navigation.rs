//! Where the page may go (desktop-app ticket 20 review): a top-level navigation stays on the local page's origin —
//! the `http://127.0.0.1:<port>` of the host now running — or is an `about:` page (the blank start, a frame's
//! `srcdoc`). Anything else is stopped. Desktop-app ticket 21: an `http`/`https` address the window was going to is
//! handed to the system browser instead, as is every `http`/`https` address the page asks a new window for
//! (`target=_blank`, `window.open`); the window itself never leaves the local page and no second window is made.
//! Every other scheme (`file:`, `mailto:`, `javascript:`, a custom one…) is stopped and recorded
//! (`shell.navigation_blocked`, with the scheme's category only): the shell never hands the system an address of a
//! kind the page chose that would run something other than a browser.
//!
//! WebKitGTK asks about frames' navigations too (wry 0.57 calls the handler for every navigation action): a frame of
//! the page that goes to another origin is stopped as well; the page's own frames (`srcdoc`, the same origin) are not.

use tauri::Url;

/// Whether the window may go to `target` while it shows `page` (none before the first page). `Err` carries the
/// category recorded for a stopped navigation: `http`, `https` or `other`.
pub fn check(target: &Url, page: Option<&Url>) -> Result<(), &'static str> {
    if target.scheme() == "about" {
        return Ok(());
    }
    // `origin()` of a `blob:` address is the origin of the page that made it.
    if page.is_some_and(|page| page.origin() == target.origin() && target.origin().is_tuple()) {
        return Ok(());
    }
    Err(match target.scheme() {
        "http" => "http",
        "https" => "https",
        _ => "other",
    })
}

/// What becomes of an address the page goes to or asks a new window for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The window goes there (the local page, `about:`).
    Stay,
    /// Not in the window: the system browser opens this address (`http`/`https` only).
    Browser(Url),
    /// Nowhere; the scheme's category, as `shell.navigation_blocked` records it.
    Blocked(&'static str),
}

fn browser_or_blocked(target: &Url, category: &'static str) -> Verdict {
    match target.scheme() {
        "http" | "https" => Verdict::Browser(target.clone()),
        _ => Verdict::Blocked(category),
    }
}

/// A navigation of the window (or of a frame in it) while it shows `page`.
pub fn on_navigation(target: &Url, page: Option<&Url>) -> Verdict {
    match check(target, page) {
        Ok(()) => Verdict::Stay,
        Err(category) => browser_or_blocked(target, category),
    }
}

/// A request for a new window: never made; an `http`/`https` address goes to the system browser (the local page's
/// own address included: the workbench opens there, as "open in browser" does).
pub fn on_new_window(target: &Url) -> Verdict {
    let category = match target.scheme() {
        "http" => "http",
        "https" => "https",
        _ => "other",
    };
    browser_or_blocked(target, category)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_away_go_to_the_system_browser_and_nothing_else_does() {
        let page = url("http://127.0.0.1:1859/");
        assert_eq!(
            on_navigation(&url("http://127.0.0.1:1859/doc/x"), Some(&page)),
            Verdict::Stay
        );
        assert_eq!(
            on_navigation(&url("about:srcdoc"), Some(&page)),
            Verdict::Stay
        );
        for away in [
            "https://doi.org/10.1/x",
            "http://example.org/a?b=c#d",
            "http://127.0.0.1:1860/",
        ] {
            assert_eq!(
                on_navigation(&url(away), Some(&page)),
                Verdict::Browser(url(away)),
                "{away}"
            );
            assert_eq!(
                on_new_window(&url(away)),
                Verdict::Browser(url(away)),
                "{away}"
            );
        }
        // A new window for the local page itself: the browser too (no second window of the shell).
        assert_eq!(
            on_new_window(&url("http://127.0.0.1:1859/settings")),
            Verdict::Browser(url("http://127.0.0.1:1859/settings"))
        );
        for other in [
            "file:///etc/passwd",
            "mailto:someone@example.org",
            "javascript:alert(1)",
            "data:text/html,hi",
            "blob:http://127.0.0.1:1859/1b2c",
            "about:blank",
            "ftp://example.org/x",
            "ipc://localhost/x",
            "argelanderspace://open",
        ] {
            assert_eq!(
                on_new_window(&url(other)),
                Verdict::Blocked("other"),
                "{other}"
            );
        }
        for other in [
            "file:///etc/passwd",
            "mailto:someone@example.org",
            "javascript:alert(1)",
        ] {
            assert_eq!(
                on_navigation(&url(other), Some(&page)),
                Verdict::Blocked("other"),
                "{other}"
            );
        }
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_local_page_and_its_own_addresses_are_allowed() {
        let page = url("http://127.0.0.1:1859/");
        for ok in [
            "http://127.0.0.1:1859/",
            "http://127.0.0.1:1859/settings?x=1#y",
            "blob:http://127.0.0.1:1859/1b2c3d",
            "about:blank",
            "about:srcdoc",
        ] {
            assert_eq!(check(&url(ok), Some(&page)), Ok(()), "{ok}");
        }
        assert_eq!(check(&url("about:blank"), None), Ok(()));
    }

    #[test]
    fn everything_else_is_stopped_with_its_category() {
        let page = url("http://127.0.0.1:1859/");
        for (target, category) in [
            ("http://127.0.0.1:1860/", "http"),
            ("http://localhost:1859/", "http"),
            ("https://127.0.0.1:1859/", "https"),
            ("https://doi.org/10.1/x", "https"),
            ("http://example.org/", "http"),
            ("file:///etc/passwd", "other"),
            ("data:text/html,hi", "other"),
            ("blob:https://example.org/1", "other"),
            ("javascript:alert(1)", "other"),
            ("ipc://localhost/x", "other"),
        ] {
            assert_eq!(check(&url(target), Some(&page)), Err(category), "{target}");
        }
        // Before a page is shown, only `about:`.
        assert_eq!(check(&url("http://127.0.0.1:1859/"), None), Err("http"));
    }
}
