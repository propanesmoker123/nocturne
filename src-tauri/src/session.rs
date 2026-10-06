//! VK web session. A dedicated `vk-session` webview keeps the vk.ru cookies. The web token
//! is requested *inside* that page (`login.vk.ru/?act=web_token`, exactly like vk.ru does);
//! the script parks the response under a one-time key in page memory and Rust collects it
//! with `eval_with_callback` (no navigation, so the page is never disturbed). The token
//! lives only in Rust memory.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;

pub const SESSION_LABEL: &str = "vk-session";
const IDLE_URL: &str = "https://vk.ru/robots.txt";
const LOGIN_URL: &str = "https://vk.ru/";
/// Covers the parked page (robots.txt) while VK's login page is still loading.
const LOADING_SCRIPT: &str = r#"document.documentElement.innerHTML = '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1c1c1e;color:#98989f;font:15px/1.4 Segoe UI,sans-serif">Открываем страницу входа VK…</body>'"#;
const WEB_APP_ID: u32 = 6287487;
/// A page reload of the same URL re-checks the session at most this often.
const PAGE_RECHECK: Duration = Duration::from_secs(4);
/// Hard floor between two web_token requests, whatever triggers them.
const REFRESH_SPACING: Duration = Duration::from_secs(2);
const POLL_EVERY: Duration = Duration::from_millis(150);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(15);
/// How long one script round trip into the session page may take.
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);
/// Extra attempts after a failure that is not VK saying "unauthorized".
const TRANSIENT_RETRIES: [Duration; 2] = [Duration::from_millis(1500), Duration::from_secs(4)];

/// Journal entry for the session flow. Never pass tokens, queries or fragments.
macro_rules! trace {
    ($($arg:tt)*) => {
        crate::journal::write("session", &format!($($arg)*))
    };
}

fn redact(url: &Url) -> String {
    format!("{}://{}{}", url.scheme(), url.host_str().unwrap_or("?"), url.path())
}

#[derive(Clone, Debug, PartialEq)]
pub struct WebToken {
    pub access_token: String,
    pub expires: i64,
    pub user_id: i64,
}

#[derive(Debug, PartialEq)]
pub enum SessionMsgError {
    Malformed(String),
    /// The page could not run the request (network/CORS).
    Script(String),
    /// login.vk.ru answered without a token (not logged in, captcha, …).
    Rejected(String),
}

#[derive(Deserialize)]
struct Parked {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    body: Option<serde_json::Value>,
}

/// Parses what the poll script returned: `None` while the request is still in flight.
pub fn parse_poll_result(raw: &str) -> Option<Result<WebToken, SessionMsgError>> {
    let raw = raw.trim();
    if raw.is_empty() || raw == "null" {
        return None;
    }
    let parked: Parked = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return Some(Err(SessionMsgError::Malformed(e.to_string()))),
    };
    if !parked.ok {
        return Some(Err(SessionMsgError::Script(parked.error.unwrap_or_default())));
    }
    let body = parked.body.unwrap_or(serde_json::Value::Null);
    if body.get("type").and_then(|t| t.as_str()) != Some("okay") {
        let info = body.get("error_info").or_else(|| body.get("error")).map(|v| v.to_string()).unwrap_or_else(|| body.to_string());
        return Some(Err(SessionMsgError::Rejected(info)));
    }
    let data = &body["data"];
    match (data["access_token"].as_str(), data["expires"].as_i64(), data["user_id"].as_i64()) {
        (Some(token), Some(expires), Some(user_id)) if !token.is_empty() => Some(Ok(WebToken { access_token: token.to_string(), expires, user_id })),
        _ => Some(Err(SessionMsgError::Rejected("okay response without a token".to_string()))),
    }
}

/// Does a failed refresh mean the VK session is gone (as opposed to a transient failure)?
pub fn is_signed_out(err: &str) -> bool {
    err.starts_with("Rejected(")
}

/// Lets only genuine page loads (Started → Finished) trigger a session check, and not more
/// than once per `PAGE_RECHECK` for the same URL. WebView2 reports a spurious "Finished"
/// without "Started" after cancelled navigations; those must never trigger anything.
#[derive(Default)]
pub struct PageLoadGate {
    started: Option<String>,
    last: Option<(String, Instant)>,
}

impl PageLoadGate {
    pub fn started(&mut self, url: &str) {
        self.started = Some(url.to_string());
    }

    pub fn finished(&mut self, url: &str, now: Instant) -> bool {
        if self.started.as_deref() != Some(url) {
            return false;
        }
        self.started = None;
        if let Some((last_url, at)) = &self.last {
            if last_url == url && now.saturating_duration_since(*at) < PAGE_RECHECK {
                return false;
            }
        }
        self.last = Some((url.to_string(), now));
        true
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

pub struct SessionState {
    token: Mutex<Option<WebToken>>,
    phase: Mutex<Phase>,
    gate: Mutex<PageLoadGate>,
    last_refresh: tokio::sync::Mutex<Option<Instant>>,
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            token: Mutex::new(None),
            phase: Mutex::new(Phase::Pending),
            gate: Mutex::new(PageLoadGate::default()),
            last_refresh: tokio::sync::Mutex::new(None),
        }
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

/// Starts the token request in the page and parks the answer under `nonce`.
fn token_script(nonce: &str) -> String {
    format!(
        r#"(() => {{
  const box = (window.__nocturne = window.__nocturne || {{}});
  fetch('https://login.vk.ru/?act=web_token', {{
    method: 'POST', credentials: 'include',
    headers: {{ 'Content-Type': 'application/x-www-form-urlencoded' }},
    body: 'version=1&app_id={app}'
  }})
    .then((r) => r.json())
    .then((body) => {{ box['{nonce}'] = {{ ok: true, body }}; }})
    .catch((e) => {{ box['{nonce}'] = {{ ok: false, error: String(e) }}; }});
  return true;
}})()"#,
        app = WEB_APP_ID,
        nonce = nonce
    )
}

/// Returns the parked answer (and forgets it) or null while it is not there yet.
fn poll_script(nonce: &str) -> String {
    format!(
        r#"(() => {{
  const box = window.__nocturne;
  const r = box && box['{nonce}'];
  if (!r) return null;
  delete box['{nonce}'];
  return r;
}})()"#,
        nonce = nonce
    )
}

/// Creates the hidden session window. Called once from setup.
pub fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let load_app = app.clone();
    WebviewWindowBuilder::new(app, SESSION_LABEL, WebviewUrl::External(IDLE_URL.parse().expect("idle url")))
        .title("Вход в VK — Nocturne")
        .inner_size(480.0, 760.0)
        .resizable(true)
        .visible(false)
        .center()
        .on_page_load(move |window, payload| {
            let url = payload.url();
            trace!("page load {:?} {}", payload.event(), redact(url));
            let st = load_app.state::<SessionState>();
            let Ok(mut gate) = st.gate.lock() else { return };
            match payload.event() {
                PageLoadEvent::Started => gate.started(url.as_str()),
                PageLoadEvent::Finished => {
                    if gate.finished(url.as_str(), Instant::now()) {
                        drop(gate);
                        on_page_loaded(&load_app, &window, url);
                    }
                }
            }
        })
        .build()
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
        // A busy WebView (app start, slow PC) can miss the eval deadline; only VK saying
        // "unauthorized" means there is no session, so give hiccups a couple more tries.
        let mut result = refresh(&app).await;
        for delay in TRANSIENT_RETRIES {
            match &result {
                Err(e) if !is_signed_out(e) => {
                    tokio::time::sleep(delay).await;
                    result = refresh(&app).await;
                }
                _ => break,
            }
        }
        let st = app.state::<SessionState>();
        match result {
            Ok(_) => {
                if visible {
                    trace!("signed in, closing the login window");
                }
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
            Err(e) if !visible => {
                trace!("no VK session ({e}), showing the login screen");
                st.set_phase(Phase::None);
                let _ = app.emit("session:logged-out", ());
            }
            Err(e) => trace!("login window: not signed in yet ({e})"),
        }
    });
}

async fn eval_value(window: &WebviewWindow, script: String) -> Result<String, String> {
    let (tx, rx) = oneshot::channel::<String>();
    let slot = Mutex::new(Some(tx));
    window
        .eval_with_callback(script, move |raw| {
            if let Some(tx) = slot.lock().ok().and_then(|mut g| g.take()) {
                let _ = tx.send(raw);
            }
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(EVAL_TIMEOUT, rx).await.map_err(|_| "eval timeout".to_string())?.map_err(|_| "eval dropped".to_string())
}

/// Requests a fresh web token through the session page. Serialized and spaced out so a
/// misbehaving trigger can never hammer login.vk.ru.
pub async fn refresh(app: &AppHandle) -> Result<WebToken, String> {
    let st = app.state::<SessionState>();
    let mut last = st.last_refresh.lock().await;
    let wait = crate::vk::wait_before(*last, Instant::now(), REFRESH_SPACING);
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    *last = Some(Instant::now());

    let window = app.get_webview_window(SESSION_LABEL).ok_or("session window missing")?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let res = match eval_value(&window, token_script(&nonce)).await {
        Err(e) => Err(e),
        Ok(_) => {
            let deadline = Instant::now() + REFRESH_TIMEOUT;
            loop {
                tokio::time::sleep(POLL_EVERY).await;
                if Instant::now() > deadline {
                    break Err("timeout".to_string());
                }
                let raw = match eval_value(&window, poll_script(&nonce)).await {
                    Ok(raw) => raw,
                    Err(e) => break Err(e),
                };
                if let Some(r) = parse_poll_result(&raw) {
                    break r.map_err(|e| format!("{e:?}"));
                }
            }
        }
    };
    drop(last);

    match &res {
        Ok(t) => trace!("token ok (expires in {}s)", t.expires - now_secs()),
        Err(e) => trace!("token failed: {e}"),
    }
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
    match refresh(app).await {
        Ok(t) => Ok(t.access_token),
        Err(e) => {
            if is_signed_out(&e) {
                st.invalidate();
                st.set_phase(Phase::None);
                let _ = app.emit("session:logged-out", ());
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub fn session_status(st: tauri::State<'_, SessionState>) -> SessionStatus {
    st.status()
}

#[tauri::command]
pub fn session_login(app: AppHandle) -> Result<(), String> {
    trace!("login requested");
    let w = app.get_webview_window(SESSION_LABEL).ok_or("session window missing")?;
    let _ = w.eval(LOADING_SCRIPT);
    w.navigate(LOGIN_URL.parse().expect("login url")).map_err(|e| e.to_string())?;
    w.center().ok();
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().ok();
    Ok(())
}

#[tauri::command]
pub async fn session_logout(app: AppHandle) -> Result<(), String> {
    trace!("signing out and clearing VK cookies");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_while_nothing_is_parked() {
        assert_eq!(parse_poll_result("null"), None);
        assert_eq!(parse_poll_result(""), None);
    }

    #[test]
    fn parses_an_okay_token_response() {
        let raw = r#"{"ok":true,"body":{"type":"okay","data":{"access_token":"tok","expires":1791268053,"user_id":42,"logout_hash":"h"}}}"#;
        assert_eq!(parse_poll_result(raw), Some(Ok(WebToken { access_token: "tok".into(), expires: 1791268053, user_id: 42 })));
    }

    #[test]
    fn maps_error_bodies_to_rejected() {
        let raw = r#"{"ok":true,"body":{"type":"error","error_info":"unauthorized"}}"#;
        assert!(matches!(parse_poll_result(raw), Some(Err(SessionMsgError::Rejected(_)))));
    }

    #[test]
    fn maps_script_failures() {
        let raw = r#"{"ok":false,"error":"TypeError: Failed to fetch"}"#;
        assert_eq!(parse_poll_result(raw), Some(Err(SessionMsgError::Script("TypeError: Failed to fetch".into()))));
    }

    #[test]
    fn reports_malformed_payloads() {
        assert!(matches!(parse_poll_result("{broken"), Some(Err(SessionMsgError::Malformed(_)))));
    }

    #[test]
    fn okay_without_token_is_rejected() {
        let raw = r#"{"ok":true,"body":{"type":"okay","data":{"user_id":42}}}"#;
        assert!(matches!(parse_poll_result(raw), Some(Err(SessionMsgError::Rejected(_)))));
    }

    #[test]
    fn rejected_refresh_means_signed_out() {
        assert!(is_signed_out(&format!("{:?}", SessionMsgError::Rejected("\"unauthorized\"".into()))));
    }

    #[test]
    fn transient_failures_do_not_sign_out() {
        assert!(!is_signed_out("timeout"));
        assert!(!is_signed_out(&format!("{:?}", SessionMsgError::Script("TypeError: Failed to fetch".into()))));
        assert!(!is_signed_out("eval timeout"));
    }

    #[test]
    fn gate_ignores_finished_without_started() {
        let mut g = PageLoadGate::default();
        assert!(!g.finished("https://vk.ru/robots.txt", Instant::now()));
    }

    #[test]
    fn gate_allows_a_genuine_load_once() {
        let mut g = PageLoadGate::default();
        let t0 = Instant::now();
        g.started("https://vk.ru/robots.txt");
        assert!(g.finished("https://vk.ru/robots.txt", t0));
        // WebView2's spurious Finished after a cancelled navigation:
        assert!(!g.finished("https://vk.ru/robots.txt", t0 + Duration::from_millis(50)));
    }

    #[test]
    fn gate_rate_limits_reloads_of_the_same_url() {
        let mut g = PageLoadGate::default();
        let t0 = Instant::now();
        g.started("https://vk.ru/feed");
        assert!(g.finished("https://vk.ru/feed", t0));
        g.started("https://vk.ru/feed");
        assert!(!g.finished("https://vk.ru/feed", t0 + Duration::from_secs(1)));
        g.started("https://vk.ru/feed");
        assert!(g.finished("https://vk.ru/feed", t0 + Duration::from_secs(5)));
    }

    #[test]
    fn gate_lets_a_different_url_through_immediately() {
        let mut g = PageLoadGate::default();
        let t0 = Instant::now();
        g.started("https://vk.ru/");
        assert!(g.finished("https://vk.ru/", t0));
        g.started("https://vk.ru/feed");
        assert!(g.finished("https://vk.ru/feed", t0 + Duration::from_millis(300)));
    }
}
