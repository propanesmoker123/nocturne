//! Preserve host-only versus parent-domain cookie scope across Chrome and WebView2.
pub struct SessionCookie {
    pub cookie: cookie::Cookie<'static>,
    pub domain: String,
}

#[cfg(windows)]
pub async fn write(view: &tauri::Webview, cookies: Vec<SessionCookie>) -> Result<(), String> {
    use windows::core::{HSTRING, Interface};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        let result = (|| -> windows::core::Result<()> {
            unsafe {
                let core = platform.controller().CoreWebView2()?.cast::<ICoreWebView2_2>()?;
                let manager = core.CookieManager()?;
                for session in cookies {
                    let cookie = session.cookie;
                    // Tauri's generic Cookie API strips this leading dot; WebView2 needs it.
                    let item = manager.CreateCookie(&HSTRING::from(cookie.name()), &HSTRING::from(cookie.value()), &HSTRING::from(session.domain), &HSTRING::from(cookie.path().unwrap_or("/")))?;
                    item.SetIsSecure(cookie.secure().unwrap_or(false))?;
                    item.SetIsHttpOnly(cookie.http_only().unwrap_or(false))?;
                    if let Some(expires) = cookie.expires_datetime() { item.SetExpires(expires.unix_timestamp() as f64)?; }
                    if let Some(site) = cookie.same_site() {
                        item.SetSameSite(match site {
                            cookie::SameSite::Strict => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
                            cookie::SameSite::Lax => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
                            cookie::SameSite::None => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
                        })?;
                    }
                    manager.AddOrUpdateCookie(&item)?;
                }
            }
            Ok(())
        })();
        let _ = tx.send(result.is_ok());
    }).map_err(|_| "Не удалось передать вход в плеер Spotify".to_owned())?;
    match tokio::time::timeout(std::time::Duration::from_secs(4),rx).await {
        Ok(Ok(true)) => Ok(()), _ => Err("Не удалось передать вход в плеер Spotify".into()),
    }
}

#[cfg(not(windows))]
pub async fn write(_view: &tauri::Webview, _cookies: Vec<SessionCookie>) -> Result<(), String> {
    Err("Вход через Chrome пока поддерживается в Windows".into())
}

#[cfg(windows)]
pub async fn clear(view: &tauri::Webview) {
    use windows::core::Interface;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    let (tx, rx) = tokio::sync::oneshot::channel();
    if view.with_webview(move |platform| {
        unsafe {
            if let Ok(core) = platform.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_2>()) {
                if let Ok(manager) = core.CookieManager() {
                    let _ = manager.DeleteAllCookies();
                }
            }
        }
        let _ = tx.send(());
    }).is_ok() {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), rx).await;
    }
}

#[cfg(not(windows))]
pub async fn clear(_view: &tauri::Webview) {}
