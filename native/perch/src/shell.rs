use crate::{
    capability::*,
    paths::{realish, PathGuard},
    Failure, Result,
};
use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{LazyLock, OnceLock},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

/// The shell rules shared with `@swiftnest/cap-shell`, so both classifiers stay in step.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rules {
    read_only: Vec<String>,
    destructive: Vec<String>,
    file_reading: Vec<String>,
    shell_operators: String,
    find_writes: Vec<String>,
    writing_invocations: HashMap<String, WritingRule>,
}
/// What makes an otherwise read-only program write: flags that write, and limits on its positionals.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WritingRule {
    #[serde(default)]
    short_flags: String,
    #[serde(default)]
    long_flags: Vec<String>,
    #[serde(default)]
    value_flags: Vec<String>,
    max_positionals: Option<usize>,
    positional_prefix: Option<String>,
    reason: String,
}
static RULES: LazyLock<Rules> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../plugins/cap-shell/src/shell-rules.json"
    ))
    .expect("shell-rules.json")
});
/// Programs that run without approval when they only read inside the shared folders.
pub static READ_ONLY: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| RULES.read_only.iter().map(String::as_str).collect());
fn listed(list: &[String], item: &str) -> bool {
    list.iter().any(|x| x == item)
}
const MAX_OUTPUT: usize = 64 * 1024;
/// Positional arguments, skipping the value that follows each flag in `value_flags`.
fn positionals<'a>(args: &'a [String], value_flags: &[String]) -> Vec<&'a str> {
    let mut out = vec![];
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if listed(value_flags, a) {
            it.next();
        } else if !a.starts_with('-') || a == "-" {
            out.push(a.as_str());
        }
    }
    out
}
/// Why this invocation of a read-only program writes files, runs programs or changes the system,
/// or None when it only reads. Doubtful cases count as writes.
pub fn writing_invocation(program: &str, args: &[String]) -> Option<&'static str> {
    let rule = RULES.writing_invocations.get(program)?;
    // Short-flag clusters (`-ro`) are split by the program, so a letter anywhere counts.
    let short_flag = |a: &str| {
        a.starts_with('-')
            && !a.starts_with("--")
            && rule.short_flags.chars().any(|f| a[1..].contains(f))
    };
    let long_flag = |a: &str| {
        rule.long_flags.iter().any(|n| {
            a == n
                || a.strip_prefix(n.as_str())
                    .is_some_and(|r| r.starts_with('='))
        })
    };
    let rest = positionals(args, &rule.value_flags);
    let writes = args.iter().any(|a| short_flag(a) || long_flag(a))
        || rule.max_positionals.is_some_and(|max| rest.len() > max)
        || rule
            .positional_prefix
            .as_deref()
            .is_some_and(|p| rest.iter().any(|a| !a.starts_with(p)));
    writes.then_some(rule.reason.as_str())
}
pub fn tokenize(command: &str) -> Option<Vec<String>> {
    let mut tokens = vec![];
    let mut cur = String::new();
    let mut quote = None;
    let mut had = false;
    for c in command.chars() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                cur.push(c);
            }
        } else if c == '\'' || c == '"' {
            quote = Some(c);
            had = true;
        } else if c.is_whitespace() {
            if !cur.is_empty() || had {
                tokens.push(std::mem::take(&mut cur));
            }
            had = false;
        } else {
            cur.push(c);
        }
    }
    if quote.is_some() {
        return None;
    }
    if !cur.is_empty() || had {
        tokens.push(cur);
    }
    Some(tokens)
}
fn basename(s: &str) -> &str {
    s.rsplit(['/', '\\']).next().unwrap_or(s)
}
pub fn classify_command(command: &str, read_only: &[&str], guard: &PathGuard) -> Classification {
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    let unquoted = QUOTED
        .get_or_init(|| Regex::new("'[^']*'|\"[^\"]*\"").unwrap())
        .replace_all(command, "");
    let tokens = tokenize(command);
    let toks = tokens.as_deref().unwrap_or_default();
    let program = toks.first().map(|s| basename(s)).unwrap_or("");
    for (i, t) in toks.iter().enumerate() {
        let start =
            i == 0 || toks[i - 1].contains([';', '&', '|', '\n']) || t.starts_with([';', '&', '|']);
        let name = basename(t.trim_start_matches([';', '&', '|', '(', '`']));
        if start && listed(&RULES.destructive, name) {
            return Classification::new(
                Risk::Sensitive,
                format!("runs \"{name}\", which can destroy data or change the system"),
            );
        }
    }
    if RULES
        .destructive
        .iter()
        .any(|d| program.starts_with(&format!("{d}.")))
    {
        return Classification::new(
            Risk::Sensitive,
            format!("runs \"{program}\", which can destroy data or change the system"),
        );
    }
    if tokens.is_none() || program.is_empty() {
        return Classification::new(Risk::Exec, "could not parse the command");
    }
    if unquoted.contains(|c| RULES.shell_operators.contains(c)) {
        return Classification::new(
            Risk::Exec,
            "uses shell operators (pipes, redirects, globs or substitutions)",
        );
    }
    if program == "find" && toks.iter().any(|t| listed(&RULES.find_writes, t)) {
        return Classification::new(
            Risk::Sensitive,
            "find with -delete/-exec/-fprint can modify files",
        );
    }
    if read_only.contains(&program) {
        if let Some(reason) = writing_invocation(program, &toks[1..]) {
            return Classification::new(Risk::Exec, reason);
        }
        if listed(&RULES.file_reading, program) {
            for arg in toks.iter().skip(1).filter(|t| !t.starts_with('-')) {
                let c = guard.lexical(Path::new(arg));
                if c.secret {
                    return Classification::new(
                        Risk::Sensitive,
                        format!(
                            "\"{program} {arg}\" reads a protected location ({})",
                            c.path.display()
                        ),
                    );
                }
                if !c.inside {
                    return Classification::new(
                        Risk::Exec,
                        format!(
                            "\"{program} {arg}\" reads outside the shared folders ({})",
                            c.path.display()
                        ),
                    );
                }
            }
        }
        return Classification::new(
            Risk::Read,
            format!("\"{program}\" is on the read-only list"),
        );
    }
    Classification::new(
        Risk::Exec,
        format!("\"{program}\" is not on the read-only list"),
    )
}
#[derive(Clone)]
pub struct Shell {
    pub guard: PathGuard,
}
#[async_trait]
impl Capability for Shell {
    fn manifest(&self) -> Value {
        serde_json::from_str(include_str!("manifests/shell.json")).expect("manifest fixture")
    }
    fn classify(&self, _tool: &str, args: &Value) -> Classification {
        let mut guard = self.guard.clone();
        // Resolve relative paths from the requested cwd as invocation does.
        if let Some(cwd) = args["cwd"].as_str() {
            let c = guard.lexical(Path::new(cwd));
            if c.secret {
                return Classification::new(Risk::Sensitive, "cwd is a protected location");
            }
            if !c.inside {
                return Classification::new(Risk::Exec, "cwd is outside the shared folders");
            }
            guard.roots.insert(0, c.path);
        }
        classify_command(args["command"].as_str().unwrap_or(""), &READ_ONLY, &guard)
    }
    async fn invoke(&self, tool: &str, args: Value, ctx: InvokeContext) -> Result<ToolResult> {
        if tool != "run" {
            return Err(Failure::new("UNKNOWN_TOOL", "shell has only run"));
        }
        let command = string_arg(&args, "command")?.trim();
        if command.is_empty() {
            return Err(Failure::new("BAD_ARGS", "command is empty."));
        }
        let root = self
            .guard
            .roots
            .first()
            .ok_or_else(|| Failure::new("PATH_NOT_ALLOWED", "Choose a shared folder first"))?;
        let cwd = self
            .guard
            .allowed(args["cwd"].as_str().map(Path::new).unwrap_or(root))?;
        let classification = self.classify(tool, &args);
        let tokens =
            tokenize(command).ok_or_else(|| Failure::new("BAD_ARGS", "Unbalanced quotes"))?;
        let program = tokens
            .first()
            .ok_or_else(|| Failure::new("BAD_ARGS", "Empty command"))?;
        if listed(&RULES.file_reading, basename(program)) {
            for arg in tokens.iter().skip(1).filter(|a| !a.starts_with('-')) {
                // The sandbox also enforces paths hidden in flags, substitutions and scripts.
                self.guard.allowed(&cwd.join(arg))?;
            }
        }
        let (file, argv) = if classification.risk == Risk::Read {
            (find_program(program)?, tokens[1..].to_vec())
        } else {
            #[cfg(windows)]
            let shell = (
                PathBuf::from("cmd.exe"),
                vec!["/D".into(), "/S".into(), "/C".into(), command.into()],
            );
            #[cfg(not(windows))]
            let shell = (find_program("sh")?, vec!["-c".into(), command.into()]);
            shell
        };
        let mut cmd = sandbox(
            &self.guard,
            &cwd,
            &file,
            &argv,
            classification.risk == Risk::Read,
        )?;
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().map_err(|e| {
            Failure::new(
                if e.kind() == std::io::ErrorKind::NotFound {
                    "SANDBOX_UNAVAILABLE"
                } else {
                    "TOOL_FAILED"
                },
                e.to_string(),
            )
        })?;
        let _group = ProcessGroup(child.id());
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let work = async {
            let (out, err, status) =
                tokio::try_join!(bounded_read(stdout), bounded_read(stderr), child.wait())?;
            Ok::<_, std::io::Error>((out, err, status))
        };
        let (out, err, status) = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => { return Err(Failure::new("CANCELLED", "Cancelled by request.")); },
            result = work => result?,
        };
        let remaining = MAX_OUTPUT.saturating_sub(out.0.len());
        let truncated = out.1 || err.1 || err.0.len() > remaining;
        let stdout = String::from_utf8_lossy(&out.0).into_owned();
        let stderr = String::from_utf8_lossy(&err.0[..err.0.len().min(remaining)]).into_owned();
        let mut parts = vec![stdout.trim_end().to_string()];
        if !stderr.trim().is_empty() {
            parts.push(format!("[stderr]\n{}", stderr.trim_end()));
        }
        if status.code() != Some(0) {
            parts.push(format!(
                "[exit code {}]",
                status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or("null".into())
            ));
        }
        if truncated {
            parts.push(format!("[output truncated at {MAX_OUTPUT} bytes]"));
        }
        Ok(ToolResult::data(
            parts
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
            json!({"exitCode":status.code(),"stdout":stdout,"stderr":stderr,"truncated":truncated}),
            true,
        ))
    }
}
async fn bounded_read(mut reader: impl AsyncRead + Unpin) -> std::io::Result<(Vec<u8>, bool)> {
    let mut data = vec![];
    let mut truncated = false;
    let mut buf = [0u8; 8192];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let take = n.min(MAX_OUTPUT.saturating_sub(data.len()));
        data.extend_from_slice(&buf[..take]);
        truncated |= take < n;
    }
    Ok((data, truncated))
}
struct ProcessGroup(Option<u32>);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}
fn find_program(program: &str) -> Result<PathBuf> {
    // Keep the final symlink name: BusyBox and Nix coreutils dispatch by argv[0].
    let named = |path: PathBuf| -> Option<PathBuf> {
        if !path.is_file() {
            return None;
        }
        Some(
            std::fs::canonicalize(path.parent()?)
                .ok()?
                .join(path.file_name()?),
        )
    };
    if program.contains(['/', '\\']) {
        return named(PathBuf::from(program))
            .ok_or_else(|| Failure::new("COMMAND_NOT_FOUND", format!("{program} was not found")));
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if let Some(path) = named(dir.join(program)) {
            return Ok(path);
        }
    }
    Err(Failure::new(
        "COMMAND_NOT_FOUND",
        format!("{program} was not found on this device"),
    ))
}
fn sandbox(
    guard: &PathGuard,
    cwd: &Path,
    file: &Path,
    argv: &[String],
    read_only: bool,
) -> Result<Command> {
    #[cfg(target_os = "linux")]
    {
        let bwrap = find_program("bwrap").map_err(|_| {
            Failure::new(
                "SANDBOX_UNAVAILABLE",
                "Install bubblewrap in the App environment to run confined commands",
            )
        })?;
        let mut cmd = Command::new(bwrap);
        // The namespace init/reaper must not inherit host API tokens either.
        cmd.env_clear();
        cmd.args([
            "--die-with-parent",
            "--unshare-all",
            "--new-session",
            "--clearenv",
        ]);
        // Mount only runtime code, not the host root, home, /run or credentials.
        for path in [
            "/usr",
            "/bin",
            "/lib",
            "/lib64",
            "/nix/store",
            "/etc/ld.so.cache",
            "/etc/alternatives",
        ] {
            if Path::new(path).exists() {
                cmd.arg("--ro-bind").arg(path).arg(path);
            }
        }
        cmd.args(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);
        for root in &guard.roots {
            let root = realish(root)?;
            if guard.check(&root)?.secret {
                return Err(Failure::new(
                    "PATH_REFUSED",
                    "Cannot share a protected root",
                ));
            }
            // Never let a shared root replace the sandbox's runtime or namespace mounts.
            if root == Path::new("/")
                || [
                    "/usr", "/bin", "/lib", "/lib64", "/nix", "/etc", "/proc", "/dev", "/tmp",
                ]
                .iter()
                .any(|p| Path::new(p).starts_with(&root))
            {
                return Err(Failure::new(
                    "PATH_REFUSED",
                    "Choose a user folder rather than a system root",
                ));
            }
            cmd.arg(if read_only { "--ro-bind" } else { "--bind" })
                .arg(&root)
                .arg(&root);
        }
        // Hide protected descendants even when the owner shares their whole home.
        for secret in &guard.secrets {
            let secret = realish(secret)?;
            if guard
                .roots
                .iter()
                .any(|r| realish(r).is_ok_and(|r| secret.starts_with(r)))
                && secret.exists()
            {
                if secret.is_dir() {
                    cmd.arg("--tmpfs").arg(&secret);
                } else {
                    cmd.args(["--ro-bind", "/dev/null"]).arg(&secret);
                }
            }
        }
        let runtime_path = ["/usr/bin", "/bin"]
            .into_iter()
            .map(str::to_owned)
            .chain(
                std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                    .filter_map(|p| std::fs::canonicalize(p).ok())
                    .filter(|p| p.starts_with("/nix/store"))
                    .map(|p| p.to_string_lossy().into_owned()),
            )
            .collect::<Vec<_>>()
            .join(":");
        cmd.args(["--setenv", "PATH", &runtime_path, "--setenv", "HOME"])
            .arg(cwd)
            .arg("--chdir")
            .arg(cwd)
            .arg("--")
            .arg(file)
            .args(argv);
        Ok(cmd)
    }
    #[cfg(target_os = "macos")]
    {
        let mut policy = String::from("(version 1)(deny default)(allow process*)(allow sysctl-read)(allow file-read* (subpath \"/usr\") (subpath \"/bin\") (subpath \"/System\") (subpath \"/Library/Apple\") (literal \"/dev/null\"))");
        for r in &guard.roots {
            policy.push_str(&format!(
                "(allow {} (subpath {}))",
                if read_only { "file-read*" } else { "file*" },
                serde_json::to_string(&realish(r)?.to_string_lossy())?
            ));
        }
        for r in &guard.secrets {
            policy.push_str(&format!(
                "(deny file* (subpath {}))",
                serde_json::to_string(&realish(r)?.to_string_lossy())?
            ));
        }
        let mut cmd = Command::new("/usr/bin/sandbox-exec");
        cmd.env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", cwd)
            .current_dir(cwd)
            .arg("-p")
            .arg(policy)
            .arg(file)
            .args(argv);
        Ok(cmd)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (guard, cwd, file, argv, read_only);
        Err(Failure::new(
            "SANDBOX_UNAVAILABLE",
            "This platform needs a filesystem sandbox before shell commands can run",
        ))
    }
}
