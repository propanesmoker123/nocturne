//! Windows System Media Transport Controls (the media flyout with artwork + hardware media
//! keys) via souvlaki, bound to the main window. Button presses become `player:command`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig, SeekDirection};
use tauri::{AppHandle, Emitter, Manager};

const MAX_MEDIA_SECS: f64 = 7.0 * 86_400.0;

pub struct MediaState(Arc<Mutex<Option<MediaControls>>>);

impl MediaState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

pub(crate) fn safe_duration(secs: f64) -> Duration {
    if !secs.is_finite() {
        return Duration::ZERO;
    }
    Duration::try_from_secs_f64(secs.clamp(0.0, MAX_MEDIA_SECS)).unwrap_or(Duration::ZERO)
}

pub(crate) fn sanitize_cover_url(raw: Option<&str>) -> Option<&str> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    url::Url::parse(s)
        .ok()
        .filter(|u| u.scheme() == "https" && u.host_str().is_some())
        .map(|_| s)
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
    let Some(win) = app.get_window("main") else { return };
    let Ok(hwnd) = win.hwnd() else { return };
    let config = PlatformConfig { display_name: "Nocturne", dbus_name: "nocturne", hwnd: Some(hwnd.0) };
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
pub async fn media_update(app: AppHandle, update: Option<MediaUpdate>) {
    if let Some(u) = &update {
        crate::tray::set_tooltip(&app, &format!("{} — {}", u.artist, u.title));
    } else {
        crate::tray::set_tooltip(&app, "Nocturne");
    }
    let controls = Arc::clone(&app.state::<MediaState>().0);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let Ok(mut g) = controls.lock() else { return };
        let Some(controls) = g.as_mut() else { return };
        match update {
            Some(u) => {
                let cover = sanitize_cover_url(u.cover_url.as_deref());
                let duration = Some(safe_duration(u.duration));
                let meta_res = controls.set_metadata(MediaMetadata {
                    title: Some(&u.title),
                    artist: Some(&u.artist),
                    album: Some(&u.album),
                    cover_url: cover,
                    duration,
                });
                if meta_res.is_err() && cover.is_some() {
                    let _ = controls.set_metadata(MediaMetadata {
                        title: Some(&u.title),
                        artist: Some(&u.artist),
                        album: Some(&u.album),
                        cover_url: None,
                        duration,
                    });
                }
                let progress = Some(MediaPosition(safe_duration(u.position)));
                let _ = controls.set_playback(if u.playing {
                    MediaPlayback::Playing { progress }
                } else {
                    MediaPlayback::Paused { progress }
                });
            }
            None => {
                let _ = controls.set_playback(MediaPlayback::Stopped);
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_duration_never_panics_and_clamps_bounds() {
        assert_eq!(safe_duration(f64::NAN), Duration::ZERO);
        assert_eq!(safe_duration(f64::INFINITY), Duration::ZERO);
        assert_eq!(safe_duration(f64::NEG_INFINITY), Duration::ZERO);
        assert_eq!(safe_duration(-12.5), Duration::ZERO);
        assert_eq!(safe_duration(0.0), Duration::ZERO);
        assert_eq!(safe_duration(123.5), Duration::from_millis(123_500));
        assert_eq!(safe_duration(1e300), Duration::from_secs(7 * 86_400));
    }

    #[test]
    fn cover_url_allows_only_valid_https_urls() {
        assert_eq!(
            sanitize_cover_url(Some("  https://i.scdn.co/image/abc.jpg  ")),
            Some("https://i.scdn.co/image/abc.jpg")
        );
        assert_eq!(sanitize_cover_url(None), None);
        assert_eq!(sanitize_cover_url(Some("")), None);
        assert_eq!(sanitize_cover_url(Some("   ")), None);
        assert_eq!(sanitize_cover_url(Some("http://i.scdn.co/image/abc.jpg")), None);
        assert_eq!(sanitize_cover_url(Some("file:///C:/secret.png")), None);
        assert_eq!(sanitize_cover_url(Some("data:image/png;base64,AAA")), None);
        assert_eq!(sanitize_cover_url(Some("not a url")), None);
    }
}
