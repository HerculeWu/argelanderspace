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
//!
//! Windows (desktop-app ticket 30, `windows` below): a named pipe in place of the socket,
//! `\\.\pipe\argelanderspace-shell-<user name>`, made with `FILE_FLAG_FIRST_PIPE_INSTANCE` (only one shell can make
//! it) and refusing remote clients. A later start connects only when the pipe's owner is this user (the same check as
//! the socket file's): another user's pipe of that name is `Instance::Foreign`, left alone, no guard. A pipe goes away
//! with the process that made it, so there is nothing left behind to replace or remove.

#[cfg(unix)]
mod unix {
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
}
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        ReadFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, WaitNamedPipeW,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const RAISE: &[u8] = b"raise\n";
    const ERROR_PIPE_BUSY: i32 = 231;

    /// The pipe's name for a user name: only letters, digits, `-` and `_` of it (`u` when none is left).
    pub fn pipe_path(user: Option<&str>) -> PathBuf {
        let user: String = user
            .unwrap_or_default()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        let user = if user.is_empty() { "u".into() } else { user };
        PathBuf::from(format!(r"\\.\pipe\argelanderspace-shell-{user}"))
    }

    pub fn default_socket_path() -> PathBuf {
        pipe_path(std::env::var("USERNAME").ok().as_deref())
    }

    /// Nothing to remove: the pipe goes with the process that made it.
    #[derive(Debug)]
    pub struct Owned;

    impl Owned {
        pub fn release(&self) -> bool {
            true
        }
    }

    /// The pipe this shell made, waiting for later starts.
    pub struct Listener(HANDLE);

    // SAFETY: the pipe handle is used by one thread at a time (moved to the serving thread).
    unsafe impl Send for Listener {}

    pub enum Instance {
        First(Listener, Owned),
        Another,
        Foreign,
    }

    fn wide(path: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn create(path: &Path) -> Option<HANDLE> {
        let name = wide(path);
        // SAFETY: a NUL-terminated name; default security (the creator owns the pipe).
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                0,
                64,
                0,
                std::ptr::null(),
            )
        };
        (handle != INVALID_HANDLE_VALUE).then_some(handle)
    }

    /// Whether the kernel object behind `handle` is owned by this process's user.
    fn owned_by_me(handle: HANDLE) -> bool {
        // SAFETY: plain Win32 security queries; every buffer is this function's and freed here.
        unsafe {
            let mut owner = std::ptr::null_mut();
            let mut descriptor = std::ptr::null_mut();
            if GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            ) != 0
            {
                return false;
            }
            let mut token = std::ptr::null_mut();
            let mut same = false;
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0 {
                let mut buffer = vec![0u8; 256];
                let mut len = 0u32;
                if GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut len,
                ) != 0
                {
                    let user = &*(buffer.as_ptr() as *const TOKEN_USER);
                    same = EqualSid(owner, user.User.Sid) != 0;
                }
                CloseHandle(token);
            }
            LocalFree(descriptor as _);
            same
        }
    }

    pub fn claim(path: &Path) -> std::io::Result<Instance> {
        for _ in 0..3 {
            if let Some(handle) = create(path) {
                return Ok(Instance::First(Listener(handle), Owned));
            }
            // The pipe is there: another shell's, or someone else's.
            match OpenOptions::new().write(true).open(path) {
                Ok(mut pipe) => {
                    if !owned_by_me(pipe.as_raw_handle() as HANDLE) {
                        return Ok(Instance::Foreign);
                    }
                    pipe.write_all(RAISE)?;
                    return Ok(Instance::Another);
                }
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    // The running shell is between two later starts: wait for its pipe a moment.
                    let name = wide(path);
                    // SAFETY: a NUL-terminated name.
                    unsafe { WaitNamedPipeW(name.as_ptr(), 2000) };
                }
                // Gone in between (the other shell ended): try to make it again.
                Err(_) => {}
            }
        }
        Err(std::io::Error::other(
            "the single-instance pipe could not be had",
        ))
    }

    pub fn serve(listener: Listener, on_raise: impl Fn() + Send + 'static) {
        std::thread::spawn(move || loop {
            let handle = listener.0;
            // SAFETY: the pipe handle is the listener's own; blocking calls on this thread only.
            unsafe {
                let connected = ConnectNamedPipe(handle, std::ptr::null_mut()) != 0
                    || GetLastError() == ERROR_PIPE_CONNECTED;
                if connected {
                    let mut buf = [0u8; 64];
                    let mut read = 0u32;
                    if ReadFile(
                        handle,
                        buf.as_mut_ptr(),
                        buf.len() as u32,
                        &mut read,
                        std::ptr::null_mut(),
                    ) != 0
                        && buf[..read as usize].starts_with(RAISE)
                    {
                        on_raise();
                    }
                }
                DisconnectNamedPipe(handle);
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_pipe_is_named_after_the_user() {
            assert_eq!(
                pipe_path(Some("Ada Lovelace")),
                PathBuf::from(r"\\.\pipe\argelanderspace-shell-AdaLovelace")
            );
            assert_eq!(
                pipe_path(None),
                PathBuf::from(r"\\.\pipe\argelanderspace-shell-u")
            );
        }

        #[test]
        fn the_second_start_raises_the_first() {
            let path = pipe_path(Some(&format!("test-{}", std::process::id())));
            let Instance::First(listener, _owned) = claim(&path).unwrap() else {
                panic!("first")
            };
            let (tx, rx) = std::sync::mpsc::channel();
            serve(listener, move || tx.send(()).unwrap());
            assert!(matches!(claim(&path).unwrap(), Instance::Another));
            rx.recv_timeout(std::time::Duration::from_secs(5))
                .expect("raised");
            assert!(matches!(claim(&path).unwrap(), Instance::Another));
            rx.recv_timeout(std::time::Duration::from_secs(5))
                .expect("raised again");
        }
    }
}
#[cfg(windows)]
pub use windows::*;
