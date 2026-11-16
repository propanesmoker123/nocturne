//! Offline native cookie scope check. Uses an isolated profile and a reserved .invalid domain.
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[path = "../src/spotify/session_cookies.rs"]
mod session_cookies;

fn main() {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let profile = std::env::temp_dir().join(format!("nocturne-cookie-probe-{}", uuid::Uuid::new_v4()));
    tauri::Builder::default().setup(move |app| {
        let window = WebviewWindowBuilder::new(app, "cookie-probe", WebviewUrl::External("about:blank".parse().unwrap()))
            .data_directory(profile).visible(false).build()?;
        let handle = app.handle().clone();
        let view = app.get_webview("cookie-probe").unwrap();
        tauri::async_runtime::spawn(async move {
            let mut cookie = tauri::webview::Cookie::new("nocturne_fixture", "fixture");
            cookie.set_domain(".nocturne-cookie.invalid"); cookie.set_path("/"); cookie.set_secure(true);
            window.set_cookie(cookie.clone()).unwrap();
            let received = window.cookies_for_url("https://sub.nocturne-cookie.invalid/".parse().unwrap()).unwrap();
            let inherited = received.iter().any(|cookie| cookie.name() == "nocturne_fixture");
            println!("generic_domain_cookie_reaches_subdomain={inherited}");
            window.delete_cookie(cookie).unwrap();
            let mut cookie = cookie::Cookie::new("nocturne_fixture", "fixture");
            cookie.set_domain(".nocturne-cookie.invalid"); cookie.set_path("/"); cookie.set_secure(true);
            session_cookies::write(&view, vec![session_cookies::SessionCookie { cookie, domain: ".nocturne-cookie.invalid".into() }]).await.unwrap();
            let received = window.cookies_for_url("https://sub.nocturne-cookie.invalid/".parse().unwrap()).unwrap();
            let preserved = received.iter().any(|cookie| cookie.name() == "nocturne_fixture" && cookie.value() == "fixture");
            println!("preserved_domain_cookie_reaches_subdomain={preserved}");
            handle.exit(if preserved { 0 } else { 1 });
        });
        Ok(())
    }).run(context).expect("cookie fixture runtime");
}
