//! How the host is started: which Node runs which entry, with which arguments, in which directory. This is the seam
//! between the shell and the host's packaging.
//!
//! - Development (now): the system `node` (looked up on `PATH`) runs the repository's built CLI bundle,
//!   `packages/app/dist/bin.js` (build it with `corepack pnpm -r build` first). The path is fixed when the shell is
//!   compiled, from this crate's location in the repository.
//! - Packaged (desktop-app ticket 23; a build with `--features packaged`, which `tauri build` gets from the packaging
//!   steps in docs/engineering.md): the Node runtime and the app's build ship as the bundle's resources, under
//!   `sidecar/` in the resource directory Tauri resolves (for a deb: `/usr/lib/argelanderspace`, found next to the
//!   executable as `../lib/argelanderspace`). `sidecar/node/bin/node` runs `sidecar/app/dist/bin.js`; Node finds the
//!   dependency directory `sidecar/app/node_modules` next to `dist/` by its own lookup. The system `PATH` is never
//!   consulted for node. A build without the feature never looks in the resource directory, and a packaged build never
//!   falls back to the repository.
//!
//! The host runs in a process group of its own (its pid is the group's id), so that the shell's forced end after the
//! shutdown limit (`kill_group`) takes the host's own children (latexmk and the like) with it instead of leaving them
//! orphaned. A terminal's Ctrl-C reaches the shell only; the host then ends when its stdin closes (desktop-app ticket 17).
//!
//! The host's arguments are the desktop host's (docs/architecture.md「桌面宿主」): `desktop-host` and, when the shell
//! knows the project (a switch's `next`, a restart after a crash), `--project <folder>`. Without it the host chooses
//! from the recently opened projects, or goes to the welcome state.

use std::ffi::OsString;
use std::os::unix::process::CommandExt;
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
    #[cfg_attr(feature = "packaged", allow(dead_code))]
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

    /// The packaged launcher: the bundle's own Node and app build, under `sidecar/` in `resource_dir`.
    #[cfg_attr(not(feature = "packaged"), allow(dead_code))]
    pub fn packaged(resource_dir: &Path) -> Self {
        let sidecar = resource_dir.join("sidecar");
        HostLauncher {
            node: sidecar.join("node").join("bin").join("node"),
            entry: sidecar.join("app").join("dist").join("bin.js"),
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
            .stderr(Stdio::inherit())
            .process_group(0);
        command
    }
}

/// Ends the host's process group at once (SIGKILL to every process in it). `pgid` is the host's pid.
pub fn kill_group(pgid: u32) -> bool {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return false;
    };
    if pgid <= 1 {
        return false;
    }
    // SAFETY: killpg only sends a signal; a group that no longer exists answers ESRCH.
    unsafe { libc::killpg(pgid, libc::SIGKILL) == 0 }
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
    use std::io::{BufRead, BufReader};

    #[test]
    fn the_development_launcher_runs_the_repositorys_bundle() {
        let l = HostLauncher::development();
        assert_eq!(l.node, PathBuf::from("node"));
        assert!(l.entry.ends_with("app/dist/bin.js"));
        assert!(l.entry.is_absolute());
    }

    #[test]
    fn the_packaged_launcher_runs_the_bundles_node_and_build_from_the_resource_directory() {
        let l = HostLauncher::packaged(Path::new("/usr/lib/argelanderspace"));
        assert_eq!(
            l.node,
            PathBuf::from("/usr/lib/argelanderspace/sidecar/node/bin/node")
        );
        assert_eq!(
            l.entry,
            PathBuf::from("/usr/lib/argelanderspace/sidecar/app/dist/bin.js")
        );
        // An absolute path: never looked up on PATH.
        assert!(l.node.is_absolute());
        assert_eq!(
            l.args(Some("/p")),
            vec![
                OsString::from("/usr/lib/argelanderspace/sidecar/app/dist/bin.js"),
                "desktop-host".into(),
                "--project".into(),
                "/p".into()
            ]
        );
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
    fn the_host_runs_in_a_group_of_its_own_and_the_forced_end_takes_its_children() {
        let dir = std::env::temp_dir().join(format!("aspace-launch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A stand-in host: starts a child of its own, says its pid, and waits.
        let script = dir.join("host.sh");
        std::fs::write(&script, "sleep 60 &\necho $!\nwait\n").unwrap();
        let l = HostLauncher {
            node: "sh".into(),
            entry: script,
        };
        let mut host = l.command(None, &dir).spawn().unwrap();
        let pid = host.id();
        let mut out = String::new();
        BufReader::new(host.stdout.take().unwrap())
            .read_line(&mut out)
            .unwrap();
        let grandchild: i32 = out.trim().parse().unwrap();
        // SAFETY: getpgid only reads.
        assert_eq!(unsafe { libc::getpgid(pid as i32) }, pid as i32);
        assert_eq!(unsafe { libc::getpgid(grandchild) }, pid as i32);
        assert_ne!(unsafe { libc::getpgid(0) }, pid as i32);
        assert!(kill_group(pid));
        host.wait().unwrap();
        let mut gone = false;
        for _ in 0..100 {
            // The grandchild is reaped by init once killed; kill(0) then fails.
            if unsafe { libc::kill(grandchild, 0) } != 0 {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(gone, "the host's child ended with it");
        assert!(!kill_group(1));
        std::fs::remove_dir_all(&dir).unwrap();
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
