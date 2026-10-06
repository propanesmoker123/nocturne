//! Windows System Media Transport Controls (the media flyout with artwork + hardware media
//! keys) via souvlaki, bound to the main window. Button presses become `player:command`.

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};
use tauri::{AppHandle, Emitter, Manager};

pub struct MediaState(Mutex<Option<MediaControls>>);

impl MediaState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUpdate {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_url: Option<String>,
    pub duration: f64,
    pub position: f64,
    pub playing: bool,
}

fn command_for(event: MediaControlEvent) -> Option<serde_json::Value> {
    Some(match event {
        MediaControlEvent::Play => json!({ "type": "play" }),
        MediaControlEvent::Pause => json!({ "type": "pause" }),
        MediaControlEvent::Toggle => json!({ "type": "toggle" }),
        MediaControlEvent::Next => json!({ "type": "next" }),
        MediaControlEvent::Previous => json!({ "type": "prev" }),
        MediaControlEvent::Stop => json!({ "type": "pause" }),
        MediaControlEvent::SetPosition(MediaPosition(d)) => json!({ "type": "seek", "value": d.as_secs_f64() }),
        MediaControlEvent::SeekBy(dir, d) => {
            let s = d.as_secs_f64();
            json!({ "type": "seekBy", "value": if matches!(dir, SeekDirection::Backward) { -s } else { s } })
        }
        MediaControlEvent::Seek(dir) => json!({ "type": "seekBy", "value": if matches!(dir, SeekDirection::Backward) { -10.0 } else { 10.0 } }),
        MediaControlEvent::SetVolume(v) => json!({ "type": "volume", "value": v }),
        MediaControlEvent::Raise => json!({ "type": "showWindow" }),
        _ => return None,
    })
}

/// Attaches SMTC to the main window. Failure is non-fatal (no flyout, keys still work in-app).
pub fn init(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let Ok(hwnd) = win.hwnd() else { return };
    let config = PlatformConfig { display_name: "Nocturne", dbus_name: "nocturne", hwnd: Some(hwnd.0 as *mut std::ffi::c_void) };
    let Ok(mut controls) = MediaControls::new(config) else { return };
    let handle = app.clone();
    let attached = controls.attach(move |event| {
        if let Some(cmd) = command_for(event) {
            let _ = handle.emit_to("main", "player:command", cmd);
        }
    });
    if attached.is_ok() {
        if let Ok(mut g) = app.state::<MediaState>().0.lock() {
            *g = Some(controls);
        }
    }
}

#[tauri::command]
pub fn media_update(app: AppHandle, state: tauri::State<'_, MediaState>, update: Option<MediaUpdate>) {
    if let Some(u) = &update {
        crate::tray::set_tooltip(&app, &format!("{} — {}", u.artist, u.title));
    } else {
        crate::tray::set_tooltip(&app, "Nocturne");
    }
    let Ok(mut g) = state.0.lock() else { return };
    let Some(controls) = g.as_mut() else { return };
    match update {
        Some(u) => {
            let _ = controls.set_metadata(MediaMetadata {
                title: Some(&u.title),
                artist: Some(&u.artist),
                album: Some(&u.album),
                cover_url: u.cover_url.as_deref(),
                duration: Some(Duration::from_secs_f64(u.duration.max(0.0))),
            });
            let progress = Some(MediaPosition(Duration::from_secs_f64(u.position.max(0.0))));
            let _ = controls.set_playback(if u.playing { MediaPlayback::Playing { progress } } else { MediaPlayback::Paused { progress } });
        }
        None => {
            let _ = controls.set_playback(MediaPlayback::Stopped);
        }
    }
}
