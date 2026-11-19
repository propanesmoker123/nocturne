//! Tray icon: left click shows the window; the menu drives playback and quitting.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "nocturne-tray";
const MAX_TOOLTIP_UTF16: usize = 127;

/// When true, closing the main window hides it to the tray instead of quitting.
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        crate::emit_main_visibility(app, true);
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
            "quit" => { crate::spotify::shutdown(app); app.exit(0); },
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

/// Truncates `text` on a valid `char` boundary so its UTF-16 encoding fits within Windows'
/// 127-unit `NOTIFYICONDATAW.szTip` limit (128 WCHARs including NUL).
pub fn truncate_tooltip(text: &str) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for ch in text.chars() {
        let n = ch.len_utf16();
        if units + n > MAX_TOOLTIP_UTF16 {
            break;
        }
        out.push(ch);
        units += n;
    }
    out
}

pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(truncate_tooltip(text)));
    }
}

#[tauri::command]
pub fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

pub fn close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_truncates_by_utf16_code_units_without_splitting_surrogates() {
        let emojis = "🎵".repeat(100);
        let short = truncate_tooltip(&emojis);
        assert!(short.encode_utf16().count() <= MAX_TOOLTIP_UTF16);
        assert_eq!(short.encode_utf16().count(), 126);
        assert_eq!(short.chars().count(), 63);

        let mixed = format!("{}🎵", "a".repeat(126));
        let short_mixed = truncate_tooltip(&mixed);
        assert_eq!(short_mixed.encode_utf16().count(), 126);
        assert_eq!(short_mixed, "a".repeat(126));

        let exact = format!("{}a", "🎵".repeat(63));
        assert_eq!(truncate_tooltip(&exact), exact);
        assert_eq!(truncate_tooltip(&exact).encode_utf16().count(), 127);

        let ascii = "x".repeat(200);
        assert_eq!(truncate_tooltip(&ascii).encode_utf16().count(), 127);
    }
}
