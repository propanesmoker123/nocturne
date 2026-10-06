mod http;
mod proxy;
mod session;
mod vk;

use tauri::{Manager, WindowEvent};

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

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
        .manage(http::Http::new())
        .manage(vk::Limiter::new())
        .manage(session::SessionState::new())
        .invoke_handler(tauri::generate_handler![
            vk::vk_api,
            proxy::proxy_fetch,
            session::session_status,
            session::session_login,
            session::session_logout,
            http::set_user_agent,
            app_quit,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    session::SESSION_LABEL => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    "main" => window.app_handle().exit(0),
                    _ => {}
                }
            }
        })
        .setup(|app| {
            session::create_window(app.handle())?;
            if let Some(w) = app.get_webview_window("main") {
                w.show()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
