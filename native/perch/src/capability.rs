use crate::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Read,
    Write,
    Exec,
    Sensitive,
}
#[derive(Debug, Clone, Serialize)]
pub struct Classification {
    pub risk: Risk,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
impl Classification {
    pub fn new(risk: Risk, reason: impl Into<String>) -> Self {
        Self {
            risk,
            reason: Some(crate::i18n::translate(&reason.into())),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    pub untrusted: bool,
}
impl ToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: crate::i18n::translate(&text.into()),
            data: None,
            untrusted: false,
        }
    }
    pub fn data(text: impl Into<String>, data: Value, untrusted: bool) -> Self {
        Self {
            text: if untrusted {
                text.into()
            } else {
                crate::i18n::translate(&text.into())
            },
            data: Some(data),
            untrusted,
        }
    }
}
#[derive(Clone)]
pub struct InvokeContext {
    pub task_id: String,
    pub cancel: CancellationToken,
}
#[async_trait]
pub trait Capability: Send + Sync {
    fn manifest(&self) -> Value;
    fn classify(&self, tool: &str, args: &Value) -> Classification;
    async fn invoke(&self, tool: &str, args: Value, context: InvokeContext) -> Result<ToolResult>;
}
/// Bail out before starting native work that was cancelled while queued.
pub trait CancelCheck {
    fn check(&self) -> Result<()>;
}
impl CancelCheck for CancellationToken {
    fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(crate::Failure::new(
                "CANCELLED",
                "Cancelled before native operation",
            ))
        } else {
            Ok(())
        }
    }
}
pub fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| crate::Failure::new("BAD_ARGS", format!("{key} is required")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_file_contents_stay_exact_even_when_they_match_catalog_text() {
        let text = "command is empty";
        let result = ToolResult::data(text, serde_json::json!({"path":"notes.txt"}), true);
        assert_eq!(result.text, text);
    }
}
