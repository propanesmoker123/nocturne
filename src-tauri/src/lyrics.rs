//! Restricted HTTP fetch helper for approved read-only lyrics APIs & metadata.

use tauri::State;

use crate::http::Http;

const MAX_BYTES: usize = 3 * 1024 * 1024;
const MAX_AI_BYTES: usize = 256 * 1024;
const MAX_AI_PROMPT_BYTES: usize = 32 * 1024;
const MAX_REDIRECT_HOPS: usize = 5;
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const GEMINI_ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const LYRICS_UA: &str = concat!("Nocturne/", env!("CARGO_PKG_VERSION"), " (lyrics)");

fn has_encoded_traversal(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.contains("..")
        || lower.contains('\\')
        || lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
}

fn raw_path_part(url: &str) -> &str {
    let before_query = url.split(['?', '#']).next().unwrap_or(url);
    if let Some(idx) = before_query.find("://") {
        let after_scheme = &before_query[idx + 3..];
        match after_scheme.find(['/', '\\']) {
            Some(slash) => &after_scheme[slash..],
            None => "",
        }
    } else {
        before_query
    }
}

pub fn lyrics_url_allowed(url: &str) -> bool {
    if has_encoded_traversal(raw_path_part(url)) {
        return false;
    }
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return false;
    }
    let Some(host) = u.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    let path = u.path();
    if has_encoded_traversal(path) {
        return false;
    }
    match host.as_str() {
        "lrclib.net" => path == "/api/get" || path == "/api/search",
        "genius.com" => {
            path == "/api/search/multi"
                || (path.starts_with('/')
                    && path.ends_with("-lyrics")
                    && path.len() > "/-lyrics".len()
                    && !path[1..].contains('/'))
        }
        "music.163.com" => path == "/api/cloudsearch/pc" || path == "/api/song/lyric",
        "c.y.qq.com" => path == "/soso/fcgi-bin/client_search_cp" || path == "/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
        "mobileservice.kugou.com" => path == "/api/v3/search/song",
        "krcs.kugou.com" => path == "/search",
        "lyrics.kugou.com" => path == "/download",
        "api.lyrics.ovh" => path.starts_with("/v1/") && path.len() > 4,
        _ => false,
    }
}

fn lyrics_referer_for(url: &str) -> Option<&'static str> {
    let u = url::Url::parse(url).ok()?;
    match u.host_str().map(str::to_ascii_lowercase).as_deref() {
        Some("music.163.com") => Some("https://music.163.com/"),
        Some("c.y.qq.com") => Some("https://y.qq.com/"),
        _ => None,
    }
}

#[tauri::command]
pub async fn lyrics_fetch(http: State<'_, Http>, url: String) -> Result<String, String> {
    if !lyrics_url_allowed(&url) {
        return Err("url not allowed".into());
    }
    let mut resp = http
        .send_with_validated_redirects(
            &url,
            MAX_REDIRECT_HOPS,
            |u| lyrics_url_allowed(u.as_str()),
            |client, u| {
                let mut req = client
                    .get(u.clone())
                    .timeout(FETCH_TIMEOUT)
                    .header(reqwest::header::USER_AGENT, LYRICS_UA)
                    .header(reqwest::header::ACCEPT, "application/json, text/html;q=0.9");
                if let Some(referer) = lyrics_referer_for(u.as_str()) {
                    req = req.header(reqwest::header::REFERER, referer);
                }
                req
            },
        )
        .await?;

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(String::new());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    if resp.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
        return Err("response too large".into());
    }

    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("network: {}", e.without_url()))? {
        if buf.len() + chunk.len() > MAX_BYTES {
            return Err("response too large".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

pub fn validate_gemini_key(raw: &str) -> Result<&str, String> {
    let key = raw.trim();
    if key.is_empty() || key.len() > 256 || !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err("invalid api key".into());
    }
    Ok(key)
}

#[tauri::command]
pub async fn lyrics_ai(http: State<'_, Http>, api_key: String, prompt: String) -> Result<String, String> {
    let key = validate_gemini_key(&api_key)?;
    let trimmed_prompt = prompt.trim();
    if trimmed_prompt.is_empty() || trimmed_prompt.len() > MAX_AI_PROMPT_BYTES {
        return Err("invalid prompt length".into());
    }

    let body = serde_json::json!({
        "contents": [{ "role": "user", "parts": [{ "text": trimmed_prompt }] }],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.4,
            "maxOutputTokens": 2048
        }
    });

    let mut resp = http
        .client
        .post(GEMINI_ENDPOINT)
        .timeout(std::time::Duration::from_secs(12))
        .header("x-goog-api-key", key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e.without_url()))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    if resp.content_length().is_some_and(|n| n > MAX_AI_BYTES as u64) {
        return Err("response too large".into());
    }

    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("network: {}", e.without_url()))? {
        if buf.len() + chunk.len() > MAX_AI_BYTES {
            return Err("response too large".into());
        }
        buf.extend_from_slice(&chunk);
    }

    let v: serde_json::Value = serde_json::from_slice(&buf).map_err(|e| format!("json: {e}"))?;
    v.pointer("/candidates/0/content/parts/0/text")
        .and_then(|x| x.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "empty AI response".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_approved_lyrics_routes() {
        assert!(lyrics_url_allowed("https://lrclib.net/api/get?artist_name=Lil+Peep&track_name=Star+Shopping"));
        assert!(lyrics_url_allowed("https://lrclib.net/api/search?q=Lil+Peep+Star+Shopping"));
        assert!(lyrics_url_allowed("https://genius.com/api/search/multi?q=Lil+Peep"));
        assert!(lyrics_url_allowed("https://genius.com/Lil-peep-star-shopping-lyrics"));
        assert!(lyrics_url_allowed("https://music.163.com/api/cloudsearch/pc?s=test&type=1"));
        assert!(lyrics_url_allowed("https://music.163.com/api/song/lyric?id=123&lv=1&yv=1"));
        assert!(lyrics_url_allowed("https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=test&format=json"));
        assert!(lyrics_url_allowed("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=abc&format=json"));
        assert!(lyrics_url_allowed("https://mobileservice.kugou.com/api/v3/search/song?keyword=test"));
        assert!(lyrics_url_allowed("https://krcs.kugou.com/search?ver=1&hash=abc"));
        assert!(lyrics_url_allowed("https://lyrics.kugou.com/download?ver=1&id=1&accesskey=k&fmt=lrc"));
        assert!(lyrics_url_allowed("https://api.lyrics.ovh/v1/The%20Weeknd/Blinding%20Lights"));

        assert!(!lyrics_url_allowed("http://lrclib.net/api/get?q=x"));
        assert!(!lyrics_url_allowed("https://lrclib.net/api/publish"));
        assert!(!lyrics_url_allowed("https://genius.com/artists/x"));
        assert!(!lyrics_url_allowed("https://genius.com/a/b-lyrics"));
        assert!(!lyrics_url_allowed("https://genius.com.evil.com/x-lyrics"));
        assert!(!lyrics_url_allowed("https://music.163.com/api/login"));
        assert!(!lyrics_url_allowed("https://c.y.qq.com/evil"));
        assert!(!lyrics_url_allowed("https://api.lyrics.ovh/v2/artist/title"));
        assert!(!lyrics_url_allowed("https://evil.com/api/get"));
        assert!(!lyrics_url_allowed("https://user@lrclib.net/api/get"));
        assert!(!lyrics_url_allowed("https://lrclib.net:8443/api/get"));
        assert!(!lyrics_url_allowed("https://api.lyrics.ovh/v1/artist/%2e%2e/secret"));
        assert!(!lyrics_url_allowed("https://api.lyrics.ovh/v1/artist/%2E%2E/secret"));
        assert!(!lyrics_url_allowed("https://genius.com/foo%2fbar-lyrics"));
        assert!(!lyrics_url_allowed("https://genius.com/foo%2Fbar-lyrics"));
        assert!(!lyrics_url_allowed("https://genius.com/foo%5cbar-lyrics"));
        assert!(!lyrics_url_allowed("https://api.lyrics.ovh/v1/a%5Cb"));
    }

    #[test]
    fn validates_gemini_key_strictly() {
        assert_eq!(validate_gemini_key("  AIzaSyTest123-_  ").unwrap(), "AIzaSyTest123-_");
        assert!(validate_gemini_key("").is_err());
        assert!(validate_gemini_key("AIza bad space").is_err());
        assert!(validate_gemini_key("AIza\nheader-inject").is_err());
        assert!(validate_gemini_key(&"x".repeat(300)).is_err());
    }
}
