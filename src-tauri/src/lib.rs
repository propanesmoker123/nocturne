mod clipboard;
mod http;
mod island;
mod journal;
#[cfg(windows)]
mod media;
mod tray;
mod wallpaper;
mod proxy;
mod quicksearch;
mod sc;
mod session;
mod vk;

use tauri::{Manager, WindowEvent};

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
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
            if let Some(w) = app.get_webview_window("main") {
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
        .manage(island::IslandState::new())
        .manage(media_state())
        .invoke_handler(tauri::generate_handler![
            vk::vk_api,
            proxy::proxy_fetch,
            session::session_status,
            session::session_login,
            session::session_logout,
            sc::sc_status,
            sc::login::sc_login,
            sc::login::sc_logout,
            sc::api::sc_api,
            sc::stream::sc_stream,
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
                        let _ = window.hide();
                    } else {
                        window.app_handle().exit(0);
                    }
                }
                _ => {}
            },
            WindowEvent::Destroyed if window.label().starts_with(sc::login::LABEL_PREFIX) => sc::login::closed(window.app_handle(), window.label()),
            // The quick search panel goes away as soon as the user clicks anywhere else
            WindowEvent::Focused(false) if window.label() == quicksearch::LABEL => {
                let _ = window.hide();
            }
            _ => {}
        })
        .setup(|app| {
            journal::init(app.handle());
            session::create_window(app.handle())?;
            sc::init(app.handle());
            island::create_window(app.handle())?;
            island::start(app.handle());
            quicksearch::create_window(app.handle())?;
            tray::create(app.handle())?;
            #[cfg(windows)]
            media::init(app.handle());
            if let Some(w) = app.get_webview_window("main") {
                w.show()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
