//! Quick search panel (Ctrl+Alt+F by default): a Spotlight-like window over every app. It is
//! created hidden at start-up, shown centred on the monitor under the cursor, takes the
//! keyboard and hides again as soon as it loses focus. It never shows in the taskbar and never
//! brings the main window up: searching and playing are done by the main window over events.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::island::{contains, PxRect};

macro_rules! trace {
    ($($arg:tt)*) => {
        crate::journal::write("search", &format!($($arg)*))
    };
}

pub const LABEL: &str = "search";
/// Logical size: the 640 px panel plus a clear margin that carries its shadow.
pub const WIDTH: f64 = 688.0;
pub const HEIGHT: f64 = 520.0;

/// Window top-left on `monitor` (physical px): centred, its top at 16 % of the monitor
/// height, and never hanging past the bottom edge.
pub fn panel_origin(monitor: PxRect, size: (i32, i32)) -> (i32, i32) {
    let (left, top, right, bottom) = monitor;
    let x = left + (right - left - size.0) / 2;
    let y = top + (f64::from(bottom - top) * 0.16).round() as i32;
    (x, y.min(bottom - size.1).max(top))
}

pub fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("search.html".into()))
        .title("Nocturne — поиск")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .visible(false)
        .build()
}

fn place_under_cursor(app: &AppHandle, win: &WebviewWindow) {
    let monitors = win.available_monitors().unwrap_or_default();
    let rect = |m: &tauri::Monitor| -> PxRect {
        let (p, s) = (m.position(), m.size());
        (p.x, p.y, p.x + s.width as i32, p.y + s.height as i32)
    };
    let cursor = app.cursor_position().ok().map(|c| (c.x.round() as i32, c.y.round() as i32));
    let target = cursor
        .and_then(|c| monitors.iter().find(|m| contains(rect(m), c)).cloned())
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    let Some(m) = target else { return };
    let scale = m.scale_factor();
    let size = ((WIDTH * scale).round() as i32, (HEIGHT * scale).round() as i32);
    let (x, y) = panel_origin(rect(&m), size);
    // Move first: crossing to a monitor with another scale resizes the window, so size last.
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new(size.0 as u32, size.1 as u32));
}

/// The hotkey: show the panel over whatever is in front, or hide it if it already is.
#[tauri::command]
pub fn search_open(app: AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    place_under_cursor(&app, &win);
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    if let Err(e) = win.set_focus() {
        trace!("could not focus the panel: {e}");
    }
    let _ = app.emit_to(LABEL, "quick:open", ());
}

#[tauri::command]
pub fn search_hide(app: AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centred_a_little_above_the_middle() {
        assert_eq!(panel_origin((0, 0, 1920, 1080), (688, 520)), (616, 173));
    }

    #[test]
    fn on_a_monitor_left_of_the_primary() {
        assert_eq!(panel_origin((-1920, 0, 0, 1080), (688, 520)), (-1304, 173));
    }

    #[test]
    fn a_short_monitor_keeps_it_on_screen() {
        assert_eq!(panel_origin((0, 0, 1280, 600), (688, 520)), (296, 80));
    }

    #[test]
    fn scaled_size_on_a_high_dpi_monitor() {
        // 150 %: 1032 x 780 physical on a 2560 x 1440 monitor
        assert_eq!(panel_origin((0, 0, 2560, 1440), (1032, 780)), (764, 230));
    }
}
