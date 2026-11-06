use crate::i18n::text;
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
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub risk: Risk,
    /// English, for logs and readers that do not know the key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_text: Option<crate::i18n::Text>,
    /// Set when the call cannot succeed at all: the Nest denies it instead of asking the owner to
    /// approve something that would fail straight after their answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<bool>,
    /// What to do instead, when this capability knows better than "ask the owner".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint_text: Option<crate::i18n::Text>,
}
impl Classification {
    pub fn new(risk: Risk, reason: impl Into<crate::Words>) -> Self {
        let (reason, reason_text) = reason.into().split();
        Self {
            risk,
            reason: Some(reason),
            reason_text,
            refused: None,
            hint_text: None,
        }
    }
    /// The same rating, marked as a call that would be refused anyway, with what to do instead.
    pub fn refusing(mut self, hint: crate::i18n::Text) -> Self {
        self.refused = Some(true);
        self.hint_text = Some(hint);
        self
    }
}
/// What a tool returns to the agent. `text` is English, like every tool result the agent reads.
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
            text: text.into(),
            data: None,
            untrusted: false,
        }
    }
    pub fn data(text: impl Into<String>, data: Value, untrusted: bool) -> Self {
        Self {
            text: text.into(),
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
                text!("cancelledBeforeNativeOperation"),
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
        .ok_or_else(|| crate::Failure::new("BAD_ARGS", text!("keyRequired", key)))
}
