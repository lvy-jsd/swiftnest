//! The phone's own abilities, served by the Android host through a [`Bridge`].
//!
//! Each capability's manifest lives in `manifests/android/`; this file only pins every tool to a host
//! method and a risk. Reading what is on screen is `read` (the owner enabled the accessibility service for
//! this), anything that acts on the phone needs approval, and reading other people's notifications is
//! `sensitive`.
use crate::bridge::{Bridge, BridgeCapability, BridgeTool};
use crate::capability::{Capability, Risk};
use std::sync::Arc;

static UI: [BridgeTool; 1] = [BridgeTool {
    name: "ui_tree",
    method: "uiTree",
    risk: Risk::Read,
    reason_key: "phoneReadScreen",
    summary: "Phone screen contents",
    untrusted: true,
}];

static INPUT: [BridgeTool; 4] = [
    BridgeTool {
        name: "input_tap",
        method: "tap",
        risk: Risk::Exec,
        reason_key: "phoneTouchNeedsApproval",
        summary: "Tapped the phone screen",
        untrusted: false,
    },
    BridgeTool {
        name: "input_swipe",
        method: "swipe",
        risk: Risk::Exec,
        reason_key: "phoneTouchNeedsApproval",
        summary: "Swiped on the phone screen",
        untrusted: false,
    },
    BridgeTool {
        name: "input_type",
        method: "typeText",
        risk: Risk::Exec,
        reason_key: "phoneTypeNeedsApproval",
        summary: "Typed on the phone",
        untrusted: false,
    },
    BridgeTool {
        name: "input_key",
        method: "pressKey",
        risk: Risk::Exec,
        reason_key: "phoneKeyNeedsApproval",
        summary: "Pressed a phone key",
        untrusted: false,
    },
];

static SCREEN: [BridgeTool; 2] = [
    BridgeTool {
        name: "screen_info",
        method: "screenInfo",
        risk: Risk::Read,
        reason_key: "phoneReadScreenSize",
        summary: "Phone screen size",
        untrusted: false,
    },
    BridgeTool {
        name: "screen_capture",
        method: "screenshot",
        risk: Risk::Read,
        reason_key: "phoneReadScreen",
        summary: "Phone screenshot",
        untrusted: true,
    },
];

static NOTIFY: [BridgeTool; 2] = [
    BridgeTool {
        name: "notify_list",
        method: "listNotifications",
        risk: Risk::Sensitive,
        reason_key: "phoneReadNotifications",
        summary: "Phone notifications",
        untrusted: true,
    },
    BridgeTool {
        name: "notify_post",
        method: "postNotification",
        risk: Risk::Write,
        reason_key: "phoneShowNotification",
        summary: "Notification shown on the phone",
        untrusted: false,
    },
];

static APPS: [BridgeTool; 2] = [
    BridgeTool {
        name: "apps_list",
        method: "listApps",
        risk: Risk::Read,
        reason_key: "phoneListApps",
        summary: "Phone apps",
        untrusted: false,
    },
    BridgeTool {
        name: "apps_open",
        method: "openApp",
        risk: Risk::Exec,
        reason_key: "phoneOpenAppNeedsApproval",
        summary: "Opened the app",
        untrusted: false,
    },
];

/// All phone capabilities, each forwarding to `bridge`.
pub fn capabilities(bridge: Arc<dyn Bridge>) -> Vec<Arc<dyn Capability>> {
    let specs: [(&str, &'static [BridgeTool]); 5] = [
        (include_str!("manifests/android/ui.json"), &UI),
        (include_str!("manifests/android/input.json"), &INPUT),
        (include_str!("manifests/android/screen.json"), &SCREEN),
        (include_str!("manifests/android/notify.json"), &NOTIFY),
        (include_str!("manifests/android/apps.json"), &APPS),
    ];
    specs
        .into_iter()
        .map(|(manifest, tools)| {
            Arc::new(BridgeCapability::new(manifest, tools, bridge.clone())) as Arc<dyn Capability>
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    struct Unused;
    impl Bridge for Unused {
        fn call(&self, _: &str, _: Value) -> crate::Result<Value> {
            unreachable!("manifest checks never call the host")
        }
    }

    #[test]
    fn manifests_match_specs_and_declared_risks() {
        for capability in capabilities(Arc::new(Unused)) {
            let manifest = capability.manifest();
            for tool in manifest["tools"].as_array().unwrap() {
                let name = tool["name"].as_str().unwrap();
                let risk =
                    serde_json::to_value(capability.classify(name, &Value::Null).risk).unwrap();
                assert_eq!(
                    tool["risk"], risk,
                    "{name}: manifest risk differs from the spec"
                );
                assert!(
                    tool["description"]["zh"].is_string(),
                    "{name}: missing Chinese description"
                );
            }
        }
    }
}
