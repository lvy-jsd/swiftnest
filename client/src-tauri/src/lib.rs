use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use swiftnest_perch::{
    runtime::{Controller, Snapshot},
    store::Settings,
    Failure,
};
use tauri::Manager;

struct DeviceState {
    core: Arc<Controller>,
    tray_ready: AtomicBool,
}
fn desktop_only() -> Result<(), Failure> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        Err(Failure::new(
            "UNSUPPORTED_PLATFORM",
            "This device control is available on desktop for now",
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
    state: tauri::State<'_, DeviceState>,
) -> Result<Snapshot, Failure> {
    desktop_only()?;
    if (settings.background || settings.allow_live_view)
        && !state.tray_ready.load(Ordering::Relaxed)
    {
        return Err(Failure::new(
            "TRAY_UNAVAILABLE",
            "No system tray is available. Enable a tray on your desktop and restart the App.",
        ));
    }
    state.core.configure(settings, code).await?;
    Ok(state.core.snapshot())
}
#[tauri::command]
fn perch_confirm(accept: bool, state: tauri::State<'_, DeviceState>) -> Result<(), Failure> {
    desktop_only()?;
    state.core.confirm(accept)
}
#[tauri::command]
async fn perch_disable(state: tauri::State<'_, DeviceState>) -> Result<Snapshot, Failure> {
    desktop_only()?;
    state.core.disable().await?;
    Ok(state.core.snapshot())
}
#[tauri::command]
fn perch_stop_view(state: tauri::State<'_, DeviceState>) -> Result<(), Failure> {
    state.core.stop_view()
}
#[tauri::command]
async fn perch_unpair(state: tauri::State<'_, DeviceState>) -> Result<Snapshot, Failure> {
    desktop_only()?;
    state.core.unpair().await?;
    Ok(state.core.snapshot())
}
#[tauri::command]
async fn perch_pick_folders(app: tauri::AppHandle) -> Result<Vec<String>, Failure> {
    desktop_only()?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_dialog::DialogExt;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        app.dialog().file().pick_folders(move |paths| {
            let _ = send.send(paths);
        });
        tauri::async_runtime::spawn_blocking(move || {
            let paths = receive
                .recv()
                .map_err(|_| Failure::new("PICKER_FAILED", "Folder picker closed"))?;
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
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let show = MenuItem::with_id(app, "show", "Open Swiftnest / 打开", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Swiftnest / 退出", true, None::<&str>)?;
    let stop = MenuItem::with_id(
        app,
        "stop-view",
        "Stop live view / 停止实时画面",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show, &stop, &quit])?;
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
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    builder
        .invoke_handler(tauri::generate_handler![
            perch_snapshot,
            perch_stop_view,
            perch_configure,
            perch_confirm,
            perch_unpair,
            perch_disable,
            perch_pick_folders
        ])
        .setup(|app| {
            let core = Controller::open(app.path().app_data_dir()?.join("perch"))?;
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let tray_ready = tray(app).is_ok();
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let tray_ready = false;
            core.set_indicator_ready(tray_ready);
            app.manage(DeviceState {
                core: core.clone(),
                tray_ready: AtomicBool::new(tray_ready),
            });
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let handle=app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_notification::NotificationExt;
                    core.resume().await;
                    let mut was_watching=false;
                    loop {
                        let snapshot=core.snapshot();let watching=snapshot.watching;
                        if let Some(tray)=handle.tray_by_id("perch-status") {
                            let title=if watching {"● Sharing desktop / 正在共享桌面"}else{"Swiftnest"};
                            let _=tray.set_tooltip(Some(title));let _=tray.set_title(Some(if watching {"●"}else{""}));
                            if watching!=was_watching {
                                if watching {
                                    let mut rgba=vec![0;32*32*4];for y in 0..32 {for x in 0..32 {if (x as i32-16).pow(2)+(y as i32-16).pow(2)<196 {let i=(y*32+x)*4;rgba[i..i+4].copy_from_slice(&[220,45,45,255]);}}}
                                    let _=tray.set_icon(Some(tauri::image::Image::new_owned(rgba,32,32)));
                                }else{let _=tray.set_icon(handle.default_window_icon().cloned());}
                            }
                        }
                        if watching && !was_watching {let _=handle.notification().builder().title("Desktop sharing / 正在共享桌面").body("Your desktop is being viewed. Stop from the Swiftnest tray menu. / 可在托盘菜单停止共享。").show();}
                        was_watching=watching;
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
        .expect("Could not start Swiftnest. Restart the app. / 无法启动 Swiftnest，请重启应用。")
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
