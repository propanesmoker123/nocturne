//! Copies a user-chosen wallpaper into `$APPDATA/wallpapers`, the only folder the asset
//! protocol may serve. Older imported wallpapers are removed.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

pub const ALLOWED: &[&str] = &["mp4", "webm", "mov", "m4v", "gif", "jpg", "jpeg", "png", "webp", "avif"];
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Lower-cased extension if it is an allowed wallpaper type.
pub fn allowed_extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    ALLOWED.contains(&ext.as_str()).then_some(ext)
}

fn wallpaper_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("wallpapers");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub async fn import_wallpaper(app: AppHandle, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let ext = allowed_extension(&src).ok_or("Этот формат не подходит для обоев")?;
    let meta = std::fs::metadata(&src).map_err(|e| format!("Файл недоступен: {e}"))?;
    if !meta.is_file() {
        return Err("Это не файл".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("Файл больше 2 ГБ".into());
    }
    let dir = wallpaper_dir(&app)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dest = dir.join(format!("wallpaper-{stamp}.{ext}"));
    let src2 = src.clone();
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::copy(&src2, &dest2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Не удалось скопировать: {e}"))?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p != dest && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("wallpaper-")) {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_images_and_videos_case_insensitively() {
        assert_eq!(allowed_extension(Path::new("C:/a/b.MP4")).as_deref(), Some("mp4"));
        assert_eq!(allowed_extension(Path::new("x.webp")).as_deref(), Some("webp"));
    }

    #[test]
    fn rejects_other_files() {
        assert_eq!(allowed_extension(Path::new("evil.exe")), None);
        assert_eq!(allowed_extension(Path::new("noext")), None);
        assert_eq!(allowed_extension(Path::new("song.mp3")), None);
    }
}
