//! Dynamic-Island window: a fixed-size transparent always-on-top webview at the top centre
//! of the chosen monitor. Everything outside the visible island shape is click-through:
//! a poller compares the cursor with the shape's rectangle and toggles
//! `set_ignore_cursor_events`. It also hides the island over full-screen apps.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

macro_rules! trace {
    ($($arg:tt)*) => {
        crate::journal::write("island", &format!($($arg)*))
    };
}

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

/// Physical-pixel rectangle (left, top, right, bottom).
pub type PxRect = (i32, i32, i32, i32);

/// A window counts as full screen when it covers its whole monitor (not just the work area).
pub fn covers_monitor(window: PxRect, monitor: PxRect) -> bool {
    window.0 <= monitor.0 && window.1 <= monitor.1 && window.2 >= monitor.2 && window.3 >= monitor.3
}

/// Where the island window goes: the user's saved spot if it is still on a monitor,
/// otherwise the top centre of `fallback`. `width` is the window width in physical px.
pub fn resolve_position(saved: Option<(i32, i32)>, monitors: &[PxRect], fallback: PxRect, width: i32) -> (i32, i32) {
    if let Some(p) = saved {
        // The pill sits at the top centre of the window: that point must be on a screen.
        let pill = (p.0 + width / 2, p.1 + 8);
        if monitors.iter().any(|m| contains(*m, pill)) {
            return p;
        }
    }
    (fallback.0 + (fallback.2 - fallback.0 - width) / 2, fallback.1)
}

pub fn contains(rect: PxRect, point: (i32, i32)) -> bool {
    point.0 >= rect.0 && point.0 < rect.2 && point.1 >= rect.1 && point.1 < rect.3
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IslandConfig {
    pub want_visible: bool,
    /// "always" or "background" (only while the main window is hidden/unfocused)
    pub mode: String,
    pub monitor: Option<String>,
    pub hide_in_fullscreen: bool,
    /// Window top-left (physical px) chosen by dragging; None = top centre of `monitor`.
    #[serde(default)]
    pub position: Option<IslandPos>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct IslandPos {
    pub x: i32,
    pub y: i32,
}

struct Inner {
    rect: Rect,
    interactive: bool,
    config: IslandConfig,
    shown: bool,
    placed_for: Option<(Option<String>, Option<IslandPos>)>,
}

pub struct IslandState(Mutex<Inner>);

impl IslandState {
    pub fn new() -> Self {
        Self(Mutex::new(Inner {
            rect: Rect::default(),
            interactive: false,
            config: IslandConfig { want_visible: false, mode: "always".into(), monitor: None, hide_in_fullscreen: true, position: None },
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

/// Puts the island where the user dragged it, or at the top centre of the named monitor
/// (or the primary one). The window size follows the target monitor's scale.
fn place(win: &WebviewWindow, monitor: Option<&str>, saved: Option<IslandPos>) {
    let monitors = win.available_monitors().unwrap_or_default();
    let fallback = monitor
        .and_then(|name| monitors.iter().find(|m| m.name().map(|n| n.as_str()) == Some(name)).cloned())
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());
    let Some(fallback) = fallback else { return };
    let rect = |m: &tauri::Monitor| -> PxRect {
        let (p, s) = (m.position(), m.size());
        (p.x, p.y, p.x + s.width as i32, p.y + s.height as i32)
    };
    let rects: Vec<PxRect> = monitors.iter().map(rect).collect();
    let fallback_w = (WIDTH * fallback.scale_factor()).round() as i32;
    let (x, y) = resolve_position(saved.map(|p| (p.x, p.y)), &rects, rect(&fallback), fallback_w);
    let scale = monitors
        .iter()
        .find(|m| contains(rect(m), (x + fallback_w / 2, y + 8)))
        .map(|m| m.scale_factor())
        .unwrap_or_else(|| fallback.scale_factor());
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new((WIDTH * scale).round() as u32, (HEIGHT * scale).round() as u32));
}

/// True when an exclusive D3D game runs, or the foreground window (not ours, not the
/// desktop) covers the whole monitor the island sits on.
#[cfg(windows)]
fn fullscreen_on(island_pos: (i32, i32)) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId};

    // SAFETY: plain Win32 queries with valid out-pointers; handles are only read.
    unsafe {
        let mut state = 0;
        if SHQueryUserNotificationState(&mut state) == 0 && state == QUNS_RUNNING_D3D_FULL_SCREEN {
            return true;
        }
        let fg = GetForegroundWindow();
        if fg.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, &mut pid);
        if pid == std::process::id() {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(fg, class.as_mut_ptr(), class.len() as i32).max(0) as usize;
        let class = String::from_utf16_lossy(&class[..n]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
            return false;
        }
        let mut wr: RECT = std::mem::zeroed();
        if GetWindowRect(fg, &mut wr) == 0 {
            return false;
        }
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST), &mut mi) == 0 {
            return false;
        }
        let m = (mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right, mi.rcMonitor.bottom);
        covers_monitor((wr.left, wr.top, wr.right, wr.bottom), m) && contains(m, island_pos)
    }
}

#[cfg(not(windows))]
fn fullscreen_on(_island_pos: (i32, i32)) -> bool {
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
                let pos = win.outer_position().map(|p| (p.x + 8, p.y + 8)).unwrap_or((0, 0));
                let now_full = fullscreen_on(pos);
                if now_full != fullscreen {
                    trace!("full screen on island monitor: {now_full}");
                }
                fullscreen = now_full;
                main_is_active = main_active(&app);
            }
            let state = app.state::<IslandState>();
            let (should_show, rect, interactive, monitor, needs_place) = {
                let Ok(mut g) = state.0.lock() else { continue };
                let c = &g.config;
                let show = c.want_visible && !(c.hide_in_fullscreen && fullscreen) && (c.mode != "background" || !main_is_active);
                let monitor = c.monitor.clone();
                let saved = c.position;
                let key = (monitor.clone(), saved);
                let needs_place = g.placed_for.as_ref() != Some(&key);
                if needs_place {
                    g.placed_for = Some(key);
                }
                let changed = show != g.shown;
                g.shown = show;
                ((show, changed), g.rect, g.interactive, (monitor, saved), needs_place)
            };
            let (show, visibility_changed) = should_show;
            if needs_place || (visibility_changed && show) {
                place(&win, monitor.0.as_deref(), monitor.1);
            }
            if visibility_changed {
                trace!("visible -> {show} (fullscreen {fullscreen}, main active {main_is_active})");
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
    trace!("configure {config:?}");
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
    fn borderless_fullscreen_covers_the_monitor() {
        assert!(covers_monitor((0, 0, 1920, 1080), (0, 0, 1920, 1080)));
        assert!(covers_monitor((-1920, 0, 0, 1080), (-1920, 0, 0, 1080)));
    }

    #[test]
    fn maximized_window_above_the_taskbar_does_not() {
        // Maximized windows overhang by 8 px but stop at the taskbar.
        assert!(!covers_monitor((-8, -8, 1928, 1048), (0, 0, 1920, 1080)));
        assert!(!covers_monitor((100, 100, 900, 700), (0, 0, 1920, 1080)));
    }

    #[test]
    fn contains_checks_half_open_bounds() {
        assert!(contains((0, 0, 1920, 1080), (720, 0)));
        assert!(!contains((0, 0, 1920, 1080), (1920, 10)));
        assert!(contains((-1920, 0, 0, 1080), (-1200, 0)));
    }

    #[test]
    fn saved_position_on_a_monitor_is_kept() {
        let mons = [(0, 0, 1920, 1080), (-1920, 0, 0, 1080)];
        assert_eq!(resolve_position(Some((-1500, 300)), &mons, mons[0], 480), (-1500, 300));
    }

    #[test]
    fn saved_position_off_every_monitor_falls_back_to_top_centre() {
        let mons = [(0, 0, 1920, 1080)];
        assert_eq!(resolve_position(Some((-1500, 300)), &mons, mons[0], 480), (720, 0));
        assert_eq!(resolve_position(None, &mons, mons[0], 480), (720, 0));
    }

    #[test]
    fn empty_rect_never_hits() {
        assert!(!hit_test((0.0, 0.0), (0, 0), 1.0, Rect::default()));
    }
}
