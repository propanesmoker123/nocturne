//! Writes need the site's browser session, including its own DataDome integration. Keep that
//! session in the sign-in profile; a challenge is shown to the person, never solved by the app.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use super::web_rules::{is_site, network, owned_write_path, progress, script, Poll, SITE};
use super::{api::{self, ScError}, login, trace, ScState};

const LABEL: &str = "sc-session";
const DEADLINE: Duration = Duration::from_secs(30);
static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    let st = app.state::<ScState>();
    if st.token().as_deref() != Some(token) { return Err(ScError::SignedOut); }
    let me = st.status().user.ok_or(ScError::SignedOut)?.id;
    let key = uuid::Uuid::new_v4().simple().to_string();
    let url = api::api_url(path, &app.state::<ScState>().ids().client_id)?;
    let args = json!({ "key": key, "url": url.as_str(), "method": method, "token": token, "me": me });
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
    if !owned_write_path(method, path, me) {
        return Err(ScError::Invalid { message: "request not allowed".to_string() });
    }
    let token = st.token().ok_or(ScError::SignedOut)?;
    let mut answer = send(app, method, path, &token).await;
    if matches!(answer, Err(ScError::Http { status: 401 })) && login::silent(app, &token).await.is_ok() {
        let token = st.token().ok_or(ScError::SignedOut)?;
        if st.status().user.map(|u| u.id) != Some(me) { return Err(ScError::SignedOut); }
        answer = send(app, method, path, &token).await;
    }
    let shown = super::shown_path(path);
    match &answer {
        Err(ScError::Http { status }) => trace!("browser {method} {shown}: HTTP {status}"),
        Err(ScError::Challenge) => trace!("browser {method} {shown}: challenge"),
        Err(_) => trace!("browser {method} {shown}: failed"),
        Ok(_) => trace!("browser {method} {shown}: succeeded"),
    }
    answer
}
