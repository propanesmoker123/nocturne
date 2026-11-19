//! Byte proxy for hls.js (playlists, segments, AES keys) and artwork. Requests go out
//! with browser-like headers of the service the host belongs to; only VK's and SoundCloud's
//! media hosts are reachable.

use tauri::State;

use crate::http::Http;

const ALLOWED_SUFFIXES: &[&str] = &[
    "vkuseraudio.ru",
    "vkuseraudio.net",
    "vkuseraudio.com",
    "vkuserphoto.ru",
    "vkuserphoto.net",
    "vkuserphoto.com",
    "userapi.com",
    "vk.ru",
    "vk.com",
    "vk.me",
    "vk-cdn.net",
    "vk-cdn.me",
    "vkuser.net",
    "mycdn.me",
    "okcdn.ru",
];

/// SoundCloud's stream and artwork hosts.
const SC_SUFFIXES: &[&str] = &["sndcdn.com", "soundcloud.cloud"];

/// Spotify's artwork and preview audio hosts.
const SPOTIFY_SUFFIXES: &[&str] = &["scdn.co", "spotifycdn.com"];

const MAX_PROXY_BYTES: usize = 64 * 1024 * 1024;
const MAX_REDIRECT_HOPS: usize = 5;

/// Whose media a host carries: it decides the headers.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Origin {
    Vk,
    Sc,
    Spotify,
}

pub fn origin_for(url: &str) -> Option<Origin> {
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "https" || u.port().is_some() || !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let host = u.host_str()?.to_ascii_lowercase();
    let under = |suffixes: &[&str]| suffixes.iter().any(|s| host == *s || host.ends_with(&format!(".{s}")));
    if under(ALLOWED_SUFFIXES) {
        Some(Origin::Vk)
    } else if under(SC_SUFFIXES) {
        Some(Origin::Sc)
    } else if under(SPOTIFY_SUFFIXES) {
        Some(Origin::Spotify)
    } else {
        None
    }
}

fn headers_for(origin: Origin) -> (&'static str, &'static str) {
    match origin {
        Origin::Vk => ("https://vk.ru", "https://vk.ru/"),
        Origin::Sc => ("https://soundcloud.com", "https://soundcloud.com/"),
        Origin::Spotify => ("https://open.spotify.com", "https://open.spotify.com/"),
    }
}

#[cfg(test)]
fn host_allowed(url: &str) -> bool {
    origin_for(url).is_some()
}

fn range_header([start, end]: [u64; 2]) -> Result<String, String> {
    if start >= end {
        return Err("invalid media byte range".into());
    }
    Ok(format!("bytes={start}-{}", end - 1))
}

/// Validates RFC 9110 `Content-Range: bytes <start>-<end>/<total>` against requested half-open
/// `[start, end)`, accepting both exact ranges and EOF-clamped ranges, returning expected length.
pub(crate) fn expected_range_len(content_range: &str, [start, end]: [u64; 2]) -> Option<u64> {
    if start >= end {
        return None;
    }
    let rest = content_range.trim().strip_prefix("bytes ")?;
    let (span, total_str) = rest.split_once('/')?;
    let (s_str, e_str) = span.split_once('-')?;
    let s_resp: u64 = s_str.parse().ok()?;
    let e_resp: u64 = e_str.parse().ok()?;
    if s_resp != start || e_resp < s_resp || e_resp >= end {
        return None;
    }
    let valid_end = if e_resp == end - 1 {
        total_str == "*" || total_str.parse::<u64>().ok().is_some_and(|total| e_resp < total)
    } else {
        total_str.parse::<u64>().ok().is_some_and(|total| e_resp.checked_add(1) == Some(total))
    };
    if !valid_end {
        return None;
    }
    e_resp.checked_sub(s_resp)?.checked_add(1)
}

#[tauri::command]
pub async fn proxy_fetch(http: State<'_, Http>, url: String, range: Option<[u64; 2]>) -> Result<tauri::ipc::Response, String> {
    // Signed CDN links must not reach the journal: host only.
    let host = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let fail = |msg: String| {
        crate::journal::write("proxy", &format!("{host}: {msg}"));
        msg
    };
    let Some(initial_origin) = origin_for(&url) else {
        return Err(fail("media host not allowed".into()));
    };
    let range_hdr = range.map(range_header).transpose()?;
    let ua = http.user_agent();
    let mut resp = http
        .send_with_validated_redirects(
            &url,
            MAX_REDIRECT_HOPS,
            |u| origin_for(u.as_str()).is_some(),
            |client, u| {
                let hop_origin = origin_for(u.as_str()).unwrap_or(initial_origin);
                let (origin, referer) = headers_for(hop_origin);
                let mut req = client
                    .get(u.clone())
                    .header(reqwest::header::USER_AGENT, &ua)
                    .header(reqwest::header::ORIGIN, origin)
                    .header(reqwest::header::REFERER, referer);
                if let Some(ref rh) = range_hdr {
                    req = req
                        .header(reqwest::header::RANGE, rh.as_str())
                        .header(reqwest::header::ACCEPT_ENCODING, "identity");
                }
                req
            },
        )
        .await
        .map_err(&fail)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(fail(format!("HTTP {}", status.as_u16())));
    }
    let expected_len = if let Some(bounds) = range {
        let content_range = resp.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok());
        let len = (status == reqwest::StatusCode::PARTIAL_CONTENT)
            .then_some(content_range)
            .flatten()
            .and_then(|hdr| expected_range_len(hdr, bounds));
        let Some(len) = len else {
            return Err(fail("unexpected response to media byte range".into()));
        };
        if len > MAX_PROXY_BYTES as u64 {
            return Err(fail("media response too large".into()));
        }
        Some(len)
    } else {
        None
    };
    if resp.content_length().is_some_and(|n| n > MAX_PROXY_BYTES as u64) {
        return Err(fail("media response too large".into()));
    }
    let cap = expected_len
        .or_else(|| resp.content_length())
        .map(|n| n.min(4 * 1024 * 1024) as usize)
        .unwrap_or(0);
    let mut buf = Vec::with_capacity(cap);
    while let Some(chunk) = resp.chunk().await.map_err(|e| fail(format!("network: {}", e.without_url())))? {
        if buf.len() + chunk.len() > MAX_PROXY_BYTES {
            return Err(fail("media response too large".into()));
        }
        buf.extend_from_slice(&chunk);
    }
    if expected_len.is_some_and(|exp| buf.len() as u64 != exp) {
        return Err(fail("incomplete media byte range".into()));
    }
    Ok(tauri::ipc::Response::new(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_vk_cdn_hosts() {
        assert!(host_allowed("https://cs1-2v4.vkuseraudio.net/s/v1/ac/x/index.m3u8"));
        assert!(host_allowed("https://cs9-7v4.vkuseraudio.ru/s/v1/ac/x/seg-01-a2.ts?siren=1"));
        assert!(host_allowed("https://sun9-1.userapi.com/impg/a.jpg"));
        assert!(host_allowed("https://sun9-69.vkuserphoto.ru/impg/a.jpg?size=300x300"));
        assert!(host_allowed("https://sun1-22.vkuserphoto.net/impg/a.jpg"));
        assert!(host_allowed("https://sun9-50.vkuserphoto.com/impg/a.jpg"));
        assert!(host_allowed("https://cs54.vk.me/v54/a.jpg"));
        assert!(host_allowed("https://vk.ru/images/x.png"));
        assert_eq!(origin_for("https://sun9-69.vkuserphoto.ru/impg/a.jpg"), Some(Origin::Vk));
        assert!(!host_allowed("https://vkuserphoto.ru.evil.com/impg/a.jpg"));
        assert!(!host_allowed("http://sun9-69.vkuserphoto.ru/impg/a.jpg"));
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
    fn rejects_explicit_ports_and_userinfo() {
        assert_eq!(origin_for("https://vk.ru:8443/images/x.png"), None);
        assert_eq!(origin_for("https://i.scdn.co:444/image/abc"), None);
        assert_eq!(origin_for("https://user@vk.ru/images/x.png"), None);
        assert_eq!(origin_for("https://user:pass@cf-hls-media.sndcdn.com/x"), None);
        assert_eq!(origin_for("https://:pass@i.scdn.co/image/abc"), None);
    }

    #[test]
    fn soundcloud_media_hosts_get_soundcloud_headers() {
        assert_eq!(origin_for("https://playback.media-streaming.soundcloud.cloud/a/playlist.m3u8"), Some(Origin::Sc));
        assert_eq!(origin_for("https://cf-hls-media.sndcdn.com/x"), Some(Origin::Sc));
        assert_eq!(origin_for("https://i.scdn.co/image/ab67616d0000b273"), Some(Origin::Spotify));
        assert_eq!(origin_for("https://p.scdn.co/mp3-preview/123"), Some(Origin::Spotify));
        assert_eq!(origin_for("https://cs1-2v4.vkuseraudio.net/s/v1/ac/x/index.m3u8"), Some(Origin::Vk));
        assert_eq!(origin_for("https://soundcloud.cloud.evil.com/x"), None);
        assert_eq!(origin_for("https://scdn.co.evil.com/x"), None);
        assert_eq!(origin_for("http://playback.media-streaming.soundcloud.cloud/x"), None);
    }

    #[test]
    fn rejects_plain_http() {
        assert!(!host_allowed("http://cs1-2v4.vkuseraudio.net/a"));
    }

    #[test]
    fn range_end_from_hls_is_exclusive() {
        assert_eq!(range_header([0, 1]).unwrap(), "bytes=0-0");
        assert_eq!(range_header([256, 1024]).unwrap(), "bytes=256-1023");
        assert!(range_header([1, 1]).is_err());
        assert!(range_header([2, 0]).is_err());
    }

    #[test]
    fn parses_exact_and_clamped_eof_content_ranges() {
        assert_eq!(expected_range_len("bytes 0-1023/5000", [0, 1024]), Some(1024));
        assert_eq!(expected_range_len("bytes 0-1023/*", [0, 1024]), Some(1024));
        // RFC 9110 clamped EOF range: requested 4096..5120, file ends at 4500.
        assert_eq!(expected_range_len("bytes 4096-4499/4500", [4096, 5120]), Some(404));
        assert_eq!(expected_range_len("bytes 0-0/1", [0, 10]), Some(1));

        // Invalid: truncated before EOF, unknown total on short range, wrong start, overshoot, impossible total.
        assert_eq!(expected_range_len("bytes 4096-4499/5000", [4096, 5120]), None);
        assert_eq!(expected_range_len("bytes 4096-4499/*", [4096, 5120]), None);
        assert_eq!(expected_range_len("bytes 0-1023/5000", [1, 1024]), None);
        assert_eq!(expected_range_len("bytes 0-1024/5000", [0, 1024]), None);
        assert_eq!(expected_range_len("bytes 10-9/5000", [10, 20]), None);
        assert_eq!(expected_range_len("bytes 0-1023/500", [0, 1024]), None);
        assert_eq!(expected_range_len("items 0-10/20", [0, 11]), None);
    }
}
