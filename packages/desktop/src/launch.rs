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
//! The host runs in a group of its own, so that the shell's forced end after the shutdown limit (`HostGroup::kill`) takes
//! the host's own children (latexmk and the like) with it instead of leaving them orphaned:
//! - Unix (Linux, macOS): a process group (its pid is the group's id); SIGKILL to the group. A terminal's Ctrl-C
//!   reaches the shell only; the host then ends when its stdin closes (desktop-app ticket 17).
//! - Windows (desktop-app ticket 30): a job object the host is put in right after its start (its children are in it
//!   too), ended with `TerminateJobObject`; the job is kill-on-close, so the host and its children also end when the
//!   shell's handle to it goes (the shell ended or crashed). The host is started without a console window
//!   (`CREATE_NO_WINDOW`: the shell is a windowed program, Node a console one).
//!
//! On Windows the packaged Node is `sidecar/node/node.exe` (the official zip's layout), elsewhere `sidecar/node/bin/node`.
//!
//! The host's arguments are the desktop host's (docs/architecture.md「桌面宿主」): `desktop-host` and, when the shell
//! knows the project (a switch's `next`, a restart after a crash), `--project <folder>`. Without it the host chooses
//! from the recently opened projects, or goes to the welcome state.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

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
            node: packaged_node(&sidecar.join("node")),
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
            .stderr(Stdio::inherit());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        command
    }
}

/// The packaged Node in the sidecar's `node/` folder: `node.exe` on Windows, `bin/node` elsewhere.
fn packaged_node(node_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        node_dir.join("node.exe")
    } else {
        node_dir.join("bin").join("node")
    }
}

/// The host's group: its process group (Unix) or the job object it was put in (Windows).
#[derive(Debug)]
pub struct HostGroup {
    #[cfg(unix)]
    pgid: u32,
    #[cfg(windows)]
    job: windows_job::Job,
}

impl HostGroup {
    /// The group of a host just started with `HostLauncher::command`; none when it cannot be had (Windows: no job
    /// object; the shell then ends the host alone).
    pub fn of(child: &Child) -> Option<HostGroup> {
        #[cfg(unix)]
        {
            Some(HostGroup { pgid: child.id() })
        }
        #[cfg(windows)]
        {
            windows_job::Job::adopt(child).map(|job| HostGroup { job })
        }
    }

    /// Ends every process in the group at once.
    pub fn kill(&self) -> bool {
        #[cfg(unix)]
        {
            kill_group(self.pgid)
        }
        #[cfg(windows)]
        {
            self.job.terminate()
        }
    }
}

/// Ends the host's process group at once (SIGKILL to every process in it). `pgid` is the host's pid.
#[cfg(unix)]
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

#[cfg(windows)]
mod windows_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A kill-on-close job object holding the host and its children; closed (and so ended) when dropped.
    #[derive(Debug)]
    pub struct Job(HANDLE);

    // SAFETY: a job handle may be used and closed from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn adopt(child: &Child) -> Option<Job> {
            // SAFETY: plain Win32 calls on a job this function made and the live child's process handle.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let job = Job(job);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return None;
                }
                if AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0 {
                    return None;
                }
                Some(job)
            }
        }

        pub fn terminate(&self) -> bool {
            // SAFETY: the job handle is this value's own and still open.
            unsafe { TerminateJobObject(self.0, 1) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closed once, here; kill-on-close then ends what is left in the job.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// The shell's working directory, set at its start so that nothing lands in whatever directory it was started from
/// (desktop-app ticket 02: the webview saved downloads into the shell's current directory): the user's home folder,
/// or the file system's root without one (`/`; on Windows the temporary directory).
pub fn shell_working_dir(home: Option<OsString>) -> PathBuf {
    home.map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir())
        .unwrap_or_else(no_home_dir)
}

/// The user's home folder variable: `HOME` (Unix), `USERPROFILE` (Windows).
pub fn home_var() -> Option<OsString> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
}

fn no_home_dir() -> PathBuf {
    if cfg!(windows) {
        std::env::temp_dir()
    } else {
        PathBuf::from("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::io::{BufRead, BufReader};

    #[test]
    fn the_development_launcher_runs_the_repositorys_bundle() {
        let l = HostLauncher::development();
        assert_eq!(l.node, PathBuf::from("node"));
        assert!(l.entry.ends_with("app/dist/bin.js"));
        assert!(l.entry.is_absolute());
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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
        let group = HostGroup::of(&host).unwrap();
        assert!(group.kill());
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
    fn the_packaged_node_is_where_each_platforms_node_archive_puts_it() {
        let node = packaged_node(Path::new("res/sidecar/node"));
        if cfg!(windows) {
            assert_eq!(node, Path::new("res/sidecar/node").join("node.exe"));
        } else {
            assert_eq!(node, PathBuf::from("res/sidecar/node/bin/node"));
        }
    }

    #[cfg(unix)]
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
