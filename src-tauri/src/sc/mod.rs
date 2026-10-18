//! SoundCloud: sign-in, the key, api-v2 requests and stream links. The key never leaves Rust.

pub mod api;
pub mod auth;
pub mod client_id;
pub mod login;
pub mod store;
pub mod stream;

use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use client_id::{fallback, load_saved, save_saved, Ids, Saved, SAVED_FILE};

/// Every change of the SoundCloud status, with `ScStatus` as payload.
pub const EV_STATUS: &str = "sc:status";
/// A sign-in that did not end with a key: `{ message, cancelled }`.
pub const EV_LOGIN_FAILED: &str = "sc:login-failed";

/// Journal entry for SoundCloud. Never pass keys, codes, `state`, queries or stream links.
macro_rules! trace {
    ($($arg:tt)*) => {
        crate::journal::write("sc", &format!($($arg)*))
    };
}
pub(crate) use trace;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScPhase {
    /// A key from the last run is being checked.
    Checking,
    SignedIn,
    SignedOut,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScUser {
    pub id: i64,
    pub name: String,
    pub avatar: Option<String>,
    pub permalink: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScStatus {
    pub state: ScPhase,
    pub user: Option<ScUser>,
}

pub struct ScState {
    token: Mutex<Option<String>>,
    user: Mutex<Option<ScUser>>,
    phase: Mutex<ScPhase>,
    ids: RwLock<Ids>,
    device_id: RwLock<String>,
    saved_path: Mutex<Option<PathBuf>>,
    /// The sign-in attempt under way, if any.
    pub(crate) pending: Mutex<Option<login::Pending>>,
    /// When the site's ids were last looked up after a 401.
    pub(crate) rediscovered: Mutex<Option<Instant>>,
}

impl ScState {
    pub fn new() -> Self {
        Self {
            token: Mutex::new(None),
            user: Mutex::new(None),
            phase: Mutex::new(ScPhase::SignedOut),
            ids: RwLock::new(fallback()),
            device_id: RwLock::new(String::new()),
            saved_path: Mutex::new(None),
            pending: Mutex::new(None),
            rediscovered: Mutex::new(None),
        }
    }

    pub fn token(&self) -> Option<String> {
        self.token.lock().ok().and_then(|g| g.clone())
    }

    pub fn set_token(&self, t: Option<String>) {
        let checking = t.is_some();
        if let Ok(mut g) = self.token.lock() {
            *g = t;
        }
        if checking {
            self.set_phase(ScPhase::Checking);
        }
    }

    pub fn set_signed_in(&self, user: Option<ScUser>) {
        if let Ok(mut g) = self.user.lock() {
            *g = user;
        }
        self.set_phase(ScPhase::SignedIn);
    }

    pub fn set_signed_out(&self) {
        if let Ok(mut g) = self.token.lock() {
            *g = None;
        }
        if let Ok(mut g) = self.user.lock() {
            *g = None;
        }
        self.set_phase(ScPhase::SignedOut);
    }

    fn set_phase(&self, p: ScPhase) {
        if let Ok(mut g) = self.phase.lock() {
            *g = p;
        }
    }

    pub fn status(&self) -> ScStatus {
        let state = self.phase.lock().map(|g| *g).unwrap_or(ScPhase::SignedOut);
        let user = self.user.lock().ok().and_then(|g| g.clone());
        ScStatus { state, user }
    }

    pub fn ids(&self) -> Ids {
        self.ids.read().map(|g| g.clone()).unwrap_or_else(|_| fallback())
    }

    /// New ids found on the site: kept here and in `sc-ids.json`.
    pub fn set_ids(&self, ids: Ids) {
        if let Ok(mut g) = self.ids.write() {
            *g = ids;
        }
        self.save();
    }

    pub fn device_id(&self) -> String {
        self.device_id.read().map(|g| g.clone()).unwrap_or_default()
    }

    fn save(&self) {
        let Some(path) = self.saved_path.lock().ok().and_then(|g| g.clone()) else { return };
        let saved = Saved { ids: Some(self.ids()), device_id: Some(self.device_id()) };
        if let Err(e) = save_saved(&path, &saved) {
            trace!("could not save {SAVED_FILE}: {e}");
        }
    }
}

pub fn emit_status(app: &AppHandle) {
    let _ = app.emit(EV_STATUS, app.state::<ScState>().status());
}

#[tauri::command]
pub fn sc_status(st: State<'_, ScState>) -> ScStatus {
    st.status()
}

/// Loads what the last run left: the ids, this install's device id, the key. Never waits for
/// the network: VK and the window must not wait for SoundCloud.
pub fn init(app: &AppHandle) {
    let st = app.state::<ScState>();
    let path = app.path().app_data_dir().ok().map(|d| d.join(SAVED_FILE));
    let saved = path.as_deref().map(load_saved).unwrap_or_default();
    if let Ok(mut g) = st.ids.write() {
        *g = saved.ids.clone().unwrap_or_else(fallback);
    }
    let fresh_device = saved.device_id.is_none();
    if let Ok(mut g) = st.device_id.write() {
        *g = saved.device_id.clone().unwrap_or_else(auth::new_device_id);
    }
    if let Ok(mut g) = st.saved_path.lock() {
        *g = path;
    }
    if fresh_device {
        st.save();
    }
    match store::load_token() {
        Some(t) => {
            st.set_token(Some(t));
            let app = app.clone();
            tauri::async_runtime::spawn(async move { check_key(&app).await });
        }
        None => st.set_signed_out(),
    }
}

/// The key from the last run still works? Without a network it stays (pages say SoundCloud does
/// not answer); a 401 goes the way of every request: the site's id, a silent sign-in, else out.
async fn check_key(app: &AppHandle) {
    let st = app.state::<ScState>();
    let Some(token) = st.token() else { return };
    let first = api::me_with(&app.state::<crate::http::Http>(), &st.ids(), &token).await;
    match first {
        Ok(user) => st.set_signed_in(Some(user)),
        Err(api::ScError::Http { status: 401 }) => match api::request(app, "GET", "/me").await {
            Ok(v) => st.set_signed_in(api::user_from_me(&v)),
            Err(api::ScError::SignedOut) => {}
            Err(_) => st.set_signed_in(None),
        },
        Err(_) => st.set_signed_in(None),
    }
    emit_status(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> ScUser {
        ScUser { id: 1, name: "a".to_string(), avatar: None, permalink: None }
    }

    #[test]
    fn status_follows_sign_in_and_out() {
        let st = ScState::new();
        assert_eq!(st.status().state, ScPhase::SignedOut);
        st.set_token(Some("k".to_string()));
        st.set_signed_in(Some(user()));
        let s = st.status();
        assert_eq!(s.state, ScPhase::SignedIn);
        assert_eq!(s.user, Some(user()));
        assert_eq!(st.token(), Some("k".to_string()));
        st.set_signed_out();
        let s = st.status();
        assert_eq!(s.state, ScPhase::SignedOut);
        assert_eq!(s.user, None);
        assert_eq!(st.token(), None);
    }

    #[test]
    fn status_serializes_for_the_ui() {
        let st = ScState::new();
        st.set_token(Some("k".to_string()));
        st.set_signed_in(Some(user()));
        let v = serde_json::to_value(st.status()).unwrap();
        assert_eq!(v, serde_json::json!({ "state": "signed-in", "user": { "id": 1, "name": "a", "avatar": null, "permalink": null } }));
    }
}
