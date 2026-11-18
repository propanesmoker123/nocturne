//! VK web session. A dedicated `vk-session` webview keeps the vk.ru cookies. The web token
//! is requested *inside* that page (`login.vk.ru/?act=web_token`, exactly like vk.ru does);
//! the script parks the response under a one-time key in page memory and Rust collects it
//! with `eval_with_callback` (no navigation, so the page is never disturbed). The token
//! lives only in Rust memory.

use std::sync::atomic::{AtomicBool, Ordering};
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
const POLL_EVERY: Duration = Duration::from_millis(50);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(15);
/// How long one script round trip into the session page may take.
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);
/// Fallback lifetime when VK omits `expires` (VK's own web client treats missing/zero `expires` as unbounded).
const DEFAULT_TOKEN_TTL_SECS: i64 = 900;
/// Extra attempts after a failure that is not VK saying "unauthorized".
const TRANSIENT_RETRIES: [Duration; 3] = [Duration::from_millis(1500), Duration::from_secs(4), Duration::from_secs(10)];
/// VK still answers «try again», or is down, or the network is: the session is not gone, so the
/// app keeps trying — soon at first, then once a minute for as long as it takes (VK has been down
/// for hours) — and only VK saying «unauthorized» shows the login screen.
pub fn patience(round: usize) -> Duration {
    const FIRST: [u64; 3] = [15, 30, 30];
    Duration::from_secs(FIRST.get(round).copied().unwrap_or(60))
}
/// VK's answer that its own web client simply retries (its «too many requests» / a failed check).
const VK_TRY_AGAIN: &str = "check result failure";
/// One patient retry loop at a time: page loads must not multiply requests while VK asks to wait.
static BEING_PATIENT: AtomicBool = AtomicBool::new(false);

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
    /// login.vk.ru asked to try again (VK's own client retries it): the session is still there.
    Busy(String),
}

#[derive(Deserialize)]
struct Parked {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    body: Option<serde_json::Value>,
    #[serde(default)]
    page_user_id: Option<serde_json::Value>,
}

fn parse_i64_loose(v: &serde_json::Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    if let Some(n) = v.as_u64() {
        return i64::try_from(n).ok();
    }
    if let Some(n) = v.as_f64() {
        if n.is_finite() && n >= i64::MIN as f64 && n < 9_223_372_036_854_775_808.0 {
            return Some(n.trunc() as i64);
        }
        return None;
    }
    let s = v.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(n) = s.parse::<i64>() {
        return Some(n);
    }
    let f = s.parse::<f64>().ok()?;
    (f.is_finite() && f >= i64::MIN as f64 && f < 9_223_372_036_854_775_808.0).then_some(f.trunc() as i64)
}

fn normalize_epoch_secs(raw: i64) -> i64 {
    if raw > 1_000_000_000_000 { raw / 1000 } else { raw }
}

fn positive_uid(v: Option<&serde_json::Value>) -> Option<i64> {
    v.and_then(parse_i64_loose).filter(|&id| id > 0)
}

fn extract_expires(obj: &serde_json::Map<String, serde_json::Value>, now: i64) -> i64 {
    for key in ["expires", "expired_at"] {
        if let Some(v) = obj.get(key).and_then(parse_i64_loose).filter(|&n| n > 0) {
            return normalize_epoch_secs(v);
        }
    }
    for key in ["expires_in", "ttl"] {
        if let Some(v) = obj.get(key).and_then(parse_i64_loose).filter(|&n| n > 0) {
            return now.saturating_add(v);
        }
    }
    now.saturating_add(DEFAULT_TOKEN_TTL_SECS)
}

fn extract_from_obj(obj: &serde_json::Map<String, serde_json::Value>, body_uid: Option<i64>, page_uid: Option<i64>, now: i64) -> Option<WebToken> {
    let token = obj
        .get("access_token")
        .or_else(|| obj.get("token"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())?;
    let user_id = positive_uid(obj.get("user_id"))
        .or_else(|| positive_uid(obj.get("uid")))
        .or(body_uid)
        .or(page_uid)
        .unwrap_or(0);
    Some(WebToken { access_token: token.to_string(), expires: extract_expires(obj, now), user_id })
}

fn extract_from_value(v: &serde_json::Value, body_uid: Option<i64>, page_uid: Option<i64>, now: i64) -> Option<WebToken> {
    match v {
        serde_json::Value::Object(obj) => {
            extract_from_obj(obj, body_uid, page_uid, now).or_else(|| obj.get("response").and_then(|r| extract_from_value(r, body_uid, page_uid, now)))
        }
        serde_json::Value::Array(items) => {
            let mut first = None;
            for item in items {
                let Some(obj) = item.as_object() else { continue };
                let Some(tok) = extract_from_obj(obj, body_uid, None, now) else { continue };
                if page_uid.is_some() && Some(tok.user_id) == page_uid {
                    return Some(tok);
                }
                if first.is_none() {
                    first = Some(if tok.user_id > 0 { tok } else { WebToken { user_id: page_uid.unwrap_or(0), ..tok } });
                }
            }
            first
        }
        _ => None,
    }
}

/// Redacted, key-and-type-only summary of a JSON payload for journal diagnostics (never emits values).
fn describe_field(v: &serde_json::Value, depth: usize) -> String {
    match v {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Bool(_) => "bool".into(),
        serde_json::Value::Number(_) => "num".into(),
        serde_json::Value::String(s) => format!("str({})", s.len()),
        serde_json::Value::Array(a) => format!("[{}]", a.len()),
        serde_json::Value::Object(m) => {
            if depth == 0 {
                return format!("obj({})", m.len());
            }
            let fields: Vec<String> = m.iter().take(8).map(|(k, val)| format!("{k}:{}", describe_field(val, depth - 1))).collect();
            let suffix = if m.len() > 8 { ",..." } else { "" };
            let out = format!("{{{fields}{suffix}}}", fields = fields.join(","));
            out.chars().take(160).collect()
        }
    }
}

/// Parses what the poll script returned: `None` while the request is still in flight.
pub fn parse_poll_result(raw: &str) -> Option<Result<WebToken, SessionMsgError>> {
    parse_poll_result_at(raw, now_secs())
}

/// Deterministic variant of `parse_poll_result` taking explicit `now` (Unix seconds).
pub fn parse_poll_result_at(raw: &str, now: i64) -> Option<Result<WebToken, SessionMsgError>> {
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
    let page_uid = positive_uid(parked.page_user_id.as_ref());
    let body = parked.body.unwrap_or(serde_json::Value::Null);
    if body.is_array() {
        if let Some(tok) = extract_from_value(&body, None, page_uid, now) {
            return Some(Ok(tok));
        }
        return Some(Err(SessionMsgError::Rejected(format!(
            "array response without a token ({})",
            describe_field(&body, 2)
        ))));
    }
    let body_type = body.get("type").and_then(|t| t.as_str());
    if body_type != Some("okay") {
        if body_type.is_none() && body.get("error").is_none() && body.get("error_info").is_none() {
            if let Some(tok) = body.get("response").and_then(|r| extract_from_value(r, positive_uid(body.get("user_id")), page_uid, now)) {
                return Some(Ok(tok));
            }
        }
        if body.get("error_info").and_then(|v| v.as_str()) == Some(VK_TRY_AGAIN) {
            return Some(Err(SessionMsgError::Busy(VK_TRY_AGAIN.to_string())));
        }
        let info = body.get("error_info").or_else(|| body.get("error")).map(|v| v.to_string()).unwrap_or_else(|| body.to_string());
        return Some(Err(SessionMsgError::Rejected(info)));
    }
    let body_uid = positive_uid(body.get("user_id"));
    for candidate in [body.get("data"), body.get("response"), Some(&body)] {
        if let Some(tok) = candidate.and_then(|v| extract_from_value(v, body_uid, page_uid, now)) {
            return Some(Ok(tok));
        }
    }
    Some(Err(SessionMsgError::Rejected(format!(
        "okay response without a token ({})",
        describe_field(&body, 2)
    ))))
}

/// Does a failed refresh mean the VK session is gone (as opposed to a transient failure)?
pub fn is_signed_out(err: &str) -> bool {
    err.starts_with("Rejected(")
}

/// Did VK ask to try again later (the session is fine)?
pub fn is_busy(err: &str) -> bool {
    err.starts_with("Busy(")
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

    fn valid_web_token(&self, margin_secs: i64) -> Option<WebToken> {
        let g = self.token.lock().ok()?;
        let t = g.as_ref()?;
        (t.expires - now_secs() > margin_secs).then(|| t.clone())
    }

    fn valid_token(&self, margin_secs: i64) -> Option<String> {
        self.valid_web_token(margin_secs).map(|t| t.access_token)
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
  const num = (v) => {{
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }};
  const expSecs = (obj) => {{
    let e = num(obj && (obj.expired_at ?? obj.expires));
    if (e > 1e12) e = Math.trunc(e / 1000);
    return e;
  }};
  const readStorage = () => {{
    for (const act of ['web_token', 'video.getWebToken']) {{
      try {{
        const raw = window.localStorage && localStorage.getItem('{app}:' + act + ':login:auth');
        if (!raw) continue;
        const d = JSON.parse(raw);
        if (d && typeof d === 'object') return d;
      }} catch {{}}
    }}
    return null;
  }};
  const fresh = (obj) => {{
    if (!obj || obj.is_anonym || typeof obj.access_token !== 'string' || !obj.access_token) return null;
    const exp = expSecs(obj);
    if (exp > 0 && exp * 1000 - Date.now() <= 90000) return null;
    return {{ access_token: obj.access_token, exp }};
  }};
  const pickToken = (v) => {{
    if (!v || typeof v !== 'object') return '';
    if (Array.isArray(v)) return v.map(pickToken).find(Boolean) || '';
    if (typeof v.access_token === 'string' && v.access_token) return v.access_token;
    if (typeof v.token === 'string' && v.token) return v.token;
    if (v.data) return pickToken(v.data);
    if (v.response) return pickToken(v.response);
    return '';
  }};
  const vkPage = window.vk;
  const saved = readStorage();
  const pageUserId = num(vkPage && vkPage.id) || num(saved && saved.user_id);
  // vk.ru now hands its own pages their web token (window.vk.webToken); take it when this page has a fresh one
  const own = fresh(vkPage && vkPage.webToken);
  if (own && own.exp > 0) {{
    box['{nonce}'] = {{
      ok: true,
      from: 'page',
      page_user_id: pageUserId || undefined,
      body: {{ type: 'okay', data: {{ access_token: own.access_token, expires: own.exp, user_id: pageUserId }} }}
    }};
    return true;
  }}
  fetch('https://login.vk.ru/?act=web_token', {{
    method: 'POST', credentials: 'include',
    headers: {{ 'Content-Type': 'application/x-www-form-urlencoded' }},
    body: 'version=1&app_id={app}'
  }})
    .then((r) => r.json())
    .then((body) => {{
      // If login.vk.ru replies "okay" with no token, reuse a valid token VK already placed on the page/origin
      if (body && !Array.isArray(body) && body.type === 'okay' && !pickToken(body)) {{
        const fallback = own || fresh(saved);
        if (fallback) {{
          const uid = own ? pageUserId : (num(saved && saved.user_id) || pageUserId);
          box['{nonce}'] = {{
            ok: true,
            from: own ? 'page' : 'storage',
            page_user_id: pageUserId || undefined,
            body: {{ type: 'okay', data: {{ access_token: fallback.access_token, expires: fallback.exp || null, user_id: uid }} }}
          }};
          return;
        }}
      }}
      box['{nonce}'] = {{ ok: true, page_user_id: pageUserId || undefined, body }};
    }})
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
        let mut result = refresh_with_retries(&app).await;
        // VK keeps asking to try again, or the network is down: the session is not gone, so keep
        // trying for a while (one such loop at a time) instead of showing the login screen
        if matches!(&result, Err(e) if !is_signed_out(e)) && !BEING_PATIENT.swap(true, Ordering::SeqCst) {
            let mut round = 0;
            while let Err(e) = &result {
                if is_signed_out(e) || app.state::<SessionState>().valid_token(120).is_some() {
                    break;
                }
                let wait = patience(round);
                // the journal hears about it now and then, not every minute of a long VK outage
                if round < 3 || round % 10 == 0 {
                    let why = if is_busy(e) { "VK asked to try again" } else { e.as_str() };
                    trace!("no token yet ({why}), trying again in {}s", wait.as_secs());
                }
                let _ = app.emit("session:busy", true);
                tokio::time::sleep(wait).await;
                round += 1;
                // one request a round: when VK means «too many requests», a burst would keep it so
                result = refresh(&app).await;
            }
            BEING_PATIENT.store(false, Ordering::SeqCst);
            let _ = app.emit("session:busy", false);
        }
        let st = app.state::<SessionState>();
        // another check got the token meanwhile
        let result = match result {
            Err(_) if st.valid_token(120).is_some() => Ok(()),
            r => r.map(|_| ()),
        };
        let still_hidden = !app.get_webview_window(SESSION_LABEL).and_then(|w| w.is_visible().ok()).unwrap_or(visible);
        match result {
            Ok(_) => {
                if !still_hidden {
                    trace!("signed in, closing the login window");
                }
                if let Some(w) = app.get_webview_window(SESSION_LABEL) {
                    let _ = w.hide();
                    if w.url().map(|u| u.as_str() != IDLE_URL).unwrap_or(true) {
                        let _ = w.navigate(IDLE_URL.parse().expect("idle url"));
                    }
                }
                if let Some(m) = app.get_window("main") {
                    let _ = m.set_focus();
                }
            }
            Err(e) if still_hidden && is_signed_out(&e) => {
                trace!("no VK session ({e}), showing the login screen");
                st.set_phase(Phase::None);
                let _ = app.emit("session:logged-out", ());
            }
            // a patient loop is already waiting for VK: this check leaves it to that one
            Err(e) if still_hidden => trace!("still waiting for VK ({e})"),
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
/// A refresh, and a few more tries after a failure that is not VK saying "unauthorized" (a busy
/// WebView can miss the eval deadline at app start; VK sometimes asks to try again).
async fn refresh_with_retries(app: &AppHandle) -> Result<WebToken, String> {
    let mut result = refresh(app).await;
    for delay in TRANSIENT_RETRIES {
        match &result {
            Err(e) if !is_signed_out(e) => {
                tokio::time::sleep(delay).await;
                result = refresh(app).await;
            }
            _ => break,
        }
    }
    result
}

async fn resolve_user_id(app: &AppHandle, access_token: &str) -> Result<Option<i64>, String> {
    let http = app.state::<crate::http::Http>();
    let resp = match tokio::time::timeout(Duration::from_secs(5), crate::vk::send(&http, "users.get", &[], access_token)).await {
        Ok(Ok(v)) => v,
        _ => return Ok(None),
    };
    if let Some(code) = resp.get("error").and_then(|e| e.get("error_code")).and_then(parse_i64_loose) {
        if matches!(code, 5 | 1116 | 1117) {
            return Err(format!("{:?}", SessionMsgError::Rejected(format!("users.get error {code}"))));
        }
        return Ok(None);
    }
    Ok(resp
        .get("response")
        .and_then(|r| r.as_array())
        .and_then(|a| a.first())
        .and_then(|u| u.get("id"))
        .and_then(parse_i64_loose)
        .filter(|&id| id > 0))
}

pub async fn refresh(app: &AppHandle) -> Result<WebToken, String> {
    let st = app.state::<SessionState>();
    let mut last = st.last_refresh.lock().await;
    if let Some(tok) = st.valid_web_token(90) {
        return Ok(tok);
    }
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

    let res = match res {
        Ok(mut tok) if tok.user_id <= 0 => {
            let cached = st.token.lock().ok().and_then(|g| g.as_ref().map(|t| t.user_id)).filter(|&id| id > 0);
            if let Some(id) = cached {
                tok.user_id = id;
                Ok(tok)
            } else {
                match resolve_user_id(app, &tok.access_token).await {
                    Ok(Some(id)) => {
                        tok.user_id = id;
                        Ok(tok)
                    }
                    Ok(None) => Ok(tok),
                    Err(e) => Err(e),
                }
            }
        }
        other => other,
    };

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
    fn okay_without_token_is_rejected_with_shape() {
        let raw = r#"{"ok":true,"body":{"type":"okay","data":{"user_id":42}}}"#;
        let err = parse_poll_result(raw).unwrap().unwrap_err();
        let SessionMsgError::Rejected(msg) = err else { panic!("expected Rejected, got {err:?}") };
        assert!(msg.starts_with("okay response without a token"), "msg={msg}");
        assert!(msg.contains("user_id:num") && !msg.contains("42"), "shape must redact values: {msg}");
    }

    #[test]
    fn parses_okay_with_missing_or_null_expires_and_missing_user_id() {
        let now = 1_794_790_000;
        let raw = r#"{"ok":true,"body":{"type":"okay","data":{"access_token":"tok","expires":null}},"page_user_id":77}"#;
        assert_eq!(
            parse_poll_result_at(raw, now),
            Some(Ok(WebToken { access_token: "tok".into(), expires: now + DEFAULT_TOKEN_TTL_SECS, user_id: 77 }))
        );

        let no_exp_or_uid = r#"{"ok":true,"body":{"type":"okay","data":{"access_token":"tok"}}}"#;
        assert_eq!(
            parse_poll_result_at(no_exp_or_uid, now),
            Some(Ok(WebToken { access_token: "tok".into(), expires: now + DEFAULT_TOKEN_TTL_SECS, user_id: 0 }))
        );
    }

    #[test]
    fn parses_string_float_and_alternate_vk_fields() {
        let now = 1_794_790_000;
        let str_nums = r#"{"ok":true,"body":{"type":"okay","data":{"access_token":"tok","expires":"1794791234","user_id":"42"}}}"#;
        assert_eq!(
            parse_poll_result_at(str_nums, now),
            Some(Ok(WebToken { access_token: "tok".into(), expires: 1794791234, user_id: 42 }))
        );

        let float_and_alt = r#"{"ok":true,"body":{"type":"okay","data":{"token":"tok","expired_at":1794791234000.0,"uid":42.0}}}"#;
        assert_eq!(
            parse_poll_result_at(float_and_alt, now),
            Some(Ok(WebToken { access_token: "tok".into(), expires: 1794791234, user_id: 42 }))
        );

        let ttl_shape = r#"{"ok":true,"body":{"type":"okay","data":{"access_token":"tok","expires_in":1200,"user_id":42}}}"#;
        assert_eq!(
            parse_poll_result_at(ttl_shape, now),
            Some(Ok(WebToken { access_token: "tok".into(), expires: now + 1200, user_id: 42 }))
        );
    }

    #[test]
    fn parses_array_wrapped_and_top_level_array_responses() {
        let now = 1_794_790_000;
        let data_arr = r#"{"ok":true,"body":{"type":"okay","data":[{"access_token":"t1","expires":1794791000,"user_id":11},{"access_token":"t2","expires":1794792000,"user_id":22}]},"page_user_id":22}"#;
        assert_eq!(
            parse_poll_result_at(data_arr, now),
            Some(Ok(WebToken { access_token: "t2".into(), expires: 1794792000, user_id: 22 }))
        );

        let top_arr = r#"{"ok":true,"body":[{"access_token":"t1","expires":1794791000,"user_id":11}]}"#;
        assert_eq!(
            parse_poll_result_at(top_arr, now),
            Some(Ok(WebToken { access_token: "t1".into(), expires: 1794791000, user_id: 11 }))
        );

        let top_level_okay = r#"{"ok":true,"body":{"type":"okay","access_token":"t1","expires":1794791000,"user_id":11}}"#;
        assert_eq!(
            parse_poll_result_at(top_level_okay, now),
            Some(Ok(WebToken { access_token: "t1".into(), expires: 1794791000, user_id: 11 }))
        );

        let api_gw = r#"{"ok":true,"body":{"response":{"token":"t1","ttl":600,"user_id":11}}}"#;
        assert_eq!(
            parse_poll_result_at(api_gw, now),
            Some(Ok(WebToken { access_token: "t1".into(), expires: now + 600, user_id: 11 }))
        );
    }

    #[test]
    fn okay_with_empty_token_redacts_secrets_and_is_signed_out() {
        let raw = r#"{"ok":true,"body":{"type":"okay","data":{"access_token":"","secret":"do_not_leak"}}}"#;
        let err = parse_poll_result(raw).unwrap().unwrap_err();
        let dbg = format!("{err:?}");
        assert!(is_signed_out(&dbg));
        assert!(!dbg.contains("do_not_leak"), "redacted shape leaked secret: {dbg}");
        assert!(dbg.contains("access_token:str(0)"), "missing empty-string shape: {dbg}");
    }

    #[test]
    fn vk_asking_to_try_again_is_busy_not_signed_out() {
        // VK's own web client retries this one (it is its «too many requests» / failed check)
        let raw = r#"{"ok":true,"body":{"type":"error","error_info":"check result failure"}}"#;
        let r = parse_poll_result(raw);
        assert_eq!(r, Some(Err(SessionMsgError::Busy("check result failure".into()))));
        assert!(!is_signed_out(&format!("{:?}", SessionMsgError::Busy("check result failure".into()))));
        assert!(is_busy(&format!("{:?}", SessionMsgError::Busy("check result failure".into()))));
        assert!(!is_busy("timeout"));
    }

    #[test]
    fn a_token_the_page_already_holds_is_taken_as_it_is() {
        // vk.ru now hands its own pages a web token (window.vk.webToken); the script parks it like an answer
        let raw = r#"{"ok":true,"body":{"type":"okay","data":{"access_token":"tok","expires":1791268053,"user_id":42}},"from":"page"}"#;
        assert_eq!(parse_poll_result(raw), Some(Ok(WebToken { access_token: "tok".into(), expires: 1791268053, user_id: 42 })));
    }

    #[test]
    fn patience_is_soon_at_first_then_once_a_minute_for_good() {
        let waits: Vec<u64> = (0..6).map(|r| patience(r).as_secs()).collect();
        assert_eq!(waits, vec![15, 30, 30, 60, 60, 60]);
        assert_eq!(patience(500).as_secs(), 60);
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
