//! api-v2, the site's own API: `https://api-v2.soundcloud.com` with the public `client_id` in the
//! query and the key as `Authorization: OAuth …`, sent like soundcloud.com sends it.

use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use url::Url;

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::client_id::{self, Ids};
use super::{emit_status, login, store, trace, ScState, ScUser};
use crate::http::Http;

/// The site's ids are looked up again at most this often (a 401 can also mean a dead key).
const REDISCOVER_EVERY: Duration = Duration::from_secs(600);

pub const API_BASE: &str = "https://api-v2.soundcloud.com";
const SITE_ORIGIN: &str = "https://soundcloud.com";
const SITE_REFERER: &str = "https://soundcloud.com/";
/// What a sign-in or a request says when SoundCloud does not answer (blocked without a VPN).
pub const UNREACHABLE: &str = "SoundCloud не отвечает — без VPN он в России не играет";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScError {
    SignedOut,
    Challenge,
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
    url = with_client_id(&url, client_id);
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

fn numeric(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn system_urn(s: &str) -> bool {
    s.strip_prefix("soundcloud:system-playlists:").is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b)))
}

/// The requests the UI may make. Writes run in SoundCloud's own browser session, not reqwest.
pub fn allowed(method: &str, path: &str) -> bool {
    let (path, query) = path.split_once('?').map_or((path, None), |(path, query)| (path, Some(query)));
    let Some(rest) = path.strip_prefix('/') else { return false };
    let segs: Vec<&str> = rest.split('/').collect();
    if let ("POST", ["me", "followings", n]) = (method, segs.as_slice()) {
        // An unsigned app command is signed inside the service browser. If a query is supplied,
        // only one well-formed signature is accepted; arbitrary write parameters remain forbidden.
        return numeric(n) && query.is_none_or(|query| {
            let mut pairs = url::form_urlencoded::parse(query.as_bytes());
            let Some((key, value)) = pairs.next() else { return false };
            let Some(hex) = value.strip_prefix("1:") else { return false };
            key == "signature" && !hex.is_empty() && hex.len() <= 6
                && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && pairs.next().is_none()
        });
    }
    if method != "GET" && query.is_some() { return false; }
    match (method, segs.as_slice()) {
        ("GET", ["me"] | ["me", "library", "all"] | ["mixed-selections"] | ["stream"] | ["tracks"] | ["search"] | ["search", "tracks" | "users" | "playlists"]) => true,
        ("GET", ["tracks", n, "related"] | ["playlists", n] | ["users", n]) => numeric(n),
        ("GET", ["system-playlists", urn]) => system_urn(urn),
        ("GET", ["users", n, "track_likes" | "playlists_without_albums" | "albums" | "toptracks" | "tracks" | "likes"]) => numeric(n),
        ("GET", ["users", n, "followings"] | ["users", n, "followings", "ids"] | ["stream", "users", n, "reposts"] | ["tracks", n, "comments"]) => numeric(n),
        ("PUT" | "DELETE", ["users", user, "track_likes", track]) => numeric(user) && numeric(track),
        ("DELETE", ["me", "followings", n]) => numeric(n),
        _ => false,
    }
}

/// What to try after a 401, in order: the site's id may have changed, then the key may have died.
#[derive(Debug, PartialEq)]
pub enum Step {
    Rediscover,
    Reauth,
    SignOut,
}

#[derive(Default)]
pub struct Unauthorized {
    rediscovered: bool,
    reauthed: bool,
}

impl Unauthorized {
    pub fn next(&mut self) -> Step {
        if !self.rediscovered {
            self.rediscovered = true;
            Step::Rediscover
        } else if !self.reauthed {
            self.reauthed = true;
            Step::Reauth
        } else {
            Step::SignOut
        }
    }
}

/// A 401's last step signs out only the key that failed (not a fresh one another sign-in brought).
pub fn signs_out(current: Option<&str>, failed: &str) -> bool {
    current == Some(failed)
}

fn with_client_id(url: &Url, client_id: &str) -> Url {
    let mut url = url.clone();
    let kept: Vec<(String, String)> = url.query_pairs().into_owned().filter(|(k, _)| k != "client_id").collect();
    url.query_pairs_mut().clear().extend_pairs(kept).append_pair("client_id", client_id);
    url
}

/// New ids from the site, if they differ from ours (at most once per `REDISCOVER_EVERY`).
async fn rediscover(app: &AppHandle) -> bool {
    let st = app.state::<ScState>();
    if let Ok(mut last) = st.rediscovered.lock() {
        if last.is_some_and(|t| t.elapsed() < REDISCOVER_EVERY) {
            return false;
        }
        *last = Some(Instant::now());
    }
    match client_id::discover(&app.state::<Http>()).await {
        Ok(ids) if ids != st.ids() => {
            trace!("SoundCloud changed its client id");
            st.set_ids(ids);
            true
        }
        _ => false,
    }
}

/// A request with the key and the 401 steps. Journals the method, the path and the error only.
pub async fn request_url(app: &AppHandle, method: Method, mut url: Url) -> Result<Value, ScError> {
    let st = app.state::<ScState>();
    let http = app.state::<Http>();
    let mut policy = Unauthorized::default();
    loop {
        let Some(token) = st.token() else { return Err(ScError::SignedOut) };
        match send(&http, method.clone(), url.clone(), &token).await {
            Err(ScError::Http { status: 401 }) => trace!("{method} {}: HTTP 401", super::shown_path(url.path())),
            Err(e) => {
                match &e {
                    ScError::Http { status } => trace!("{method} {}: HTTP {status}", super::shown_path(url.path())),
                    ScError::Network { .. } => trace!("{method} {}: network", super::shown_path(url.path())),
                    _ => trace!("{method} {}: {e:?}", super::shown_path(url.path())),
                }
                return Err(e);
            }
            ok => return ok,
        }
        loop {
            match policy.next() {
                Step::Rediscover => {
                    if rediscover(app).await {
                        url = with_client_id(&url, &st.ids().client_id);
                        break;
                    }
                }
                Step::Reauth => {
                    if login::silent(app, &token).await.is_ok() {
                        break;
                    }
                }
                Step::SignOut => {
                    if signs_out(st.token().as_deref(), &token) {
                        trace!("the key no longer works, signing out");
                        st.set_signed_out();
                        store::clear_token();
                        emit_status(app);
                        return Err(ScError::SignedOut);
                    }
                    // the key changed meanwhile: a new one gets its own try; none — someone signed out
                    if st.token().is_none() {
                        return Err(ScError::SignedOut);
                    }
                    break;
                }
            }
        }
    }
}

pub async fn request(app: &AppHandle, method: &str, path: &str) -> Result<Value, ScError> {
    let m = Method::from_bytes(method.as_bytes()).map_err(|_| invalid("bad method"))?;
    let url = api_url(path, &app.state::<ScState>().ids().client_id)?;
    request_url(app, m, url).await
}

#[tauri::command]
pub async fn sc_api(app: AppHandle, method: String, path: String) -> Result<Value, ScError> {
    if !allowed(&method, &path) {
        return Err(invalid("request not allowed"));
    }
    if method != "GET" {
        return super::web::request(&app, &method, &path).await;
    }
    request(&app, &method, &path).await
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
    fn allowed_follows_the_list() {
        for (m, p) in [
            ("GET", "/me"),
            ("GET", "/stream?limit=5"),
            ("GET", "/users/12/track_likes"),
            ("GET", "/system-playlists/soundcloud:system-playlists:weekly:123"),
            ("GET", "/me/library/all"),
            ("PUT", "/users/1/track_likes/2"),
            ("DELETE", "/users/1/track_likes/2"),
        ] {
            assert!(allowed(m, p), "{m} {p}");
        }
        for (m, p) in [
            ("PUT", "/me"),
            ("PUT", "/users/1/track_likes/abc"),
            ("PUT", "/users/1/track_likes/2?x=1"),
            ("GET", "/users/abc"),
            ("POST", "/users/1/track_likes/2"),
            ("GET", "/oauth/token"),
            ("GET", "/system-playlists/evil"),
            ("GET", "/users/1/track_likes/2/x"),
            ("DELETE", "/stream"),
        ] {
            assert!(!allowed(m, p), "{m} {p}");
        }
    }

    #[test]
    fn the_people_someone_follows_can_be_read() {
        assert!(allowed("GET", "/users/12/followings?limit=50"));
        assert!(allowed("GET", "/users/12/followings?offset=x&limit=50"));
        assert!(!allowed("GET", "/users/x/followings"));
        assert!(!allowed("DELETE", "/users/12/followings"));
    }

    #[test]
    fn profile_and_comment_reads_are_allowed() {
        for p in ["/stream/users/12/reposts?limit=50", "/users/12/likes?limit=50&offset=x", "/users/12/followings/ids?limit=5000", "/tracks/9/comments?threaded=0&filter_replies=1&limit=200"] {
            assert!(allowed("GET", p), "{p}");
        }
        assert!(allowed("DELETE", "/me/followings/12"));
        for (m, p) in [("PUT", "/me/followings/12"), ("DELETE", "/me/followings/x"), ("DELETE", "/me/followings/12?signature=a"), ("GET", "/users/x/likes"), ("GET", "/stream/users/x/reposts")] {
            assert!(!allowed(m, p), "{m} {p}");
        }
    }

    #[test]
    fn only_follow_posts_may_have_a_signature_query() {
        // The UI can omit the signature: the service browser signs it with its actual user agent.
        assert!(allowed("POST", "/me/followings/12"));
        assert!(allowed("POST", "/me/followings/12?signature=1%3A73c1f3"));
        assert!(allowed("POST", "/me/followings/12?signature=1:73c1f3"));
        for (method, path) in [
            ("POST", "/me/followings/x?signature=1:abc"),
            ("POST", "/me/followings/12?signature="),
            ("POST", "/me/followings/12?signature=wrong"),
            ("POST", "/me/followings/12?signature=1:1234567"),
            ("POST", "/me/followings/12?signature=1:abc&signature=1:def"),
            ("POST", "/me/followings/12?signature=1:abc&client_id=other"),
            ("POST", "/me/followings/12?other=1"),
            ("POST", "/me/followings/12?"),
            ("POST", "/me/followings/12/extra?signature=1:abc"),
            ("POST", "/users/7/track_likes/12?signature=1:abc"),
            ("DELETE", "/me/followings/12?signature=1:abc"),
            ("PUT", "/users/7/track_likes/12?signature=1:abc"),
        ] { assert!(!allowed(method, path), "{method} {path}"); }
    }

    #[test]
    fn only_the_key_that_failed_is_signed_out() {
        assert!(signs_out(Some("k"), "k"));
        assert!(!signs_out(Some("k2"), "k"));
        assert!(!signs_out(None, "k"));
    }

    #[test]
    fn unauthorized_goes_rediscover_reauth_signout() {
        let mut u = Unauthorized::default();
        assert_eq!([u.next(), u.next(), u.next(), u.next()], [Step::Rediscover, Step::Reauth, Step::SignOut, Step::SignOut]);
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
