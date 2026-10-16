//! Shared HTTP client with a browser-like User-Agent (the WebView2 one, reported by the UI).

use std::sync::RwLock;

pub const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0";

pub struct Http {
    pub client: reqwest::Client,
    ua: RwLock<String>,
}

impl Http {
    pub fn new() -> Self {
        // A slow CDN node still gets there: a request ends when nothing comes for a while, not after a
        // fixed time (30 s for a whole segment cut slow downloads off and started them over again)
        let client = reqwest::Client::builder()
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
        if let Ok(mut g) = self.ua.write() {
            *g = ua;
        }
    }
}

#[tauri::command]
pub fn set_user_agent(http: tauri::State<'_, Http>, ua: String) {
    let ua = ua.trim();
    if ua.starts_with("Mozilla/") && ua.len() < 400 {
        http.set_user_agent(ua.to_string());
    }
}
