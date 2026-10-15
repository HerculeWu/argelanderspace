//! Where the page may go (desktop-app ticket 20 review): a top-level navigation stays on the local page's origin —
//! the `http://127.0.0.1:<port>` of the host now running — or is an `about:` page (the blank start, a frame's
//! `srcdoc`). Anything else is stopped and recorded (`shell.navigation_blocked`, with the scheme's category only).
//! Desktop-app ticket 21 hands such addresses to the system browser instead.
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

#[cfg(test)]
mod tests {
    use super::*;

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
