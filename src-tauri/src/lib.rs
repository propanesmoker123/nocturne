mod clipboard;
mod feedback;
mod http;
mod island;
mod journal;
mod lyrics;
mod whisper;
#[cfg(windows)]
mod media;
mod tray;
mod wallpaper;
mod proxy;
mod quicksearch;
mod sc;
mod spotify;
mod session;
mod vk;

use tauri::{Emitter, Manager, WindowEvent};

#[derive(Default)]
struct FullscreenInner {
    active: bool,
    was_maximized: bool,
    #[cfg(windows)]
    saved_normal_rect: Option<windows_sys::Win32::Foundation::RECT>,
}

struct FullscreenState(std::sync::Mutex<FullscreenInner>);

impl FullscreenState {
    fn new() -> Self {
        Self(std::sync::Mutex::new(FullscreenInner::default()))
    }
}

#[tauri::command]
async fn window_fullscreen(app: tauri::AppHandle, fullscreen: Option<bool>) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_clone = app.clone();
    app.run_on_main_thread(move || {
        let res = (|| -> Result<bool, String> {
            let w = app_clone.get_window("main").ok_or("main window not found")?;
            let st = app_clone.state::<FullscreenState>();
            let mut g = st.0.lock().map_err(|_| "lock poisoned")?;
            let current_fs = w.is_fullscreen().unwrap_or(g.active);
            let target = fullscreen.unwrap_or(!current_fs);
            if target == g.active && target == current_fs {
                return Ok(g.active);
            }

            #[cfg(windows)]
            {
                use windows_sys::Win32::Foundation::{POINT, RECT};
                use windows_sys::Win32::Graphics::Gdi::{
                    GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
                    MONITOR_DEFAULTTOPRIMARY,
                };
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    GetWindowPlacement, IsZoomed, SetWindowPlacement, SetWindowPos, HWND_TOP, SWP_FRAMECHANGED,
                    SWP_NOOWNERZORDER, SWP_SHOWWINDOW, SW_SHOWMAXIMIZED, WINDOWPLACEMENT,
                };

                let hwnd = w.hwnd().map_err(|e| e.to_string())?.0 as windows_sys::Win32::Foundation::HWND;
                unsafe {
                    let mut mi: MONITORINFO = std::mem::zeroed();
                    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                    let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                    if GetMonitorInfoW(mon, &mut mi) == 0 {
                        return Err("GetMonitorInfoW failed".into());
                    }

                    if target {
                        let is_max = IsZoomed(hwnd) != 0 || w.is_maximized().unwrap_or(false);
                        g.was_maximized = is_max;
                        if is_max {
                            let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
                            wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
                            if GetWindowPlacement(hwnd, &mut wp) != 0 {
                                g.saved_normal_rect = Some(wp.rcNormalPosition);
                                let mut pmi: MONITORINFO = std::mem::zeroed();
                                pmi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                                let pmon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
                                let (dx, dy) = if GetMonitorInfoW(pmon, &mut pmi) != 0 && mon == pmon {
                                    (pmi.rcWork.left - pmi.rcMonitor.left, pmi.rcWork.top - pmi.rcMonitor.top)
                                } else {
                                    (mi.rcWork.left - mi.rcMonitor.left, mi.rcWork.top - mi.rcMonitor.top)
                                };
                                let wk = mi.rcWork;
                                wp.rcNormalPosition = RECT {
                                    left: wk.left - dx,
                                    top: wk.top - dy,
                                    right: wk.right - dx,
                                    bottom: wk.bottom - dy,
                                };
                                wp.flags = 0;
                                wp.showCmd = SW_SHOWMAXIMIZED as u32;
                                SetWindowPlacement(hwnd, &wp);
                            }
                            let _ = w.unmaximize();
                        }
                        w.set_fullscreen(true).map_err(|e| e.to_string())?;
                        let m = mi.rcMonitor;
                        SetWindowPos(
                            hwnd,
                            HWND_TOP,
                            m.left,
                            m.top,
                            m.right - m.left,
                            m.bottom - m.top,
                            SWP_FRAMECHANGED | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
                        );
                        g.active = true;
                    } else {
                        w.set_fullscreen(false).map_err(|e| e.to_string())?;
                        if g.was_maximized {
                            let _ = w.maximize();
                            if let Some(normal_rect) = g.saved_normal_rect.take() {
                                let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
                                wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
                                if GetWindowPlacement(hwnd, &mut wp) != 0 {
                                    wp.rcNormalPosition = normal_rect;
                                    wp.flags = 0;
                                    wp.showCmd = SW_SHOWMAXIMIZED as u32;
                                    SetWindowPlacement(hwnd, &wp);
                                }
                            }
                        }
                        g.active = false;
                    }
                }
            }

            #[cfg(not(windows))]
            {
                w.set_fullscreen(target).map_err(|e| e.to_string())?;
                g.active = target;
            }

            journal::write("app", &format!("fullscreen -> {}", g.active));
            Ok(g.active)
        })();
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;

    rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    spotify::shutdown(&app);
    app.exit(0);
}

#[cfg(windows)]
fn media_state() -> media::MediaState {
    media::MediaState::new()
}

#[cfg(not(windows))]
fn media_state() {}

#[cfg(windows)]
use media::media_update;

/// No SMTC outside Windows; keep the command so the UI can call it everywhere.
#[cfg(not(windows))]
#[tauri::command]
fn media_update() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(http::Http::new())
        .manage(vk::Limiter::new())
        .manage(session::SessionState::new())
        .manage(sc::ScState::new())
        .manage(spotify::SpotifyState::new())
        .manage(island::IslandState::new())
        .manage(FullscreenState::new())
        .manage(media_state())
        .invoke_handler(tauri::generate_handler![
            vk::vk_api,
            proxy::proxy_fetch,
            lyrics::lyrics_fetch,
            lyrics::lyrics_ai,
            whisper::whisper_probe_asset,
            whisper::whisper_fetch_asset,
            whisper::whisper_model_status,
            whisper::whisper_model_clear,
            session::session_status,
            session::session_login,
            session::session_logout,
            sc::sc_status,
            sc::login::sc_login,
            sc::login::sc_logout,
            sc::api::sc_api,
            sc::stream::sc_stream,
            spotify::spotify_open,
            spotify::spotify_bounds,
            spotify::spotify_filter,
            spotify::spotify_close,
            spotify::spotify_control,
            spotify::spotify_status,
            spotify::spotify_login_start,
            spotify::spotify_login_finish,
            spotify::spotify_login_cancel,
            http::set_user_agent,
            island::island_set_hit_rect,
            island::island_configure,
            quicksearch::search_open,
            quicksearch::search_hide,
            clipboard::clipboard_invite_code,
            media_update,
            tray::set_close_to_tray,
            wallpaper::import_wallpaper,
            wallpaper::list_wallpapers,
            wallpaper::delete_wallpaper,
            journal::journal_write,
            journal::journal_tail,
            journal::journal_open_dir,
            feedback::send_feedback,
            feedback::fetch_notifications,
            window_fullscreen,
            app_quit,
        ])
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => match window.label() {
                session::SESSION_LABEL | island::LABEL | quicksearch::LABEL => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                "main" => {
                    if tray::close_to_tray() {
                        api.prevent_close();
                        if window.hide().is_ok() {
                            let _ = window.emit_to("main", "window:visibility", false);
                        }
                    } else {
                        spotify::shutdown(window.app_handle());
                        window.app_handle().exit(0);
                    }
                }
                _ => {}
            },
            WindowEvent::Destroyed if window.label().starts_with(sc::login::LABEL_PREFIX) => sc::login::closed(window.app_handle(), window.label()),
            WindowEvent::Focused(_) | WindowEvent::Resized(_) if window.label() == "main" => {
                let visible = window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
                let _ = window.emit_to("main", "window:visibility", visible);
            }
            // The quick search panel goes away as soon as the user clicks anywhere else
            WindowEvent::Focused(false) if window.label() == quicksearch::LABEL => {
                let _ = window.hide();
            }
            _ => {}
        })
        .setup(|app| {
            journal::init(app.handle());
            spotify::cleanup_login_profiles(app.handle());
            session::create_window(app.handle())?;
            sc::init(app.handle());
            island::create_window(app.handle())?;
            island::start(app.handle());
            quicksearch::create_window(app.handle())?;
            tray::create(app.handle())?;
            #[cfg(windows)]
            media::init(app.handle());
            if let Some(w) = app.get_window("main") {
                w.show()?;
            }
            spotify::prewarm_if_active(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
