use crate::{Failure, Result};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub const SECRET_PATHS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".password-store",
    ".netrc",
    ".pgpass",
    ".git-credentials",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".docker/config.json",
    ".npmrc",
    ".pypirc",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".config/gh",
    ".local/share/keyrings",
    ".mozilla",
    ".config/google-chrome",
    ".config/chromium",
    ".config/BraveSoftware",
    ".local/state/swiftnest",
    ".config/swiftnest",
    // Native platform counterparts, in addition to the TS list.
    "Library/Keychains",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "AppData/Local/Google/Chrome",
    "AppData/Roaming/Mozilla",
    "AppData/Roaming/Microsoft/Credentials",
    "AppData/Local/Microsoft/Credentials",
];
#[derive(Clone)]
pub struct PathGuard {
    pub roots: Vec<PathBuf>,
    pub secrets: Vec<PathBuf>,
    pub home: PathBuf,
}
pub struct Check {
    pub path: PathBuf,
    pub inside: bool,
    pub secret: bool,
}
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}
pub fn realish(path: &Path) -> Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(p) => Ok(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // A dangling symlink must never be treated as a new ordinary file.
            if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(Failure::new("PATH_REFUSED", "Dangling symlink"));
            }
            let parent = path
                .parent()
                .ok_or_else(|| Failure::new("PATH_REFUSED", "Unresolvable path"))?;
            Ok(realish(parent)?.join(
                path.file_name()
                    .ok_or_else(|| Failure::new("PATH_REFUSED", "Invalid path"))?,
            ))
        }
        Err(e) => Err(e.into()),
    }
}
impl PathGuard {
    /// Unlike CLI defaults, empty roots expose nothing in an App.
    pub fn new(roots: Vec<PathBuf>, deny: Vec<PathBuf>) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/nonexistent"));
        let mut secrets: Vec<_> = SECRET_PATHS.iter().map(|s| home.join(s)).collect();
        secrets.extend(deny);
        if let Some(p) = std::env::var_os("SWIFTNEST_HOME") {
            secrets.push(PathBuf::from(p));
        }
        let mut guard = Self {
            roots: vec![],
            secrets,
            home,
        };
        guard.roots = roots.iter().map(|p| guard.expand(p)).collect();
        guard
    }
    fn expand(&self, path: &Path) -> PathBuf {
        let s = path.to_string_lossy();
        let p = if s == "~" {
            self.home.clone()
        } else if let Some(p) = s.strip_prefix("~/") {
            self.home.join(p)
        } else {
            path.to_path_buf()
        };
        normalize(&if p.is_absolute() {
            p
        } else {
            self.roots.first().unwrap_or(&self.home).join(p)
        })
    }
    pub fn lexical(&self, path: &Path) -> Check {
        let path = self.expand(path);
        Check {
            inside: self.roots.iter().any(|r| path.starts_with(r)),
            secret: self.secrets.iter().any(|r| path.starts_with(r)),
            path,
        }
    }
    pub fn check(&self, path: &Path) -> Result<Check> {
        let lexical = self.lexical(path);
        let path = realish(&lexical.path)?;
        let roots = self
            .roots
            .iter()
            .map(|r| realish(r))
            .collect::<Result<Vec<_>>>()?;
        let secrets = self
            .secrets
            .iter()
            .map(|r| realish(r))
            .collect::<Result<Vec<_>>>()?;
        Ok(Check {
            inside: roots.iter().any(|r| path.starts_with(r)),
            secret: lexical.secret || secrets.iter().any(|r| path.starts_with(r)),
            path,
        })
    }
    pub fn allowed(&self, path: &Path) -> Result<PathBuf> {
        let c = self.check(path)?;
        if c.secret {
            return Err(Failure::new(
                "PATH_REFUSED",
                "Protected keys, credentials, browser or Swiftnest data are never shared",
            ));
        }
        if !c.inside {
            return Err(Failure::new(
                "PATH_NOT_ALLOWED",
                "Path is outside the shared folders. Add its folder in This device.",
            ));
        }
        Ok(c.path)
    }
}
