//! An explicit user login in Nocturne's own Chrome profile. Never attach to a personal profile.
use std::{path::PathBuf, process::{Child, Command, Stdio}, time::{Duration, Instant}};
use cookie::{Cookie, SameSite, time::OffsetDateTime};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use url::Url;
use super::session_cookies::SessionCookie;
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

const LOGIN_URL: &str = "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F";
const TRANSPORT_ERROR: &str = "Окно входа Chrome не ответило. Закройте его и повторите вход.";
const NOT_SIGNED_IN: &str = "Завершите вход в Spotify в окне Chrome и дождитесь открытия веб-плеера, затем нажмите «Я вошёл».";
const LIMIT: usize = 256 * 1024;

fn remove_profile(root: &std::path::Path, profile: &std::path::Path) {
    if let Ok(profile) = profile.canonicalize() {
        if profile.parent() == Some(root) && profile.file_name().and_then(|name| name.to_str()).is_some_and(|name| uuid::Uuid::parse_str(name).is_ok()) {
            for attempt in 0..6 {
                if std::fs::remove_dir_all(&profile).is_ok() || !profile.exists() {
                    break;
                }
                if attempt < 5 {
                    std::thread::sleep(Duration::from_millis(60));
                }
            }
        }
    }
}
pub fn cleanup_orphans(root: &std::path::Path) {
    let Ok(root) = root.canonicalize() else { return };
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    for entry in entries.flatten() { remove_profile(&root, &entry.path()); }
}

fn opaque_id(id: &str) -> bool { !id.is_empty() && id.len() <= 100 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') }
fn debugger_url(text: &str) -> Result<Url, String> {
    let error = || TRANSPORT_ERROR.to_owned();
    if text.len() > 200 { return Err(error()); }
    let mut lines = text.lines();
    let port: u16 = lines.next().ok_or_else(error)?.parse().map_err(|_| error())?;
    let path = lines.next().ok_or_else(error)?;
    if port < 1024 || lines.next().is_some() || !path.strip_prefix("/devtools/browser/").is_some_and(opaque_id) { return Err(error()); }
    Url::parse(&format!("ws://127.0.0.1:{port}{path}")).map_err(|_| error())
}
fn page_socket(raw: &str, port: u16) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| TRANSPORT_ERROR.to_owned())?;
    if url.scheme() != "ws" || url.host_str() != Some("127.0.0.1") || url.port() != Some(port)
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || !url.path().strip_prefix("/devtools/page/").is_some_and(opaque_id) { return Err(TRANSPORT_ERROR.into()); }
    Ok(url)
}
fn spotify_cookie(value: &Value, now: i64) -> Option<SessionCookie> {
    let name = value["name"].as_str()?;
    let content = value["value"].as_str()?;
    let domain = value["domain"].as_str()?;
    if !matches!(domain, ".spotify.com" | "spotify.com" | "open.spotify.com" | "accounts.spotify.com")
        || name.is_empty() || name.len() > 256 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || content.len() > 8192 || content.bytes().any(|b| b <= 32 || b >= 127 || b == b';') { return None; }
    let secure = value["secure"].as_bool().unwrap_or(false);
    let http_only = value["httpOnly"].as_bool().unwrap_or(false);
    if name == "sp_dc" && (!secure || !http_only || content.is_empty()) { return None; }
    let path = value["path"].as_str().unwrap_or("/");
    if !path.starts_with('/') || path.len() > 1024 || path.bytes().any(|b| b <= 32 || b == b';') { return None; }
    let mut cookie = Cookie::new(name.to_owned(), content.to_owned());
    cookie.set_domain(domain.to_owned()); cookie.set_path(path.to_owned());
    cookie.set_secure(secure); cookie.set_http_only(http_only);
    match value["sameSite"].as_str() {
        Some("Lax") => cookie.set_same_site(SameSite::Lax), Some("Strict") => cookie.set_same_site(SameSite::Strict),
        Some("None") if secure => cookie.set_same_site(SameSite::None), _ => {},
    }
    if !value["session"].as_bool().unwrap_or(false) {
        let expires = value["expires"].as_f64()?;
        if !expires.is_finite() || expires <= now as f64 { return None; }
        cookie.set_expires(OffsetDateTime::from_unix_timestamp(expires as i64).ok()?);
    }
    Some(SessionCookie { cookie, domain: domain.to_owned() })
}

async fn cdp(url: &Url, method: &str, params: Value) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(4), async {
        let config = WebSocketConfig::default().max_message_size(Some(LIMIT)).max_frame_size(Some(LIMIT));
        let (mut socket, _) = tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), false).await.map_err(|_| TRANSPORT_ERROR)?;
        socket.send(Message::Text(json!({"id":1,"method":method,"params":params}).to_string().into())).await.map_err(|_| TRANSPORT_ERROR)?;
        for _ in 0..32 {
            let Some(message) = socket.next().await else { break };
            match message.map_err(|_| TRANSPORT_ERROR)? {
                Message::Text(text) => {
                    let reply: Value = serde_json::from_str(&text).map_err(|_| TRANSPORT_ERROR)?;
                    if reply["id"] == 1 {
                        if reply.get("error").is_some() { return Err(TRANSPORT_ERROR.to_owned()); }
                        let _ = socket.close(None).await;
                        return Ok(reply["result"].clone());
                    }
                },
                Message::Close(_) if method == "Browser.close" => return Ok(Value::Null),
                _ => {},
            }
        }
        Err(TRANSPORT_ERROR.to_owned())
    }).await.map_err(|_| TRANSPORT_ERROR.to_owned())?
}

pub struct BrowserLogin {
    child: Option<Child>,
    profile: PathBuf,
    root: PathBuf,
    debugger: Option<Url>,
    client: reqwest::Client,
    started: Instant,
    #[cfg(windows)]
    job: Option<OwnedHandle>,
}
#[cfg(windows)]
fn browser_job(child: &mut Child) -> Result<OwnedHandle, String> {
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() { let _ = child.kill(); return Err(TRANSPORT_ERROR.into()); }
        let job = OwnedHandle::from_raw_handle(raw);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(raw, JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&limits) as u32) == 0
            || AssignProcessToJobObject(raw, child.as_raw_handle()) == 0 {
            let _ = child.kill(); let _ = child.wait(); return Err(TRANSPORT_ERROR.into());
        }
        Ok(job)
    }
}
impl BrowserLogin {
    pub fn id(&self) -> String { self.profile.file_name().unwrap().to_string_lossy().into_owned() }
    pub async fn start(root: PathBuf) -> Result<Self, String> {
        let chrome = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].into_iter()
            .filter_map(std::env::var_os).map(|base| PathBuf::from(base).join("Google/Chrome/Application/chrome.exe"))
            .find(|path| path.is_file()).ok_or("Для этого входа установите Google Chrome.")?;
        std::fs::create_dir_all(&root).map_err(|_| "Не удалось создать профиль окна входа")?;
        let root = root.canonicalize().map_err(|_| TRANSPORT_ERROR)?;
        cleanup_orphans(&root);
        let profile = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&profile).map_err(|_| TRANSPORT_ERROR)?;
        let cleanup_early = |root: &std::path::Path, profile: &std::path::Path| {
            remove_profile(root, profile);
        };
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(_) => { cleanup_early(&root, &profile); return Err(TRANSPORT_ERROR.into()); }
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(_) => { cleanup_early(&root, &profile); return Err(TRANSPORT_ERROR.into()); }
        };
        drop(listener);
        let client = match reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(4)).build() {
            Ok(c) => c,
            Err(_) => { cleanup_early(&root, &profile); return Err(TRANSPORT_ERROR.into()); }
        };
        let mut child = match Command::new(chrome)
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg(format!("--remote-debugging-port={port}"))
            .args(["--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--new-window", LOGIN_URL])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
        {
            Ok(c) => c,
            Err(_) => { cleanup_early(&root, &profile); return Err("Не удалось открыть Chrome".into()); }
        };
        #[cfg(windows)]
        let job = match browser_job(&mut child) {
            Ok(j) => Some(j),
            Err(e) => { cleanup_early(&root, &profile); return Err(e); }
        };
        let mut login = Self { child: Some(child), profile, root, debugger: None, client: client.clone(), started: Instant::now(), #[cfg(windows)] job };
        for _ in 0..100 {
            if login.child.as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_some()) {
                return Err(TRANSPORT_ERROR.into());
            }
            if let Ok(text) = std::fs::read_to_string(login.profile.join("DevToolsActivePort")) {
                // DevToolsActivePort may be read while Chrome is still flushing it; retry on parse failure.
                if let Ok(url) = debugger_url(&text) {
                    if url.port() != Some(port) { return Err(TRANSPORT_ERROR.into()); }
                    login.debugger = Some(url);
                    return Ok(login);
                }
            }
            if let Ok(response) = client.get(format!("http://127.0.0.1:{port}/json/version")).timeout(Duration::from_millis(250)).send().await {
                if response.content_length().is_some_and(|size| size <= 16384) {
                    if let Ok(value) = response.json::<Value>().await {
                        if let Some(raw) = value["webSocketDebuggerUrl"].as_str() {
                            if let Ok(url) = Url::parse(raw) {
                                if let Ok(expected) = debugger_url(&format!("{port}\n{}", url.path())) {
                                    if url != expected { return Err(TRANSPORT_ERROR.into()); }
                                    login.debugger = Some(url);
                                    return Ok(login);
                                }
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        Err(TRANSPORT_ERROR.into())
    }
    pub fn expired(&mut self) -> bool {
        self.started.elapsed() > Duration::from_secs(600)
            || self.child.as_mut().is_none_or(|c| c.try_wait().ok().flatten().is_some())
    }
    pub fn probe_info(&mut self) -> Result<(u16, reqwest::Client), String> {
        if self.expired() { return Err(TRANSPORT_ERROR.into()); }
        let port = self.debugger.as_ref().and_then(Url::port).ok_or(TRANSPORT_ERROR)?;
        Ok((port, self.client.clone()))
    }
    pub async fn fetch_cookies(port: u16, client: reqwest::Client) -> Result<Vec<SessionCookie>, String> {
        let mut response = client.get(format!("http://127.0.0.1:{port}/json/list")).send().await.map_err(|_| TRANSPORT_ERROR)?;
        if !response.status().is_success() { return Err(TRANSPORT_ERROR.into()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| TRANSPORT_ERROR)? {
            if bytes.len() + chunk.len() > LIMIT { return Err(TRANSPORT_ERROR.into()); }
            bytes.extend_from_slice(&chunk);
        }
        let pages: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| TRANSPORT_ERROR)?;
        let spotify_page = |page: &&Value, allowed: &[&str]| {
            page["type"] == "page" && page["url"].as_str().and_then(|raw| Url::parse(raw).ok()).is_some_and(|url| url.scheme() == "https" && url.host_str().is_some_and(|h| allowed.contains(&h)))
        };
        let page = pages.iter().find(|p| spotify_page(p, &["open.spotify.com"]))
            .or_else(|| pages.iter().find(|p| spotify_page(p, &["accounts.spotify.com", "www.spotify.com"])))
            .ok_or(NOT_SIGNED_IN)?;
        let socket = page_socket(page["webSocketDebuggerUrl"].as_str().ok_or(TRANSPORT_ERROR)?, port)?;
        // Restrict the request itself, not just the output: Google's cookies are never requested.
        let reply = cdp(&socket, "Network.getCookies", json!({"urls":["https://open.spotify.com/","https://accounts.spotify.com/","https://www.spotify.com/"]})).await?;
        let list = reply["cookies"].as_array().filter(|list| list.len() <= 200).ok_or(TRANSPORT_ERROR)?;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let cookies: Vec<_> = list.iter().filter_map(|value| spotify_cookie(value, now)).collect();
        if !cookies.iter().any(|cookie| cookie.cookie.name() == "sp_dc") { return Err(NOT_SIGNED_IN.into()); }
        Ok(cookies)
    }
    #[allow(dead_code)]
    pub async fn cookies(&mut self) -> Result<Vec<SessionCookie>, String> {
        let (port, client) = self.probe_info()?;
        Self::fetch_cookies(port, client).await
    }
    pub async fn close(mut self) {
        if let Some(url) = self.debugger.take() { let _ = cdp(&url, "Browser.close", json!({})).await; }
        let child = self.child.take();
        #[cfg(windows)]
        let job = self.job.take();
        let root = self.root.clone();
        let profile = self.profile.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            #[cfg(windows)]
            drop(job);
            if let Some(mut c) = child {
                if c.try_wait().ok().flatten().is_none() { let _ = c.kill(); }
                let _ = c.wait();
            }
            remove_profile(&root, &profile);
        }).await;
    }
}
impl Drop for BrowserLogin {
    fn drop(&mut self) {
        #[cfg(windows)]
        let job = self.job.take();
        let child = self.child.take();
        if child.is_none() {
            return;
        }
        let root = self.root.clone();
        let profile = self.profile.clone();
        // Never block a Tokio async worker thread if dropped synchronously (e.g. during shutdown).
        std::thread::spawn(move || {
            #[cfg(windows)]
            drop(job);
            if let Some(mut c) = child {
                if c.try_wait().ok().flatten().is_none() { let _ = c.kill(); }
                let _ = c.wait();
            }
            remove_profile(&root, &profile);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn debugger_discovery_is_bounded_to_the_owned_loopback_browser() {
        assert_eq!(debugger_url("31567\n/devtools/browser/fixture-id\n").unwrap().as_str(), "ws://127.0.0.1:31567/devtools/browser/fixture-id");
        for raw in ["0\n/devtools/browser/id", "80\n/devtools/browser/id", "31567\nhttps://evil.test/", "31567\n/devtools/browser/../../other", "31567\n/devtools/browser/id?token=extra", "31567\n/devtools/browser/id\nextra"] { assert!(debugger_url(raw).is_err(), "{raw}"); }
        assert!(page_socket("ws://127.0.0.1:31567/devtools/page/fixture-id", 31567).is_ok());
        for raw in ["ws://evil.test:31567/devtools/page/id", "ws://127.0.0.1:31568/devtools/page/id", "ws://user@127.0.0.1:31567/devtools/page/id", "ws://127.0.0.1:31567/other", "ws://127.0.0.1:31567/devtools/page/id?x=1"] { assert!(page_socket(raw, 31567).is_err(), "{raw}"); }
    }
    #[test]
    fn session_import_preserves_cookie_flags_and_excludes_other_accounts() {
        let base = json!({"name":"sp_dc","value":"fixture-session","domain":".spotify.com","path":"/","secure":true,"httpOnly":true,"sameSite":"Lax","expires":2000000000.0});
        let session = spotify_cookie(&base, 1800000000).unwrap();
        assert_eq!(session.domain, ".spotify.com");
        let cookie = session.cookie;
        assert_eq!(cookie.name(), "sp_dc");
        assert_eq!(cookie.value(), "fixture-session");
        assert_eq!(cookie.domain(), Some("spotify.com"));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(cookie::SameSite::Lax));
        assert_eq!(cookie.expires_datetime().unwrap().unix_timestamp(), 2000000000);
        for domain in [".google.com", ".spotify.com.evil.test", ".evilspotify.com", "analytics.spotify.com"] {
            let mut item=base.clone(); item["domain"]=json!(domain); assert!(spotify_cookie(&item,1800000000).is_none());
        }
        let mut expired=base.clone(); expired["expires"]=json!(1700000000); assert!(spotify_cookie(&expired,1800000000).is_none());
        let mut insecure=base.clone(); insecure["secure"]=json!(false); assert!(spotify_cookie(&insecure,1800000000).is_none());
        let mut invalid=base.clone(); invalid["name"]=json!("bad\r\nname"); assert!(spotify_cookie(&invalid,1800000000).is_none());
    }
}
