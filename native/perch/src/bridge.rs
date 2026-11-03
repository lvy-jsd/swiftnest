//! Capabilities whose work is done by the host platform (for example Android system services).
//!
//! The core stays platform-neutral: a host hands it a [`Bridge`] plus a manifest, and every tool call is
//! forwarded as `bridge.call(method, args)`. Risk is fixed per tool in the spec, never decided by the host.
use crate::capability::{CancelCheck, Capability, Classification, InvokeContext, Risk, ToolResult};
use crate::i18n::text;
use crate::{Failure, Result};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

/// Synchronous call into the host platform. Implementations may block; calls run on the blocking pool.
pub trait Bridge: Send + Sync {
    fn call(&self, method: &str, args: Value) -> Result<Value>;
}

/// How one tool maps onto the bridge.
pub struct BridgeTool {
    pub name: &'static str,
    pub method: &'static str,
    pub risk: Risk,
    /// Catalog key of why the tool has this risk.
    pub reason_key: &'static str,
    /// Short line the agent sees above the returned data, e.g. "Phone notifications".
    pub summary: &'static str,
    /// Results that carry third-party content (screens, notifications) are marked untrusted for the agent.
    pub untrusted: bool,
}

pub struct BridgeCapability {
    manifest: Value,
    tools: &'static [BridgeTool],
    bridge: Arc<dyn Bridge>,
}

impl BridgeCapability {
    /// `manifest` must list exactly the tools in `tools`; checked here so a mismatch fails at startup.
    pub fn new(manifest: &str, tools: &'static [BridgeTool], bridge: Arc<dyn Bridge>) -> Self {
        let manifest: Value =
            serde_json::from_str(manifest).expect("bundled manifest is valid JSON");
        let listed: Vec<&str> = manifest["tools"]
            .as_array()
            .expect("manifest has tools")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        let specified: Vec<&str> = tools.iter().map(|tool| tool.name).collect();
        assert_eq!(listed, specified, "manifest and bridge spec disagree");
        Self {
            manifest,
            tools,
            bridge,
        }
    }

    fn tool(&self, name: &str) -> Result<&'static BridgeTool> {
        self.tools
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| Failure::new("UNKNOWN_TOOL", text!("unknownToolName", name)))
    }
}

#[async_trait]
impl Capability for BridgeCapability {
    fn manifest(&self) -> Value {
        self.manifest.clone()
    }

    fn classify(&self, tool: &str, _: &Value) -> Classification {
        match self.tool(tool) {
            Ok(spec) => Classification::new(
                spec.risk,
                crate::i18n::Text {
                    key: spec.reason_key,
                    args: vec![],
                },
            ),
            Err(error) => Classification::new(Risk::Sensitive, error.words()),
        }
    }

    async fn invoke(&self, tool: &str, args: Value, context: InvokeContext) -> Result<ToolResult> {
        let spec = self.tool(tool)?;
        context.cancel.check()?;
        let bridge = self.bridge.clone();
        let value = tokio::task::spawn_blocking(move || bridge.call(spec.method, args))
            .await
            .map_err(|error| Failure::new("TOOL_FAILED", error.to_string()))??;
        Ok(ToolResult::data(spec.summary, value, spec.untrusted))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio_util::sync::CancellationToken;

    const MANIFEST: &str = r#"{"id":"demo","title":"Demo","tools":[
        {"name":"demo_read","description":"Read","risk":"read"},
        {"name":"demo_tap","description":"Tap","risk":"exec"}]}"#;
    static TOOLS: [BridgeTool; 2] = [
        BridgeTool {
            name: "demo_read",
            method: "readThing",
            risk: Risk::Read,
            reason_key: "phoneReadScreen",
            summary: "Read",
            untrusted: true,
        },
        BridgeTool {
            name: "demo_tap",
            method: "tap",
            risk: Risk::Exec,
            reason_key: "phoneTouchNeedsApproval",
            summary: "Tapped",
            untrusted: false,
        },
    ];

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, Value)>>);
    impl Bridge for Recorder {
        fn call(&self, method: &str, args: Value) -> Result<Value> {
            self.0.lock().unwrap().push((method.into(), args));
            Ok(serde_json::json!({"ok": true}))
        }
    }

    fn context() -> InvokeContext {
        InvokeContext {
            task_id: "t".into(),
            cancel: CancellationToken::new(),
        }
    }

    #[tokio::test]
    async fn forwards_calls_by_method_and_keeps_spec_risk() {
        let recorder = Arc::new(Recorder::default());
        let capability = BridgeCapability::new(MANIFEST, &TOOLS, recorder.clone());
        assert_eq!(
            capability.classify("demo_tap", &Value::Null).risk,
            Risk::Exec
        );
        assert_eq!(
            capability.classify("missing", &Value::Null).risk,
            Risk::Sensitive
        );
        let result = capability
            .invoke("demo_read", serde_json::json!({"x": 1}), context())
            .await
            .unwrap();
        assert!(result.untrusted);
        assert_eq!(result.data.unwrap()["ok"], true);
        assert_eq!(
            recorder.0.lock().unwrap()[0],
            ("readThing".to_string(), serde_json::json!({"x": 1}))
        );
    }

    #[tokio::test]
    async fn rejects_unknown_tools_without_calling_the_host() {
        let recorder = Arc::new(Recorder::default());
        let capability = BridgeCapability::new(MANIFEST, &TOOLS, recorder.clone());
        assert!(capability
            .invoke("demo_other", Value::Null, context())
            .await
            .is_err());
        assert!(recorder.0.lock().unwrap().is_empty());
    }

    #[test]
    #[should_panic(expected = "manifest and bridge spec disagree")]
    fn refuses_a_manifest_that_does_not_match_the_spec() {
        BridgeCapability::new(MANIFEST, &TOOLS[..1], Arc::new(Recorder::default()));
    }
}
