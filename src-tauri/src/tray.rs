//! Tray icon: left click shows the window; the menu drives playback and quitting.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "nocturne-tray";

/// When true, closing the main window hides it to the tray instead of quitting.
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn command(app: &AppHandle, kind: &str) {
    let _ = app.emit_to("main", "player:command", json!({ "type": kind }));
}

pub fn create(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let toggle = MenuItem::with_id(app, "toggle", "Пауза / воспроизведение", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Следующий трек", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Предыдущий трек", true, None::<&str>)?;
    let like = MenuItem::with_id(app, "like", "В мои аудио / убрать", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Открыть Nocturne", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &next, &prev, &like, &sep1, &show, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Nocturne")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => command(app, "toggle"),
            "next" => command(app, "next"),
            "prev" => command(app, "prev"),
            "like" => command(app, "toggleLike"),
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)
}

pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let short: String = text.chars().take(120).collect();
        let _ = tray.set_tooltip(Some(short));
    }
}

#[tauri::command]
pub fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

pub fn close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed)
}
