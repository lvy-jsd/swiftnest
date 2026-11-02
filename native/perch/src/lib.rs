//! Device-only core. The host owns consent/UI; the server owns the Nest and approvals.
pub use swiftnest_locale as i18n;
pub mod bridge;
pub mod capability;
pub mod channel;
pub mod files;
pub mod paths;
pub mod phone;
pub mod runtime;
pub mod shell;
pub mod store;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub hint: String,
    #[serde(skip)]
    pub diagnostic: String,
}
impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        let diagnostic = message.into();
        Self {
            code: code.into(),
            message: i18n::failure_message(code, &diagnostic),
            hint: i18n::text("retryHint"),
            diagnostic,
            retryable: matches!(code, "TIMEOUT" | "DISCONNECTED" | "NEST_UNREACHABLE"),
        }
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Failure {}
impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        Self::new("IO_ERROR", e.to_string())
    }
}
impl From<serde_json::Error> for Failure {
    fn from(e: serde_json::Error) -> Self {
        Self::new("PROTOCOL_ERROR", e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Failure>;

pub mod screen;
pub mod stream;

pub mod transfer;
