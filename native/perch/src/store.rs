use crate::{Failure, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub name: String,
    /// Stable protocol identity, independent of the editable display name.
    pub slug: String,
    pub enabled: bool,
    pub background: bool,
    pub allow_live_view: bool,
    pub roots: Vec<PathBuf>,
    pub url: String,
    pub nest_key: Option<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            name: "This computer".into(),
            slug: String::new(),
            enabled: false,
            background: false,
            allow_live_view: false,
            roots: vec![],
            url: String::new(),
            nest_key: None,
        }
    }
}

pub struct Store {
    pub dir: PathBuf,
    pub identity: SigningKey,
    pub settings: Settings,
}
impl Store {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        }
        // Establish a private DACL before creating key material on Windows.
        #[cfg(windows)]
        {
            let user = std::env::var("USERNAME")
                .map_err(|_| Failure::new("STORE_PERMISSIONS", "No Windows user"))?;
            let status = std::process::Command::new("icacls")
                .arg(&dir)
                .args(["/inheritance:r", "/grant:r", &format!("{user}:(OI)(CI)F")])
                .status()?;
            if !status.success() {
                return Err(Failure::new(
                    "STORE_PERMISSIONS",
                    "Cannot restrict data directory ACL",
                ));
            }
        }
        let key_path = dir.join("identity.key");
        let identity = match fs::read(&key_path) {
            Ok(raw) => {
                let raw = Zeroizing::new(raw);
                let bytes = Zeroizing::new(<[u8; 32]>::try_from(raw.as_slice()).map_err(|_| {
                    Failure::new("STORE_CORRUPT", "Invalid private key; do not overwrite it")
                })?);
                SigningKey::from_bytes(&bytes)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let key = SigningKey::generate(&mut OsRng);
                let mut tmp = tempfile::NamedTempFile::new_in(&dir)?;
                private_file(tmp.as_file())?;
                let bytes = Zeroizing::new(key.to_bytes());
                tmp.write_all(&*bytes)?;
                tmp.as_file().sync_all()?;
                tmp.persist_noclobber(&key_path)
                    .map_err(|e| Failure::new("STORE_WRITE", e.to_string()))?;
                key
            }
            Err(e) => return Err(e.into()),
        };
        private_file(&fs::File::open(&key_path)?)?;
        let mut settings: Settings = match fs::read(dir.join("settings.json")) {
            Ok(raw) => serde_json::from_slice(&raw)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(e.into()),
        };
        if settings.slug.is_empty() {
            settings.slug = format!(
                "computer-{}",
                &fingerprint(&public_key(&identity))?.replace('-', "")[..12]
            );
        }
        let store = Self {
            dir,
            identity,
            settings,
        };
        store.save()?;
        Ok(store)
    }
    pub fn save(&self) -> Result<()> {
        let mut tmp = tempfile::NamedTempFile::new_in(&self.dir)?;
        private_file(tmp.as_file())?;
        tmp.write_all(&serde_json::to_vec_pretty(&self.settings)?)?;
        tmp.as_file().sync_all()?;
        tmp.persist(self.dir.join("settings.json"))
            .map_err(|e| Failure::new("STORE_WRITE", e.to_string()))?;
        Ok(())
    }
}
fn private_file(file: &fs::File) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    let _ = file;
    Ok(())
}
pub fn public_key(identity: &SigningKey) -> String {
    B64.encode(identity.verifying_key().as_bytes())
}
pub fn fingerprint(key: &str) -> Result<String> {
    let raw = B64
        .decode(key)
        .map_err(|_| Failure::new("HANDSHAKE_FAILED", "Invalid public key"))?;
    if raw.len() != 32 {
        return Err(Failure::new(
            "HANDSHAKE_FAILED",
            "Invalid public key length",
        ));
    }
    let hash = Sha256::digest(raw);
    Ok(hash[..8]
        .chunks(2)
        .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
        .collect::<Vec<_>>()
        .join("-"))
}
