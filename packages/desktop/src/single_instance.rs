//! One shell per user session (spec User Story 6): the first shell listens on a Unix socket; a later start connects,
//! asks it to bring its window to the front and exits. Plain std, no D-Bus: the socket is in `$XDG_RUNTIME_DIR` (the
//! session's private directory), or in the temporary directory with the user id in its name.
//!
//! A socket file left by a shell that was killed is noticed (nobody answers) and replaced. Before the shell connects to
//! a socket file or replaces it, the file must be a socket owned by this user: in the temporary-directory fallback
//! another user could have put one there; otherwise the shell runs without the guard (`Instance::Foreign`) and leaves
//! the file alone. The shell removes the socket file at its end only if it made it and the file is still that one
//! (same device, inode and change time as at its bind — a file system may give a new file the inode of a removed one): a shell that did not get the socket never removes it. Two shells started in
//! the same instant may both become first; the window of that race is the time between a refused connect and a bind.
//! Unix only; the other platforms' shells are desktop-app ticket 26.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const RAISE: &str = "raise";

/// Where the socket is: `$XDG_RUNTIME_DIR/argelanderspace-shell.sock`, else `<tmp>/argelanderspace-shell-<uid>.sock`.
pub fn socket_path(runtime_dir: Option<&Path>, temp_dir: &Path, uid: Option<u32>) -> PathBuf {
    match runtime_dir.filter(|d| d.is_absolute()) {
        Some(dir) => dir.join("argelanderspace-shell.sock"),
        None => temp_dir.join(format!(
            "argelanderspace-shell-{}.sock",
            uid.map_or("u".into(), |u| u.to_string())
        )),
    }
}

fn my_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// The socket path for this process's environment.
pub fn default_socket_path() -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    socket_path(runtime.as_deref(), &std::env::temp_dir(), Some(my_uid()))
}

/// The socket file this shell made: removed at its end only while it is still that file.
#[derive(Debug)]
pub struct Owned {
    path: PathBuf,
    id: (u64, u64, i64, i64),
}

fn identity(meta: &std::fs::Metadata) -> (u64, u64, i64, i64) {
    (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec())
}

impl Owned {
    fn of(path: &Path) -> std::io::Result<Owned> {
        let meta = std::fs::symlink_metadata(path)?;
        Ok(Owned {
            path: path.to_path_buf(),
            id: identity(&meta),
        })
    }

    /// Removes the socket file if it is still the one this shell bound (another shell may have replaced it).
    pub fn release(&self) -> bool {
        match std::fs::symlink_metadata(&self.path) {
            Ok(meta) if identity(&meta) == self.id => std::fs::remove_file(&self.path).is_ok(),
            _ => false,
        }
    }
}

pub enum Instance {
    /// This is the first shell: raise requests arrive on the listener.
    First(UnixListener, Owned),
    /// Another shell runs and was asked to raise its window.
    Another,
    /// The file at the socket's place is not a socket of this user: left alone, no guard.
    Foreign,
}

/// Whether the file at the socket's place may be connected to or replaced: a socket owned by `uid`.
fn ours(meta: &std::fs::Metadata, uid: u32) -> bool {
    meta.file_type().is_socket() && meta.uid() == uid
}

/// Becomes the first shell, or tells the running one to raise its window.
pub fn claim(path: &Path) -> std::io::Result<Instance> {
    claim_as(path, my_uid())
}

fn claim_as(path: &Path, uid: u32) -> std::io::Result<Instance> {
    let bound = |path: &Path| -> std::io::Result<Instance> {
        let listener = UnixListener::bind(path)?;
        Ok(Instance::First(listener, Owned::of(path)?))
    };
    match bound(path) {
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            let meta = std::fs::symlink_metadata(path)?;
            if !ours(&meta, uid) {
                return Ok(Instance::Foreign);
            }
            if let Ok(mut stream) = UnixStream::connect(path) {
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                stream.write_all(format!("{RAISE}\n").as_bytes())?;
                return Ok(Instance::Another);
            }
            // Nobody answers: a socket file left by a shell that was killed.
            std::fs::remove_file(path)?;
            bound(path)
        }
        other => other,
    }
}

/// Calls `on_raise` for every later start, on a thread of its own.
pub fn serve(listener: UnixListener, on_raise: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut line = String::new();
            if BufReader::new(stream).read_line(&mut line).is_ok() && line.trim_end() == RAISE {
                on_raise();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aspace-si-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn where_the_socket_is() {
        assert_eq!(
            socket_path(
                Some(Path::new("/run/user/1000")),
                Path::new("/tmp"),
                Some(1000)
            ),
            PathBuf::from("/run/user/1000/argelanderspace-shell.sock")
        );
        assert_eq!(
            socket_path(None, Path::new("/tmp"), Some(1000)),
            PathBuf::from("/tmp/argelanderspace-shell-1000.sock")
        );
        assert_eq!(
            socket_path(Some(Path::new("relative")), Path::new("/tmp"), None),
            PathBuf::from("/tmp/argelanderspace-shell-u.sock")
        );
    }

    #[test]
    fn the_second_start_raises_the_first() {
        let d = dir("raise");
        let path = d.join("s.sock");
        let Instance::First(listener, owned) = claim(&path).unwrap() else {
            panic!("first")
        };
        let (tx, rx) = mpsc::channel();
        serve(listener, move || tx.send(()).unwrap());
        assert!(matches!(claim(&path).unwrap(), Instance::Another));
        rx.recv_timeout(Duration::from_secs(5)).expect("raised");
        assert!(matches!(claim(&path).unwrap(), Instance::Another));
        rx.recv_timeout(Duration::from_secs(5))
            .expect("raised again");
        // The later starts did not take the socket file away.
        assert!(path.exists());
        assert!(owned.release());
        assert!(!path.exists());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_socket_left_by_a_killed_shell_is_taken_over() {
        let d = dir("stale");
        let path = d.join("s.sock");
        drop(UnixListener::bind(&path).unwrap()); // the file stays, nobody listens
        assert!(path.exists());
        assert!(matches!(claim(&path).unwrap(), Instance::First(..)));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn the_socket_file_is_removed_only_while_it_is_still_the_one_bound() {
        let d = dir("release");
        let path = d.join("s.sock");
        let Instance::First(listener, owned) = claim(&path).unwrap() else {
            panic!("first")
        };
        // Another shell took the place over (this one's socket file was removed and a new one bound there).
        drop(listener);
        // Later than the kernel's coarse clock tick, as another shell's start would be.
        std::thread::sleep(Duration::from_millis(20));
        std::fs::remove_file(&path).unwrap();
        let other = UnixListener::bind(&path).unwrap();
        assert!(!owned.release(), "not this shell's file any more");
        assert!(path.exists());
        drop(other);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_file_that_is_not_a_socket_of_this_user_is_left_alone() {
        let d = dir("foreign");
        let path = d.join("s.sock");
        std::fs::write(&path, "not a socket").unwrap();
        assert!(matches!(claim(&path).unwrap(), Instance::Foreign));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a socket");
        // A socket nobody answers on, but owned by another user: neither connected to nor replaced.
        let sock = d.join("t.sock");
        drop(UnixListener::bind(&sock).unwrap());
        let ino = std::fs::symlink_metadata(&sock).unwrap().ino();
        assert!(matches!(
            claim_as(&sock, my_uid().wrapping_add(1)).unwrap(),
            Instance::Foreign
        ));
        assert_eq!(std::fs::symlink_metadata(&sock).unwrap().ino(), ino);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
