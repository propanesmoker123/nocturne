//! SoundCloud: sign-in, api-v2 requests and stream links. The key never reaches the app's UI.

pub mod api;
pub mod auth;
pub mod client_id;
mod idle;
pub mod login;
pub mod store;
pub mod stream;
pub mod web;
pub mod web_rules;

use std::path::PathBuf;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

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

/// A request path as the journal may show it: no query, and no ids — whom the person follows or
/// likes, or what they play, is theirs (the journal is sent to helpers).
pub(crate) fn shown_path(path: &str) -> String {
    let path = path.split('?').next().unwrap_or_default();
    let mut out = String::with_capacity(path.len());
    let mut digits = String::new();
    let flush = |out: &mut String, digits: &mut String, whole: bool| {
        if !digits.is_empty() {
            out.push_str(if whole || digits.len() >= 3 { "{n}" } else { digits.as_str() });
            digits.clear();
        }
    };
    for seg in path.split('/').enumerate() {
        let (i, seg) = seg;
        if i > 0 { out.push('/'); }
        let whole = !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit());
        for ch in seg.chars() {
            if ch.is_ascii_digit() { digits.push(ch); } else { flush(&mut out, &mut digits, false); out.push(ch); }
        }
        flush(&mut out, &mut digits, whole);
    }
    out
}

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

struct ScInner {
    token: Option<String>,
    user: Option<ScUser>,
    phase: ScPhase,
    generation: u64,
}

pub struct ScState {
    inner: Mutex<ScInner>,
    ids: RwLock<Ids>,
    device_id: RwLock<String>,
    saved_path: Mutex<Option<PathBuf>>,
    /// The sign-in attempt under way, if any.
    pub(crate) pending: Mutex<Option<login::Pending>>,
    /// Do not look up the site's ids again until this deadline passes.
    pub(crate) rediscovered: Mutex<Option<Instant>>,
}

impl ScState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ScInner {
                token: None,
                user: None,
                phase: ScPhase::SignedOut,
                generation: 0,
            }),
            ids: RwLock::new(fallback()),
            device_id: RwLock::new(String::new()),
            saved_path: Mutex::new(None),
            pending: Mutex::new(None),
            rediscovered: Mutex::new(None),
        }
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, ScInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn generation(&self) -> u64 {
        self.lock_inner().generation
    }

    pub fn token(&self) -> Option<String> {
        self.lock_inner().token.clone()
    }

    pub fn token_and_generation(&self) -> (Option<String>, u64) {
        let g = self.lock_inner();
        (g.token.clone(), g.generation)
    }

    pub fn set_token(&self, t: Option<String>) {
        let mut g = self.lock_inner();
        g.generation = g.generation.wrapping_add(1);
        g.user = None;
        if t.is_some() {
            g.token = t;
            g.phase = ScPhase::Checking;
        } else {
            g.token = None;
            g.phase = ScPhase::SignedOut;
        }
    }

    #[cfg(test)]
    pub fn set_signed_in(&self, user: Option<ScUser>) {
        let mut g = self.lock_inner();
        if g.token.is_none() {
            return;
        }
        g.user = user;
        g.phase = ScPhase::SignedIn;
    }

    /// Commits a freshly exchanged token + profile atomically only if `generation` is unchanged.
    /// Returns the new generation on success.
    pub(crate) fn commit_signed_in_if_gen(&self, expected_gen: u64, token: String, user: Option<ScUser>) -> Option<u64> {
        let mut g = self.lock_inner();
        if g.generation != expected_gen {
            return None;
        }
        g.generation = g.generation.wrapping_add(1);
        g.token = Some(token);
        g.user = user;
        g.phase = ScPhase::SignedIn;
        Some(g.generation)
    }

    /// Marks the session signed-in with `user` only if `generation` still matches and a token exists.
    pub(crate) fn set_signed_in_if_gen(&self, expected_gen: u64, user: Option<ScUser>) -> bool {
        let mut g = self.lock_inner();
        if g.generation != expected_gen || g.token.is_none() {
            return false;
        }
        g.user = user;
        g.phase = ScPhase::SignedIn;
        true
    }

    pub fn set_signed_out(&self) {
        let mut g = self.lock_inner();
        g.token = None;
        g.user = None;
        g.phase = ScPhase::SignedOut;
        g.generation = g.generation.wrapping_add(1);
        drop(g);
        REPAIR_WAKE.notify_one();
    }

    /// Atomically signs out only if `failed` is still the current token.
    pub(crate) fn sign_out_if_token(&self, failed: &str) -> bool {
        let mut g = self.lock_inner();
        if api::signs_out(g.token.as_deref(), failed) {
            g.token = None;
            g.user = None;
            g.phase = ScPhase::SignedOut;
            g.generation = g.generation.wrapping_add(1);
            drop(g);
            REPAIR_WAKE.notify_one();
            true
        } else {
            false
        }
    }

    pub(crate) fn repair_target_generation(&self) -> Option<u64> {
        let g = self.lock_inner();
        (g.phase == ScPhase::SignedIn && g.token.is_some() && g.user.is_none()).then_some(g.generation)
    }

    pub(crate) fn needs_profile_repair(&self) -> bool {
        self.repair_target_generation().is_some()
    }

    pub fn status(&self) -> ScStatus {
        let g = self.lock_inner();
        ScStatus { state: g.phase, user: g.user.clone() }
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

/// Pauses between tries to read the profile when a sign-in came without it (no network yet, a 5xx);
/// the last one repeats for as long as it takes.
const PROFILE_RETRY: [Duration; 4] = [Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(30), Duration::from_secs(60)];
/// One such loop at a time.
static REPAIRING: AtomicBool = AtomicBool::new(false);
/// Wakes a sleeping repair loop when a new sign-in or sign-out changes session generation.
static REPAIR_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Tries `fetch` until it gives the profile, while `alive` says the same sign-in still stands.
/// Wakes early from sleep if `wake` is notified.
pub(crate) async fn until_profile_notified<F, Fut>(
    mut fetch: F,
    mut alive: impl FnMut() -> bool,
    delays: &[Duration],
    wake: &tokio::sync::Notify,
) -> Option<ScUser>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<ScUser>>,
{
    let mut round = 0;
    loop {
        if !alive() {
            return None;
        }
        if let Some(user) = fetch().await {
            return Some(user);
        }
        if !alive() {
            return None;
        }
        let wait = delays.get(round).or(delays.last()).copied().unwrap_or(Duration::from_secs(60));
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = wake.notified() => {
                if !alive() {
                    return None;
                }
            }
        }
        round += 1;
    }
}

/// Tries `fetch` until it gives the profile, while `alive` says the same sign-in still stands.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn until_profile<F, Fut>(fetch: F, alive: impl FnMut() -> bool, delays: &[Duration]) -> Option<ScUser>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<ScUser>>,
{
    let wake = tokio::sync::Notify::new();
    until_profile_notified(fetch, alive, delays, &wake).await
}

/// Signed in, but the profile did not come: without it likes and the person's own lists cannot
/// work, so it is read again in the background until it comes (or the key changes).
pub(crate) fn repair_profile(app: &AppHandle) {
    if !app.state::<ScState>().needs_profile_repair() {
        return;
    }
    if REPAIRING.swap(true, Ordering::SeqCst) {
        // Wake the active loop immediately so a new sign-in during a 60s sleep is never dropped.
        REPAIR_WAKE.notify_one();
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let st = app.state::<ScState>();
            let Some(target_gen) = st.repair_target_generation() else {
                REPAIRING.store(false, Ordering::SeqCst);
                // Re-check in case a new sign-in arrived right before we cleared REPAIRING.
                if st.needs_profile_repair() && !REPAIRING.swap(true, Ordering::SeqCst) {
                    continue;
                }
                break;
            };
            let fetch = {
                let app = app.clone();
                move || {
                    let app = app.clone();
                    async move {
                        match api::request(&app, "GET", "/me").await {
                            Ok(v) => api::user_from_me(&v),
                            Err(_) => None,
                        }
                    }
                }
            };
            let alive = {
                let app = app.clone();
                move || app.state::<ScState>().repair_target_generation() == Some(target_gen)
            };
            let user = until_profile_notified(fetch, alive, &PROFILE_RETRY, &REPAIR_WAKE).await;
            if let Some(user) = user {
                if st.set_signed_in_if_gen(target_gen, Some(user)) {
                    trace!("profile read");
                    emit_status(&app);
                }
            }
        }
    });
}

/// The key from the last run still works? Without a network it stays (pages say SoundCloud does
/// not answer); a 401 goes the way of every request: the site's id, a silent sign-in, else out.
async fn check_key(app: &AppHandle) {
    let st = app.state::<ScState>();
    let (Some(token), gen0) = st.token_and_generation() else { return };
    let first = api::me_with(&app.state::<crate::http::Http>(), &st.ids(), &token).await;
    let committed = match first {
        Ok(user) => st.set_signed_in_if_gen(gen0, Some(user)),
        Err(api::ScError::Http { status: 401 }) => match api::request(app, "GET", "/me").await {
            Ok(v) => st.set_signed_in_if_gen(gen0, api::user_from_me(&v)),
            Err(api::ScError::SignedOut) => false,
            Err(_) => st.set_signed_in_if_gen(gen0, None),
        },
        Err(_) => st.set_signed_in_if_gen(gen0, None),
    };
    if committed {
        emit_status(app);
    }
    if st.needs_profile_repair() {
        repair_profile(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_journal_names_no_one_and_no_track() {
        assert_eq!(shown_path("/me/followings/1498436755"), "/me/followings/{n}");
        assert_eq!(shown_path("/users/1690419329/track_likes/339318387"), "/users/{n}/track_likes/{n}");
        assert_eq!(shown_path("/tracks/9/comments?threaded=0&filter_replies=1&limit=200"), "/tracks/{n}/comments");
        assert_eq!(shown_path("/media/soundcloud:tracks:1875595929/ab12cd/stream/hls"), "/media/soundcloud:tracks:{n}/ab12cd/stream/hls");
        assert_eq!(shown_path("/stream"), "/stream");
    }

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
    fn a_missing_profile_is_read_again_until_it_comes() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;
        let tries = Arc::new(AtomicU32::new(0));
        let fetch = {
            let tries = tries.clone();
            move || {
                let tries = tries.clone();
                async move { (tries.fetch_add(1, Ordering::SeqCst) >= 2).then(user) }
            }
        };
        let got = tauri::async_runtime::block_on(until_profile(fetch, || true, &[std::time::Duration::ZERO]));
        assert_eq!(got, Some(user()));
        assert_eq!(tries.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn reading_the_profile_stops_when_the_key_is_gone() {
        let mut left = 2;
        let alive = move || {
            left -= 1;
            left >= 0
        };
        let got = tauri::async_runtime::block_on(until_profile(|| async { None }, alive, &[std::time::Duration::ZERO]));
        assert_eq!(got, None);
    }

    #[test]
    fn status_serializes_for_the_ui() {
        let st = ScState::new();
        st.set_token(Some("k".to_string()));
        st.set_signed_in(Some(user()));
        let v = serde_json::to_value(st.status()).unwrap();
        assert_eq!(v, serde_json::json!({ "state": "signed-in", "user": { "id": 1, "name": "a", "avatar": null, "permalink": null } }));
    }

    #[test]
    fn generation_prevents_stale_commits_and_split_brain_signed_in() {
        let st = ScState::new();
        // Cannot become SignedIn when token is None.
        st.set_signed_in(Some(user()));
        assert_eq!(st.status().state, ScPhase::SignedOut);
        assert_eq!(st.status().user, None);

        // Snapshot generation before an async exchange; a concurrent sign-out invalidates it.
        let gen0 = st.generation();
        st.set_signed_out();
        assert_ne!(st.generation(), gen0);
        assert_eq!(st.commit_signed_in_if_gen(gen0, "k1".to_string(), Some(user())), None);
        assert_eq!(st.status().state, ScPhase::SignedOut);
        assert_eq!(st.token(), None);

        // With current generation, commit succeeds atomically and advances generation.
        let gen1 = st.generation();
        let gen2 = st.commit_signed_in_if_gen(gen1, "k2".to_string(), None).unwrap();
        assert_ne!(gen2, gen1);
        assert_eq!(st.status().state, ScPhase::SignedIn);
        assert_eq!(st.token().as_deref(), Some("k2"));
        assert_eq!(st.repair_target_generation(), Some(gen2));

        // Stale check_key generation cannot overwrite profile or phase; matching generation can.
        assert!(!st.set_signed_in_if_gen(gen1, Some(user())));
        assert!(st.set_signed_in_if_gen(gen2, Some(user())));
        assert_eq!(st.status().user, Some(user()));
        assert_eq!(st.repair_target_generation(), None);

        // Atomic sign_out_if_token only signs out matching token.
        assert!(!st.sign_out_if_token("wrong"));
        assert_eq!(st.status().state, ScPhase::SignedIn);
        assert!(st.sign_out_if_token("k2"));
        assert_eq!(st.status().state, ScPhase::SignedOut);
        assert_eq!(st.token(), None);
        assert_ne!(st.generation(), gen2);
    }

    #[tokio::test(start_paused = true)]
    async fn profile_repair_wakes_immediately_from_long_sleep_on_session_change() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let alive_flag = Arc::new(AtomicBool::new(true));
        let wake = Arc::new(tokio::sync::Notify::new());
        let handle = {
            let alive_flag = alive_flag.clone();
            let wake = wake.clone();
            tokio::spawn(async move {
                until_profile_notified(
                    || async { None },
                    move || alive_flag.load(Ordering::SeqCst),
                    &[Duration::from_secs(60)],
                    &wake,
                )
                .await
            })
        };

        // Let the task run its first failed fetch and enter the 60s sleep.
        tokio::task::yield_now().await;
        // Simulate a new sign-in/sign-out 1s into the 60s sleep.
        tokio::time::advance(Duration::from_secs(1)).await;
        alive_flag.store(false, Ordering::SeqCst);
        wake.notify_one();

        let res = tokio::time::timeout(Duration::from_secs(2), handle).await;
        assert!(res.is_ok(), "repair loop must wake immediately instead of sleeping 60s");
        assert_eq!(res.unwrap().unwrap(), None);
    }
}
