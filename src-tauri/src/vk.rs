//! VK API client: `POST https://api.vk.ru/method/<m>?v=5.289&client_id=6287487` with the
//! web-session token. Global ≤3 rps limiter, one token refresh on auth errors, backoff on
//! rate errors. Errors reach JS as a tagged `VkError`.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

use crate::http::Http;
use crate::session;

pub const API_BASE: &str = "https://api.vk.ru/method/";
pub const API_VERSION: &str = "5.289";
pub const CLIENT_ID: &str = "6287487";
pub const MIN_INTERVAL: Duration = Duration::from_millis(340);

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VkError {
    #[serde(rename_all = "camelCase")]
    Vk { code: i64, message: String, captcha_sid: Option<String>, captcha_img: Option<String>, redirect_uri: Option<String> },
    Auth { message: String },
    Network { message: String },
    Invalid { message: String },
}

#[derive(Debug, PartialEq)]
pub enum ErrorAction {
    RefreshAndRetry,
    Backoff,
    Fail,
}

pub fn classify(code: i64) -> ErrorAction {
    match code {
        5 | 1116 | 1117 => ErrorAction::RefreshAndRetry,
        6 | 10 => ErrorAction::Backoff,
        _ => ErrorAction::Fail,
    }
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    Retry { refresh: bool, delay: Duration },
    GiveUp,
}

/// Per-call retry bookkeeping: at most one token refresh and three backoffs.
#[derive(Default)]
pub struct RetryPolicy {
    refreshed: bool,
    backoffs: u32,
}

impl RetryPolicy {
    pub fn on_error(&mut self, code: i64) -> Decision {
        match classify(code) {
            ErrorAction::RefreshAndRetry if !self.refreshed => {
                self.refreshed = true;
                Decision::Retry { refresh: true, delay: Duration::ZERO }
            }
            ErrorAction::Backoff if self.backoffs < 3 => {
                self.backoffs += 1;
                Decision::Retry { refresh: false, delay: Duration::from_millis(400 * u64::from(self.backoffs)) }
            }
            _ => Decision::GiveUp,
        }
    }
}

/// How long to wait before the next request may start.
pub fn wait_before(last: Option<Instant>, now: Instant, interval: Duration) -> Duration {
    match last {
        None => Duration::ZERO,
        Some(l) => (l + interval).saturating_duration_since(now),
    }
}

pub fn valid_method(method: &str) -> bool {
    let mut parts = method.split('.');
    let (Some(ns), Some(name), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    !ns.is_empty()
        && !name.is_empty()
        && ns.chars().all(|c| c.is_ascii_alphabetic())
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

/// JSON params → form pairs (strings verbatim, numbers, bools as 1/0, arrays comma-joined, null skipped).
pub fn params_to_form(params: &Map<String, Value>) -> Vec<(String, String)> {
    params
        .iter()
        .filter_map(|(k, v)| {
            let s = match v {
                Value::Null => return None,
                Value::String(s) => s.clone(),
                Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
                Value::Number(n) => n.to_string(),
                Value::Array(items) => items
                    .iter()
                    .map(|x| match x {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(","),
                Value::Object(_) => v.to_string(),
            };
            Some((k.clone(), s))
        })
        .collect()
}

pub enum ApiOutcome {
    Ok(Value),
    Err { code: i64, message: String, captcha_sid: Option<String>, captcha_img: Option<String>, redirect_uri: Option<String> },
}

pub fn parse_api_response(body: Value) -> ApiOutcome {
    if let Some(r) = body.get("response") {
        return ApiOutcome::Ok(r.clone());
    }
    if let Some(e) = body.get("error") {
        let text = |k: &str| e.get(k).and_then(|v| v.as_str()).map(String::from);
        let any = |k: &str| e.get(k).map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string()));
        return ApiOutcome::Err {
            code: e.get("error_code").and_then(|v| v.as_i64()).unwrap_or(-1),
            message: text("error_msg").unwrap_or_default(),
            captcha_sid: any("captcha_sid"),
            captcha_img: text("captcha_img"),
            redirect_uri: text("redirect_uri"),
        };
    }
    ApiOutcome::Err { code: -1, message: "unexpected response".to_string(), captcha_sid: None, captcha_img: None, redirect_uri: None }
}

pub struct Limiter {
    last: tokio::sync::Mutex<Option<Instant>>,
}

impl Limiter {
    pub fn new() -> Self {
        Self { last: tokio::sync::Mutex::new(None) }
    }

    async fn turn(&self) {
        let mut last = self.last.lock().await;
        let wait = wait_before(*last, Instant::now(), MIN_INTERVAL);
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        *last = Some(Instant::now());
    }
}

async fn send(http: &Http, method: &str, form: &[(String, String)], token: &str) -> Result<Value, VkError> {
    let url = format!("{API_BASE}{method}?v={API_VERSION}&client_id={CLIENT_ID}");
    let mut body: Vec<(&str, &str)> = form.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    body.push(("access_token", token));
    let resp = http
        .client
        .post(url)
        .header(reqwest::header::USER_AGENT, http.user_agent())
        .header(reqwest::header::ORIGIN, "https://vk.ru")
        .header(reqwest::header::REFERER, "https://vk.ru/")
        .form(&body)
        .send()
        .await
        .map_err(|e| VkError::Network { message: e.without_url().to_string() })?;
    if !resp.status().is_success() {
        return Err(VkError::Network { message: format!("HTTP {}", resp.status().as_u16()) });
    }
    resp.json::<Value>().await.map_err(|e| VkError::Network { message: e.without_url().to_string() })
}

#[tauri::command]
pub async fn vk_api(app: AppHandle, http: State<'_, Http>, limiter: State<'_, Limiter>, method: String, params: Map<String, Value>) -> Result<Value, VkError> {
    if !valid_method(&method) {
        return Err(VkError::Invalid { message: format!("bad method name: {method}") });
    }
    let form = params_to_form(&params);
    let mut policy = RetryPolicy::default();
    loop {
        let token = session::get_token(&app).await.map_err(|message| VkError::Auth { message })?;
        limiter.turn().await;
        match parse_api_response(send(&http, &method, &form, &token).await?) {
            ApiOutcome::Ok(v) => return Ok(v),
            ApiOutcome::Err { code, message, captcha_sid, captcha_img, redirect_uri } => match policy.on_error(code) {
                Decision::Retry { refresh, delay } => {
                    if refresh {
                        app.state::<session::SessionState>().invalidate();
                    }
                    tokio::time::sleep(delay).await;
                }
                Decision::GiveUp => {
                    if classify(code) == ErrorAction::RefreshAndRetry {
                        return Err(VkError::Auth { message });
                    }
                    return Err(VkError::Vk { code, message, captcha_sid, captcha_img, redirect_uri });
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_error_codes() {
        assert_eq!(classify(5), ErrorAction::RefreshAndRetry);
        assert_eq!(classify(1117), ErrorAction::RefreshAndRetry);
        assert_eq!(classify(6), ErrorAction::Backoff);
        assert_eq!(classify(10), ErrorAction::Backoff);
        assert_eq!(classify(14), ErrorAction::Fail);
        assert_eq!(classify(201), ErrorAction::Fail);
    }

    #[test]
    fn refreshes_the_token_only_once() {
        let mut p = RetryPolicy::default();
        assert_eq!(p.on_error(5), Decision::Retry { refresh: true, delay: Duration::ZERO });
        assert_eq!(p.on_error(5), Decision::GiveUp);
    }

    #[test]
    fn backs_off_three_times_with_growing_delay() {
        let mut p = RetryPolicy::default();
        assert_eq!(p.on_error(6), Decision::Retry { refresh: false, delay: Duration::from_millis(400) });
        assert_eq!(p.on_error(6), Decision::Retry { refresh: false, delay: Duration::from_millis(800) });
        assert_eq!(p.on_error(6), Decision::Retry { refresh: false, delay: Duration::from_millis(1200) });
        assert_eq!(p.on_error(6), Decision::GiveUp);
    }

    #[test]
    fn gives_up_immediately_on_captcha() {
        assert_eq!(RetryPolicy::default().on_error(14), Decision::GiveUp);
    }

    #[test]
    fn limiter_waits_out_the_interval() {
        let now = Instant::now();
        assert_eq!(wait_before(None, now, MIN_INTERVAL), Duration::ZERO);
        assert_eq!(wait_before(Some(now), now + Duration::from_millis(100), MIN_INTERVAL), Duration::from_millis(240));
        assert_eq!(wait_before(Some(now), now + Duration::from_millis(500), MIN_INTERVAL), Duration::ZERO);
    }

    #[test]
    fn validates_method_names() {
        assert!(valid_method("audio.get"));
        assert!(valid_method("catalog.getSection"));
        assert!(!valid_method("audio.get/../x"));
        assert!(!valid_method("audio"));
        assert!(!valid_method("audio.get?x=1"));
        assert!(!valid_method(""));
    }

    #[test]
    fn converts_params_to_form() {
        let p = json!({ "owner_id": -5, "q": "кино", "need": true, "skip": null, "ids": ["1_2", "3_4"], "f": 0.5 });
        let mut form = params_to_form(p.as_object().unwrap());
        form.sort();
        assert_eq!(
            form,
            vec![
                ("f".to_string(), "0.5".to_string()),
                ("ids".to_string(), "1_2,3_4".to_string()),
                ("need".to_string(), "1".to_string()),
                ("owner_id".to_string(), "-5".to_string()),
                ("q".to_string(), "кино".to_string()),
            ]
        );
    }

    #[test]
    fn parses_success_and_error_envelopes() {
        assert!(matches!(parse_api_response(json!({"response": {"count": 1}})), ApiOutcome::Ok(v) if v["count"] == 1));
        match parse_api_response(json!({"error": {"error_code": 14, "error_msg": "Captcha needed", "captcha_sid": "s", "captcha_img": "https://img"}})) {
            ApiOutcome::Err { code, message, captcha_sid, captcha_img, .. } => {
                assert_eq!(code, 14);
                assert_eq!(message, "Captcha needed");
                assert_eq!(captcha_sid.as_deref(), Some("s"));
                assert_eq!(captcha_img.as_deref(), Some("https://img"));
            }
            _ => panic!("expected error"),
        }
        assert!(matches!(parse_api_response(json!({"weird": 1})), ApiOutcome::Err { code: -1, .. }));
    }
}
