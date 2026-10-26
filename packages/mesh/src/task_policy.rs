//! Task policy for delegated tasks: the mesh's execution boundary.
//!
//! A `shell:` task delegated by a peer is not automatically trusted. Before anything runs, the
//! command is checked against the same rules the TypeScript cap-shell uses (the two must not
//! disagree about a secret or an out-of-bounds path):
//!
//! - read-only program (ls, cat, df, …) + no shell operators + no destructive program at a
//!   command start + every file argument inside the shared roots and not a protected location
//!   → run WITHOUT a shell (no injection possible through arguments);
//! - a peer listed in `MESH_TRUSTED_PEERS` → run through `sh -c` (explicit opt-in);
//! - anything else → refused, with a reason. The TS policy layer (which can ask a person)
//!   takes over task execution later; until then, the mesh only runs what is safe by default.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use libp2p::PeerId;

/// Read-only programs (same list as the TypeScript cap-shell).
pub const READ_ONLY: &[&str] = &[
    "echo", "pwd", "whoami", "id", "hostname", "uname", "date", "uptime", "ls", "cat", "head", "tail", "wc",
    "df", "du", "free", "ps", "which", "file", "stat", "grep", "sort", "uniq", "true", "nproc", "lscpu",
];

/// Destructive or privilege-changing programs (same list as the TypeScript cap-shell).
pub const DESTRUCTIVE: &[&str] = &[
    "rm", "rmdir", "dd", "shred", "mkfs", "fdisk", "parted", "wipefs", "shutdown", "reboot", "poweroff", "halt",
    "kill", "killall", "pkill", "sudo", "su", "doas", "chmod", "chown", "chattr", "mount", "umount", "iptables",
    "nft", "systemctl", "crontab", "passwd", "useradd", "userdel",
];

/// Read-only programs that read file paths from their arguments. For these, a path outside the
/// shared roots or inside a protected location is refused.
const FILE_READING: &[&str] = &[
    "cat", "head", "tail", "less", "more", "wc", "grep", "egrep", "fgrep",
    "file", "stat", "ls", "du", "find", "sort", "uniq", "diff", "cmp",
    "md5sum", "sha1sum", "sha256sum", "cksum", "od", "xxd", "strings", "base64", "readlink", "realpath",
];

/// Protected locations, relative to the home directory (same list as the TypeScript PathGuard).
const SECRET_PATHS: &[&str] = &[
    ".ssh", ".gnupg", ".password-store", ".netrc", ".pgpass", ".git-credentials",
    ".aws", ".azure", ".config/gcloud", ".kube", ".docker/config.json",
    ".npmrc", ".pypirc", ".cargo/credentials", ".cargo/credentials.toml", ".config/gh",
    ".local/share/keyrings", ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware",
    ".local/state/swiftnest", ".config/swiftnest",
];

/// The home directory (from `$HOME`).
fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/root"))
}

/// Expand a leading `~` to the home directory.
fn expand_home(p: &str) -> PathBuf {
    if p == "~" {
        home_dir()
    } else if let Some(rest) = p.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(p)
    }
}

/// True when `child` is `parent` or lives under it (component-wise, so `/tmp/abc` is not under `/tmp2`).
fn within(child: &Path, parent: &Path) -> bool {
    child == parent || child.starts_with(parent)
}

/// Collapse `.` and lexically reduce `..` (no symlinks followed).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// Real path of `p`, or of its nearest existing ancestor joined with the rest (for files about to be created).
fn realish(p: &Path) -> PathBuf {
    if let Ok(r) = std::fs::canonicalize(p) {
        return r;
    }
    let parent = match p.parent() {
        Some(par) if par != p => par,
        _ => return p.to_path_buf(),
    };
    realish(parent).join(p.file_name().unwrap_or_default())
}

/// The path guard: which folders does this node share, and which locations are never touched.
/// Mirrors the TypeScript PathGuard so the mesh and the TS capabilities cannot disagree.
#[derive(Debug, Clone)]
pub struct PathGuard {
    pub roots: Vec<PathBuf>,
    pub secrets: Vec<PathBuf>,
}

impl PathGuard {
    /// Build a guard. `roots` defaults to the home directory; `deny` adds more protected paths.
    /// Leading `~` is expanded.
    pub fn new(roots: Vec<PathBuf>, deny: Vec<PathBuf>) -> Self {
        let home = home_dir();
        let expand = |p: PathBuf| expand_home(&p.to_string_lossy());
        let roots = if roots.is_empty() {
            vec![home.clone()]
        } else {
            roots.into_iter().map(expand).collect()
        };
        let mut secrets: Vec<PathBuf> = SECRET_PATHS.iter().map(|s| home.join(s)).collect();
        secrets.extend(deny.into_iter().map(expand));
        if let Ok(sh) = std::env::var("SWIFTNEST_HOME") {
            secrets.push(PathBuf::from(sh));
        }
        Self { roots, secrets }
    }

    /// Lexical check (no I/O): the resolved path, whether it is inside a root, whether it is a secret.
    pub fn lexical(&self, raw: &str) -> (PathBuf, bool, bool) {
        let given = expand_home(raw);
        let path = if given.is_absolute() {
            normalize(&given)
        } else {
            self.roots[0].join(&given)
        };
        let inside = self.roots.iter().any(|r| within(&path, r));
        let secret = self.secrets.iter().any(|s| within(&path, s));
        (path, inside, secret)
    }

    /// Real check (follows symlinks), right before acting.
    pub fn real(&self, raw: &str) -> (PathBuf, PathBuf, bool, bool) {
        let (path, _, lex_secret) = self.lexical(raw);
        let real = realish(&path);
        let real_roots: Vec<PathBuf> = self.roots.iter().map(|r| realish(r)).collect();
        let real_secrets: Vec<PathBuf> = self.secrets.iter().map(|s| realish(s)).collect();
        let inside = real_roots.iter().any(|r| within(&real, r));
        let secret = real_secrets.iter().any(|s| within(&real, s)) || lex_secret;
        (path, real, inside, secret)
    }
}

/// Split a command line on whitespace, honouring simple single/double quotes.
/// Returns None on unbalanced quotes.
fn tokenize(command: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut had = false;
    for ch in command.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                had = true;
            }
            None if ch.is_whitespace() => {
                if !cur.is_empty() || had {
                    out.push(std::mem::take(&mut cur));
                }
                had = false;
            }
            None => cur.push(ch),
        }
    }
    if quote.is_some() {
        return None;
    }
    if !cur.is_empty() || had {
        out.push(cur);
    }
    Some(out)
}

/// The command with quoted strings removed (operators inside quotes are data, not operators).
fn strip_quoted(command: &str) -> String {
    let mut out = String::new();
    let mut quote: Option<char> = None;
    for ch in command.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None => out.push(ch),
        }
    }
    out
}

/// True when the command (outside quotes) uses shell operators: pipes, redirects, globs, substitutions.
fn has_shell_operators(command: &str) -> bool {
    strip_quoted(command)
        .chars()
        .any(|c| matches!(c, ';' | '&' | '|' | '`' | '$' | '<' | '>' | '(' | ')' | '{' | '}' | '\n' | '\\' | '*' | '?' | '~'))
}

/// The destructive program that starts a command, if any. A destructive program counts when it
/// starts a command (the program, or a new command after `;` `&` `|` etc.), so `ls; rm -rf x` is
/// destructive but `cat /etc/passwd` is not — there, `passwd` is a file, not a program.
fn destructive_program(tokens: &[String]) -> Option<String> {
    for (i, tok) in tokens.iter().enumerate() {
        let prev = if i > 0 { tokens[i - 1].as_str() } else { "" };
        let prev_starts = prev
            .chars()
            .any(|c| matches!(c, ';' | '&' | '|' | '\n'));
        let cur_starts = tok
            .chars()
            .next()
            .is_some_and(|c| matches!(c, ';' | '&' | '|'));
        let starts_command = i == 0 || prev_starts || cur_starts;
        let name = tok.trim_start_matches(";&|(`");
        let name = name.rsplit('/').next().unwrap_or(name);
        if starts_command && DESTRUCTIVE.contains(&name) {
            return Some(name.to_string());
        }
    }
    // A program literally named `rm.something` (a destructive program with a suffix) also counts.
    if let Some(prog) = tokens.first() {
        let prog_name = prog.rsplit('/').next().unwrap_or(prog.as_str());
        if DESTRUCTIVE.iter().any(|d| prog_name.starts_with(&format!("{d}."))) {
            return Some(prog_name.to_string());
        }
    }
    None
}

/// What the mesh may run for a delegated task.
#[derive(Debug, Clone)]
pub enum CheckedTask {
    /// Run the program directly with its arguments, WITHOUT a shell (no injection possible).
    Direct { program: String, args: Vec<String> },
    /// Run through `sh -c` (only for trusted peers).
    Shell(String),
    /// An `echo:` task — just return the text.
    Echo(String),
    /// Anything else — acknowledge receipt.
    Ack(String),
}

/// The task policy: decides what a delegated task may do on this node.
#[derive(Debug, Clone)]
pub struct TaskPolicy {
    pub guard: PathGuard,
    trusted_peers: HashSet<PeerId>,
}

impl TaskPolicy {
    pub fn new(guard: PathGuard, trusted_peers: HashSet<PeerId>) -> Self {
        Self { guard, trusted_peers }
    }

    /// Check a delegated task before it runs. `from` is the sender's peer id (or agent name).
    pub fn check(&self, from: &str, task: &str) -> Result<CheckedTask, String> {
        if let Some(text) = task.strip_prefix("echo:") {
            return Ok(CheckedTask::Echo(text.to_string()));
        }
        if let Some(cmd) = task.strip_prefix("shell:") {
            if let Ok(peer) = from.parse::<PeerId>() {
                if self.trusted_peers.contains(&peer) {
                    return Ok(CheckedTask::Shell(cmd.to_string()));
                }
            }
            return check_shell_command(cmd, &self.guard);
        }
        Ok(CheckedTask::Ack(task.to_string()))
    }

    /// Right before running a Direct task, follow symlinks and re-check the file arguments: a
    /// protected location is refused, and an out-of-bounds path is refused too (the command was
    /// only auto-allowed as a read).
    pub fn verify_direct(&self, program: &str, args: &[String]) -> Result<(), String> {
        if !FILE_READING.contains(&program) {
            return Ok(());
        }
        for a in args.iter().filter(|t| !t.starts_with('-')) {
            let (_, _real, inside, secret) = self.guard.real(a);
            if secret {
                return Err(format!("{a} is a protected location (keys, credentials or browser data)"));
            }
            if !inside {
                return Err(format!("{a} is outside the folders this node shares"));
            }
        }
        Ok(())
    }
}

/// The rules for a `shell:` task from a non-trusted peer: only what the TS cap-shell would
/// auto-allow as a `read` may run, and it runs without a shell.
fn check_shell_command(cmd: &str, guard: &PathGuard) -> Result<CheckedTask, String> {
    let tokens = tokenize(cmd)
        .ok_or_else(|| "could not parse the command (unbalanced quotes)".to_string())?;
    let program = tokens
        .first()
        .map(|t| t.rsplit('/').next().unwrap_or(t.as_str()))
        .unwrap_or("");
    if program.is_empty() {
        return Err("empty command".to_string());
    }
    if let Some(d) = destructive_program(&tokens) {
        return Err(format!("runs \"{d}\", which can destroy data or change the system"));
    }
    if has_shell_operators(cmd) {
        return Err("uses shell operators (pipes, redirects, globs or substitutions)".to_string());
    }
    if program == "find"
        && tokens
            .iter()
            .any(|t| matches!(t.as_str(), "-delete" | "-exec" | "-execdir" | "-ok" | "-fprint"))
    {
        return Err("find with -delete/-exec can modify files".to_string());
    }
    if !READ_ONLY.contains(&program) {
        return Err(format!("\"{program}\" is not on the read-only list"));
    }
    for a in tokens.iter().skip(1).filter(|t| !t.starts_with('-')) {
        if FILE_READING.contains(&program) {
            let (_, inside, secret) = guard.lexical(a);
            if secret {
                return Err(format!("\"{program} {a}\" reads a protected location"));
            }
            if !inside {
                return Err(format!("\"{program} {a}\" reads outside the shared folders"));
            }
        }
    }
    Ok(CheckedTask::Direct {
        program: tokens[0].clone(),
        args: tokens[1..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> TaskPolicy {
        TaskPolicy::new(PathGuard::new(vec![], vec![]), HashSet::new())
    }

    #[test]
    fn echo_task_is_allowed() {
        let p = policy();
        assert!(matches!(p.check("anyone", "echo:hi").unwrap(), CheckedTask::Echo(_)));
    }

    #[test]
    fn unknown_task_is_acknowledged() {
        let p = policy();
        assert!(matches!(p.check("anyone", "do the thing").unwrap(), CheckedTask::Ack(_)));
    }

    #[test]
    fn read_only_command_runs_direct() {
        let p = policy();
        // The home directory is inside the default root (and `~` itself is a shell operator).
        let home = home_dir().to_string_lossy().into_owned();
        match p.check("anyone", &format!("shell:ls -la {home}")).unwrap() {
            CheckedTask::Direct { program, args } => {
                assert_eq!(program, "ls");
                assert_eq!(args, vec!["-la".to_string(), home]);
            }
            other => panic!("expected Direct, got {other:?}"),
        }
    }

    #[test]
    fn secret_path_is_refused() {
        let p = policy();
        let home = home_dir();
        let err = p
            .check("anyone", &format!("shell:cat {}/.ssh/id_rsa", home.display()))
            .unwrap_err();
        assert!(err.contains("protected"), "{err}");
    }

    #[test]
    fn out_of_bounds_path_is_refused() {
        let p = policy();
        let err = p.check("anyone", "shell:cat /etc/passwd").unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn shell_operators_are_refused() {
        let p = policy();
        // A pipe with no destructive program: refused for the operators, not for `rm`.
        let err = p.check("anyone", "shell:ls | grep x").unwrap_err();
        assert!(err.contains("operators"), "{err}");
    }

    #[test]
    fn destructive_program_is_refused() {
        let p = policy();
        let err = p.check("anyone", "shell:rm -rf /tmp/x").unwrap_err();
        assert!(err.contains("destroy"), "{err}");
    }

    #[test]
    fn destructive_after_operator_is_refused() {
        let p = policy();
        let err = p.check("anyone", "shell:ls; rm -rf /tmp/x").unwrap_err();
        assert!(err.contains("destroy") || err.contains("operators"), "{err}");
    }

    #[test]
    fn non_read_only_program_is_refused() {
        let p = policy();
        let err = p.check("anyone", "shell:sh -c 'echo hi'").unwrap_err();
        assert!(err.contains("read-only"), "{err}");
    }

    #[test]
    fn quoted_operators_do_not_count() {
        let p = policy();
        // The operator is inside quotes, so it is data, not a shell operator.
        assert!(p.check("anyone", "shell:echo 'a;b'").is_ok());
    }

    #[test]
    fn find_with_delete_is_refused() {
        let p = policy();
        let err = p.check("anyone", "shell:find /tmp -name x -delete").unwrap_err();
        assert!(err.contains("find"), "{err}");
    }

    #[test]
    fn trusted_peer_may_run_any_shell() {
        let peer: PeerId = "12D3KooWNSW47MD4MJPVtgFBqH9ezFSGFiGyQwVdHEvkpAK5vnP4"
            .parse()
            .unwrap();
        let p = TaskPolicy::new(PathGuard::new(vec![], vec![]), [peer].into_iter().collect());
        match p.check(&peer.to_string(), "shell:sh -c 'echo hi'").unwrap() {
            CheckedTask::Shell(cmd) => assert_eq!(cmd, "sh -c 'echo hi'"),
            other => panic!("expected Shell, got {other:?}"),
        }
    }

    #[test]
    fn symlink_to_secret_is_refused_on_real_check() {
        // A link inside the shared root that points at a protected dir: the lexical check passes,
        // the real check (right before running) must refuse it.
        let dir = std::env::temp_dir().join("swiftnest-task-policy-test");
        std::fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("secret");
        std::fs::create_dir_all(&secret).unwrap();
        let link = dir.join("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let p = TaskPolicy::new(
            PathGuard::new(vec![dir.clone()], vec![secret.clone()]),
            HashSet::new(),
        );
        let checked = p
            .check("anyone", &format!("shell:cat {}/link/f", link.display()))
            .unwrap();
        if let CheckedTask::Direct { program, args } = checked {
            let err = p.verify_direct(&program, &args).unwrap_err();
            assert!(err.contains("protected"), "{err}");
        } else {
            panic!("expected Direct");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}