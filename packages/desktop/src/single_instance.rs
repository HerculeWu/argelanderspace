//! One shell per user session (spec User Story 6): the first shell listens on a Unix socket; a later start connects,
//! asks it to bring its window to the front and exits. Plain std, no D-Bus: the socket is in `$XDG_RUNTIME_DIR` (the
//! session's private directory), or in the temporary directory with the user id in its name.
//!
//! A socket file left by a shell that was killed is noticed (nobody answers) and replaced. Two shells started in the
//! same instant may both become first; the window of that race is the time between a refused connect and a bind.
//! Unix only; the other platforms' shells are desktop-app ticket 26.

use std::io::{BufRead, BufReader, Write};
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

/// The socket path for this process's environment.
pub fn default_socket_path() -> PathBuf {
    use std::os::unix::fs::MetadataExt;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    let uid = std::fs::metadata("/proc/self").ok().map(|m| m.uid());
    socket_path(runtime.as_deref(), &std::env::temp_dir(), uid)
}

pub enum Instance {
    /// This is the first shell: raise requests arrive on the listener.
    First(UnixListener),
    /// Another shell runs and was asked to raise its window.
    Another,
}

/// Becomes the first shell, or tells the running one to raise its window.
pub fn claim(path: &Path) -> std::io::Result<Instance> {
    match UnixListener::bind(path) {
        Ok(listener) => Ok(Instance::First(listener)),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            if let Ok(mut stream) = UnixStream::connect(path) {
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                stream.write_all(format!("{RAISE}\n").as_bytes())?;
                return Ok(Instance::Another);
            }
            // Nobody answers: a socket file left by a shell that was killed.
            std::fs::remove_file(path)?;
            UnixListener::bind(path).map(Instance::First)
        }
        Err(error) => Err(error),
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
        let Instance::First(listener) = claim(&path).unwrap() else {
            panic!("first")
        };
        let (tx, rx) = mpsc::channel();
        serve(listener, move || tx.send(()).unwrap());
        assert!(matches!(claim(&path).unwrap(), Instance::Another));
        rx.recv_timeout(Duration::from_secs(5)).expect("raised");
        assert!(matches!(claim(&path).unwrap(), Instance::Another));
        rx.recv_timeout(Duration::from_secs(5))
            .expect("raised again");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_socket_left_by_a_killed_shell_is_taken_over() {
        let d = dir("stale");
        let path = d.join("s.sock");
        drop(UnixListener::bind(&path).unwrap()); // the file stays, nobody listens
        assert!(path.exists());
        assert!(matches!(claim(&path).unwrap(), Instance::First(_)));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
