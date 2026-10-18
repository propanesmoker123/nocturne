//! Writes need the site's browser session, including its own DataDome integration. Keep that
//! session in the sign-in profile; a challenge is shown to the person, never solved by the app.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;

use super::{api::{self, ScError}, login, trace, ScState};

const LABEL: &str = "sc-session";
const SITE: &str = "https://soundcloud.com/";
const DEADLINE: Duration = Duration::from_secs(30);
static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn network() -> ScError {
    ScError::Network { message: "SoundCloud browser request did not finish".to_string() }
}

fn is_site(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("soundcloud.com") && url.port_or_known_default() == Some(443)
}

fn owned_like_path(method: &str, path: &str, me: i64) -> bool {
    if me <= 0 || !api::allowed(method, path) || !matches!(method, "PUT" | "DELETE") || path.contains('?') {
        return false;
    }
    let parts: Vec<_> = path.split('/').collect();
    parts.get(2).and_then(|s| s.parse::<i64>().ok()) == Some(me)
        && parts.get(4).and_then(|s| s.parse::<u64>().ok()).is_some_and(|id| id > 0)
}

fn window(app: &AppHandle) -> Result<WebviewWindow, ScError> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(SITE.parse().expect("site")))
        .title("Проверка SoundCloud — Nocturne")
        .inner_size(960.0, 720.0)
        .center()
        .visible(false)
        .data_directory(login::profile_dir(app).map_err(|_| network())?)
        .on_navigation(is_site)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|_| network())
}

pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
}

async fn eval(w: &WebviewWindow, script: String) -> Result<String, ScError> {
    let (tx, rx) = oneshot::channel();
    let slot = Mutex::new(Some(tx));
    w.eval_with_callback(script, move |raw| {
        if let Some(tx) = slot.lock().ok().and_then(|mut s| s.take()) {
            let _ = tx.send(raw);
        }
    }).map_err(|_| network())?;
    tokio::time::timeout(Duration::from_secs(3), rx).await.map_err(|_| network())?.map_err(|_| network())
}

#[derive(Deserialize, Debug)]
struct Reply {
    status: Option<u16>,
    #[serde(default)]
    captcha: bool,
    #[serde(default)]
    network: bool,
}

#[derive(Deserialize)]
struct Poll {
    reply: Option<Reply>,
    #[serde(default)]
    challenge: bool,
}

fn result(reply: Reply) -> Result<Value, ScError> {
    if reply.network { return Err(network()); }
    match reply.status {
        Some(200..=299) => Ok(Value::Null),
        Some(403) if reply.captcha => Err(ScError::Challenge),
        Some(status) => Err(ScError::Http { status }),
        None => Err(network()),
    }
}

fn progress(poll: Poll) -> Option<Result<Value, ScError>> {
    // The site's fetch wrapper can hold the response until its challenge is completed. Return
    // control now, leaving its UI visible, rather than letting a network timeout mask the captcha.
    if poll.reply.as_ref().is_some_and(|r| matches!(r.status, Some(200..=299))) {
        return Some(Ok(Value::Null));
    }
    if poll.challenge { return Some(Err(ScError::Challenge)); }
    poll.reply.map(result)
}

fn script(args: Value) -> String {
    format!("({})({args})", include_str!("like.js"))
}

async fn send(app: &AppHandle, method: &str, path: &str, token: &str) -> Result<Value, ScError> {
    let w = window(app)?;
    let until = Instant::now() + DEADLINE;
    loop {
        if Instant::now() >= until { close(app); return Err(network()); }
        let ready = match eval(&w, "location.origin === 'https://soundcloud.com' && document.readyState === 'complete'".to_string()).await {
            Ok(ready) => ready,
            Err(e) => { close(app); return Err(e); }
        };
        if ready == "true" { break; }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    // Check both natively and inside the script before handing a service key to its own origin.
    if !w.url().map(|u| is_site(&u)).unwrap_or(false) { return Err(network()); }
    let key = uuid::Uuid::new_v4().simple().to_string();
    let url = api::api_url(path, &app.state::<ScState>().ids().client_id)?;
    let args = json!({ "key": key, "url": url.as_str(), "method": method, "token": token });
    if eval(&w, script(args)).await? != "true" { return Err(network()); }
    let until = Instant::now() + DEADLINE;
    let answer = loop {
        if Instant::now() >= until { break Err(network()); }
        if app.state::<ScState>().token().as_deref() != Some(token) { break Err(ScError::SignedOut); }
        let raw = match eval(&w, script(json!({ "key": key, "poll": true }))).await { Ok(raw) => raw, Err(e) => break Err(e) };
        let poll: Poll = match serde_json::from_str(&raw) { Ok(p) => p, Err(_) => break Err(network()) };
        if let Some(result) = progress(poll) { break result; }
        tokio::time::sleep(Duration::from_millis(150)).await;
    };
    let _ = w.eval(format!("(() => {{ const b = window.__nocturneScLikes; b?.['{key}']?.abort(); if (b) delete b['{key}']; }})()"));
    match &answer {
        Err(ScError::Challenge) => { let _ = w.show(); let _ = w.set_focus(); }
        Ok(_) => { let _ = w.hide(); }
        _ => {}
    }
    answer
}

pub async fn request(app: &AppHandle, method: &str, path: &str) -> Result<Value, ScError> {
    let _one = WRITING.lock().await;
    let st = app.state::<ScState>();
    let me = st.status().user.ok_or(ScError::SignedOut)?.id;
    if !owned_like_path(method, path, me) {
        return Err(ScError::Invalid { message: "request not allowed".to_string() });
    }
    let token = st.token().ok_or(ScError::SignedOut)?;
    let mut answer = send(app, method, path, &token).await;
    if matches!(answer, Err(ScError::Http { status: 401 })) && login::silent(app).await.is_ok() {
        let token = st.token().ok_or(ScError::SignedOut)?;
        if st.status().user.map(|u| u.id) != Some(me) { return Err(ScError::SignedOut); }
        answer = send(app, method, path, &token).await;
    }
    match &answer {
        Err(ScError::Http { status }) => trace!("browser {method} {path}: HTTP {status}"),
        Err(ScError::Challenge) => trace!("browser {method} {path}: challenge"),
        Err(_) => trace!("browser {method} {path}: failed"),
        Ok(_) => trace!("browser {method} {path}: succeeded"),
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_signed_in_users_likes_can_change() {
        assert!(owned_like_path("PUT", "/users/7/track_likes/402", 7));
        assert!(owned_like_path("DELETE", "/users/7/track_likes/402", 7));
        for (method, path, me) in [
            ("PUT", "/users/8/track_likes/402", 7), ("PUT", "/users/0/track_likes/402", 0),
            ("GET", "/users/7/track_likes/402", 7), ("PUT", "/users/7/track_likes/0", 7),
            ("PUT", "/users/7/track_likes/402?x=1", 7), ("PUT", "/users/7/track_likes/402/extra", 7),
        ] { assert!(!owned_like_path(method, path, me), "{method} {path}"); }
    }

    #[test]
    fn service_keys_only_go_to_the_site() {
        for url in ["http://soundcloud.com/", "https://soundcloud.com.evil.test/", "https://soundcloud.com:444/"] {
            assert!(!is_site(&Url::parse(url).unwrap()));
        }
        assert!(is_site(&Url::parse(SITE).unwrap()));
    }

    #[test]
    fn only_a_successful_status_means_a_like_was_changed() {
        let reply = |status, captcha| Reply { status: Some(status), captcha, network: false };
        assert_eq!(result(reply(204, false)), Ok(Value::Null));
        assert_eq!(result(reply(403, true)), Err(ScError::Challenge));
        assert_eq!(result(reply(403, false)), Err(ScError::Http { status: 403 }));
        assert_eq!(result(reply(401, false)), Err(ScError::Http { status: 401 }));
    }

    #[test]
    fn a_visible_challenge_returns_control_before_a_pending_fetch_times_out() {
        assert_eq!(progress(Poll { reply: None, challenge: true }), Some(Err(ScError::Challenge)));
        assert_eq!(progress(Poll { reply: None, challenge: false }), None);
        let network_reply = Reply { status: None, captcha: false, network: true };
        assert_eq!(progress(Poll { reply: Some(network_reply), challenge: true }), Some(Err(ScError::Challenge)));
    }
}
