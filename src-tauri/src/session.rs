//! VK web session. A dedicated `vk-session` webview keeps the vk.ru cookies. The web token
//! is requested *inside* that page (`login.vk.ru/?act=web_token`, exactly like vk.ru does)
//! and handed back by navigating to `https://nocturne.invalid/session#<json>`, which
//! `on_navigation` intercepts and cancels. The token lives only in Rust memory.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;

pub const SESSION_LABEL: &str = "vk-session";
pub const MESSAGE_HOST: &str = "nocturne.invalid";
const IDLE_URL: &str = "https://vk.ru/robots.txt";
const LOGIN_URL: &str = "https://vk.ru/";
const WEB_APP_ID: u32 = 6287487;

#[derive(Clone, Debug, PartialEq)]
pub struct WebToken {
    pub access_token: String,
    pub expires: i64,
    pub user_id: i64,
}

#[derive(Debug, PartialEq)]
pub enum SessionMsgError {
    /// The message was not produced by our current request (ignored, request keeps waiting).
    NonceMismatch,
    Malformed(String),
    /// The page could not run the request (network/CORS).
    Script(String),
    /// login.vk.ru answered without a token (not logged in, captcha, …).
    Rejected(String),
}

/// Parses the navigation that carries the token response. `None` = not our message.
pub fn parse_session_message(url: &Url, nonce: &str) -> Option<Result<WebToken, SessionMsgError>> {
    if url.host_str() != Some(MESSAGE_HOST) {
        return None;
    }
    let raw = url.fragment().unwrap_or("");
    let decoded = match urlencoding::decode(raw) {
        Ok(s) => s.into_owned(),
        Err(e) => return Some(Err(SessionMsgError::Malformed(e.to_string()))),
    };
    let env: Envelope = match serde_json::from_str(&decoded) {
        Ok(v) => v,
        Err(e) => return Some(Err(SessionMsgError::Malformed(e.to_string()))),
    };
    if env.nonce != nonce {
        return Some(Err(SessionMsgError::NonceMismatch));
    }
    if !env.ok {
        return Some(Err(SessionMsgError::Script(env.error.unwrap_or_default())));
    }
    let body = env.body.unwrap_or(serde_json::Value::Null);
    if body.get("type").and_then(|t| t.as_str()) != Some("okay") {
        let info = body.get("error_info").or_else(|| body.get("error")).map(|v| v.to_string()).unwrap_or_else(|| body.to_string());
        return Some(Err(SessionMsgError::Rejected(info)));
    }
    let data = &body["data"];
    match (data["access_token"].as_str(), data["expires"].as_i64(), data["user_id"].as_i64()) {
        (Some(token), Some(expires), Some(user_id)) if !token.is_empty() => {
            Some(Ok(WebToken { access_token: token.to_string(), expires, user_id }))
        }
        _ => Some(Err(SessionMsgError::Rejected("okay response without a token".to_string()))),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Pending,
    None,
    Ready,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub state: Phase,
    pub user_id: Option<i64>,
}

struct Pending {
    nonce: String,
    tx: oneshot::Sender<Result<WebToken, SessionMsgError>>,
}

pub struct SessionState {
    token: Mutex<Option<WebToken>>,
    phase: Mutex<Phase>,
    pending: Mutex<Option<Pending>>,
    refresh_lock: tokio::sync::Mutex<()>,
}

impl SessionState {
    pub fn new() -> Self {
        Self { token: Mutex::new(None), phase: Mutex::new(Phase::Pending), pending: Mutex::new(None), refresh_lock: tokio::sync::Mutex::new(()) }
    }

    fn valid_token(&self, margin_secs: i64) -> Option<String> {
        let g = self.token.lock().ok()?;
        let t = g.as_ref()?;
        (t.expires - now_secs() > margin_secs).then(|| t.access_token.clone())
    }

    pub fn invalidate(&self) {
        if let Ok(mut g) = self.token.lock() {
            *g = None;
        }
    }

    fn set_phase(&self, p: Phase) {
        if let Ok(mut g) = self.phase.lock() {
            *g = p;
        }
    }

    pub fn status(&self) -> SessionStatus {
        let state = self.phase.lock().map(|g| *g).unwrap_or(Phase::None);
        let user_id = self.token.lock().ok().and_then(|g| g.as_ref().map(|t| t.user_id));
        SessionStatus { state, user_id }
    }
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn token_script(nonce: &str) -> String {
    format!(
        r#"(async () => {{
  const send = (p) => {{ location.href = 'https://{host}/session#' + encodeURIComponent(JSON.stringify(p)); }};
  try {{
    const r = await fetch('https://login.vk.ru/?act=web_token', {{
      method: 'POST', credentials: 'include',
      headers: {{ 'Content-Type': 'application/x-www-form-urlencoded' }},
      body: 'version=1&app_id={app}'
    }});
    send({{ nonce: '{nonce}', ok: true, body: await r.json() }});
  }} catch (e) {{
    send({{ nonce: '{nonce}', ok: false, error: String(e) }});
  }}
}})();"#,
        host = MESSAGE_HOST,
        app = WEB_APP_ID,
        nonce = nonce
    )
}

/// Creates the hidden session window. Called once from setup.
pub fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let load_app = app.clone();
    WebviewWindowBuilder::new(app, SESSION_LABEL, WebviewUrl::External(IDLE_URL.parse().expect("idle url")))
        .title("Вход в VK — Nocturne")
        .inner_size(480.0, 760.0)
        .resizable(true)
        .visible(false)
        .center()
        .on_navigation(move |url| on_navigation(&nav_app, url))
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                on_page_loaded(&load_app, &window, payload.url());
            }
        })
        .build()
}

fn on_navigation(app: &AppHandle, url: &Url) -> bool {
    if url.host_str() != Some(MESSAGE_HOST) {
        return true;
    }
    let st = app.state::<SessionState>();
    let Ok(mut slot) = st.pending.lock() else { return false };
    if let Some(p) = slot.take() {
        match parse_session_message(url, &p.nonce) {
            Some(Err(SessionMsgError::NonceMismatch)) | None => *slot = Some(p),
            Some(res) => {
                let _ = p.tx.send(res);
            }
        }
    }
    false
}

fn is_vk_page(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("vk.ru")
}

fn on_page_loaded(app: &AppHandle, window: &WebviewWindow, url: &Url) {
    if !is_vk_page(url) || url.path().starts_with("/login") || url.path().starts_with("/join") {
        return;
    }
    let st = app.state::<SessionState>();
    if st.valid_token(120).is_some() && url.as_str() == IDLE_URL {
        return;
    }
    let app = app.clone();
    let visible = window.is_visible().unwrap_or(false);
    tauri::async_runtime::spawn(async move {
        let result = refresh(&app).await;
        let st = app.state::<SessionState>();
        match result {
            Ok(_) => {
                if let Some(w) = app.get_webview_window(SESSION_LABEL) {
                    let _ = w.hide();
                    if w.url().map(|u| u.as_str() != IDLE_URL).unwrap_or(true) {
                        let _ = w.navigate(IDLE_URL.parse().expect("idle url"));
                    }
                }
                if let Some(m) = app.get_webview_window("main") {
                    let _ = m.set_focus();
                }
            }
            Err(_) if !visible => {
                st.set_phase(Phase::None);
                let _ = app.emit("session:logged-out", ());
            }
            Err(_) => {}
        }
    });
}

/// Requests a fresh web token through the session page. Serialized by `refresh_lock`.
pub async fn refresh(app: &AppHandle) -> Result<WebToken, String> {
    let st = app.state::<SessionState>();
    let _guard = st.refresh_lock.lock().await;
    let window = app.get_webview_window(SESSION_LABEL).ok_or("session window missing")?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = oneshot::channel();
    st.pending.lock().map_err(|_| "poisoned")?.replace(Pending { nonce: nonce.clone(), tx });
    window.eval(token_script(&nonce)).map_err(|e| e.to_string())?;
    let res = match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(r)) => r.map_err(|e| format!("{e:?}")),
        Ok(Err(_)) => Err("cancelled".to_string()),
        Err(_) => {
            st.pending.lock().ok().and_then(|mut g| g.take());
            Err("timeout".to_string())
        }
    };
    if let Ok(tok) = &res {
        let was_ready = st.status().state == Phase::Ready;
        if let Ok(mut g) = st.token.lock() {
            *g = Some(tok.clone());
        }
        st.set_phase(Phase::Ready);
        if !was_ready {
            let _ = app.emit("session:ready", serde_json::json!({ "userId": tok.user_id }));
        }
    }
    res
}

/// Returns a token valid for at least 90 more seconds, refreshing if needed.
pub async fn get_token(app: &AppHandle) -> Result<String, String> {
    let st = app.state::<SessionState>();
    if let Some(t) = st.valid_token(90) {
        return Ok(t);
    }
    if st.status().state == Phase::None {
        return Err("not logged in".to_string());
    }
    if let Some(t) = st.valid_token(90) {
        return Ok(t);
    }
    refresh(app).await.map(|t| t.access_token)
}

#[tauri::command]
pub fn session_status(st: tauri::State<'_, SessionState>) -> SessionStatus {
    st.status()
}

#[tauri::command]
pub fn session_login(app: AppHandle) -> Result<(), String> {
    let w = app.get_webview_window(SESSION_LABEL).ok_or("session window missing")?;
    w.navigate(LOGIN_URL.parse().expect("login url")).map_err(|e| e.to_string())?;
    w.center().ok();
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().ok();
    Ok(())
}

#[tauri::command]
pub async fn session_logout(app: AppHandle) -> Result<(), String> {
    let st = app.state::<SessionState>();
    st.invalidate();
    st.set_phase(Phase::None);
    if let Some(w) = app.get_webview_window(SESSION_LABEL) {
        w.clear_all_browsing_data().map_err(|e| e.to_string())?;
        let _ = w.navigate(IDLE_URL.parse().expect("idle url"));
    }
    let _ = app.emit("session:logged-out", ());
    Ok(())
}

#[derive(Deserialize)]
struct Envelope {
    nonce: String,
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    body: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(json: &str) -> Url {
        Url::parse(&format!("https://nocturne.invalid/session#{}", urlencoding::encode(json))).unwrap()
    }

    #[test]
    fn ignores_other_hosts() {
        assert_eq!(parse_session_message(&Url::parse("https://vk.ru/feed").unwrap(), "n1"), None);
    }

    #[test]
    fn parses_an_okay_token_response() {
        let url = msg(r#"{"nonce":"n1","ok":true,"body":{"type":"okay","data":{"access_token":"tok","expires":1791268053,"user_id":42,"logout_hash":"h"}}}"#);
        assert_eq!(
            parse_session_message(&url, "n1"),
            Some(Ok(WebToken { access_token: "tok".into(), expires: 1791268053, user_id: 42 }))
        );
    }

    #[test]
    fn rejects_a_foreign_nonce() {
        let url = msg(r#"{"nonce":"other","ok":true,"body":{"type":"okay","data":{"access_token":"tok","expires":1,"user_id":1}}}"#);
        assert_eq!(parse_session_message(&url, "n1"), Some(Err(SessionMsgError::NonceMismatch)));
    }

    #[test]
    fn maps_error_bodies_to_rejected() {
        let url = msg(r#"{"nonce":"n1","ok":true,"body":{"type":"error","error_code":5,"error_info":"not authorized"}}"#);
        assert!(matches!(parse_session_message(&url, "n1"), Some(Err(SessionMsgError::Rejected(_)))));
    }

    #[test]
    fn maps_script_failures() {
        let url = msg(r#"{"nonce":"n1","ok":false,"error":"TypeError: Failed to fetch"}"#);
        assert_eq!(parse_session_message(&url, "n1"), Some(Err(SessionMsgError::Script("TypeError: Failed to fetch".into()))));
    }

    #[test]
    fn reports_malformed_payloads() {
        let url = Url::parse("https://nocturne.invalid/session#%7Bbroken").unwrap();
        assert!(matches!(parse_session_message(&url, "n1"), Some(Err(SessionMsgError::Malformed(_)))));
    }

    #[test]
    fn okay_without_token_is_rejected() {
        let url = msg(r#"{"nonce":"n1","ok":true,"body":{"type":"okay","data":{"user_id":42}}}"#);
        assert!(matches!(parse_session_message(&url, "n1"), Some(Err(SessionMsgError::Rejected(_)))));
    }
}
