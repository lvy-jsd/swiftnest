use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use swiftnest_perch::i18n;
use swiftnest_perch::i18n::text;
use swiftnest_perch::{
    runtime::{Controller, Snapshot},
    store::Settings,
    Failure,
};
use tauri::Manager;

#[cfg(target_os = "android")]
mod phone;

struct DeviceState {
    core: Arc<Controller>,
    tray_ready: AtomicBool,
    language_path: std::path::PathBuf,
}
#[tauri::command]
fn app_pairing_load(
    root: String,
    state: tauri::State<'_, swiftnest_app_pairing::PairingStore>,
) -> Result<Option<String>, Failure> {
    state.load(&root).map_err(Failure::from)
}
#[tauri::command]
fn app_pairing_save(
    root: String,
    credential: Option<String>,
    state: tauri::State<'_, swiftnest_app_pairing::PairingStore>,
) -> Result<(), Failure> {
    state
        .save(&root, credential.as_deref())
        .map_err(Failure::from)
}
#[tauri::command]
fn set_language(
    lang: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, DeviceState>,
) -> Result<(), Failure> {
    if lang != "en" && lang != "zh-CN" {
        return Err(Failure::new("BAD_ARGS", text!("invalidLanguage")));
    }
    let mut file = tempfile::NamedTempFile::new_in(state.language_path.parent().unwrap())
        .map_err(Failure::from)?;
    std::io::Write::write_all(&mut file, lang.as_bytes()).map_err(Failure::from)?;
    file.persist(&state.language_path)
        .map_err(|e| Failure::from(e.error))?;
    i18n::set_language(&lang);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Some(tray) = app.tray_by_id("perch-status") {
        tray.set_menu(Some(
            tray_menu(&app).map_err(|e| Failure::new("TRAY_UNAVAILABLE", e.to_string()))?,
        ))
        .map_err(|e| Failure::new("TRAY_UNAVAILABLE", e.to_string()))?;
    }
    Ok(())
}
/// Device control runs on desktop and Android; iOS has no device side yet.
fn device_control_supported() -> Result<(), Failure> {
    if cfg!(target_os = "ios") {
        Err(Failure::new(
            "UNSUPPORTED_PLATFORM",
            text!("deviceControlAvailableDesktopNow"),
        ))
    } else {
        Ok(())
    }
}
/// Mobile settings the App cannot honour are reset: no tray, no desktop live view, and files are confined
/// to the App's own folder (a picker for phone folders comes later).
#[cfg(target_os = "android")]
fn mobile_settings(mut settings: Settings, app: &tauri::AppHandle) -> Result<Settings, Failure> {
    let shared = app
        .path()
        .app_data_dir()
        .map_err(|e| Failure::new("IO_ERROR", e.to_string()))?
        .join("shared");
    std::fs::create_dir_all(&shared)?;
    settings.background = false;
    settings.allow_live_view = false;
    settings.roots = vec![shared];
    Ok(settings)
}
fn desktop_only() -> Result<(), Failure> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        Err(Failure::new(
            "UNSUPPORTED_PLATFORM",
            text!("deviceControlAvailableDesktopNow"),
        ))
    } else {
        Ok(())
    }
}
#[tauri::command]
fn perch_snapshot(state: tauri::State<'_, DeviceState>) -> Snapshot {
    state.core.snapshot()
}
#[tauri::command]
async fn perch_configure(
    settings: Settings,
    code: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, DeviceState>,
) -> Result<Snapshot, Failure> {
    device_control_supported()?;
    #[cfg(target_os = "android")]
    let settings = mobile_settings(settings, &app)?;
    #[cfg(not(target_os = "android"))]
    let _ = &app;
    if (settings.background || settings.allow_live_view)
        && !state.tray_ready.load(Ordering::Relaxed)
    {
        return Err(Failure::new(
            "TRAY_UNAVAILABLE",
            text!("noSystemTrayAvailableEnableTray"),
        ));
    }
    state.core.configure(settings, code).await?;
    Ok(state.core.snapshot())
}
#[tauri::command]
fn perch_confirm(accept: bool, state: tauri::State<'_, DeviceState>) -> Result<(), Failure> {
    device_control_supported()?;
    state.core.confirm(accept)
}
#[tauri::command]
async fn perch_disable(state: tauri::State<'_, DeviceState>) -> Result<Snapshot, Failure> {
    device_control_supported()?;
    state.core.disable().await?;
    Ok(state.core.snapshot())
}
#[tauri::command]
fn perch_stop_view(state: tauri::State<'_, DeviceState>) -> Result<(), Failure> {
    state.core.stop_view()
}
#[tauri::command]
async fn perch_unpair(state: tauri::State<'_, DeviceState>) -> Result<Snapshot, Failure> {
    device_control_supported()?;
    state.core.unpair().await?;
    Ok(state.core.snapshot())
}
#[tauri::command]
async fn perch_pick_file(app: tauri::AppHandle) -> Result<Option<String>, Failure> {
    desktop_only()?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_dialog::DialogExt;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        app.dialog()
            .file()
            .set_title(i18n::message("pickFile"))
            .pick_file(move |path| {
                let _ = send.send(path);
            });
        tauri::async_runtime::spawn_blocking(move || {
            receive
                .recv()
                .map_err(|_| Failure::new("PICKER_FAILED", text!("filePickerClosed")))?
                .map(|p| {
                    p.into_path()
                        .map(|p| p.to_string_lossy().into_owned())
                        .map_err(|e| Failure::new("PICKER_FAILED", e.to_string()))
                })
                .transpose()
        })
        .await
        .map_err(|e| Failure::new("PICKER_FAILED", e.to_string()))?
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Err(Failure::new("UNSUPPORTED", text!("desktopFilePickerOnly")))
    }
}
#[tauri::command]
async fn perch_pick_folders(app: tauri::AppHandle) -> Result<Vec<String>, Failure> {
    desktop_only()?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_dialog::DialogExt;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        app.dialog()
            .file()
            .set_title(i18n::message("pickFolders"))
            .pick_folders(move |paths| {
                let _ = send.send(paths);
            });
        tauri::async_runtime::spawn_blocking(move || {
            let paths = receive
                .recv()
                .map_err(|_| Failure::new("PICKER_FAILED", text!("folderPickerClosed")))?;
            paths
                .unwrap_or_default()
                .into_iter()
                .map(|p| {
                    p.into_path()
                        .map(|p| p.to_string_lossy().into_owned())
                        .map_err(|e| Failure::new("PICKER_FAILED", e.to_string()))
                })
                .collect()
        })
        .await
        .map_err(|e| Failure::new("PICKER_FAILED", e.to_string()))?
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Ok(vec![])
    }
}
/// Which phone permissions the owner has granted (Android only).
#[tauri::command]
async fn phone_status(app: tauri::AppHandle) -> Result<serde_json::Value, Failure> {
    phone_call(app, "status", serde_json::json!({})).await
}
/// Opens the system page for `kind` ("accessibility" or "notifications") (Android only).
#[tauri::command]
async fn phone_open_settings(app: tauri::AppHandle, kind: String) -> Result<(), Failure> {
    phone_call(app, "openSettings", serde_json::json!({ "kind": kind }))
        .await
        .map(|_| ())
}
#[cfg(target_os = "android")]
async fn phone_call(
    app: tauri::AppHandle,
    method: &'static str,
    args: serde_json::Value,
) -> Result<serde_json::Value, Failure> {
    use swiftnest_perch::bridge::Bridge;
    let bridge = app
        .state::<Arc<phone::PhoneBridge<tauri::Wry>>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || bridge.call(method, args))
        .await
        .map_err(|e| Failure::new("PHONE_FAILED", e.to_string()))?
}
#[cfg(not(target_os = "android"))]
async fn phone_call(
    _: tauri::AppHandle,
    _: &'static str,
    _: serde_json::Value,
) -> Result<serde_json::Value, Failure> {
    Err(Failure::new(
        "UNSUPPORTED_PLATFORM",
        text!("phoneSettingsAndroidOnly"),
    ))
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn tray_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};
    let show = MenuItem::with_id(
        app,
        "show",
        i18n::message("openSwiftnest"),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        i18n::message("quitSwiftnest"),
        true,
        None::<&str>,
    )?;
    let stop = MenuItem::with_id(
        app,
        "stop-view",
        i18n::message("stopLiveView"),
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show, &stop, &quit])?;
    Ok(menu)
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::TrayIconBuilder;
    let menu = tray_menu(app.handle())?;
    let mut tray = TrayIconBuilder::with_id("perch-status")
        .menu(&menu)
        .tooltip("Swiftnest")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "stop-view" => {
                let _ = app.state::<DeviceState>().core.stop_view();
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(phone::init());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    builder
        .invoke_handler(tauri::generate_handler![
            set_language,
            app_pairing_load,
            app_pairing_save,
            perch_snapshot,
            perch_stop_view,
            perch_configure,
            perch_confirm,
            perch_unpair,
            perch_disable,
            perch_pick_file,
            perch_pick_folders,
            phone_status,
            phone_open_settings
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(swiftnest_app_pairing::PairingStore::new(
                data_dir.join("app-pairing"),
            ));
            let core = Controller::open(data_dir.join("perch"))?;
            let language_path = data_dir.join("language");
            if let Ok(lang) = std::fs::read_to_string(&language_path) {
                i18n::set_language(lang.trim());
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let tray_ready = tray(app).is_ok();
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let tray_ready = false;
            core.set_indicator_ready(tray_ready);
            app.manage(DeviceState {
                language_path,
                core: core.clone(),
                tray_ready: AtomicBool::new(tray_ready),
            });
            #[cfg(target_os = "android")]
            {
                let bridge = app
                    .state::<Arc<phone::PhoneBridge<tauri::Wry>>>()
                    .inner()
                    .clone();
                core.add_platform_capabilities(swiftnest_perch::phone::capabilities(bridge));
                let core = core.clone();
                tauri::async_runtime::spawn(async move { core.resume().await });
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_notification::NotificationExt;
                    core.resume().await;
                    let mut was_watching = false;
                    loop {
                        let snapshot = core.snapshot();
                        let watching = snapshot.watching;
                        if let Some(tray) = handle.tray_by_id("perch-status") {
                            let title = if watching {
                                i18n::message("sharingDesktop")
                            } else {
                                "Swiftnest".into()
                            };
                            let _ = tray.set_tooltip(Some(&title));
                            let _ = tray.set_title(Some(if watching { "●" } else { "" }));
                            if watching != was_watching {
                                if watching {
                                    let mut rgba = vec![0; 32 * 32 * 4];
                                    for y in 0..32 {
                                        for x in 0..32 {
                                            if (x as i32 - 16).pow(2) + (y as i32 - 16).pow(2) < 196
                                            {
                                                let i = (y * 32 + x) * 4;
                                                rgba[i..i + 4].copy_from_slice(&[220, 45, 45, 255]);
                                            }
                                        }
                                    }
                                    let _ = tray.set_icon(Some(tauri::image::Image::new_owned(
                                        rgba, 32, 32,
                                    )));
                                } else {
                                    let _ = tray.set_icon(handle.default_window_icon().cloned());
                                }
                            }
                        }
                        if watching && !was_watching {
                            let _ = handle
                                .notification()
                                .builder()
                                .title(i18n::message("desktopSharing"))
                                .body(i18n::message("desktopBeingViewedStopSwiftnestTray"))
                                .show();
                        }
                        was_watching = watching;
                        tokio_pause().await;
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<DeviceState>();
                if state.tray_ready.load(Ordering::Relaxed)
                    && state.core.snapshot().settings.background
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|_| panic!("{}", i18n::message("couldNotStartSwiftnestRestartApp")))
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let core = app.state::<DeviceState>().core.clone();
                tauri::async_runtime::block_on(core.shutdown());
            }
        });
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn tokio_pause() {
    tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(std::time::Duration::from_millis(250))
    })
    .await
    .ok();
}
