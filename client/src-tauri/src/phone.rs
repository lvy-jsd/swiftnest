//! Android: the phone's abilities, implemented in Kotlin (`gen/android/.../phone/PhonePlugin.kt`).
//!
//! Rust calls the plugin's commands through Tauri's mobile bridge; the device core sees them as ordinary
//! capabilities via [`swiftnest_perch::bridge::Bridge`].
use serde_json::Value;
use swiftnest_perch::{bridge::Bridge, Failure, Result};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

pub struct PhoneBridge<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Bridge for PhoneBridge<R> {
    fn call(&self, method: &str, args: Value) -> Result<Value> {
        self.0
            .run_mobile_plugin::<Value>(method, args)
            .map_err(|error| match error {
                tauri::plugin::mobile::PluginInvokeError::InvokeRejected(rejected) => Failure::new(
                    rejected.code.as_deref().unwrap_or("PHONE_FAILED"),
                    rejected.message.unwrap_or_default(),
                ),
                other => Failure::new("PHONE_FAILED", other.to_string()),
            })
    }
}

/// Registers the Kotlin plugin and makes the bridge available as app state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("phone")
        .setup(|app, api| {
            let handle = api.register_android_plugin("dev.swiftnest.app.phone", "PhonePlugin")?;
            app.manage(std::sync::Arc::new(PhoneBridge(handle)));
            Ok(())
        })
        .build()
}
