//! A SoundCloud track's stream: the plain HLS transcoding (AAC first), turned into a short-lived
//! m3u8 link at play time. Encrypted (DRM) transcodings and 30-second previews have no stream here.

use reqwest::Method;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use url::Url;

use super::api::{request, request_url, ScError};
use super::ScState;

pub struct Pick {
    pub url: String,
}

fn kbps(preset: &str) -> u32 {
    let digits: String = preset.split('_').find(|p| p.ends_with('k')).map(|p| p.trim_end_matches('k').to_string()).unwrap_or_default();
    digits.parse().unwrap_or(0)
}

/// The transcoding to play: plain `hls`, not a preview, AAC (`audio/mp4`, highest bitrate) before
/// MP3 (`audio/mpeg`); never the adaptive `audio/mpegurl` master. None when nothing is playable.
pub fn pick_transcoding(track: &Value) -> Option<Pick> {
    if track.get("streamable").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    if matches!(track.get("policy").and_then(Value::as_str), Some("BLOCK" | "SNIP")) {
        return None;
    }
    let list = track.get("media")?.get("transcodings")?.as_array()?;
    let mut best: Option<(u8, u32, Pick)> = None;
    for t in list {
        let format = t.get("format");
        let protocol = format.and_then(|f| f.get("protocol")).and_then(Value::as_str).unwrap_or_default();
        let mime = format.and_then(|f| f.get("mime_type")).and_then(Value::as_str).unwrap_or_default();
        let url = t.get("url").and_then(Value::as_str).unwrap_or_default();
        if protocol != "hls" || t.get("snipped").and_then(Value::as_bool) == Some(true) || url.is_empty() {
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
        if best.as_ref().is_none_or(|(r, k, _)| (rank, rate) > (*r, *k)) {
            best = Some((rank, rate, Pick { url: url.to_string() }));
        }
    }
    best.map(|(_, _, p)| p)
}

fn invalid(message: &str) -> ScError {
    ScError::Invalid { message: message.to_string() }
}

/// The m3u8 link for a track, fresh: SoundCloud's links last minutes and may be single-use.
/// Never journaled.
#[tauri::command]
pub async fn sc_stream(app: AppHandle, track_id: u64) -> Result<String, ScError> {
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
    let link = answer.get("url").and_then(Value::as_str).ok_or_else(|| invalid("no stream"))?;
    if crate::proxy::origin_for(link) != Some(crate::proxy::Origin::Sc) {
        return Err(invalid("unexpected stream address"));
    }
    Ok(link.to_string())
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
    fn encrypted_only_has_no_stream() {
        let t = json!({ "policy": "MONETIZE", "media": { "transcodings": [
            tc("ctr-encrypted-hls", "audio/mp4", "aac_160k", "a"),
            tc("cbc-encrypted-hls", "audio/mp4", "aac_160k", "b"),
        ] } });
        assert!(pick_transcoding(&t).is_none());
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
}
