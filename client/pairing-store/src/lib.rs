//! Private App credential storage, independent of device control and WebView storage.
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct PairingStore {
    file: PathBuf,
    writes: Mutex<()>,
}
impl PairingStore {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            writes: Mutex::new(()),
        }
    }
    pub fn load(&self, root: &str) -> io::Result<Option<String>> {
        let _lock = self.writes.lock().map_err(|_| io::ErrorKind::Other)?;
        let content = match fs::read_to_string(&self.file) {
            Ok(content) => content,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        Ok(content
            .split_once('\n')
            .filter(|(saved, token)| *saved == root && valid_credential_line(token))
            .map(|(_, token)| token.to_string()))
    }
    pub fn save(&self, root: &str, credential: Option<&str>) -> io::Result<()> {
        if root.contains(['\n', '\r'])
            || !(root.starts_with("http://") || root.starts_with("https://"))
            || credential.is_some_and(|t| !valid_credential_line(t))
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let _lock = self.writes.lock().map_err(|_| io::ErrorKind::Other)?;
        let parent = self.file.parent().ok_or(io::ErrorKind::InvalidInput)?;
        fs::create_dir_all(parent)?;
        if let Some(token) = credential {
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.as_file()
                    .set_permissions(fs::Permissions::from_mode(0o600))?;
            }
            file.write_all(format!("{root}\n{token}").as_bytes())?;
            file.as_file().sync_all()?;
            file.persist(&self.file).map_err(|e| e.error)?;
        } else {
            // A stale request for another server cannot delete the current pairing.
            if fs::read_to_string(&self.file)
                .ok()
                .and_then(|s| s.split_once('\n').map(|(saved, _)| saved != root))
                .unwrap_or(false)
            {
                return Ok(());
            }
            match fs::remove_file(&self.file) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}
// Storage treats the credential as opaque; the protocol and its issuer validate its wire format.
fn valid_credential_line(credential: &str) -> bool {
    !credential.is_empty() && credential.len() <= 512 && !credential.contains(['\n', '\r'])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn survives_reopen_is_authority_bound_and_forgets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pairing");
        let store = PairingStore::new(path.clone());
        assert_eq!(store.load("https://server/").unwrap(), None);
        store
            .save("https://server/", Some(&"x".repeat(43)))
            .unwrap();
        let reopened = PairingStore::new(path.clone());
        assert_eq!(
            reopened.load("https://server/").unwrap(),
            Some("x".repeat(43))
        );
        assert_eq!(reopened.load("https://other/").unwrap(), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(store.save("https://server/", Some("bad\ntoken")).is_err());
        reopened.save("https://other/", None).unwrap();
        assert!(store.load("https://server/").unwrap().is_some());
        reopened.save("https://server/", None).unwrap();
        assert_eq!(store.load("https://server/").unwrap(), None);
    }
}
