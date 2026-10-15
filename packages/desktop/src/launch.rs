//! How the host is started: which Node runs which entry, with which arguments, in which directory. This is the seam
//! between the shell and the host's packaging.
//!
//! - Development (now): the system `node` (looked up on `PATH`) runs the repository's built CLI bundle,
//!   `packages/app/dist/bin.js` (build it with `corepack pnpm -r build` first). The path is fixed when the shell is
//!   compiled, from this crate's location in the repository.
//! - Packaged (desktop-app ticket 23): the Node runtime and the app's build shipped as the bundle's resources;
//!   `HostLauncher` gets a constructor that finds them from the resource directory. Nothing else changes.
//!
//! The host's arguments are the desktop host's (docs/architecture.md「桌面宿主」): `desktop-host` and, when the shell
//! knows the project (a switch's `next`, a restart after a crash), `--project <folder>`. Without it the host chooses
//! from the recently opened projects, or goes to the welcome state.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostLauncher {
    /// The Node executable (a bare name is looked up on `PATH`).
    pub node: PathBuf,
    /// The CLI bundle that has the `desktop-host` entry.
    pub entry: PathBuf,
}

impl HostLauncher {
    /// The development launcher: the system `node` and the repository's built bundle.
    pub fn development() -> Self {
        HostLauncher {
            node: PathBuf::from("node"),
            entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("app")
                .join("dist")
                .join("bin.js"),
        }
    }

    /// The host's argument list.
    pub fn args(&self, project: Option<&str>) -> Vec<OsString> {
        let mut args: Vec<OsString> =
            vec![self.entry.clone().into_os_string(), "desktop-host".into()];
        if let Some(project) = project {
            args.push("--project".into());
            args.push(project.into());
        }
        args
    }

    /// The host's command: the line protocol on its stdin and stdout, its stderr the shell's, its working
    /// directory the shell's (fixed at the shell's start, `main.rs`).
    pub fn command(&self, project: Option<&str>, cwd: &Path) -> Command {
        let mut command = Command::new(&self.node);
        command
            .args(self.args(project))
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        command
    }
}

/// The shell's working directory, set at its start so that nothing lands in whatever directory it was started from
/// (desktop-app ticket 02: the webview saved downloads into the shell's current directory): the user's home folder,
/// or `/` without one.
pub fn shell_working_dir(home: Option<OsString>) -> PathBuf {
    home.map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir())
        .unwrap_or_else(|| PathBuf::from("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_development_launcher_runs_the_repositorys_bundle() {
        let l = HostLauncher::development();
        assert_eq!(l.node, PathBuf::from("node"));
        assert!(l.entry.ends_with("app/dist/bin.js"));
        assert!(l.entry.is_absolute());
    }

    #[test]
    fn arguments_with_and_without_a_project() {
        let l = HostLauncher {
            node: "/n".into(),
            entry: "/e/bin.js".into(),
        };
        assert_eq!(
            l.args(None),
            vec![OsString::from("/e/bin.js"), "desktop-host".into()]
        );
        assert_eq!(
            l.args(Some("/home/u/My Project")),
            vec![
                OsString::from("/e/bin.js"),
                "desktop-host".into(),
                "--project".into(),
                "/home/u/My Project".into()
            ]
        );
    }

    #[test]
    fn the_working_directory() {
        let tmp = std::env::temp_dir();
        assert_eq!(shell_working_dir(Some(tmp.clone().into_os_string())), tmp);
        assert_eq!(shell_working_dir(None), PathBuf::from("/"));
        assert_eq!(
            shell_working_dir(Some("relative".into())),
            PathBuf::from("/")
        );
        assert_eq!(
            shell_working_dir(Some("/nonexistent/aspace".into())),
            PathBuf::from("/")
        );
    }
}
