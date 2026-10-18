//! The SoundCloud sign-in window. Its own WebView2 profile (`sc-webview`): signing out of VK
//! clears the main profile, and signing out of SoundCloud must not touch VK. Google, Facebook and
//! Apple open as popups of the same profile. The callback navigation is caught and cancelled here;
//! the code becomes the key in Rust. With the profile's session alive, a hidden window signs in
//! again by itself in about a second (silent sign-in).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;

use super::auth::{self, CallbackError, Pkce};
use super::{api, emit_status, store, trace, ScState, EV_LOGIN_FAILED};
use crate::http::Http;

/// Each attempt has its own label (`sc-login-<n>`), so a closed old window never ends a new attempt.
pub const LABEL_PREFIX: &str = "sc-login-";
const POPUP_PREFIX: &str = "sc-popup-";
const WIPE_LABEL: &str = "sc-wipe";
const PROFILE_DIR: &str = "sc-webview";
const SILENT_TIMEOUT: Duration = Duration::from_secs(15);
/// Time for WebView2 to finish clearing the profile before its last window goes.
const WIPE_GRACE: Duration = Duration::from_millis(1500);
const GENERIC_FAILURE: &str = "Не получилось войти в SoundCloud — попробуйте ещё раз";

static ATTEMPTS: AtomicU32 = AtomicU32::new(0);
static POPUPS: AtomicU32 = AtomicU32::new(0);
/// One silent sign-in at a time: two requests that both got a 401 share one.
static SILENT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub struct Pending {
    pkce: Pkce,
    silent: bool,
    label: String,
    done: Option<oneshot::Sender<Result<(), String>>>,
}

struct Failure {
    message: String,
    cancelled: bool,
}

impl Failure {
    fn new(message: &str) -> Self {
        Self { message: message.to_string(), cancelled: false }
    }
}

pub(super) fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|d| d.join(PROFILE_DIR)).map_err(|e| e.to_string())
}

fn close_windows(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) || label.starts_with(POPUP_PREFIX) {
            let _ = w.destroy();
        }
    }
}

/// Opens the sign-in page for a new attempt (hidden for a silent one). The receiver hears how it ended.
pub fn open(app: &AppHandle, silent: bool) -> Result<oneshot::Receiver<Result<(), String>>, String> {
    close_windows(app);
    let st = app.state::<ScState>();
    let ids = st.ids();
    let pkce = auth::new_pkce();
    let page: Url = auth::auth_url(&ids.client_id, &ids.app_id, &st.device_id(), &pkce).parse().map_err(|_| "bad sign-in address".to_string())?;
    let label = format!("{LABEL_PREFIX}{}", ATTEMPTS.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = oneshot::channel();
    if let Ok(mut g) = st.pending.lock() {
        *g = Some(Pending { pkce, silent, label: label.clone(), done: Some(tx) });
    }
    let dir = profile_dir(app)?;
    let nav_app = app.clone();
    let popup_app = app.clone();
    let popup_dir = dir.clone();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(page))
        .title("Вход в SoundCloud — Nocturne")
        .inner_size(480.0, 760.0)
        .center()
        .visible(!silent)
        .data_directory(dir)
        .initialization_script(auth::INIT_SCRIPT)
        .on_navigation(move |url| {
            if auth::is_callback(url) {
                let app = nav_app.clone();
                let url = url.clone();
                tauri::async_runtime::spawn(async move { finish(&app, url).await });
                return false;
            }
            matches!(url.scheme(), "https" | "about")
        })
        .on_new_window(move |_url, features| {
            let n = POPUPS.fetch_add(1, Ordering::Relaxed);
            let blank: Url = "about:blank".parse().expect("about:blank");
            match WebviewWindowBuilder::new(&popup_app, format!("{POPUP_PREFIX}{n}"), WebviewUrl::External(blank))
                .window_features(features)
                .data_directory(popup_dir.clone())
                .title("Вход — SoundCloud (Nocturne)")
                .build()
            {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    trace!("{} sign-in window opened", if silent { "silent" } else { "visible" });
    Ok(rx)
}

async fn finish(app: &AppHandle, url: Url) {
    let st = app.state::<ScState>();
    let Some(mut p) = st.pending.lock().ok().and_then(|mut g| g.take()) else { return };
    let result = exchange(app, &p, &url).await;
    close_windows(app);
    match &result {
        Ok(()) => trace!("signed in"),
        Err(f) if f.cancelled => trace!("sign-in cancelled"),
        Err(_) => {}
    }
    if let Err(f) = &result {
        if !p.silent {
            let _ = app.emit(EV_LOGIN_FAILED, json!({ "message": f.message, "cancelled": f.cancelled }));
        }
    }
    if let Some(tx) = p.done.take() {
        let _ = tx.send(result.map_err(|f| f.message));
    }
}

async fn exchange(app: &AppHandle, p: &Pending, url: &Url) -> Result<(), Failure> {
    let code = match auth::code_from_callback(url, &p.pkce.nonce) {
        Ok(c) => c,
        Err(CallbackError::Cancelled) => return Err(Failure { message: String::new(), cancelled: true }),
        Err(e) => {
            trace!("callback refused: {e:?}");
            return Err(Failure::new(GENERIC_FAILURE));
        }
    };
    let st = app.state::<ScState>();
    let http = app.state::<Http>();
    let ids = st.ids();
    let resp = http
        .client
        .post(auth::TOKEN_URL)
        .header(reqwest::header::USER_AGENT, http.user_agent())
        .header(reqwest::header::ORIGIN, "https://soundcloud.com")
        .header(reqwest::header::REFERER, "https://soundcloud.com/")
        .form(&auth::token_form(&code, &p.pkce.verifier, &ids.client_id))
        .send()
        .await
        .map_err(|_| {
            trace!("sign-in: SoundCloud did not answer");
            Failure::new(api::UNREACHABLE)
        })?;
    if !resp.status().is_success() {
        trace!("sign-in failed: HTTP {}", resp.status().as_u16());
        return Err(Failure::new(GENERIC_FAILURE));
    }
    let body: Value = resp.json().await.map_err(|_| Failure::new(GENERIC_FAILURE))?;
    let token = auth::token_from(&body).ok_or_else(|| Failure::new(GENERIC_FAILURE))?;
    // without Credential Manager the key still works for this run
    if let Err(e) = store::save_token(&token) {
        trace!("could not keep the key: {e}");
    }
    st.set_token(Some(token.clone()));
    let user = api::me_with(&http, &ids, &token).await.ok();
    let missing = user.is_none();
    st.set_signed_in(user);
    emit_status(app);
    if missing {
        super::repair_profile(app);
    }
    Ok(())
}

/// Signs in again without the person, from the profile's session, when the key stopped working.
pub async fn silent(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<ScState>();
    let before = st.token();
    let _one = SILENT.lock().await;
    // another request's silent sign-in already got a new key
    if st.token().is_some() && st.token() != before {
        return Ok(());
    }
    // never take the window from someone signing in right now
    if st.pending.lock().map(|g| g.as_ref().is_some_and(|p| !p.silent)).unwrap_or(false) {
        return Err("sign-in in progress".to_string());
    }
    let rx = open(app, true)?;
    match tokio::time::timeout(SILENT_TIMEOUT, rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("sign-in dropped".to_string()),
        Err(_) => {
            if let Ok(mut g) = st.pending.lock() {
                if g.as_ref().is_some_and(|p| p.silent) {
                    g.take();
                }
            }
            close_windows(app);
            trace!("silent sign-in: no session");
            Err("timeout".to_string())
        }
    }
}

/// The window of the attempt `label` went away (the person closed it): that attempt is over.
pub fn closed(app: &AppHandle, label: &str) {
    let st = app.state::<ScState>();
    let p = st.pending.lock().ok().and_then(|mut g| if g.as_ref().is_some_and(|p| p.label == label && !p.silent) { g.take() } else { None });
    if let Some(mut p) = p {
        trace!("sign-in window closed");
        let _ = app.emit(EV_LOGIN_FAILED, json!({ "message": "", "cancelled": true }));
        if let Some(tx) = p.done.take() {
            let _ = tx.send(Err("closed".to_string()));
        }
    }
}

/// Async on purpose: a sync command runs on the main thread, and building a webview window there
/// deadlocks on Windows (the window stays white and the app stops answering).
#[tauri::command]
pub async fn sc_login(app: AppHandle) -> Result<(), String> {
    open(&app, false).map(|_| ())
}

#[tauri::command]
pub async fn sc_logout(app: AppHandle) -> Result<(), String> {
    trace!("signing out");
    let st = app.state::<ScState>();
    if let Ok(mut g) = st.pending.lock() {
        g.take();
    }
    st.set_signed_out();
    store::clear_token();
    close_windows(&app);
    super::web::close(&app);
    emit_status(&app);
    wipe_profile(&app).await
}

/// Forgets the sign-in profile's cookies (only that profile: VK keeps its own).
async fn wipe_profile(app: &AppHandle) -> Result<(), String> {
    let w = match app.get_webview_window(WIPE_LABEL) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, WIPE_LABEL, WebviewUrl::External("about:blank".parse().expect("about:blank")))
            .visible(false)
            .data_directory(profile_dir(app)?)
            .build()
            .map_err(|e| e.to_string())?,
    };
    let r = w.clear_all_browsing_data().map_err(|e| e.to_string());
    tokio::time::sleep(WIPE_GRACE).await;
    let _ = w.destroy();
    r
}
