//! api-v2, the site's own API: `https://api-v2.soundcloud.com` with the public `client_id` in the
//! query and the key as `Authorization: OAuth …`, sent like soundcloud.com sends it.

use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use url::Url;

use super::client_id::Ids;
use super::ScUser;
use crate::http::Http;

pub const API_BASE: &str = "https://api-v2.soundcloud.com";
const SITE_ORIGIN: &str = "https://soundcloud.com";
const SITE_REFERER: &str = "https://soundcloud.com/";
/// What a sign-in or a request says when SoundCloud does not answer (blocked without a VPN).
pub const UNREACHABLE: &str = "SoundCloud не отвечает — без VPN он в России не играет";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScError {
    SignedOut,
    Http { status: u16 },
    Network { message: String },
    Invalid { message: String },
}

fn invalid(message: &str) -> ScError {
    ScError::Invalid { message: message.to_string() }
}

/// `path_and_query` on api-v2, with our `client_id` as the only one.
pub fn api_url(path_and_query: &str, client_id: &str) -> Result<Url, ScError> {
    if !path_and_query.starts_with('/') || path_and_query.starts_with("//") {
        return Err(invalid("bad path"));
    }
    let path = path_and_query.split('?').next().unwrap_or_default();
    if path.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err(invalid("bad path"));
    }
    let mut url = Url::parse(&format!("{API_BASE}{path_and_query}")).map_err(|_| invalid("bad path"))?;
    if url.host_str() != Some("api-v2.soundcloud.com") {
        return Err(invalid("bad path"));
    }
    let kept: Vec<(String, String)> = url.query_pairs().into_owned().filter(|(k, _)| k != "client_id").collect();
    url.query_pairs_mut().clear().extend_pairs(kept).append_pair("client_id", client_id);
    Ok(url)
}

/// One request with the key. A 2xx without a body (a like) is `Value::Null`.
pub async fn send(http: &Http, method: Method, url: Url, token: &str) -> Result<Value, ScError> {
    let resp = http
        .client
        .request(method, url)
        .header(reqwest::header::USER_AGENT, http.user_agent())
        .header(reqwest::header::ORIGIN, SITE_ORIGIN)
        .header(reqwest::header::REFERER, SITE_REFERER)
        .header(reqwest::header::AUTHORIZATION, format!("OAuth {token}"))
        .send()
        .await
        .map_err(|e| ScError::Network { message: e.without_url().to_string() })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(ScError::Http { status: status.as_u16() });
    }
    let bytes = resp.bytes().await.map_err(|e| ScError::Network { message: e.without_url().to_string() })?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid("not json"))
}

pub fn user_from_me(v: &Value) -> Option<ScUser> {
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    Some(ScUser { id: v.get("id")?.as_i64()?, name: text("username").unwrap_or_default(), avatar: text("avatar_url"), permalink: text("permalink_url") })
}

pub async fn me_with(http: &Http, ids: &Ids, token: &str) -> Result<ScUser, ScError> {
    let v = send(http, Method::GET, api_url("/me", &ids.client_id)?, token).await?;
    user_from_me(&v).ok_or_else(|| invalid("no profile"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_url_puts_our_client_id_once() {
        let url = api_url("/stream?limit=20&client_id=OLD&cursor=x", "NEW").unwrap();
        assert_eq!(url.host_str(), Some("api-v2.soundcloud.com"));
        assert_eq!(url.path(), "/stream");
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert!(pairs.contains(&("limit".to_string(), "20".to_string())));
        assert!(pairs.contains(&("cursor".to_string(), "x".to_string())));
        assert_eq!(pairs.iter().filter(|(k, _)| k == "client_id").collect::<Vec<_>>(), [&("client_id".to_string(), "NEW".to_string())]);
    }

    #[test]
    fn api_url_refuses_odd_paths() {
        for bad in ["//evil.com/x", "/a/../me", "stream", ""] {
            assert!(matches!(api_url(bad, "C"), Err(ScError::Invalid { .. })), "{bad}");
        }
    }

    #[test]
    fn user_from_me_maps_the_profile() {
        let v = serde_json::json!({ "id": 5, "username": "u", "avatar_url": "https://i1.sndcdn.com/a-large.jpg", "permalink_url": "https://soundcloud.com/u" });
        assert_eq!(
            user_from_me(&v),
            Some(ScUser { id: 5, name: "u".to_string(), avatar: Some("https://i1.sndcdn.com/a-large.jpg".to_string()), permalink: Some("https://soundcloud.com/u".to_string()) })
        );
        assert_eq!(user_from_me(&serde_json::json!({ "username": "u" })), None);
    }
}
