//! SoundCloud's public web client id (and its app id): not secrets, the site hands them to every
//! visitor in its scripts. Found there when needed, remembered in `sc-ids.json` with this
//! install's anonymous device id; a built-in pair covers a first start without soundcloud.com.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::http::Http;

pub const SAVED_FILE: &str = "sc-ids.json";
const SITE: &str = "https://soundcloud.com/";
const ASSETS: &str = "https://a-v2.sndcdn.com/assets/";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ids {
    pub client_id: String,
    pub app_id: String,
}

/// The site's pair on 18.10.2026.
pub fn fallback() -> Ids {
    Ids { client_id: "tHVbSbDP4TaoMbPppngv6Tdry83vNbMQ".to_string(), app_id: "46941".to_string() }
}

/// `client_application_id:<digits>,client_id:"<letters and digits>"` in one of the site's scripts.
pub fn find_ids(js: &str) -> Option<Ids> {
    const APP: &str = "client_application_id:";
    const CLIENT: &str = ",client_id:\"";
    let mut rest = js;
    while let Some(at) = rest.find(APP) {
        let after = &rest[at + APP.len()..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        let tail = &after[digits.len()..];
        if !digits.is_empty() && tail.starts_with(CLIENT) {
            let id_part = &tail[CLIENT.len()..];
            let id: String = id_part.chars().take_while(char::is_ascii_alphanumeric).collect();
            if !id.is_empty() && id_part[id.len()..].starts_with('"') {
                return Some(Ids { client_id: id, app_id: digits });
            }
        }
        rest = after;
    }
    None
}

/// The site's own scripts, in page order, each once.
pub fn script_urls(html: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in html.split("src=\"").skip(1) {
        let Some(end) = part.find('"') else { continue };
        let url = &part[..end];
        if url.starts_with(ASSETS) && url.ends_with(".js") && !out.iter().any(|u| u == url) {
            out.push(url.to_string());
        }
    }
    out
}

async fn get_text(http: &Http, url: &str) -> Result<String, String> {
    let resp = http
        .client
        .get(url)
        .header(reqwest::header::USER_AGENT, http.user_agent())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|e| e.without_url().to_string())
}

/// Reads the pair off soundcloud.com (it sat near the end of the script list in October 2026).
pub async fn discover(http: &Http) -> Result<Ids, String> {
    let html = get_text(http, SITE).await?;
    for url in script_urls(&html).iter().rev() {
        if let Ok(js) = get_text(http, url).await {
            if let Some(ids) = find_ids(&js) {
                return Ok(ids);
            }
        }
    }
    Err("client_id not found".to_string())
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub ids: Option<Ids>,
    pub device_id: Option<String>,
}

pub fn load_saved(path: &Path) -> Saved {
    std::fs::read(path).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default()
}

pub fn save_saved(path: &Path, s: &Saved) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(s).map_err(std::io::Error::other)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_ids_in_the_sites_script() {
        let js = r#"…,o={},client_application_id:46941,client_id:"AbC123xyz",x=1"#;
        assert_eq!(find_ids(js), Some(Ids { client_id: "AbC123xyz".to_string(), app_id: "46941".to_string() }));
    }

    #[test]
    fn no_ids_without_both_parts() {
        assert_eq!(find_ids(r#"x,client_id:"x",y"#), None);
        assert_eq!(find_ids(r#"client_application_id:46941,client_id:"a-b""#), None);
    }

    #[test]
    fn script_urls_keep_page_order() {
        let html = r#"<script crossorigin src="https://a-v2.sndcdn.com/assets/0-a.js"></script>
<script src="https://a-v2.sndcdn.com/assets/50-b.js"></script>
<script src="https://evil.com/x.js"></script>
<script src="https://a-v2.sndcdn.com/assets/0-a.js"></script>"#;
        assert_eq!(script_urls(html), ["https://a-v2.sndcdn.com/assets/0-a.js", "https://a-v2.sndcdn.com/assets/50-b.js"]);
    }

    #[test]
    fn fallback_is_the_known_pair() {
        assert_eq!(fallback(), Ids { client_id: "tHVbSbDP4TaoMbPppngv6Tdry83vNbMQ".to_string(), app_id: "46941".to_string() });
    }

    #[test]
    fn saved_round_trip() {
        let dir = std::env::temp_dir().join(format!("nocturne-sc-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SAVED_FILE);
        assert_eq!(load_saved(&path), Saved::default());
        let s = Saved { ids: Some(fallback()), device_id: Some("111111-222222-333333-444444".to_string()) };
        save_saved(&path, &s).unwrap();
        assert_eq!(load_saved(&path), s);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load_saved(&path), Saved::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
