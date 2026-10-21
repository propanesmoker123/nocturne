//! SoundCloud playback: prefer clear HLS, otherwise CTR HLS through the browser CDM. Its
//! short-lived license authorization is returned with the stream, never the account OAuth key.

use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use url::Url;

use super::api::{request, request_url, ScError};
use super::ScState;

pub struct Pick {
    pub url: String,
    pub protected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drm {
    license_token: String,
    app_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSource {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    drm: Option<Drm>,
    #[serde(skip_serializing_if = "Option::is_none")]
    waveform_url: Option<String>,
}

fn kbps(preset: &str) -> u32 {
    let digits: String = preset.split('_').find(|p| p.ends_with('k')).map(|p| p.trim_end_matches('k').to_string()).unwrap_or_default();
    digits.parse().unwrap_or(0)
}

/// Prefer clear HLS, then CTR HLS (Widevine/PlayReady). AAC before MP3, highest bitrate, full
/// tracks only. CBC requires FairPlay, so it is not selected on this Windows playback path.
pub fn pick_transcoding(track: &Value) -> Option<Pick> {
    if track.get("streamable").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    if matches!(track.get("policy").and_then(Value::as_str), Some("BLOCK" | "SNIP")) {
        return None;
    }
    let list = track.get("media")?.get("transcodings")?.as_array()?;
    let mut best: Option<(u8, u8, u32, Pick)> = None;
    for t in list {
        let format = t.get("format");
        let protocol = format.and_then(|f| f.get("protocol")).and_then(Value::as_str).unwrap_or_default();
        let mime = format.and_then(|f| f.get("mime_type")).and_then(Value::as_str).unwrap_or_default();
        let url = t.get("url").and_then(Value::as_str).unwrap_or_default();
        if !matches!(protocol, "hls" | "ctr-encrypted-hls") || t.get("snipped").and_then(Value::as_bool) == Some(true) || url.is_empty() {
            continue;
        }
        // the browser's CDM decrypts CENC in MP4 only
        if protocol == "ctr-encrypted-hls" && !mime.starts_with("audio/mp4") {
            continue;
        }
        let rank = if mime.starts_with("audio/mp4") {
            2
        } else if mime.starts_with("audio/mpeg") && !mime.starts_with("audio/mpegurl") {
            1
        } else {
            continue;
        };
        let rate = kbps(t.get("preset").and_then(Value::as_str).unwrap_or_default());
        let clear = u8::from(protocol == "hls");
        if best.as_ref().is_none_or(|(c, r, k, _)| (clear, rank, rate) > (*c, *r, *k)) {
            best = Some((clear, rank, rate, Pick { url: url.to_string(), protected: clear == 0 }));
        }
    }
    best.map(|(_, _, _, p)| p)
}

fn invalid(message: &str) -> ScError {
    ScError::Invalid { message: message.to_string() }
}

/// SoundCloud's waveform files only (`https://wave.sndcdn.com/….json`): small JSON, nothing else.
fn waveform_file(url: &str) -> bool {
    Url::parse(url).is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some("wave.sndcdn.com") && u.path().ends_with(".json"))
}

fn source_from_reply(answer: &Value, protected: bool, app_id: &str, waveform: Option<&str>) -> Result<PlaybackSource, ScError> {
    let url = answer.get("url").and_then(Value::as_str).ok_or_else(|| invalid("no stream"))?;
    if crate::proxy::origin_for(url) != Some(crate::proxy::Origin::Sc) {
        return Err(invalid("unexpected stream address"));
    }
    let drm = if protected {
        let token = answer.get("licenseAuthToken").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| invalid("no license authorization"))?;
        Some(Drm { license_token: token.to_string(), app_id: app_id.to_string() })
    } else { None };
    let waveform_url = waveform.filter(|url| waveform_file(url)).map(str::to_string);
    Ok(PlaybackSource { url: url.to_string(), drm, waveform_url })
}

/// The m3u8 link for a track, fresh: SoundCloud's links last minutes and may be single-use.
/// Never journaled.
#[tauri::command]
pub async fn sc_stream(app: AppHandle, track_id: u64) -> Result<PlaybackSource, ScError> {
    let list = request(&app, "GET", &format!("/tracks?ids={track_id}")).await?;
    let track = list.as_array().and_then(|a| a.first()).ok_or_else(|| invalid("no such track"))?;
    let pick = pick_transcoding(track).ok_or_else(|| invalid("no stream"))?;
    if !pick.url.starts_with("https://api-v2.soundcloud.com/media/") {
        return Err(invalid("unexpected stream address"));
    }
    let mut url = Url::parse(&pick.url).map_err(|_| invalid("unexpected stream address"))?;
    url.query_pairs_mut().append_pair("client_id", &app.state::<ScState>().ids().client_id);
    if let Some(auth) = track.get("track_authorization").and_then(Value::as_str) {
        url.query_pairs_mut().append_pair("track_authorization", auth);
    }
    let answer = request_url(&app, Method::GET, url).await?;
    source_from_reply(&answer, pick.protected, &app.state::<ScState>().ids().app_id, track.get("waveform_url").and_then(Value::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tc(protocol: &str, mime: &str, preset: &str, url: &str) -> serde_json::Value {
        json!({ "url": url, "preset": preset, "snipped": false, "format": { "protocol": protocol, "mime_type": mime } })
    }

    #[test]
    fn prefers_aac_160k() {
        let t = json!({ "policy": "MONETIZE", "media": { "transcodings": [
            tc("hls", "audio/mp4; codecs=\"mp4a.40.2\"", "aac_96k", "u96"),
            tc("hls", "audio/mp4; codecs=\"mp4a.40.2\"", "aac_160k", "u160"),
            tc("hls", "audio/mpegurl", "abr_sq", "uabr"),
        ] } });
        assert_eq!(pick_transcoding(&t).map(|p| p.url), Some("u160".to_string()));
    }

    #[test]
    fn ctr_encrypted_hls_is_played_through_the_browser_cdm() {
        let t = json!({ "policy": "MONETIZE", "media": { "transcodings": [
            tc("ctr-encrypted-hls", "audio/mp4", "aac_160k", "a"),
            tc("cbc-encrypted-hls", "audio/mp4", "aac_160k", "b"),
        ] } });
        assert_eq!(pick_transcoding(&t).map(|p| p.url), Some("a".to_string()));
    }

    #[test]
    fn existing_clear_streams_take_precedence_over_drm() {
        let t = json!({ "media": { "transcodings": [
            tc("ctr-encrypted-hls", "audio/mp4", "aac_160k", "drm"),
            tc("hls", "audio/mp4", "aac_96k", "clear"),
        ] } });
        assert_eq!(pick_transcoding(&t).map(|p| p.url), Some("clear".to_string()));
    }

    #[test]
    fn encrypted_mp3_is_not_taken() {
        assert!(pick_transcoding(&json!({ "media": { "transcodings": [tc("ctr-encrypted-hls", "audio/mpeg", "mp3_1_0", "m")] } })).is_none());
    }

    #[test]
    fn the_waveform_comes_only_from_soundclouds_waveform_files() {
        let url = "https://playback.media-streaming.soundcloud.cloud/track/playlist.m3u8";
        let wave = |w: &str| serde_json::to_value(source_from_reply(&json!({"url": url}), false, "1", Some(w)).unwrap()).unwrap().get("waveformUrl").cloned();
        assert_eq!(wave("https://wave.sndcdn.com/abc_m.json"), Some(json!("https://wave.sndcdn.com/abc_m.json")));
        assert_eq!(wave("https://i1.sndcdn.com/abc.json"), None);
        assert_eq!(wave("https://wave.sndcdn.com/abc_m.png"), None);
        assert_eq!(wave("http://wave.sndcdn.com/abc_m.json"), None);
    }

    #[test]
    fn cbc_only_still_needs_a_fairplay_player() {
        assert!(pick_transcoding(&json!({ "media": { "transcodings": [tc("cbc-encrypted-hls", "audio/mp4", "aac_160k", "cbc")] } })).is_none());
    }

    #[test]
    fn snipped_or_snip_policy_has_no_stream() {
        let mut snipped = tc("hls", "audio/mp4", "aac_160k", "a");
        snipped["snipped"] = json!(true);
        assert!(pick_transcoding(&json!({ "media": { "transcodings": [snipped] } })).is_none());
        for policy in ["SNIP", "BLOCK"] {
            let t = json!({ "policy": policy, "media": { "transcodings": [tc("hls", "audio/mp4", "aac_160k", "a")] } });
            assert!(pick_transcoding(&t).is_none(), "{policy}");
        }
    }

    #[test]
    fn mp3_when_there_is_no_aac() {
        let t = json!({ "policy": "ALLOW", "media": { "transcodings": [tc("hls", "audio/mpeg", "mp3_1_0", "m")] } });
        assert_eq!(pick_transcoding(&t).map(|p| p.url), Some("m".to_string()));
    }

    #[test]
    fn not_streamable_has_no_stream() {
        let t = json!({ "streamable": false, "media": { "transcodings": [tc("hls", "audio/mp4", "aac_160k", "a")] } });
        assert!(pick_transcoding(&t).is_none());
    }

    #[test]
    fn protected_sources_require_the_services_license_authorization() {
        let url = "https://playback.media-streaming.soundcloud.cloud/track/playlist.m3u8";
        assert!(source_from_reply(&json!({"url": url}), true, "46941", None).is_err());
        assert!(source_from_reply(&json!({"url": url, "licenseAuthToken": ""}), true, "46941", None).is_err());
        let source = source_from_reply(&json!({"url": url, "licenseAuthToken": "temporary"}), true, "46941", None).unwrap();
        assert_eq!(serde_json::to_value(source).unwrap(), json!({"url": url, "drm": {"licenseToken": "temporary", "appId": "46941"}}));
        let plain = source_from_reply(&json!({"url": url, "licenseAuthToken": "unused"}), false, "46941", None).unwrap();
        assert_eq!(serde_json::to_value(plain).unwrap(), json!({"url": url}));
        assert!(source_from_reply(&json!({"url": "https://evil.test/x.m3u8", "licenseAuthToken": "temporary"}), true, "46941", None).is_err());
    }
}
