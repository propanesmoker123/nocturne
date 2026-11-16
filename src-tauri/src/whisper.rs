//! Local Whisper AI asset cache & allowlisted model/WASM downloader.
//! Keeps HuggingFace / jsDelivr downloads strictly in Rust so renderer CSP stays minimal.

use std::path::PathBuf;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::http::Http;

const MAX_ASSET_BYTES: usize = 350 * 1024 * 1024;
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

pub fn whisper_url_allowed(url: &str) -> bool {
    if url.contains("..") {
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
    if path.contains("..") {
        return false;
    }
    match host.as_str() {
        "huggingface.co" => {
            path.starts_with("/onnx-community/whisper-tiny/resolve/")
                || path.starts_with("/onnx-community/whisper-base/resolve/")
                || path.starts_with("/api/models/onnx-community/whisper-tiny")
                || path.starts_with("/api/models/onnx-community/whisper-base")
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

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models").join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn cache_path(dir: &PathBuf, url: &str) -> PathBuf {
    let digest = Sha256::digest(url.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{hex}.bin"))
}

#[tauri::command]
pub async fn whisper_probe_asset(app: AppHandle, http: State<'_, Http>, url: String) -> Result<WhisperProbe, String> {
    if !whisper_url_allowed(&url) {
        return Err("url not allowed".into());
    }
    let dir = cache_dir(&app)?;
    let dest = cache_path(&dir, &url);
    if let Ok(meta) = std::fs::metadata(&dest) {
        if meta.is_file() {
            let len = meta.len();
            return Ok(WhisperProbe {
                status: 206,
                content_length: Some(1),
                content_type: Some("application/octet-stream".into()),
                content_range: Some(format!("bytes 0-0/{len}")),
            });
        }
    }

    let resp = http
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(20))
        .header(reqwest::header::USER_AGENT, WHISPER_UA)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| format!("network: {}", e.without_url()))?;

    if !redirect_host_allowed(resp.url()) {
        return Err("redirect not allowed".into());
    }
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
    let dir = cache_dir(&app)?;
    let dest = cache_path(&dir, &url);

    let dest_read = dest.clone();
    if let Ok(bytes) = tauri::async_runtime::spawn_blocking(move || std::fs::read(&dest_read)).await.unwrap_or_else(|e| Err(std::io::Error::other(e.to_string()))) {
        if !bytes.is_empty() {
            return Ok(Response::new(bytes));
        }
    }

    let mut resp = http
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(180))
        .header(reqwest::header::USER_AGENT, WHISPER_UA)
        .send()
        .await
        .map_err(|e| format!("network: {}", e.without_url()))?;

    if !redirect_host_allowed(resp.url()) {
        return Err("redirect not allowed".into());
    }
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
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("network: {}", e.without_url()))? {
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

    let bytes_to_save = buf.clone();
    let tmp = dest.with_extension("tmp");
    let dest_save = dest.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if std::fs::write(&tmp, &bytes_to_save).is_ok() {
            let _ = std::fs::rename(&tmp, &dest_save);
        }
    })
    .await;

    Ok(Response::new(buf))
}

#[tauri::command]
pub async fn whisper_model_status(app: AppHandle) -> Result<WhisperStatus, String> {
    let dir = cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut bytes = 0u64;
        let mut files = 0usize;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        bytes += meta.len();
                        files += 1;
                    }
                }
            }
        }
        Ok(WhisperStatus { bytes, files })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn whisper_model_clear(app: AppHandle) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
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
        assert!(whisper_url_allowed("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm"));

        assert!(!whisper_url_allowed("https://huggingface.co/arbitrary-user/evil-model/resolve/main/model.onnx"));
        assert!(!whisper_url_allowed("https://huggingface.co/onnx-community/whisper-tiny/resolve/main/../../etc/passwd"));
        assert!(!whisper_url_allowed("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0/dist/ort.min.js"));
        assert!(!whisper_url_allowed("http://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json"));
        assert!(!whisper_url_allowed("https://evil.com/ort-wasm-simd-threaded.asyncify.wasm"));
    }
}
