//! Byte proxy for hls.js (playlists, segments, AES keys) and artwork. Requests go out
//! with browser-like vk.ru headers; only VK CDN hosts are reachable.

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

pub fn host_allowed(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    if u.scheme() != "https" {
        return false;
    }
    let Some(host) = u.host_str() else { return false };
    let host = host.to_ascii_lowercase();
    ALLOWED_SUFFIXES.iter().any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

#[tauri::command]
pub async fn proxy_fetch(http: State<'_, Http>, url: String) -> Result<tauri::ipc::Response, String> {
    if !host_allowed(&url) {
        return Err(format!("host not allowed: {url}"));
    }
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
        .header(reqwest::header::ORIGIN, "https://vk.ru")
        .header(reqwest::header::REFERER, "https://vk.ru/")
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
    fn rejects_plain_http() {
        assert!(!host_allowed("http://cs1-2v4.vkuseraudio.net/a"));
    }
}
