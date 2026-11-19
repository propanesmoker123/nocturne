//! Local Whisper AI asset cache & allowlisted model/WASM downloader.
//! Keeps HuggingFace / jsDelivr downloads strictly in Rust so renderer CSP stays minimal.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::http::Http;

const MAX_ASSET_BYTES: usize = 350 * 1024 * 1024;
const MAX_REDIRECT_HOPS: usize = 5;
const CHUNK_TIMEOUT: Duration = Duration::from_secs(45);
/// Overrides the shared client's 120s total timeout so slow steady downloads succeed while
/// `CHUNK_TIMEOUT` and the client's 20s read timeout still catch stalls.
const FETCH_TOTAL_TIMEOUT: Duration = Duration::from_secs(3600);
const WHISPER_UA: &str = concat!("Nocturne/", env!("CARGO_PKG_VERSION"), " (whisper)");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperStatus {
    pub bytes: u64,
    pub files: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperProbe {
    pub status: u16,
    pub content_length: Option<u64>,
    pub content_type: Option<String>,
    pub content_range: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    url: String,
    loaded: u64,
    total: u64,
}

fn matches_api_model(path: &str, prefix: &str) -> bool {
    path == prefix || path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'))
}

fn has_path_traversal(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.contains("..")
        || lower.contains('\\')
        || lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
}

fn raw_path_part(url: &str) -> &str {
    let before_query = url.split(['?', '#']).next().unwrap_or(url);
    if let Some(idx) = before_query.find("://") {
        let after_scheme = &before_query[idx + 3..];
        match after_scheme.find(['/', '\\']) {
            Some(slash) => &after_scheme[slash..],
            None => "",
        }
    } else {
        before_query
    }
}

pub fn whisper_url_allowed(url: &str) -> bool {
    if url.contains("..") || has_path_traversal(raw_path_part(url)) {
        return false;
    }
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return false;
    }
    let Some(host) = u.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    let path = u.path();
    if has_path_traversal(path) {
        return false;
    }
    match host.as_str() {
        "huggingface.co" => {
            path.starts_with("/onnx-community/whisper-tiny/resolve/")
                || path.starts_with("/onnx-community/whisper-base/resolve/")
                || matches_api_model(path, "/api/models/onnx-community/whisper-tiny")
                || matches_api_model(path, "/api/models/onnx-community/whisper-base")
        }
        "cdn.jsdelivr.net" => {
            path.starts_with("/npm/onnxruntime-web@")
                && path.contains("/dist/ort-wasm-simd-threaded")
                && path.ends_with(".wasm")
        }
        _ => false,
    }
}

fn redirect_host_allowed(url: &url::Url) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return false;
    }
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host.ends_with(".hf.co")
        || host == "cdn.jsdelivr.net"
}

fn cache_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("models").join("whisper"))
}

fn ensure_cache_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())
}

fn cache_path(dir: &Path, url: &str) -> PathBuf {
    let digest = Sha256::digest(url.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{hex}.bin"))
}

fn cached_file_len(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    (meta.is_file() && meta.len() > 0).then_some(meta.len())
}

fn count_cached_models(dir: &Path) -> WhisperStatus {
    let mut bytes = 0u64;
    let mut files = 0usize;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("bin") {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    bytes += meta.len();
                    files += 1;
                }
            }
        }
    }
    WhisperStatus { bytes, files }
}

#[tauri::command]
pub async fn whisper_probe_asset(app: AppHandle, http: State<'_, Http>, url: String) -> Result<WhisperProbe, String> {
    if !whisper_url_allowed(&url) {
        return Err("url not allowed".into());
    }
    let dir = cache_dir_path(&app)?;
    let url_for_cache = url.clone();
    let cached_len = tauri::async_runtime::spawn_blocking(move || -> Result<Option<u64>, String> {
        ensure_cache_dir(&dir)?;
        let dest = cache_path(&dir, &url_for_cache);
        Ok(cached_file_len(&dest))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(len) = cached_len {
        return Ok(WhisperProbe {
            status: 206,
            content_length: Some(1),
            content_type: Some("application/octet-stream".into()),
            content_range: Some(format!("bytes 0-0/{len}")),
        });
    }

    let resp = http
        .send_with_validated_redirects(&url, MAX_REDIRECT_HOPS, redirect_host_allowed, |client, u| {
            client
                .get(u.clone())
                .timeout(Duration::from_secs(20))
                .header(reqwest::header::USER_AGENT, WHISPER_UA)
                .header(reqwest::header::RANGE, "bytes=0-0")
        })
        .await?;

    let status = resp.status().as_u16();
    let content_length = resp.content_length();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let content_range = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    Ok(WhisperProbe {
        status,
        content_length,
        content_type,
        content_range,
    })
}

#[tauri::command]
pub async fn whisper_fetch_asset(app: AppHandle, http: State<'_, Http>, url: String) -> Result<Response, String> {
    if !whisper_url_allowed(&url) {
        return Err("url not allowed".into());
    }
    let dir = cache_dir_path(&app)?;
    let url_for_cache = url.clone();
    let (dest, cached) = tauri::async_runtime::spawn_blocking(move || -> Result<(PathBuf, Option<Vec<u8>>), String> {
        ensure_cache_dir(&dir)?;
        let dest = cache_path(&dir, &url_for_cache);
        if let Ok(bytes) = std::fs::read(&dest) {
            if !bytes.is_empty() {
                return Ok((dest, Some(bytes)));
            }
        }
        Ok((dest, None))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(bytes) = cached {
        return Ok(Response::new(bytes));
    }

    let mut resp = http
        .send_with_validated_redirects(&url, MAX_REDIRECT_HOPS, redirect_host_allowed, |client, u| {
            client
                .get(u.clone())
                .timeout(FETCH_TOTAL_TIMEOUT)
                .header(reqwest::header::USER_AGENT, WHISPER_UA)
        })
        .await?;

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("HTTP_404".into());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);
    if total > MAX_ASSET_BYTES as u64 {
        return Err("asset too large".into());
    }

    let mut buf = Vec::with_capacity(total.min(32 * 1024 * 1024) as usize);
    let mut last_emit = 0u64;
    while let Some(chunk) = tokio::time::timeout(CHUNK_TIMEOUT, resp.chunk())
        .await
        .map_err(|_| "network: download timed out".to_string())?
        .map_err(|e| format!("network: {}", e.without_url()))?
    {
        if buf.len() + chunk.len() > MAX_ASSET_BYTES {
            return Err("asset too large".into());
        }
        buf.extend_from_slice(&chunk);
        let loaded = buf.len() as u64;
        if loaded - last_emit >= 256 * 1024 || (total > 0 && loaded >= total) {
            last_emit = loaded;
            let _ = app.emit(
                "whisper:progress",
                DownloadProgress {
                    url: url.clone(),
                    loaded,
                    total,
                },
            );
        }
    }

    let loaded = buf.len() as u64;
    if total > 0 && loaded != total {
        return Err("incomplete asset download".into());
    }

    let buf = if !buf.is_empty() {
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let tmp = dest.with_extension(format!("{unique}.tmp"));
        let dest_save = dest.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let write_ok = std::fs::write(&tmp, &buf).is_ok();
            if !write_ok || std::fs::rename(&tmp, &dest_save).is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
            buf
        })
        .await
        .map_err(|e| e.to_string())?
    } else {
        buf
    };

    Ok(Response::new(buf))
}

#[tauri::command]
pub async fn whisper_model_status(app: AppHandle) -> Result<WhisperStatus, String> {
    let dir = cache_dir_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_cache_dir(&dir)?;
        Ok(count_cached_models(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn whisper_model_clear(app: AppHandle) -> Result<(), String> {
    let dir = cache_dir_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_cache_dir(&dir)?;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_whisper_onnx_models_and_ort_wasm() {
        assert!(whisper_url_allowed("https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json"));
        assert!(whisper_url_allowed("https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx"));
        assert!(whisper_url_allowed("https://huggingface.co/api/models/onnx-community/whisper-tiny"));
        assert!(whisper_url_allowed("https://huggingface.co/api/models/onnx-community/whisper-tiny/tree/main"));
        assert!(whisper_url_allowed("https://huggingface.co/api/models/onnx-community/whisper-base"));
        assert!(whisper_url_allowed("https://huggingface.co/api/models/onnx-community/whisper-base/revision/main"));
        assert!(whisper_url_allowed("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm"));

        assert!(!whisper_url_allowed("https://huggingface.co/api/models/onnx-community/whisper-tiny-evil"));
        assert!(!whisper_url_allowed("https://huggingface.co/api/models/onnx-community/whisper-base2/tree/main"));
        assert!(!whisper_url_allowed("https://huggingface.co/arbitrary-user/evil-model/resolve/main/model.onnx"));
        assert!(!whisper_url_allowed("https://huggingface.co/onnx-community/whisper-tiny/resolve/main/../../etc/passwd"));
        assert!(!whisper_url_allowed("https://huggingface.co/onnx-community/whisper-tiny/resolve/main/%2e%2e/secret"));
        assert!(!whisper_url_allowed("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0/dist/ort.min.js"));
        assert!(!whisper_url_allowed("http://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json"));
        assert!(!whisper_url_allowed("https://evil.com/ort-wasm-simd-threaded.asyncify.wasm"));
    }

    #[test]
    fn status_counts_only_bin_files_and_probe_ignores_empty_files() {
        let dir = std::env::temp_dir().join(format!("nocturne-whisper-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("model.bin");
        let empty = dir.join("empty.bin");
        let tmp = dir.join("partial.abcd.tmp");
        std::fs::write(&bin, b"12345").unwrap();
        std::fs::write(&empty, b"").unwrap();
        std::fs::write(&tmp, b"1234567890").unwrap();

        let status = count_cached_models(&dir);
        assert_eq!(status.files, 2);
        assert_eq!(status.bytes, 5);
        assert_eq!(cached_file_len(&bin), Some(5));
        assert_eq!(cached_file_len(&empty), None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
