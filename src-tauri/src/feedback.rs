//! Anonymous feedback and diagnostic journal submission to the developer relay.

use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::http::Http;
use crate::journal;

pub const FEEDBACK_ENDPOINT: &str = "https://64.188.95.211/nocturne-feedback";
pub const MAX_MESSAGE_CHARS: usize = 4000;
pub const MAX_CONTACT_CHARS: usize = 160;
const SEND_TIMEOUT: Duration = Duration::from_secs(15);

pub fn feedback_endpoint() -> &'static str {
    option_env!("NOCTURNE_FEEDBACK_URL")
        .filter(|s| s.starts_with("https://"))
        .unwrap_or(FEEDBACK_ENDPOINT)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct FeedbackPayload {
    pub kind: String,
    pub message: String,
    pub contact: String,
    pub version: &'static str,
    pub platform: &'static str,
    pub arch: &'static str,
    pub log: String,
}

pub fn normalize_kind(raw: &str) -> &'static str {
    match raw.trim() {
        "idea" => "idea",
        "other" => "other",
        _ => "bug",
    }
}

pub fn validate_input(kind: &str, message: &str, contact: Option<&str>) -> Result<(&'static str, String, String), String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Опишите проблему или идею".into());
    }
    if trimmed.chars().count() > MAX_MESSAGE_CHARS {
        return Err(format!("Сообщение не должно быть длиннее {MAX_MESSAGE_CHARS} символов"));
    }
    let clean_contact = contact
        .unwrap_or("")
        .replace(['\r', '\n', '\t'], " ")
        .trim()
        .chars()
        .take(MAX_CONTACT_CHARS)
        .collect::<String>();
    Ok((normalize_kind(kind), trimmed.to_string(), clean_contact))
}

#[tauri::command]
pub async fn send_feedback(
    http: State<'_, Http>,
    kind: String,
    message: String,
    contact: Option<String>,
    include_log: bool,
) -> Result<(), String> {
    let (clean_kind, clean_message, clean_contact) = validate_input(&kind, &message, contact.as_deref())?;
    let log = if include_log { journal::journal_tail() } else { String::new() };

    let payload = FeedbackPayload {
        kind: clean_kind.to_string(),
        message: clean_message,
        contact: clean_contact,
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        log,
    };

    let resp = http
        .client
        .post(feedback_endpoint())
        .timeout(SEND_TIMEOUT)
        .header(reqwest::header::USER_AGENT, http.user_agent())
        .json(&payload)
        .send()
        .await
        .map_err(|_| {
            journal::write("app", "feedback send failed: network");
            "Не удалось связаться с сервером обратной связи".to_string()
        })?;

    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        journal::write("app", &format!("feedback send failed: HTTP {status}"));
        let msg = match status {
            429 => "Слишком много отправок подряд — попробуйте через пару минут".to_string(),
            413 => "Отчёт получился слишком большим".to_string(),
            404 => "Сервис обратной связи на сервере пока не подключён".to_string(),
            _ => format!("Не удалось отправить отзыв (HTTP {status})"),
        };
        return Err(msg);
    }

    journal::write("app", &format!("feedback sent: kind={clean_kind} log={include_log}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_kind_message_and_contact_cleanly() {
        assert!(validate_input("bug", "   \n  ", None).is_err());
        assert!(validate_input("bug", &"a".repeat(MAX_MESSAGE_CHARS + 1), None).is_err());

        let (k, msg, contact) = validate_input("idea", "  Добавить тему  ", Some(" @user\n123 ")).unwrap();
        assert_eq!(k, "idea");
        assert_eq!(msg, "Добавить тему");
        assert_eq!(contact, "@user 123");

        let (fallback_kind, _, _) = validate_input("weird-kind", "ok", None).unwrap();
        assert_eq!(fallback_kind, "bug");
    }

    #[test]
    fn endpoint_is_https() {
        assert!(feedback_endpoint().starts_with("https://"));
    }

    #[tokio::test]
    #[ignore = "live network check against feedback relay TLS and validation"]
    async fn relay_tls_live() {
        let http = Http::new();
        let resp = http
            .client
            .post(feedback_endpoint())
            .timeout(SEND_TIMEOUT)
            .header(reqwest::header::USER_AGENT, http.user_agent())
            .json(&serde_json::json!({ "kind": "bug", "message": "" }))
            .send()
            .await
            .expect("reqwest rustls POST to feedback endpoint");
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        assert_eq!(status, 400, "unexpected status {status}: {body}");
        assert!(body.contains("Message is required"), "unexpected body: {body}");
    }
}
