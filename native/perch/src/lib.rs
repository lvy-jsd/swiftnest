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

use i18n::Text;
use serde::Serialize;

/// What a failure or reason says: catalog text, or prose that has no catalog entry (an OS error,
/// a message relayed from the Nest).
#[derive(Debug, Clone)]
pub enum Words {
    Text(Text),
    Plain(String),
}
impl From<Text> for Words {
    fn from(text: Text) -> Self {
        Self::Text(text)
    }
}
impl From<String> for Words {
    fn from(prose: String) -> Self {
        Self::Plain(prose)
    }
}
impl From<&str> for Words {
    fn from(prose: &str) -> Self {
        Self::Plain(prose.into())
    }
}
impl Words {
    /// English prose plus the catalog text, as sent on the wire.
    pub(crate) fn split(self) -> (String, Option<Text>) {
        match self {
            Self::Text(text) => (text.english(), Some(text)),
            Self::Plain(prose) => (prose, None),
        }
    }
}

/// A failure as the Nest and the App receive it: English prose plus catalog text, so each
/// reader shows it in their own language.
#[derive(Debug, Clone)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub text: Option<Text>,
    pub retryable: bool,
}
impl Failure {
    pub fn new(code: &str, words: impl Into<Words>) -> Self {
        let (message, text) = words.into().split();
        Self {
            code: code.into(),
            message,
            text,
            retryable: matches!(code, "TIMEOUT" | "DISCONNECTED" | "NEST_UNREACHABLE"),
        }
    }
    /// What the failure says, to pass on as a reason.
    pub fn words(&self) -> Words {
        match &self.text {
            Some(text) => Words::Text(text.clone()),
            None => Words::Plain(self.message.clone()),
        }
    }
}
/// Every Perch failure carries the same hint.
impl Serialize for Failure {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            code: &'a str,
            message: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            text: Option<&'a Text>,
            retryable: bool,
            hint: String,
            hint_text: Text,
        }
        let hint_text = i18n::text!("retryHintDevice");
        Wire {
            code: &self.code,
            message: &self.message,
            text: self.text.as_ref(),
            retryable: self.retryable,
            hint: hint_text.english(),
            hint_text,
        }
        .serialize(serializer)
    }
}
/// The failure in the host language, for the owner's own screen.
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.text {
            Some(text) => write!(f, "{}: {}", self.code, text.render()),
            None => write!(f, "{}: {}", self.code, self.message),
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failures_send_english_and_catalog_text() {
        let failure = Failure::new("BAD_ARGS", i18n::text!("keyRequired", "port"));
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            json!({
                "code": "BAD_ARGS",
                "message": "port is required",
                "text": {"key": "keyRequired", "args": ["port"]},
                "retryable": false,
                "hint": "Check the connection, permissions and shared folders, then retry.",
                "hintText": {"key": "retryHintDevice"},
            })
        );
        let plain = Failure::new("IO_ERROR", "disk full");
        assert_eq!(
            serde_json::to_value(&plain).unwrap()["message"],
            "disk full"
        );
        assert!(serde_json::to_value(&plain).unwrap().get("text").is_none());
    }
}
