//! Dynamic-Island window: a fixed-size transparent always-on-top webview at the top centre
//! of the chosen monitor. Everything outside the visible island shape is click-through:
//! a poller compares the cursor with the shape's rectangle and toggles
//! `set_ignore_cursor_events`. It also hides the island over full-screen apps.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "island";
pub const WIDTH: f64 = 480.0;
pub const HEIGHT: f64 = 260.0;

/// Rectangle in logical pixels relative to the island window's top-left corner.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Is the cursor (physical screen px) inside `rect` of a window at `win_pos` (physical px)?
pub fn hit_test(cursor: (f64, f64), win_pos: (i32, i32), scale: f64, rect: Rect) -> bool {
    if rect.w <= 0.0 || rect.h <= 0.0 || scale <= 0.0 {
        return false;
    }
    let x = (cursor.0 - f64::from(win_pos.0)) / scale;
    let y = (cursor.1 - f64::from(win_pos.1)) / scale;
    x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IslandConfig {
    pub want_visible: bool,
    /// "always" or "background" (only while the main window is hidden/unfocused)
    pub mode: String,
    pub monitor: Option<String>,
    pub hide_in_fullscreen: bool,
}

struct Inner {
    rect: Rect,
    interactive: bool,
    config: IslandConfig,
    shown: bool,
    placed_for: Option<Option<String>>,
}

pub struct IslandState(Mutex<Inner>);

impl IslandState {
    pub fn new() -> Self {
        Self(Mutex::new(Inner {
            rect: Rect::default(),
            interactive: false,
            config: IslandConfig { want_visible: false, mode: "always".into(), monitor: None, hide_in_fullscreen: true },
            shown: false,
            placed_for: None,
        }))
    }
}

#[derive(Serialize, Clone)]
struct Hover {
    inside: bool,
}

pub fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("island.html".into()))
        .title("Nocturne Island")
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
        .focusable(false)
        .visible(false)
        .build()
}

/// Puts the island at the top centre of the named monitor (or the primary one).
fn place(win: &WebviewWindow, monitor: Option<&str>) {
    let monitors = win.available_monitors().unwrap_or_default();
    let target = monitor
        .and_then(|name| monitors.iter().find(|m| m.name().map(|n| n.as_str()) == Some(name)).cloned())
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    let Some(m) = target else { return };
    let scale = m.scale_factor();
    let w = (WIDTH * scale).round() as i32;
    let h = (HEIGHT * scale).round() as i32;
    let x = m.position().x + (m.size().width as i32 - w) / 2;
    let y = m.position().y;
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
}

#[cfg(windows)]
fn foreground_fullscreen() -> bool {
    use windows_sys::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
    let mut state = 0;
    // SAFETY: plain out-parameter call into shell32.
    let hr = unsafe { SHQueryUserNotificationState(&mut state) };
    hr == 0 && (state == QUNS_BUSY || state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE)
}

#[cfg(not(windows))]
fn foreground_fullscreen() -> bool {
    false
}

fn main_active(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

/// Starts the cursor/visibility poller. Called once from setup.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick: u32 = 0;
        let mut last_inside = false;
        let mut ignoring: Option<bool> = None;
        let mut fullscreen = false;
        let mut main_is_active = false;
        let mut interval = tokio::time::interval(Duration::from_millis(40));
        loop {
            interval.tick().await;
            tick = tick.wrapping_add(1);
            let Some(win) = app.get_webview_window(LABEL) else { continue };
            if tick % 10 == 0 {
                fullscreen = foreground_fullscreen();
                main_is_active = main_active(&app);
            }
            let state = app.state::<IslandState>();
            let (should_show, rect, interactive, monitor, needs_place) = {
                let Ok(mut g) = state.0.lock() else { continue };
                let c = &g.config;
                let show = c.want_visible && !(c.hide_in_fullscreen && fullscreen) && (c.mode != "background" || !main_is_active);
                let monitor = c.monitor.clone();
                let needs_place = g.placed_for.as_ref() != Some(&monitor);
                if needs_place {
                    g.placed_for = Some(monitor.clone());
                }
                let changed = show != g.shown;
                g.shown = show;
                ((show, changed), g.rect, g.interactive, monitor, needs_place)
            };
            let (show, visibility_changed) = should_show;
            if needs_place || (visibility_changed && show) {
                place(&win, monitor.as_deref());
            }
            if visibility_changed {
                if show {
                    let _ = win.show();
                    let _ = win.set_always_on_top(true);
                } else {
                    let _ = win.hide();
                }
            }
            if !show {
                continue;
            }
            let (Ok(cursor), Ok(pos), Ok(scale)) = (app.cursor_position(), win.outer_position(), win.scale_factor()) else { continue };
            let inside = hit_test((cursor.x, cursor.y), (pos.x, pos.y), scale, rect);
            if inside != last_inside {
                last_inside = inside;
                let _ = app.emit_to(LABEL, "island:hover", Hover { inside });
            }
            let want_ignore = !(inside && interactive);
            if ignoring != Some(want_ignore) {
                if win.set_ignore_cursor_events(want_ignore).is_ok() {
                    ignoring = Some(want_ignore);
                }
            }
        }
    });
}

#[tauri::command]
pub fn island_set_hit_rect(state: tauri::State<'_, IslandState>, x: f64, y: f64, w: f64, h: f64, interactive: bool) {
    if let Ok(mut g) = state.0.lock() {
        g.rect = Rect { x, y, w, h };
        g.interactive = interactive;
    }
}

#[tauri::command]
pub fn island_configure(state: tauri::State<'_, IslandState>, config: IslandConfig) {
    if let Ok(mut g) = state.0.lock() {
        g.config = config;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PILL: Rect = Rect { x: 140.0, y: 8.0, w: 200.0, h: 36.0 };

    #[test]
    fn inside_at_100_percent_scale() {
        assert!(hit_test((960.0 - 240.0 + 240.0, 20.0), (720, 0), 1.0, PILL));
        assert!(!hit_test((720.0 + 100.0, 20.0), (720, 0), 1.0, PILL));
        assert!(!hit_test((720.0 + 240.0, 60.0), (720, 0), 1.0, PILL));
    }

    #[test]
    fn hit_test_scaled() {
        // Window at physical (600, 0) on a 150 % display: logical (240, 20) → physical (960, 30).
        assert!(hit_test((600.0 + 240.0 * 1.5, 20.0 * 1.5), (600, 0), 1.5, PILL));
        // Logical x = 120 is left of the pill (starts at 140).
        assert!(!hit_test((600.0 + 120.0 * 1.5, 20.0 * 1.5), (600, 0), 1.5, PILL));
    }

    #[test]
    fn hit_test_on_a_monitor_left_of_the_primary() {
        // Secondary monitor spans x ∈ [-1920, 0): window at physical (-1200, 0).
        assert!(hit_test((-1200.0 + 300.0, 10.0), (-1200, 0), 1.0, PILL));
        assert!(!hit_test((-1200.0 + 30.0, 10.0), (-1200, 0), 1.0, PILL));
    }

    #[test]
    fn edges_count_as_inside() {
        assert!(hit_test((140.0, 8.0), (0, 0), 1.0, PILL));
        assert!(hit_test((340.0, 44.0), (0, 0), 1.0, PILL));
    }

    #[test]
    fn empty_rect_never_hits() {
        assert!(!hit_test((0.0, 0.0), (0, 0), 1.0, Rect::default()));
    }
}
