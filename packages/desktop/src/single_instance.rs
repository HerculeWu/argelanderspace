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
//! `\\.\pipe\argelanderspace-shell-<user SID>` (the SID string: ASCII whatever the user's name), made with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE` (only one shell can make it), refusing remote clients, owned by this user and with a
//! DACL that lets only this user in (`O:<sid>D:P(A;;GA;;;<sid>)`). A later start opens it for identification only
//! (`SECURITY_IDENTIFICATION`: the pipe's server cannot act as it) and writes only when the pipe's owner is this user
//! (the same check as the socket file's); a pipe of that name it may not open (access denied) or that another user
//! owns is `Instance::Foreign`, left alone, no guard. The first shell waits at most 2 s for a connected start's line,
//! and backs off (50 ms doubling to 5 s) when waiting for a connection keeps failing. A pipe goes away with the
//! process that made it, so there is nothing left behind to replace or remove.

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
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_NO_DATA,
        ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        ReadFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND, SECURITY_IDENTIFICATION,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PeekNamedPipe, WaitNamedPipeW,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const RAISE: &[u8] = b"raise\n";
    const ERROR_PIPE_BUSY: i32 = 231;
    /// How long a connected later start has to write its line before it is dropped.
    const READ_WITHIN: Duration = Duration::from_secs(2);

    /// The pipe's name for a user's SID string (`S-1-5-21-…`: ASCII whatever the user's name); `u` when none.
    pub fn pipe_path(sid: Option<&str>) -> PathBuf {
        let sid: String = sid
            .unwrap_or_default()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        let sid = if sid.is_empty() { "u".into() } else { sid };
        PathBuf::from(format!(r"\\.\pipe\argelanderspace-shell-{sid}"))
    }

    pub fn default_socket_path() -> PathBuf {
        // Test builds: the smoke's own pipe, so a smoke run never meets a shell of the user's (or an earlier run's).
        #[cfg(feature = "smoke-probe")]
        if let Ok(tag) = std::env::var("ARGELANDERSPACE_SHELL_PROBE_PIPE") {
            return pipe_path(Some(&tag));
        }
        pipe_path(my_sid_string().as_deref())
    }

    /// This process's user SID, in a buffer aligned for TOKEN_USER (u64 words); none when it cannot be read.
    fn my_token_user() -> Option<Vec<u64>> {
        // SAFETY: plain Win32 token queries into this function's own buffer; the token handle is closed here.
        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buffer = vec![0u64; (len as usize).div_ceil(8).max(1)];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut len,
            ) != 0;
            CloseHandle(token);
            ok.then_some(buffer)
        }
    }

    fn my_sid_string() -> Option<String> {
        let buffer = my_token_user()?;
        // SAFETY: the buffer holds a TOKEN_USER (checked above) whose SID points into it; the string is freed here.
        unsafe {
            let user = &*(buffer.as_ptr() as *const TOKEN_USER);
            let mut text = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
                return None;
            }
            let mut n = 0;
            while *text.add(n) != 0 {
                n += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
            LocalFree(text as _);
            Some(sid)
        }
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

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        text.encode_wide().chain(Some(0)).collect()
    }

    /// Makes the pipe, owned by this user and open to this user only (no one else may connect or change it).
    fn create(path: &Path) -> Option<HANDLE> {
        let sid = my_sid_string()?;
        let sddl = wide(format!("O:{sid}D:P(A;;GA;;;{sid})").as_ref());
        let name = wide(path.as_os_str());
        // SAFETY: NUL-terminated strings; the security descriptor is made here and freed after the pipe is.
        unsafe {
            let mut descriptor = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return None;
            }
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let handle = CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                0,
                64,
                0,
                &attributes,
            );
            LocalFree(descriptor as _);
            (handle != INVALID_HANDLE_VALUE).then_some(handle)
        }
    }

    /// Whether the kernel object behind `handle` is owned by this process's user.
    fn owned_by_me(handle: HANDLE) -> bool {
        let Some(buffer) = my_token_user() else {
            return false;
        };
        // SAFETY: plain Win32 security queries; the descriptor is freed here; the TOKEN_USER is the aligned buffer's.
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
            let user = &*(buffer.as_ptr() as *const TOKEN_USER);
            let same = EqualSid(owner, user.User.Sid) != 0;
            LocalFree(descriptor as _);
            same
        }
    }

    pub fn claim(path: &Path) -> std::io::Result<Instance> {
        for _ in 0..3 {
            if let Some(handle) = create(path) {
                return Ok(Instance::First(Listener(handle), Owned));
            }
            // The pipe is there: another shell's, or someone else's. Opened for identification only: the pipe's
            // server cannot act as this user.
            match OpenOptions::new()
                .write(true)
                .security_qos_flags(SECURITY_IDENTIFICATION)
                .open(path)
            {
                Ok(mut pipe) => {
                    if !owned_by_me(pipe.as_raw_handle() as HANDLE) {
                        return Ok(Instance::Foreign);
                    }
                    pipe.write_all(RAISE)?;
                    return Ok(Instance::Another);
                }
                // A pipe of that name this user may not open: someone else's.
                Err(e) if e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                    return Ok(Instance::Foreign);
                }
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    // The running shell is between two later starts: wait for its pipe a moment.
                    let name = wide(path.as_os_str());
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
        std::thread::spawn(move || {
            // The whole listener moves here (not only its handle field, which is not Send).
            let listener = listener;
            serve_loop(&listener, &on_raise);
        });
    }

    /// The pause before the next wait for a later start, after `failures` failed waits in a row: none after a
    /// connection, then doubling from 50 ms up to 5 s (a pipe that keeps failing does not spin a core).
    pub fn backoff(failures: u32) -> Duration {
        if failures == 0 {
            return Duration::ZERO;
        }
        Duration::from_millis(50u64.saturating_mul(1 << (failures - 1).min(7)))
            .min(Duration::from_secs(5))
    }

    /// Reads what a connected later start wrote, waiting at most READ_WITHIN for it (a client that connects and
    /// writes nothing does not hold the pipe).
    unsafe fn read_line(handle: HANDLE) -> Vec<u8> {
        let deadline = Instant::now() + READ_WITHIN;
        loop {
            let mut available = 0u32;
            let peeked = PeekNamedPipe(
                handle,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            ) != 0;
            // Not readable: the start went away without writing.
            if !peeked {
                return Vec::new();
            }
            if available as usize >= RAISE.len() {
                let mut buf = [0u8; 64];
                let mut read = 0u32;
                if ReadFile(
                    handle,
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    &mut read,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Vec::new();
                }
                return buf[..read as usize].to_vec();
            }
            if Instant::now() >= deadline {
                return Vec::new();
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn serve_loop(listener: &Listener, on_raise: &impl Fn()) {
        let mut failures = 0u32;
        loop {
            std::thread::sleep(backoff(failures));
            let handle = listener.0;
            // SAFETY: the pipe handle is the listener's own; calls on this thread only.
            unsafe {
                // ERROR_PIPE_CONNECTED: a later start connected before this call; ERROR_NO_DATA: it also wrote and
                // closed its end already (found on the Windows runner: the raise was lost). Its bytes are still in
                // the pipe either way, so they are read.
                let connected = ConnectNamedPipe(handle, std::ptr::null_mut()) != 0
                    || matches!(GetLastError(), ERROR_PIPE_CONNECTED | ERROR_NO_DATA);
                if connected {
                    failures = 0;
                    if read_line(handle).starts_with(RAISE) {
                        on_raise();
                    }
                } else {
                    failures = failures.saturating_add(1);
                }
                DisconnectNamedPipe(handle);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_pipe_is_named_after_the_users_sid() {
            assert_eq!(
                pipe_path(Some("S-1-5-21-1004336348-1177238915-682003330-512")),
                PathBuf::from(
                    r"\\.\pipe\argelanderspace-shell-S-1-5-21-1004336348-1177238915-682003330-512"
                )
            );
            assert_eq!(
                pipe_path(None),
                PathBuf::from(r"\\.\pipe\argelanderspace-shell-u")
            );
            let sid = my_sid_string().expect("this process's SID");
            assert!(sid.starts_with("S-1-"), "{sid}");
            assert_eq!(default_socket_path(), pipe_path(Some(&sid)));
        }

        #[test]
        fn a_failing_pipe_is_waited_on_longer_and_longer() {
            assert_eq!(backoff(0), Duration::ZERO);
            assert_eq!(backoff(1), Duration::from_millis(50));
            assert_eq!(backoff(2), Duration::from_millis(100));
            assert_eq!(
                backoff(8),
                Duration::from_millis(6400).min(Duration::from_secs(5))
            );
            assert_eq!(backoff(1000), Duration::from_secs(5));
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
            rx.recv_timeout(Duration::from_secs(5)).expect("raised");
            assert!(matches!(claim(&path).unwrap(), Instance::Another));
            rx.recv_timeout(Duration::from_secs(5))
                .expect("raised again");
        }

        #[test]
        fn a_later_start_that_writes_nothing_does_not_hold_the_pipe() {
            let path = pipe_path(Some(&format!("test-silent-{}", std::process::id())));
            let Instance::First(listener, _owned) = claim(&path).unwrap() else {
                panic!("first")
            };
            let (tx, rx) = std::sync::mpsc::channel();
            serve(listener, move || tx.send(()).unwrap());
            // Connects and stays connected without writing.
            let silent = OpenOptions::new().write(true).open(&path).unwrap();
            std::thread::sleep(READ_WITHIN + Duration::from_millis(500));
            // The server has dropped it and waits again: a real later start raises.
            assert!(matches!(claim(&path).unwrap(), Instance::Another));
            rx.recv_timeout(Duration::from_secs(5)).expect("raised");
            drop(silent);
        }

        #[test]
        fn the_pipe_is_open_to_this_user_only() {
            use windows_sys::Win32::Security::Authorization::GetSecurityInfo;
            use windows_sys::Win32::Security::{
                GetAce, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION,
            };
            let path = pipe_path(Some(&format!("test-dacl-{}", std::process::id())));
            let Instance::First(listener, _owned) = claim(&path).unwrap() else {
                panic!("first")
            };
            let buffer = my_token_user().unwrap();
            // SAFETY: Win32 security queries on this test's own pipe; buffers freed here.
            unsafe {
                assert!(owned_by_me(listener.0));
                let mut dacl: *mut ACL = std::ptr::null_mut();
                let mut descriptor = std::ptr::null_mut();
                assert_eq!(
                    GetSecurityInfo(
                        listener.0,
                        SE_KERNEL_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        &mut dacl,
                        std::ptr::null_mut(),
                        &mut descriptor,
                    ),
                    0
                );
                assert_eq!((*dacl).AceCount, 1);
                let mut ace = std::ptr::null_mut();
                assert_ne!(GetAce(dacl, 0, &mut ace), 0);
                let ace = &*(ace as *const ACCESS_ALLOWED_ACE);
                let user = &*(buffer.as_ptr() as *const TOKEN_USER);
                assert_ne!(
                    EqualSid(std::ptr::addr_of!(ace.SidStart) as _, user.User.Sid),
                    0
                );
                LocalFree(descriptor as _);
                CloseHandle(listener.0);
            }
        }
    }
}
#[cfg(windows)]
pub use windows::*;
