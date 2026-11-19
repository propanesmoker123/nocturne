//! Shared HTTP client with a browser-like User-Agent (the WebView2 one, reported by the UI).

use std::sync::RwLock;

use reqwest::header::HeaderValue;
use url::Url;

pub const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0";

pub struct Http {
    pub client: reqwest::Client,
    ua: RwLock<String>,
}

pub fn valid_user_agent(ua: &str) -> bool {
    ua.starts_with("Mozilla/") && ua.len() < 400 && ua.is_ascii() && HeaderValue::from_str(ua).is_ok()
}

pub(crate) fn is_redirect_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

pub(crate) fn resolve_redirect<F>(current: &Url, location: &str, allow_url: &F) -> Result<Url, String>
where
    F: Fn(&Url) -> bool,
{
    let loc = location.trim();
    if loc.is_empty() {
        return Err("invalid redirect location".to_string());
    }
    let next = current.join(loc).map_err(|_| "invalid redirect location".to_string())?;
    if !allow_url(&next) {
        return Err("redirect not allowed".to_string());
    }
    Ok(next)
}

impl Http {
    pub fn new() -> Self {
        // A slow CDN node still gets there: a request ends when nothing comes for a while, not after a
        // fixed time (30 s for a whole segment cut slow downloads off and started them over again).
        // Redirects are disabled globally so callers never silently follow cross-origin/downgrade hops
        // or leak custom headers / POST bodies; callers that expect redirects use
        // `send_with_validated_redirects`.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .gzip(true)
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("http client");
        Self { client, ua: RwLock::new(DEFAULT_UA.to_string()) }
    }

    pub fn user_agent(&self) -> String {
        self.ua.read().map(|s| s.clone()).unwrap_or_else(|_| DEFAULT_UA.to_string())
    }

    pub fn set_user_agent(&self, ua: String) {
        let ua = ua.trim();
        if valid_user_agent(ua) {
            if let Ok(mut g) = self.ua.write() {
                *g = ua.to_string();
            }
        }
    }

    /// Sends a request and manually follows 301/302/303/307/308 redirects up to `max_hops`,
    /// validating every target URL with `allow_url` BEFORE connecting to it.
    pub async fn send_with_validated_redirects<F, B>(
        &self,
        initial_url: &str,
        max_hops: usize,
        allow_url: F,
        mut build: B,
    ) -> Result<reqwest::Response, String>
    where
        F: Fn(&Url) -> bool,
        B: FnMut(&reqwest::Client, &Url) -> reqwest::RequestBuilder,
    {
        let mut current = Url::parse(initial_url).map_err(|_| "invalid url".to_string())?;
        let mut hops = 0usize;
        loop {
            let resp = build(&self.client, &current)
                .send()
                .await
                .map_err(|e| format!("network: {}", e.without_url()))?;
            if is_redirect_status(resp.status()) {
                let Some(loc_hdr) = resp.headers().get(reqwest::header::LOCATION) else {
                    return Ok(resp);
                };
                if hops >= max_hops {
                    return Err("too many redirects".to_string());
                }
                let loc = loc_hdr.to_str().map_err(|_| "invalid redirect location".to_string())?;
                current = resolve_redirect(&current, loc, &allow_url)?;
                hops += 1;
                continue;
            }
            return Ok(resp);
        }
    }
}

#[tauri::command]
pub fn set_user_agent(http: tauri::State<'_, Http>, ua: String) {
    http.set_user_agent(ua);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn user_agent_rejects_invalid_header_chars_and_accepts_valid_mozilla() {
        let http = Http::new();
        let original = http.user_agent();

        assert!(valid_user_agent("Mozilla/5.0 (Windows NT 10.0)"));
        assert!(!valid_user_agent("curl/8.0"));
        assert!(!valid_user_agent("Mozilla/5.0\r\nX-Injected: 1"));
        assert!(!valid_user_agent("Mozilla/5.0\nEvil"));
        assert!(!valid_user_agent("Mozilla/5.0\0nul"));
        assert!(!valid_user_agent("Mozilla/5.0\x7fdel"));
        assert!(!valid_user_agent("Mozilla/5.0 привет"));
        assert!(!valid_user_agent(&format!("Mozilla/{}", "a".repeat(400))));

        http.set_user_agent("Mozilla/5.0\r\nX-Evil: 1".to_string());
        assert_eq!(http.user_agent(), original);

        http.set_user_agent("  Mozilla/5.0 (Test)  ".to_string());
        assert_eq!(http.user_agent(), "Mozilla/5.0 (Test)");
    }

    #[test]
    fn resolve_redirect_handles_relative_and_rejects_disallowed() {
        let base = Url::parse("https://cdn.example.com/a/b").unwrap();
        let allow_same = |u: &Url| u.scheme() == "https" && u.host_str() == Some("cdn.example.com");

        assert_eq!(
            resolve_redirect(&base, "/c/d?x=1", &allow_same).unwrap().as_str(),
            "https://cdn.example.com/c/d?x=1"
        );
        assert_eq!(
            resolve_redirect(&base, "next.bin", &allow_same).unwrap().as_str(),
            "https://cdn.example.com/a/next.bin"
        );
        assert_eq!(
            resolve_redirect(&base, "https://evil.example/x", &allow_same).unwrap_err(),
            "redirect not allowed"
        );
        assert_eq!(
            resolve_redirect(&base, "http://cdn.example.com/c", &allow_same).unwrap_err(),
            "redirect not allowed"
        );
        assert_eq!(
            resolve_redirect(&base, "   ", &allow_same).unwrap_err(),
            "invalid redirect location"
        );
    }

    fn spawn_http_once(response: &'static str) -> (String, Arc<AtomicBool>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hit = Arc::new(AtomicBool::new(false));
        let hit_bg = Arc::clone(&hit);
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                hit_bg.store(true, Ordering::SeqCst);
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}"), hit)
    }

    #[tokio::test]
    async fn client_never_auto_follows_redirects() {
        let (target_base, target_hit) = spawn_http_once("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let loc = format!("{target_base}/secret");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let resp = format!("HTTP/1.1 302 Found\r\nLocation: {loc}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });

        let http = Http::new();
        let resp = http.client.get(format!("http://{addr}/start")).send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 302);
        assert!(!target_hit.load(Ordering::SeqCst), "client must not follow redirects automatically");
    }

    #[tokio::test]
    async fn validated_redirects_follows_allowed_and_blocks_disallowed_before_connecting() {
        // 1. Disallowed redirect target must never be contacted.
        let (evil_base, evil_hit) = spawn_http_once("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 4\r\n\r\nevil");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let evil_loc = format!("{evil_base}/pwn");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let resp = format!("HTTP/1.1 302 Found\r\nLocation: {evil_loc}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });

        let http = Http::new();
        let allowed_port = addr.port();
        let err = http
            .send_with_validated_redirects(
                &format!("http://{addr}/start"),
                5,
                |u| u.port() == Some(allowed_port),
                |c, u| c.get(u.clone()),
            )
            .await
            .unwrap_err();
        assert_eq!(err, "redirect not allowed");
        assert!(!evil_hit.load(Ordering::SeqCst), "disallowed hop must not be contacted");

        // 2. Relative redirect on allowed host succeeds, and exceeding max_hops fails.
        let listener2 = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr2 = listener2.local_addr().unwrap();
        std::thread::spawn(move || {
            for _ in 0..3 {
                let Ok((mut stream, _)) = listener2.accept() else { break };
                let mut buf = [0u8; 1024];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let resp = if req.starts_with("GET /hop1 ") {
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: /final\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                } else if req.starts_with("GET /final ") {
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 4\r\n\r\ndone"
                } else {
                    "HTTP/1.1 302 Found\r\nLocation: /loop\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                };
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        let p2 = addr2.port();
        let resp = http
            .send_with_validated_redirects(
                &format!("http://{addr2}/hop1"),
                3,
                |u| u.port() == Some(p2),
                |c, u| c.get(u.clone()),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(resp.text().await.unwrap(), "done");

        let err = http
            .send_with_validated_redirects(
                &format!("http://{addr2}/loop"),
                0,
                |u| u.port() == Some(p2),
                |c, u| c.get(u.clone()),
            )
            .await
            .unwrap_err();
        assert_eq!(err, "too many redirects");
    }
}
