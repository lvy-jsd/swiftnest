#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Could not start Swiftnest. Restart the app. / 无法启动 Swiftnest，请重启应用。");
}
