//! Plain-text troubleshooting journal (Settings → Журнал). Two files of up to 5 MB each — the
//! current one and the previous one — so it never takes more than ~10 MB. Callers must never
//! pass tokens, cookies, URL queries or what the user listens to.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const CURRENT: &str = "nocturne.log";
const PREVIOUS: &str = "nocturne.1.log";
const MAX_LINE: usize = 600;
/// How much the "Скопировать" button hands over: enough for a session, small enough to paste.
const TAIL_BYTES: u64 = 96 * 1024;

pub struct Journal {
    dir: PathBuf,
    max: u64,
    file: Option<File>,
    size: u64,
}

impl Journal {
    pub fn open(dir: PathBuf, max: u64) -> Self {
        let _ = fs::create_dir_all(&dir);
        let mut j = Journal { dir, max, file: None, size: 0 };
        j.reopen();
        j
    }

    fn reopen(&mut self) {
        self.file = OpenOptions::new().create(true).append(true).open(self.dir.join(CURRENT)).ok();
        self.size = self.file.as_ref().and_then(|f| f.metadata().ok()).map(|m| m.len()).unwrap_or(0);
    }

    fn rotate(&mut self) {
        self.file = None;
        let _ = fs::rename(self.dir.join(CURRENT), self.dir.join(PREVIOUS));
        self.reopen();
    }

    pub fn append(&mut self, line: &str) {
        let bytes = line.as_bytes();
        if self.size > 0 && self.size + bytes.len() as u64 > self.max {
            self.rotate();
        }
        if let Some(f) = self.file.as_mut() {
            if f.write_all(bytes).is_ok() {
                self.size += bytes.len() as u64;
            }
        }
    }

    /// The newest `max_bytes` of the journal (previous file first), cut at a line start.
    pub fn tail(&self, max_bytes: u64) -> String {
        let current = read_tail(&self.dir.join(CURRENT), max_bytes);
        let left = max_bytes.saturating_sub(current.len() as u64);
        let mut out = if left > 0 { read_tail(&self.dir.join(PREVIOUS), left) } else { Vec::new() };
        out.extend_from_slice(&current);
        let start = if out.len() as u64 >= max_bytes { out.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0) } else { 0 };
        String::from_utf8_lossy(&out[start..]).into_owned()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

fn read_tail(path: &Path, max_bytes: u64) -> Vec<u8> {
    let Ok(mut f) = File::open(path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(max_bytes);
    if f.seek(SeekFrom::Start(from)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    buf
}

/// One line per entry, bounded, so a hostile or huge message cannot bloat or forge entries.
pub fn sanitize(msg: &str) -> String {
    let flat: String = msg.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut cut: String = flat.chars().take(MAX_LINE).collect();
    if flat.chars().count() > MAX_LINE {
        cut.push('…');
    }
    cut
}

/// "2026-10-06 13:45:07 UTC" from a Unix time in seconds.
pub fn timestamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", rem / 3600, rem % 3600 / 60, rem % 60)
}

static SINK: OnceLock<Mutex<Journal>> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = SINK.set(Mutex::new(Journal::open(dir, MAX_FILE_BYTES)));
    let webview = tauri::webview_version().unwrap_or_else(|_| "?".into());
    write(
        "app",
        &format!("Nocturne {} started ({} {}, WebView2 {webview})", app.package_info().version, std::env::consts::OS, std::env::consts::ARCH),
    );
}

pub fn write(area: &str, msg: &str) {
    let msg = sanitize(msg);
    if cfg!(debug_assertions) {
        eprintln!("[{area}] {msg}");
    }
    let Some(sink) = SINK.get() else { return };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    if let Ok(mut j) = sink.lock() {
        j.append(&format!("{} [{area}] {msg}\n", timestamp(now)));
    }
}

fn valid_area(area: &str) -> bool {
    !area.is_empty() && area.len() <= 16 && area.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}

#[tauri::command]
pub fn journal_write(area: String, message: String) {
    if valid_area(&area) {
        write(&area, &message);
    }
}

#[tauri::command]
pub fn journal_tail() -> String {
    SINK.get().and_then(|s| s.lock().ok().map(|j| j.tail(TAIL_BYTES))).unwrap_or_default()
}

#[tauri::command]
pub fn journal_open_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = SINK.get().and_then(|s| s.lock().ok().map(|j| j.dir().to_path_buf())).ok_or("journal is off")?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("nocturne-journal-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rotates_into_one_previous_file() {
        let dir = temp_dir();
        let mut j = Journal::open(dir.clone(), 40);
        for i in 0..10 {
            j.append(&format!("line {i:02} ........\n")); // 17 bytes: two fit under 40
        }
        let cur = fs::read_to_string(dir.join(CURRENT)).unwrap();
        let prev = fs::read_to_string(dir.join(PREVIOUS)).unwrap();
        assert_eq!(cur, "line 08 ........\nline 09 ........\n");
        assert_eq!(prev, "line 06 ........\nline 07 ........\n");
        assert!(fs::read_dir(&dir).unwrap().count() == 2, "never more than two files");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_appending_across_restarts() {
        let dir = temp_dir();
        Journal::open(dir.clone(), 1000).append("a\n");
        Journal::open(dir.clone(), 1000).append("b\n");
        assert_eq!(fs::read_to_string(dir.join(CURRENT)).unwrap(), "a\nb\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn tail_spans_both_files_and_starts_on_a_line() {
        let dir = temp_dir();
        let mut j = Journal::open(dir.clone(), 40);
        for i in 0..6 {
            j.append(&format!("line {i:02} ........\n"));
        }
        assert_eq!(j.tail(1000), "line 02 ........\nline 03 ........\nline 04 ........\nline 05 ........\n");
        assert_eq!(j.tail(30), "line 05 ........\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sanitize_flattens_and_bounds() {
        assert_eq!(sanitize("a\nb\r\tc"), "a b  c");
        assert_eq!(sanitize(&"x".repeat(700)).chars().count(), MAX_LINE + 1);
    }

    #[test]
    fn timestamps_are_utc_calendar_dates() {
        assert_eq!(timestamp(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(timestamp(1_791_291_372), "2026-10-06 12:56:12 UTC");
        assert_eq!(timestamp(951_782_400), "2000-02-29 00:00:00 UTC");
    }

    #[test]
    fn frontend_areas_are_short_lowercase_words() {
        assert!(valid_area("player"));
        assert!(valid_area("log-in"));
        assert!(!valid_area(""));
        assert!(!valid_area("Player"));
        assert!(!valid_area("a b"));
        assert!(!valid_area(&"a".repeat(17)));
    }
}
