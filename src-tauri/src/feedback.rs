//! Anonymous feedback submission, developer inbox replies, and release notes sync.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::http::Http;
use crate::journal;

pub const FEEDBACK_ENDPOINT: &str = "https://64.188.95.211/nocturne-feedback";
pub const RELEASES_ENDPOINT: &str = "https://api.github.com/repos/propanesmoker123/nocturne/releases?per_page=8";
pub const MAX_MESSAGE_CHARS: usize = 4000;
pub const MAX_CONTACT_CHARS: usize = 160;
const MAX_SAVED_REPORTS: usize = 30;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

static IDENTITY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn id_lock() -> &'static Mutex<()> {
    IDENTITY_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn feedback_endpoint() -> &'static str {
    option_env!("NOCTURNE_FEEDBACK_URL")
        .filter(|s| s.starts_with("https://"))
        .unwrap_or(FEEDBACK_ENDPOINT)
}

pub fn inbox_endpoint() -> String {
    format!("{}/inbox", feedback_endpoint().trim_end_matches('/'))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedReport {
    pub id: String,
    pub kind: String,
    pub preview: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientIdentity {
    client_id: String,
    client_token: String,
    #[serde(default)]
    submitted_reports: Vec<SubmittedReport>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackPayload {
    pub kind: String,
    pub message: String,
    pub contact: String,
    pub version: &'static str,
    pub platform: &'static str,
    pub arch: &'static str,
    pub log: String,
    pub client_id: String,
    pub client_token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayReply {
    pub id: String,
    #[serde(default)]
    pub report_id: String,
    #[serde(default)]
    pub report_message: String,
    #[serde(default)]
    pub kind: String,
    pub message: String,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayAnnouncement {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub message: String,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    pub version: String,
    pub title: String,
    pub notes: String,
    pub published_at: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationsPayload {
    pub current_version: &'static str,
    pub inbox_ok: bool,
    pub releases_ok: bool,
    pub replies: Vec<RelayReply>,
    pub announcements: Vec<RelayAnnouncement>,
    pub releases: Vec<ReleaseNote>,
    pub sent_reports: Vec<SubmittedReport>,
}

#[derive(Debug, Deserialize)]
struct InboxResponse {
    #[serde(default)]
    replies: Vec<RelayReply>,
    #[serde(default)]
    announcements: Vec<RelayAnnouncement>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseRaw {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    html_url: String,
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

fn valid_id(raw: &str) -> bool {
    (16..=64).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_token(raw: &str) -> bool {
    (24..=128).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn preview_text(s: &str, max_chars: usize) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    for (idx, ch) in collapsed.chars().enumerate() {
        if idx >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn random_hex_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Не удалось сгенерировать ключ устройства".to_string())?;
    let mut hex = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    Ok(hex)
}

fn identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Не удалось определить папку конфигурации".to_string())?;
    Ok(dir.join("feedback-client.json"))
}

fn load_or_create_identity_at(path: &Path) -> Result<ClientIdentity, String> {
    let _guard = id_lock().lock().unwrap_or_else(|p| p.into_inner());
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<ClientIdentity>(&raw) {
            Ok(parsed) if valid_id(&parsed.client_id) && valid_token(&parsed.client_token) => Ok(parsed),
            _ => {
                let backup = path.with_extension(format!("corrupt-{}.json", now_ms()));
                let _ = fs::copy(path, &backup);
                Err("Файл профиля обратной связи повреждён".to_string())
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let identity = ClientIdentity {
                client_id: uuid::Uuid::new_v4().to_string(),
                client_token: random_hex_token()?,
                submitted_reports: Vec::new(),
            };
            save_identity_at(path, &identity)?;
            Ok(identity)
        }
        Err(e) => Err(format!("Не удалось прочитать ключ устройства: {e}")),
    }
}

fn save_identity_at(path: &Path, identity: &ClientIdentity) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "Не удалось создать папку конфигурации".to_string())?;
    }
    let json = serde_json::to_string_pretty(identity).map_err(|_| "Ошибка сериализации профиля".to_string())?;
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, json).is_err() {
        let _ = fs::remove_file(&tmp);
        return Err("Не удалось сохранить ключ устройства".to_string());
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        return Err("Не удалось обновить ключ устройства".to_string());
    }
    Ok(())
}

async fn read_text_bounded(mut resp: reqwest::Response, max_bytes: usize) -> Result<String, String> {
    if resp.content_length().is_some_and(|n| n > max_bytes as u64) {
        return Err("response too large".into());
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.without_url().to_string())? {
        if buf.len() + chunk.len() > max_bytes {
            return Err("response too large".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn record_submitted_report_at(path: &Path, report: SubmittedReport) {
    let _guard = id_lock().lock().unwrap_or_else(|p| p.into_inner());
    let Ok(raw) = fs::read_to_string(path) else { return };
    let Ok(mut identity) = serde_json::from_str::<ClientIdentity>(&raw) else { return };
    identity.submitted_reports.insert(0, report);
    if identity.submitted_reports.len() > MAX_SAVED_REPORTS {
        identity.submitted_reports.truncate(MAX_SAVED_REPORTS);
    }
    let _ = save_identity_at(path, &identity);
}

pub fn parse_github_releases(raw_json: &str) -> Result<Vec<ReleaseNote>, String> {
    let items: Vec<GithubReleaseRaw> =
        serde_json::from_str(raw_json).map_err(|_| "Некорректный ответ GitHub API".to_string())?;
    Ok(items
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let ver = r.tag_name.trim().trim_start_matches('v').to_string();
            if ver.is_empty() {
                return None;
            }
            let title = if r.name.trim().is_empty() {
                format!("Nocturne {ver}")
            } else {
                r.name.trim().to_string()
            };
            Some(ReleaseNote {
                version: ver,
                title,
                notes: r.body.unwrap_or_default().trim().to_string(),
                published_at: r.published_at,
                url: r.html_url,
            })
        })
        .collect())
}

pub fn parse_inbox_response(raw_json: &str) -> Result<(Vec<RelayReply>, Vec<RelayAnnouncement>), String> {
    let parsed: InboxResponse =
        serde_json::from_str(raw_json).map_err(|_| "Некорректный ответ сервера уведомлений".to_string())?;
    Ok((parsed.replies, parsed.announcements))
}

#[tauri::command]
pub async fn send_feedback(
    app: AppHandle,
    http: State<'_, Http>,
    kind: String,
    message: String,
    contact: Option<String>,
    include_log: bool,
) -> Result<(), String> {
    let (clean_kind, clean_message, clean_contact) = validate_input(&kind, &message, contact.as_deref())?;
    let id_path = identity_path(&app)?;
    let id_path_load = id_path.clone();
    let (identity, log) = tauri::async_runtime::spawn_blocking(move || -> Result<(ClientIdentity, String), String> {
        let identity = load_or_create_identity_at(&id_path_load)?;
        let log = if include_log { journal::tail() } else { String::new() };
        Ok((identity, log))
    })
    .await
    .map_err(|e| e.to_string())??;

    let payload = FeedbackPayload {
        kind: clean_kind.to_string(),
        message: clean_message.clone(),
        contact: clean_contact,
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        log,
        client_id: identity.client_id,
        client_token: identity.client_token,
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

    let body_text = read_text_bounded(resp, MAX_RESPONSE_BYTES).await.unwrap_or_default();
    let report_id = serde_json::from_str::<serde_json::Value>(&body_text)
        .ok()
        .and_then(|v| v.get("reportId")?.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("local_{}", now_ms()));

    let report = SubmittedReport {
        id: report_id,
        kind: clean_kind.to_string(),
        preview: preview_text(&clean_message, 110),
        created_at: now_ms(),
    };
    let _ = tauri::async_runtime::spawn_blocking(move || record_submitted_report_at(&id_path, report)).await;

    journal::write("app", &format!("feedback sent: kind={clean_kind} log={include_log}"));
    Ok(())
}

#[tauri::command]
pub async fn fetch_notifications(
    app: AppHandle,
    http: State<'_, Http>,
) -> Result<NotificationsPayload, String> {
    let id_path = identity_path(&app)?;
    let identity = tauri::async_runtime::spawn_blocking(move || load_or_create_identity_at(&id_path))
        .await
        .map_err(|e| e.to_string())??;

    let inbox_req = http
        .client
        .get(inbox_endpoint())
        .timeout(FETCH_TIMEOUT)
        .header(reqwest::header::USER_AGENT, http.user_agent())
        .header("X-Nocturne-Client", &identity.client_id)
        .header("X-Nocturne-Token", &identity.client_token)
        .send();

    let releases_req = http
        .client
        .get(RELEASES_ENDPOINT)
        .timeout(FETCH_TIMEOUT)
        .header(reqwest::header::USER_AGENT, http.user_agent())
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send();

    let (inbox_res, releases_res) = tokio::join!(inbox_req, releases_req);

    let mut inbox_ok = false;
    let mut replies = Vec::new();
    let mut announcements = Vec::new();
    if let Ok(resp) = inbox_res {
        if resp.status().is_success() {
            if let Ok(text) = read_text_bounded(resp, MAX_RESPONSE_BYTES).await {
                if let Ok((r, a)) = parse_inbox_response(&text) {
                    inbox_ok = true;
                    replies = r;
                    announcements = a;
                }
            }
        } else {
            journal::write("app", &format!("inbox fetch failed: HTTP {}", resp.status().as_u16()));
        }
    }

    let mut releases_ok = false;
    let mut releases = Vec::new();
    if let Ok(resp) = releases_res {
        if resp.status().is_success() {
            if let Ok(text) = read_text_bounded(resp, MAX_RESPONSE_BYTES).await {
                if let Ok(parsed) = parse_github_releases(&text) {
                    releases_ok = true;
                    releases = parsed;
                }
            }
        } else {
            journal::write("app", &format!("releases fetch failed: HTTP {}", resp.status().as_u16()));
        }
    }

    Ok(NotificationsPayload {
        current_version: env!("CARGO_PKG_VERSION"),
        inbox_ok,
        releases_ok,
        replies,
        announcements,
        releases,
        sent_reports: identity.submitted_reports,
    })
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
        assert!(inbox_endpoint().ends_with("/inbox"));
    }

    #[test]
    fn loads_or_creates_stable_identity_and_records_reports() {
        let dir = std::env::temp_dir().join(format!("nocturne_fb_test_{}", uuid::Uuid::new_v4()));
        let path = dir.join("feedback-client.json");

        let first = load_or_create_identity_at(&path).unwrap();
        assert!(valid_id(&first.client_id));
        assert!(valid_token(&first.client_token));

        let second = load_or_create_identity_at(&path).unwrap();
        assert_eq!(first.client_id, second.client_id);
        assert_eq!(first.client_token, second.client_token);

        record_submitted_report_at(
            &path,
            SubmittedReport {
                id: "r_1".into(),
                kind: "bug".into(),
                preview: "Спотифай скипает".into(),
                created_at: 123456,
            },
        );
        let third = load_or_create_identity_at(&path).unwrap();
        assert_eq!(third.submitted_reports.len(), 1);
        assert_eq!(third.submitted_reports[0].id, "r_1");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_github_releases_filtering_drafts_and_prereleases() {
        let raw = r#"[
            { "tag_name": "v0.3.7", "name": "Nocturne 0.3.7", "body": "Исправления: Spotify.", "draft": false, "prerelease": false, "published_at": "2026-11-17T10:00:00Z", "html_url": "https://github.com/x/y" },
            { "tag_name": "v0.3.8-beta", "name": "Beta", "body": "wip", "draft": false, "prerelease": true, "published_at": "2026-11-18T10:00:00Z", "html_url": "" },
            { "tag_name": "v0.3.9", "name": "Draft", "body": "", "draft": true, "prerelease": false, "published_at": "", "html_url": "" }
        ]"#;
        let parsed = parse_github_releases(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].version, "0.3.7");
        assert_eq!(parsed[0].notes, "Исправления: Spotify.");
        assert!(parse_github_releases("<html>rate limit</html>").is_err());
    }

    #[test]
    fn identity_loader_never_clobbers_corrupt_or_unreadable_files() {
        let dir = std::env::temp_dir().join(format!("nocturne_fb_corrupt_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        // Corrupt JSON: returns Err, preserves original file, creates backup.
        let corrupt = dir.join("feedback-client.json");
        fs::write(&corrupt, "{not valid json").unwrap();
        assert!(load_or_create_identity_at(&corrupt).is_err());
        assert_eq!(fs::read_to_string(&corrupt).unwrap(), "{not valid json");
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);

        // Non-NotFound I/O error (path is a directory): returns Err without creating a file.
        let as_dir = dir.join("dir-as-file");
        fs::create_dir(&as_dir).unwrap();
        assert!(load_or_create_identity_at(&as_dir).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_inbox_json_payload_cleanly() {
        let raw = r#"{
            "ok": true,
            "replies": [
                { "id": "rep_1", "reportId": "r_1", "reportMessage": "Не работает", "kind": "bug", "message": "Починили!", "createdAt": 999 }
            ],
            "announcements": [
                { "id": "ann_1", "title": "Сервис", "message": "Обновление готово", "createdAt": 1000 }
            ]
        }"#;
        let (replies, announcements) = parse_inbox_response(raw).unwrap();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0].message, "Починили!");
        assert_eq!(announcements.len(), 1);
        assert_eq!(announcements[0].title, "Сервис");
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
