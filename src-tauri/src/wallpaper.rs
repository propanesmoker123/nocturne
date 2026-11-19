//! Copies user-chosen wallpapers into `$APPDATA/wallpapers`, the only folder the asset
//! protocol may serve. They stay there (a small gallery in Settings) until the user deletes them.

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

fn wallpaper_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("wallpapers"))
}

fn import_wallpaper_sync(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    let ext = allowed_extension(src).ok_or("Этот формат не подходит для обоев")?;
    let meta = std::fs::metadata(src).map_err(|e| format!("Файл недоступен: {e}"))?;
    if !meta.is_file() {
        return Err("Это не файл".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("Файл больше 2 ГБ".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let uid = uuid::Uuid::new_v4().simple().to_string();
    let short_uid = &uid[..8];
    let tmp = dir.join(format!("{uid}.tmp"));
    let dest = dir.join(format!("wallpaper-{stamp}-{short_uid}.{ext}"));
    if let Err(e) = std::fs::copy(src, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Не удалось скопировать: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Не удалось скопировать: {e}"));
    }
    Ok(dest)
}

#[tauri::command]
pub async fn import_wallpaper(app: AppHandle, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let dir = wallpaper_dir_path(&app)?;
    let dest = tauri::async_runtime::spawn_blocking(move || import_wallpaper_sync(&src, &dir))
        .await
        .map_err(|e| e.to_string())??;
    Ok(dest.to_string_lossy().into_owned())
}

/// A file this module created: `wallpaper-<stamp>.<allowed ext>` directly inside `dir`.
pub fn is_imported(path: &Path, dir: &Path) -> bool {
    path.parent() == Some(dir)
        && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("wallpaper-"))
        && allowed_extension(path).is_some()
}

fn delete_wallpaper_sync(path: &Path, dir: &Path) -> Result<(), String> {
    let file_name = path.file_name().and_then(|n| n.to_str()).ok_or("Это не сохранённые обои")?;
    if !file_name.starts_with("wallpaper-") || allowed_extension(path).is_none() {
        return Err("Это не сохранённые обои".into());
    }
    let Some(parent) = path.parent() else {
        return Err("Это не сохранённые обои".into());
    };
    let canon_dir = std::fs::canonicalize(dir).map_err(|_| "Это не сохранённые обои".to_string())?;
    let canon_parent = std::fs::canonicalize(parent).map_err(|_| "Это не сохранённые обои".to_string())?;
    if canon_parent != canon_dir {
        return Err("Это не сохранённые обои".into());
    }
    let target = canon_dir.join(file_name);
    let meta = std::fs::symlink_metadata(&target).map_err(|e| format!("Не удалось удалить: {e}"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Это не сохранённые обои".into());
    }
    std::fs::remove_file(&target).map_err(|e| format!("Не удалось удалить: {e}"))
}

/// Imported wallpapers, newest first.
#[tauri::command]
pub async fn list_wallpapers(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = wallpaper_dir_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.path())
            .filter(|p| is_imported(p, &dir))
            .collect();
        files.sort();
        files.reverse();
        Ok(files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes one imported wallpaper; anything outside the wallpaper folder is refused.
#[tauri::command]
pub async fn delete_wallpaper(app: AppHandle, path: String) -> Result<(), String> {
    let dir = wallpaper_dir_path(&app)?;
    let p = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || delete_wallpaper_sync(&p, &dir))
        .await
        .map_err(|e| e.to_string())?
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
    fn only_imported_files_in_the_folder_count() {
        let dir = Path::new("C:/data/wallpapers");
        assert!(is_imported(Path::new("C:/data/wallpapers/wallpaper-1700.mp4"), dir));
        assert!(is_imported(Path::new("C:/data/wallpapers/wallpaper-1700-a1b2c3d4.mp4"), dir));
        assert!(!is_imported(Path::new("C:/data/wallpapers/sub/wallpaper-1.mp4"), dir));
        assert!(!is_imported(Path::new("C:/data/wallpapers/../settings.json"), dir));
        assert!(!is_imported(Path::new("C:/data/wallpapers/other.png"), dir));
        assert!(!is_imported(Path::new("C:/data/wallpapers/wallpaper-1.exe"), dir));
        assert!(!is_imported(Path::new("C:/Windows/wallpaper-1.png"), dir));
    }

    #[test]
    fn rejects_other_files() {
        assert_eq!(allowed_extension(Path::new("evil.exe")), None);
        assert_eq!(allowed_extension(Path::new("noext")), None);
        assert_eq!(allowed_extension(Path::new("song.mp3")), None);
    }

    #[test]
    fn import_generates_unique_names_and_delete_canonicalizes_slashes_and_rejects_outside() {
        let root = std::env::temp_dir().join(format!("nocturne-wp-{}", uuid::Uuid::new_v4().simple()));
        let dir = root.join("wallpapers");
        let src = root.join("src.png");
        let outside = root.join("wallpaper-999.png");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&src, b"png-bytes").unwrap();
        std::fs::write(&outside, b"keep-me").unwrap();

        let p1 = import_wallpaper_sync(&src, &dir).unwrap();
        let p2 = import_wallpaper_sync(&src, &dir).unwrap();
        assert_ne!(p1, p2, "rapid imports must not collide");
        assert!(is_imported(&p1, &dir));
        assert!(is_imported(&p2, &dir));
        // No leftover .tmp files.
        let tmps: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("tmp"))
            .collect();
        assert!(tmps.is_empty());

        // Forward-slash variant of Windows path must still delete successfully.
        let forward_slash = PathBuf::from(p1.to_string_lossy().replace('\\', "/"));
        delete_wallpaper_sync(&forward_slash, &dir).unwrap();
        assert!(!p1.exists());

        // File outside wallpapers dir must be rejected even with matching name.
        assert!(delete_wallpaper_sync(&outside, &dir).is_err());
        assert!(outside.exists());

        // Directory masquerading as a wallpaper must be rejected.
        let fake_dir = dir.join("wallpaper-dir.png");
        std::fs::create_dir(&fake_dir).unwrap();
        assert!(delete_wallpaper_sync(&fake_dir, &dir).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}
