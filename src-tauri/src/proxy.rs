//! Byte proxy for hls.js (playlists, segments, AES keys) and artwork. Requests go out
//! with browser-like headers of the service the host belongs to; only VK's and SoundCloud's
//! media hosts are reachable.

use tauri::State;

use crate::http::Http;

const ALLOWED_SUFFIXES: &[&str] = &[
    "vkuseraudio.ru",
    "vkuseraudio.net",
    "vkuseraudio.com",
    "userapi.com",
    "vk.ru",
    "vk.com",
    "vk-cdn.net",
    "vkuser.net",
    "mycdn.me",
    "okcdn.ru",
];

/// SoundCloud's stream and artwork hosts.
const SC_SUFFIXES: &[&str] = &["sndcdn.com", "soundcloud.cloud"];

/// Whose media a host carries: it decides the headers.
#[derive(Debug, PartialEq)]
pub enum Origin {
    Vk,
    Sc,
}

pub fn origin_for(url: &str) -> Option<Origin> {
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "https" {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    let under = |suffixes: &[&str]| suffixes.iter().any(|s| host == *s || host.ends_with(&format!(".{s}")));
    if under(ALLOWED_SUFFIXES) {
        Some(Origin::Vk)
    } else if under(SC_SUFFIXES) {
        Some(Origin::Sc)
    } else {
        None
    }
}

#[cfg(test)]
fn host_allowed(url: &str) -> bool {
    origin_for(url).is_some()
}

#[tauri::command]
pub async fn proxy_fetch(http: State<'_, Http>, url: String) -> Result<tauri::ipc::Response, String> {
    let Some(origin) = origin_for(&url) else {
        return Err(format!("host not allowed: {url}"));
    };
    let (origin, referer) = match origin {
        Origin::Vk => ("https://vk.ru", "https://vk.ru/"),
        Origin::Sc => ("https://soundcloud.com", "https://soundcloud.com/"),
    };
    // Signed CDN links must not reach the journal: host only.
    let host = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let fail = |msg: String| {
        crate::journal::write("proxy", &format!("{host}: {msg}"));
        msg
    };
    let resp = http
        .client
        .get(&url)
        .header(reqwest::header::USER_AGENT, http.user_agent())
        .header(reqwest::header::ORIGIN, origin)
        .header(reqwest::header::REFERER, referer)
        .send()
        .await
        .map_err(|e| fail(format!("network: {}", e.without_url())))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(fail(format!("HTTP {}", status.as_u16())));
    }
    let bytes = resp.bytes().await.map_err(|e| fail(format!("network: {}", e.without_url())))?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_vk_cdn_hosts() {
        assert!(host_allowed("https://cs1-2v4.vkuseraudio.net/s/v1/ac/x/index.m3u8"));
        assert!(host_allowed("https://cs9-7v4.vkuseraudio.ru/s/v1/ac/x/seg-01-a2.ts?siren=1"));
        assert!(host_allowed("https://sun9-1.userapi.com/impg/a.jpg"));
        assert!(host_allowed("https://vk.ru/images/x.png"));
    }

    #[test]
    fn rejects_other_hosts_and_lookalikes() {
        assert!(!host_allowed("https://example.com/a"));
        assert!(!host_allowed("https://vkuseraudio.net.evil.com/a"));
        assert!(!host_allowed("https://evilvkuseraudio.net/a"));
        assert!(!host_allowed("file:///C:/Windows/win.ini"));
        assert!(!host_allowed("not a url"));
    }

    #[test]
    fn soundcloud_media_hosts_get_soundcloud_headers() {
        assert_eq!(origin_for("https://playback.media-streaming.soundcloud.cloud/a/playlist.m3u8"), Some(Origin::Sc));
        assert_eq!(origin_for("https://cf-hls-media.sndcdn.com/x"), Some(Origin::Sc));
        assert_eq!(origin_for("https://cs1-2v4.vkuseraudio.net/s/v1/ac/x/index.m3u8"), Some(Origin::Vk));
        assert_eq!(origin_for("https://soundcloud.cloud.evil.com/x"), None);
        assert_eq!(origin_for("http://playback.media-streaming.soundcloud.cloud/x"), None);
    }

    #[test]
    fn rejects_plain_http() {
        assert!(!host_allowed("http://cs1-2v4.vkuseraudio.net/a"));
    }
}
