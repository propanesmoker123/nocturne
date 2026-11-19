mod rules;
mod browser_login;
mod session_cookies;

use std::sync::{atomic::{AtomicBool, AtomicU32, Ordering}, Mutex};
use std::time::Duration;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, Webview, WebviewUrl, WebviewWindowBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tokio::sync::oneshot;

pub const LABEL: &str = "spotify-player";
const POPUP: &str = "spotify-login-";
static POPUPS: AtomicU32 = AtomicU32::new(0);
pub struct SpotifyState {
    enabled: AtomicBool,
    ready: AtomicBool,
    harmony_ready: AtomicBool,
    cookie_checked: AtomicBool,
    has_cookie: AtomicBool,
    gate: tokio::sync::Mutex<()>,
    playback_revision: AtomicU32,
    playback_dispatch: tokio::sync::Mutex<()>,
    login: tokio::sync::Mutex<Option<browser_login::BrowserLogin>>,
}
impl SpotifyState {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            harmony_ready: AtomicBool::new(false),
            cookie_checked: AtomicBool::new(false),
            has_cookie: AtomicBool::new(false),
            gate: tokio::sync::Mutex::new(()),
            playback_revision: AtomicU32::new(0),
            playback_dispatch: tokio::sync::Mutex::new(()),
            login: tokio::sync::Mutex::new(None),
        }
    }

    fn next_playback_revision(&self) -> u32 {
        self.playback_revision.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
    }

    fn is_current_playback(&self, revision: u32) -> bool {
        self.playback_revision.load(Ordering::Relaxed) == revision
    }
}
pub fn shutdown(app: &AppHandle) {
    if let Ok(mut login) = app.state::<SpotifyState>().login.try_lock() { login.take(); }
}
pub fn cleanup_login_profiles(app: &AppHandle) {
    // Called at startup before any login, after the single-instance guard has run.
    if let Ok(root) = app.path().app_local_data_dir() { browser_login::cleanup_orphans(&root.join("spotify-chrome-login")); }
}
pub fn prewarm_if_active(app: AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let is_spotify = std::fs::read_to_string(dir.join("service.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["data"].as_str().map(|s| s == "spotify"))
        .unwrap_or(false);
    if !is_spotify { return; }
    let filter_enabled = std::fs::read_to_string(dir.join("spotify-filter.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["data"].as_bool())
        .unwrap_or(true);
    app.state::<SpotifyState>().enabled.store(filter_enabled, Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        let Ok(url) = rules::target_url("home", None) else { return };
        let st = app.state::<SpotifyState>();
        let _gate = st.gate.lock().await;
        let _ = ensure_webview(&app, &st, hidden_rect(), url, false, false);
    });
}
fn main_only(window: &Webview) -> Result<(), String> {
    if window.label() != "main" { return Err("Команда доступна только в главном окне".into()); }
    Ok(())
}
fn script_error(_: impl std::fmt::Display) -> String { "Страница Spotify не ответила. Попробуйте обновить её.".into() }
fn flush_diag(items: Option<&Value>) {
    let Some(list) = items.and_then(|v| v.as_array()) else { return };
    for item in list.iter().filter_map(|v| v.as_str()).take(10) {
        crate::journal::write("spotify", item);
    }
}
async fn eval(view: &Webview, script: &str) -> Result<String, String> {
    let (tx, rx) = oneshot::channel();
    let slot = Mutex::new(Some(tx));
    view.eval_with_callback(script.to_owned(), move |value| {
        if let Some(tx) = slot.lock().ok().and_then(|mut s| s.take()) { let _ = tx.send(value); }
    }).map_err(script_error)?;
    tokio::time::timeout(Duration::from_secs(3), rx).await.map_err(script_error)?.map_err(script_error)
}
#[derive(Deserialize)]
pub struct Bounds { x: f64, y: f64, width: f64, height: f64 }
fn hidden_rect() -> Rect {
    Rect { position: LogicalPosition::new(-4.0, -4.0).into(), size: LogicalSize::new(2.0, 2.0).into() }
}
fn has_sp_dc(view: &Webview) -> bool {
    view.cookies_for_url("https://open.spotify.com/".parse().unwrap())
        .map(|list| list.iter().any(|c| c.name() == "sp_dc" && !c.value().is_empty()))
        .unwrap_or(false)
}
fn checked_bounds(app: &AppHandle, b: &Bounds) -> Result<Rect, String> {
    let window = app.get_window("main").ok_or("Главное окно закрыто")?;
    let size = window.inner_size().map_err(script_error)?.to_logical::<f64>(window.scale_factor().map_err(script_error)?);
    if !rules::valid_bounds(b.x,b.y,b.width,b.height,size.width,size.height) { return Err("Недопустимый размер области Spotify".into()); }
    Ok(Rect { position: LogicalPosition::new(b.x,b.y).into(), size: LogicalSize::new(b.width,b.height).into() })
}

fn ensure_webview(app: &AppHandle, st: &SpotifyState, rect: Rect, url: url::Url, visible: bool, update_bounds: bool) -> Result<(Webview, bool), String> {
    let target_rect = if visible { rect } else { hidden_rect() };
    if let Some(view) = app.get_webview(LABEL) {
        if update_bounds {
            view.set_bounds(target_rect).map_err(script_error)?;
            let _ = view.show();
        }
        return Ok((view, false));
    }
    let profile = app.path().app_local_data_dir().map_err(script_error)?.join("spotify-webview");
    let popup_profile = profile.clone();
    let popup_app = app.clone();
    let popup_navigation_app = app.clone();
    let page_app = app.clone();
    let navigation_app = app.clone();
    let init = format!("{}\nwindow.__nocturneSpotifyLab?.configure({});\n{}", include_str!("filter.js"), st.enabled.load(Ordering::Relaxed),
        "if(location.origin==='https://open.spotify.com') { window.__nocturneSpotifyDrm=null; navigator.requestMediaKeySystemAccess?.('com.widevine.alpha',[{initDataTypes:['cenc'],audioCapabilities:[{contentType:'audio/mp4; codecs=\"mp4a.40.2\"'}]}]).then(()=>{window.__nocturneSpotifyDrm=true}).catch(()=>{window.__nocturneSpotifyDrm=false}); }");
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .data_directory(profile)
        .initialization_script(init)
        .on_navigation(move |url| {
            if matches!(url.host_str(), Some("accounts.google.com" | "appleid.apple.com" | "idmsa.apple.com" | "www.facebook.com")) && rules::allowed_navigation(url) {
                let _ = navigation_app.emit_to("main", "spotify:external-login", ());
                return false;
            }
            rules::allowed_navigation(url)
        })
        .on_download(|_,_| false)
        .on_new_window(move |url, features| {
            if !rules::allowed_navigation(&url) { return NewWindowResponse::Deny; }
            if !matches!(url.host_str(), Some("open.spotify.com" | "accounts.spotify.com" | "www.spotify.com")) {
                let _ = popup_app.emit_to("main", "spotify:external-login", ());
                return NewWindowResponse::Deny;
            }
            if popup_app.webview_windows().keys().filter(|label| label.starts_with(POPUP)).count() >= 2 { return NewWindowResponse::Deny; }
            let label = format!("{POPUP}{}", POPUPS.fetch_add(1,Ordering::Relaxed));
            let navigation_app = popup_navigation_app.clone();
            match WebviewWindowBuilder::new(&popup_app,label,WebviewUrl::External("about:blank".parse().unwrap()))
                .window_features(features).data_directory(popup_profile.clone()).title("Вход в Spotify — Nocturne")
                .on_navigation(move |url| {
                    if rules::allowed_navigation(url) && !matches!(url.host_str(), Some("open.spotify.com" | "accounts.spotify.com" | "www.spotify.com")) {
                        let _ = navigation_app.emit_to("main", "spotify:external-login", ()); return false;
                    }
                    url.as_str() == "about:blank" || rules::allowed_navigation(url)
                })
                .on_new_window(|_,_| NewWindowResponse::Deny).build() {
                Ok(window) => NewWindowResponse::Create { window }, Err(_) => NewWindowResponse::Deny,
            }
        })
        .on_page_load(move |view, payload| {
            match payload.event() {
                PageLoadEvent::Started => {
                    let st = page_app.state::<SpotifyState>();
                    st.ready.store(false, Ordering::Relaxed);
                    st.harmony_ready.store(false, Ordering::Relaxed);
                }
                PageLoadEvent::Finished => {
                    let enabled = page_app.state::<SpotifyState>().enabled.load(Ordering::Relaxed);
                    let _ = view.eval(format!("window.__nocturneSpotifyLab?.configure({enabled})"));
                    let _ = page_app.emit_to("main","spotify:page",());
                }
            }
        });
    let parent = app.get_window("main").ok_or("Главное окно закрыто")?;
    let child = parent.add_child(builder, target_rect.position, target_rect.size).map_err(script_error)?;
    let _ = child.show();
    Ok((child, true))
}

async fn hidden_ready_view(app: &AppHandle, st: &SpotifyState) -> Result<Webview, String> {
    let view = if let Some(v) = app.get_webview(LABEL) {
        if st.ready.load(Ordering::Relaxed) {
            return Ok(v);
        }
        v
    } else {
        st.ready.store(false, Ordering::Relaxed);
        let _gate = st.gate.lock().await;
        ensure_webview(app, st, hidden_rect(), rules::target_url("home", None)?, false, false)?.0
    };
    let ready = tokio::time::timeout(Duration::from_secs(12), async {
        for step in 0..70 {
            if eval(&view, "Boolean(location.origin === 'https://open.spotify.com' && window.__nocturneSpotifyLab)").await.as_deref() == Ok("true") {
                st.ready.store(true, Ordering::Relaxed);
                return true;
            }
            let delay_ms = if step < 8 { 30 } else if step < 20 { 55 } else { 100 };
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        false
    }).await;
    if matches!(ready, Ok(true)) {
        return Ok(view);
    }
    Err("Страница Spotify ещё загружается. Повторите через пару секунд.".into())
}

async fn run_lab_job(view: &Webview, spec: Value) -> Result<Value, String> {
    let key = uuid::Uuid::new_v4().simple().to_string();
    let key_json = serde_json::to_string(&key).unwrap();
    let kind = spec["kind"].as_str().unwrap_or("unknown");
    let target = spec["path"].as_str().and_then(|p| p.split('?').next()).unwrap_or("");
    let started = eval(view, &format!("window.__nocturneSpotifyLab?.startJob({key_json}, {spec}) ?? false")).await?;
    if started != "true" { return Err("Плеер Spotify не готов".into()); }
    let drop_job = || {
        let _ = view.eval(format!("window.__nocturneSpotifyLab?.dropJob?.({key_json})"));
    };
    for step in 0..120 {
        let raw = match eval(view, &format!("window.__nocturneSpotifyLab?.pollJob({key_json}) ?? {{done:true,ok:false,error:'MISSING'}}")).await {
            Ok(r) => r,
            Err(e) => { drop_job(); return Err(e); }
        };
        let poll: Value = match serde_json::from_str(&raw) {
            Ok(p) => p,
            Err(e) => { drop_job(); return Err(script_error(e)); }
        };
        if poll["done"].as_bool() == Some(true) {
            if poll["ok"].as_bool() == Some(true) { return Ok(poll["data"].clone()); }
            let code = poll["error"].as_str().unwrap_or("ERROR");
            crate::journal::write("spotify", &format!("lab {kind} {target} failed: {code}"));
            return Err(match code {
                "SIGNED_OUT" | "HTTP_401" => "SIGNED_OUT".into(),
                "HTTP_429" => "Spotify временно ограничил запросы (HTTP_429). Подождите пару секунд и повторите.".into(),
                _ => format!("Ошибка запроса Spotify ({code})"),
            });
        }
        let delay_ms = if step < 12 { 15 } else if step < 25 { 35 } else if step < 40 { 65 } else { 100 };
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
    drop_job();
    crate::journal::write("spotify", &format!("lab {kind} {target} timed out"));
    Err("Превышено время ожидания ответа от Spotify".into())
}

#[tauri::command]
pub async fn spotify_open(app: AppHandle, window: Webview, bounds: Bounds, page: String, value: Option<String>, visible: bool, st: State<'_, SpotifyState>) -> Result<(), String> {
    main_only(&window)?;
    let _gate = st.gate.lock().await;
    let rect = checked_bounds(&app, &bounds)?;
    let url = rules::target_url(&page,value.as_deref())?;
    let (view, created) = ensure_webview(&app, &st, rect, url.clone(), visible, true)?;
    if !created && page != "resume" {
        st.ready.store(false, Ordering::Relaxed);
        st.harmony_ready.store(false, Ordering::Relaxed);
        view.navigate(url).map_err(script_error)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn spotify_bounds(app: AppHandle, window: Webview, bounds: Bounds, visible: bool) -> Result<(), String> {
    main_only(&window)?;
    let Some(view) = app.get_webview(LABEL) else { return Ok(()) };
    if !visible {
        view.set_bounds(hidden_rect()).map_err(script_error)?;
        let _ = view.show();
        return Ok(());
    }
    view.set_bounds(checked_bounds(&app,&bounds)?).map_err(script_error)?;
    view.show().map_err(script_error)
}
#[tauri::command]
pub async fn spotify_filter(app: AppHandle, window: Webview, enabled: bool, st: State<'_, SpotifyState>) -> Result<(), String> {
    main_only(&window)?;
    st.enabled.store(enabled,Ordering::Relaxed);
    if let Some(view) = app.get_webview(LABEL) {
        view.eval(format!("window.__nocturneSpotifyLab?.configure({enabled})")).map_err(script_error)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn spotify_close(app: AppHandle, window: Webview, st: State<'_, SpotifyState>) -> Result<(), String> {
    main_only(&window)?;
    st.next_playback_revision();
    st.ready.store(false, Ordering::Relaxed);
    st.harmony_ready.store(false, Ordering::Relaxed);
    st.cookie_checked.store(false, Ordering::Relaxed);
    let prev_login = st.login.lock().await.take();
    if let Some(login) = prev_login { login.close().await; }
    let _gate = st.gate.lock().await;
    for (label, popup) in app.webview_windows() { if label.starts_with(POPUP) { let _ = popup.destroy(); } }
    if let Some(view) = app.get_webview(LABEL) {
        view.close().map_err(script_error)?;
        for _ in 0..40 {
            if app.get_webview(LABEL).is_none() { break; }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn spotify_control(app: AppHandle, window: Webview, action: String, value: Option<f64>, st: State<'_, SpotifyState>) -> Result<bool,String> {
    main_only(&window)?;
    if !rules::control_allowed(&action, value) { return Err("Неизвестное действие Spotify".into()); }
    let _dispatch = if matches!(action.as_str(), "pause" | "play" | "toggle" | "next" | "previous" | "reload") {
        let revision = st.next_playback_revision();
        let lock = st.playback_dispatch.lock().await;
        if !st.is_current_playback(revision) { return Ok(false); }
        Some(lock)
    } else {
        None
    };
    let Some(view) = app.get_webview(LABEL) else { return Ok(false) };
    if action == "reload" {
        st.ready.store(false, Ordering::Relaxed);
        st.harmony_ready.store(false, Ordering::Relaxed);
        view.reload().map_err(script_error)?;
        return Ok(true);
    }
    let value = value.map_or_else(|| "null".to_owned(), |value| value.to_string());
    let raw = eval(&view,&format!("window.__nocturneSpotifyLab?.control({}, {value}) ?? false", serde_json::to_string(&action).unwrap())).await?;
    Ok(raw == "true")
}

fn sanitize_fallback_embed(raw: Option<&Value>) -> Value {
    let Some(obj) = raw.and_then(Value::as_object) else { return Value::Null };
    let Some(entity) = obj.get("entity").and_then(Value::as_str).filter(|e| matches!(*e, "playlist" | "album" | "artist" | "track")) else {
        return Value::Null;
    };
    let Some(id) = obj.get("id").and_then(Value::as_str).filter(|id| rules::valid_spotify_id(id)) else {
        return Value::Null;
    };
    json!({ "entity": entity, "id": id })
}

#[tauri::command]
pub async fn spotify_status(app: AppHandle, window: Webview, request: Option<Value>, st: State<'_,SpotifyState>) -> Result<Value,String> {
    main_only(&window)?;
    if let Some(req) = request {
        let kind = req["kind"].as_str().unwrap_or_default();
        // Start commands may spend seconds waiting for WebView2. A newer command or pause takes precedence.
        let play_revision = matches!(kind, "play" | "logout").then(|| st.next_playback_revision());
        if kind == "volume" {
            let Some(view) = app.get_webview(LABEL) else { return Ok(json!({ "ok": false })) };
            let vol = req["volume"].as_f64().unwrap_or(0.8).clamp(0.0, 1.0);
            let muted = req["muted"].as_bool().unwrap_or(false);
            view.eval(format!("window.__nocturneSpotifyLab?.setVolume({vol}, {muted})")).map_err(script_error)?;
            return Ok(json!({ "ok": true }));
        }
        if kind == "warm" {
            let Some(view) = app.get_webview(LABEL) else { return Ok(json!({ "ok": false })) };
            let id_arg = match req.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                Some(id) if rules::valid_spotify_id(id) => serde_json::to_string(id).unwrap(),
                Some(_) => return Err("Некорректный ID трека Spotify".into()),
                None => "null".to_owned(),
            };
            let _ = view.eval(format!("window.__nocturneSpotifyLab?.warmNextTrack?.({id_arg})"));
            return Ok(json!({ "ok": true }));
        }
        if kind == "logout" {
            let active_login = st.login.lock().await.take();
            if let Some(login) = active_login {
                login.close().await;
            }
            let _gate = st.gate.lock().await;
            let _dispatch = st.playback_dispatch.lock().await;
            st.ready.store(false, Ordering::Relaxed);
            st.harmony_ready.store(false, Ordering::Relaxed);
            st.cookie_checked.store(false, Ordering::Relaxed);
            st.has_cookie.store(false, Ordering::Relaxed);
            for (label, popup) in app.webview_windows() {
                if label.starts_with(POPUP) {
                    let _ = popup.destroy();
                }
            }
            let home_url = rules::target_url("home", None)?;
            let view = match app.get_webview(LABEL) {
                Some(v) => Some(v),
                None => ensure_webview(&app, &st, hidden_rect(), home_url.clone(), false, false).ok().map(|(v, _)| v),
            };
            if let Some(view) = view {
                session_cookies::clear(&view).await;
                let _ = view.clear_all_browsing_data();
                tokio::time::sleep(Duration::from_millis(250)).await;
                let _ = view.navigate(home_url);
            }
            return Ok(json!({ "ok": true }));
        }
        let view = hidden_ready_view(&app, &st).await?;
        if kind != "init" {
            return match kind {
                "play" => {
                    let revision = play_revision.ok_or("Missing playback revision")?;
                    if !st.is_current_playback(revision) { return Ok(json!({ "ok": false })); }
                    let id = req["id"].as_str().filter(|id| rules::valid_spotify_id(id)).ok_or("Некорректный ID трека Spotify")?;
                    let start_at = req["startAt"].as_f64().unwrap_or(0.0).clamp(0.0, 86_400.0);
                    let vol_arg = req["volume"].as_f64().map(|v| v.clamp(0.0, 1.0).to_string()).unwrap_or_else(|| "null".into());
                    let muted_arg = req["muted"].as_bool().map(|m| m.to_string()).unwrap_or_else(|| "null".into());
                    let context_uri = req["contextUri"].as_str().map(str::trim).filter(|s| rules::valid_context_uri(s));
                    let album_id = req["albumId"].as_str().map(str::trim).filter(|s| rules::valid_spotify_id(s));
                    let track_uid = req["trackUid"].as_str().map(str::trim).filter(|s| rules::valid_track_uid(s));
                    let prefer_context = req["preferContext"].as_bool().unwrap_or(false);
                    let context_arg = json!({
                        "contextUri": context_uri,
                        "albumId": album_id,
                        "trackUid": track_uid,
                        "preferContext": prefer_context,
                    });
                    if !st.harmony_ready.load(Ordering::Relaxed) {
                        let _ = tokio::time::timeout(Duration::from_secs(3), async {
                            for _ in 0..12 {
                                if !st.is_current_playback(revision) { break; }
                                let ready = eval(&view, "(() => { const s = window.__nocturneSpotifyLab?.stats(); return Boolean(s && (s.hasHarmony || s.hasApi)) || window.__nocturneSpotifyLab?.account() === 'out'; })()").await.unwrap_or_default();
                                if ready == "true" { break; }
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                        }).await;
                    }
                    let _dispatch = st.playback_dispatch.lock().await;
                    if !st.is_current_playback(revision) { return Ok(json!({ "ok": false })); }
                    let raw = eval(
                        &view,
                        &format!(
                            "(() => {{ const ok = window.__nocturneSpotifyLab?.playTrack({}, {start_at}, {vol_arg}, {muted_arg}, {}) ?? false; const st = window.__nocturneSpotifyLab?.stats() ?? {{}}; const diag = window.__nocturneSpotifyLab?.takeDiagnostics?.() ?? []; return {{ ok, drm: window.__nocturneSpotifyDrm ?? null, hasHarmony: Boolean(st.hasHarmony || st.hasApi), err: st.lastPlayError || '', method: st.lastPlayMethod || '', diag }}; }})()",
                            serde_json::to_string(id).unwrap(),
                            serde_json::to_string(&context_arg).unwrap()
                        ),
                    ).await?;
                    let res: Value = serde_json::from_str(&raw).map_err(script_error)?;
                    let ok = res["ok"].as_bool() == Some(true);
                    if res["hasHarmony"].as_bool() == Some(true) {
                        st.harmony_ready.store(true, Ordering::Relaxed);
                    }
                    flush_diag(res.get("diag"));
                    if res["drm"].as_bool() == Some(false) {
                        crate::journal::write("spotify", "play requested while Widevine DRM unavailable");
                    }
                    if !ok {
                        crate::journal::write("spotify", "playTrack rejected");
                    } else if res["hasHarmony"].as_bool() == Some(false) {
                        crate::journal::write("spotify", &format!("play requested without Harmony handle (method={})", res["method"].as_str().unwrap_or("")));
                    } else if let Some(err) = res["err"].as_str().filter(|s| !s.is_empty()) {
                        crate::journal::write("spotify", &format!("play notice: {err}"));
                    }
                    Ok(json!({ "ok": ok }))
                }
                "waveform" => {
                    let id = req["id"].as_str().filter(|id| rules::valid_spotify_id(id)).ok_or("Некорректный ID трека Spotify")?;
                    run_lab_job(&view, json!({ "kind": "waveform", "id": id })).await
                }
                "embed" => {
                    let entity = req["entity"].as_str().filter(|e| matches!(*e, "playlist" | "album" | "artist" | "track")).ok_or("Неизвестный тип объекта Spotify")?;
                    let id = req["id"].as_str().filter(|id| rules::valid_spotify_id(id)).ok_or("Некорректный ID Spotify")?;
                    run_lab_job(&view, json!({ "kind": "embed", "entity": entity, "id": id })).await
                }
                "api" => {
                    let method = req["method"].as_str().unwrap_or("GET");
                    let path = req["path"].as_str().filter(|p| rules::valid_api_path(method, p)).ok_or("Недопустимый запрос к API Spotify")?;
                    let fallback = sanitize_fallback_embed(req.get("fallbackEmbed"));
                    run_lab_job(&view, json!({ "kind": "api", "method": method, "path": path, "fallbackEmbed": fallback })).await
                }
                _ => Err("Неизвестный запрос к Spotify".into()),
            };
        }
    }
    let (login_waiting, expired_login) = {
        let mut login = st.login.lock().await;
        let expired = if login.as_mut().is_some_and(|l| l.expired()) { login.take() } else { None };
        (login.is_some(), expired)
    };
    if let Some(l) = expired_login {
        l.close().await;
    }
    let Some(view) = app.get_webview(LABEL) else { return Ok(json!({"open":false,"enabled":st.enabled.load(Ordering::Relaxed),"loginWaiting":login_waiting})) };
    let raw = eval(&view, r#"(() => {
      const origin=location.origin;
      const phase=origin==='https://www.spotify.com' && location.pathname.includes('why-not-available')?'region':origin==='https://open.spotify.com'?'ready':['https://accounts.spotify.com','https://accounts.google.com','https://appleid.apple.com','https://idmsa.apple.com','https://www.facebook.com'].includes(origin)?'login':'loading';
      const diag=window.__nocturneSpotifyLab?.takeDiagnostics?.()??[];
      return {open:true,phase,title:document.title.slice(0,160),drm:window.__nocturneSpotifyDrm??null,playing:window.__nocturneSpotifyLab?.playing()??null,nowPlaying:window.__nocturneSpotifyLab?.nowPlaying()??null,account:window.__nocturneSpotifyLab?.account()??null,diag,...(window.__nocturneSpotifyLab?.stats()??{})};
    })()"#).await?;
    let mut status: Value = serde_json::from_str(&raw).map_err(script_error)?;
    if !status.is_object() {
        return Err(script_error("invalid status payload"));
    }
    let diag = status.as_object_mut().and_then(|o| o.remove("diag"));
    flush_diag(diag.as_ref());
    if status["phase"].as_str() == Some("ready") {
        st.ready.store(true, Ordering::Relaxed);
    }
    match status["account"].as_str() {
        Some("in") => {
            st.has_cookie.store(true, Ordering::Relaxed);
            st.cookie_checked.store(true, Ordering::Relaxed);
        }
        Some("out") => {
            // Explicit "out" from the page (login button or anonymous token): never overwrite with stale cached has_cookie.
            st.has_cookie.store(false, Ordering::Relaxed);
            st.cookie_checked.store(true, Ordering::Relaxed);
        }
        _ => {
            let has_cookie = if !st.cookie_checked.swap(true, Ordering::Relaxed) || login_waiting {
                let c = has_sp_dc(&view);
                st.has_cookie.store(c, Ordering::Relaxed);
                c
            } else {
                st.has_cookie.load(Ordering::Relaxed)
            };
            if has_cookie {
                status["account"] = json!("in");
            }
        }
    }
    status["loginWaiting"] = json!(login_waiting);
    Ok(status)
}

async fn complete_login(app: &AppHandle, st: &SpotifyState) -> Result<(), String> {
    let view = if let Some(v) = app.get_webview(LABEL) {
        v
    } else {
        let _gate = st.gate.lock().await;
        ensure_webview(app, st, hidden_rect(), rules::target_url("home", None)?, false, false)?.0
    };
    let probe = {
        let mut login = st.login.lock().await;
        match login.as_mut() {
            Some(l) => Some((l.id(), l.probe_info()?)),
            None => None,
        }
    };
    let Some((login_id, (port, client))) = probe else {
        if has_sp_dc(&view) {
            return Ok(());
        }
        return Err("Сначала нажмите «Войти через Chrome»".into());
    };
    let cookies = browser_login::BrowserLogin::fetch_cookies(port, client).await?;
    let expected = cookies.iter().find(|cookie| cookie.cookie.name() == "sp_dc").map(|cookie| cookie.cookie.value().to_owned()).ok_or("Spotify не подтвердил вход")?;
    {
        let _gate = st.gate.lock().await;
        session_cookies::write(&view, cookies).await?;
        let imported = view.cookies_for_url("https://open.spotify.com/".parse().unwrap()).map_err(|_| "Не удалось проверить вход в плеер Spotify")?;
        if !imported.iter().any(|cookie| cookie.name() == "sp_dc" && cookie.value() == expected) {
            return Err("Вход пока не передан в плеер. Оставьте окно Chrome открытым и повторите попытку.".into());
        }
        st.ready.store(false, Ordering::Relaxed);
        st.harmony_ready.store(false, Ordering::Relaxed);
        st.has_cookie.store(true, Ordering::Relaxed);
        st.cookie_checked.store(true, Ordering::Relaxed);
        view.navigate(rules::target_url("home",None)?).map_err(script_error)?;
    }
    let finished_login = {
        let mut login = st.login.lock().await;
        if login.as_ref().is_some_and(|l| l.id() == login_id) { login.take() } else { None }
    };
    if let Some(login) = finished_login { login.close().await; }
    if let Some(main) = app.get_window("main") { let _ = main.unminimize(); let _ = main.show(); let _ = main.set_focus(); }
    let _ = app.emit_to("main","spotify:page",());
    Ok(())
}

#[tauri::command]
pub async fn spotify_login_start(app: AppHandle, window: Webview, st: State<'_, SpotifyState>) -> Result<(), String> {
    main_only(&window)?;
    let expired_prev = {
        let mut login = st.login.lock().await;
        if login.as_mut().is_some_and(|login| !login.expired()) { return Ok(()); }
        login.take()
    };
    if let Some(prev) = expired_prev {
        prev.close().await;
    }
    let root = app.path().app_local_data_dir().map_err(script_error)?.join("spotify-chrome-login");
    let started = browser_login::BrowserLogin::start(root).await?;
    let id = started.id();
    {
        let mut login = st.login.lock().await;
        if login.as_mut().is_some_and(|l| !l.expired()) {
            drop(login);
            started.close().await;
            return Ok(());
        }
        *login = Some(started);
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<SpotifyState>();
        for _ in 0..400 {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let (active, expired) = {
                let mut login = state.login.lock().await;
                if login.as_mut().is_some_and(|l| l.id() == id && l.expired()) {
                    (false, login.take())
                } else {
                    (login.as_ref().is_some_and(|l| l.id() == id), None)
                }
            };
            if let Some(l) = expired {
                l.close().await;
                let _ = app.emit_to("main", "spotify:page", ());
            }
            if !active { return; }
            if complete_login(&app, &state).await.is_ok() { return; }
        }
        let timed_out = {
            let mut login = state.login.lock().await;
            if login.as_ref().is_some_and(|l| l.id() == id) { login.take() } else { None }
        };
        if let Some(login) = timed_out {
            login.close().await;
            let _ = app.emit_to("main", "spotify:page", ());
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn spotify_login_finish(app: AppHandle, window: Webview, st: State<'_, SpotifyState>) -> Result<(), String> {
    main_only(&window)?;
    complete_login(&app, &st).await
}
#[tauri::command]
pub async fn spotify_login_cancel(window: Webview, st: State<'_, SpotifyState>) -> Result<(), String> {
    main_only(&window)?;
    let active = st.login.lock().await.take();
    if let Some(login) = active { login.close().await; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_fallback_embed_strictly() {
        let valid = json!({ "entity": "playlist", "id": "37i9dQZF1DXcBWIGoYBM5M", "extra": "dropped" });
        assert_eq!(
            sanitize_fallback_embed(Some(&valid)),
            json!({ "entity": "playlist", "id": "37i9dQZF1DXcBWIGoYBM5M" })
        );
        for invalid in [
            json!(null),
            json!("playlist"),
            json!({ "entity": "evil", "id": "37i9dQZF1DXcBWIGoYBM5M" }),
            json!({ "entity": "playlist", "id": "../bad" }),
        ] {
            assert_eq!(sanitize_fallback_embed(Some(&invalid)), Value::Null);
        }
    }
}
