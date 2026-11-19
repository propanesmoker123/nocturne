//! Picks the invite code for listening together out of the clipboard. Only the code leaves this
//! module: whatever else was copied never reaches the interface. Reading here, natively, also
//! spares the person WebView's «the site wants to see your clipboard» prompt.

/// The first `XXXX-XXXX-XXXX-XXXX` group of letters and digits in `text`, upper-cased, or None.
/// Like the interface's `findCode`, a group glued to more letters or digits does not count.
pub fn find_invite(text: &str) -> Option<String> {
    // An invite is a short message; a huge clipboard is only skimmed directly over UTF-8 bytes.
    // ASCII bytes (0x00..=0x7F) never appear inside multi-byte UTF-8 sequences, so any 19-byte
    // ASCII match is guaranteed to align on char boundaries.
    let all = text.as_bytes();
    let limit = all.len().min(SKIM);
    if limit < CODE_LEN {
        return None;
    }
    let sym = |b: u8| b.is_ascii_alphanumeric();
    'start: for start in 0..=limit - CODE_LEN {
        if start > 0 && sym(all[start - 1]) {
            continue;
        }
        for (i, &b) in all[start..start + CODE_LEN].iter().enumerate() {
            let fits = if i % 5 == 4 { b == b'-' } else { sym(b) };
            if !fits {
                continue 'start;
            }
        }
        if all.get(start + CODE_LEN).is_some_and(|&b| sym(b)) {
            continue;
        }
        let slice = std::str::from_utf8(&all[start..start + CODE_LEN]).ok()?;
        return Some(slice.to_ascii_uppercase());
    }
    None
}

const CODE_LEN: usize = 19;
const SKIM: usize = 64 * 1024;

/// The clipboard's text, if it holds any.
#[cfg(windows)]
fn clipboard_text() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;

    // SAFETY: the clipboard is opened and closed around the read; the locked buffer is read only
    // within its GlobalSize and unlocked before the clipboard is closed.
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
            return None;
        }
        let mut opened = false;
        for attempt in 0..4 {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            if attempt < 3 {
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
        }
        if !opened {
            return None;
        }
        let handle = GetClipboardData(CF_UNICODETEXT);
        let text = if handle.is_null() {
            None
        } else {
            let ptr = GlobalLock(handle) as *const u16;
            if ptr.is_null() {
                None
            } else {
                let units = (GlobalSize(handle) / 2).min(SKIM);
                let len = (0..units).take_while(|&i| *ptr.add(i) != 0).count();
                let s = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                GlobalUnlock(handle);
                Some(s)
            }
        };
        CloseClipboard();
        text
    }
}

#[cfg(not(windows))]
fn clipboard_text() -> Option<String> {
    None
}

/// «Присоединиться» opened: an invite code from the clipboard, if one was copied — and nothing else.
#[tauri::command]
pub async fn clipboard_invite_code() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| clipboard_text().as_deref().and_then(find_invite))
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_code_inside_a_forwarded_invite() {
        assert_eq!(find_invite("Слушаем вместе в Nocturne. Код: K7QM-2XFD-9WRA-HT4C"), Some("K7QM-2XFD-9WRA-HT4C".into()));
        assert_eq!(find_invite("держи k7qm-2xfd-9wra-ht4c ;)"), Some("K7QM-2XFD-9WRA-HT4C".into()));
        assert_eq!(find_invite("K7QM-2XFD-9WRA-HT4C"), Some("K7QM-2XFD-9WRA-HT4C".into()));
    }

    #[test]
    fn ignores_text_without_a_code() {
        assert_eq!(find_invite(""), None);
        assert_eq!(find_invite("просто текст и ссылка https://vk.ru/audio"), None);
        assert_eq!(find_invite("abcdefghijklmnop"), None);
        assert_eq!(find_invite("K7QM-2XFD-9WRA"), None);
    }

    #[test]
    fn a_group_glued_to_more_symbols_is_not_a_code() {
        assert_eq!(find_invite("XK7QM-2XFD-9WRA-HT4C"), None);
        assert_eq!(find_invite("K7QM-2XFD-9WRA-HT4CX"), None);
        assert_eq!(find_invite("XK7QM-2XFD-9WRA-HT4CX и потом Q7QM-2XFD-9WRA-HT4C"), Some("Q7QM-2XFD-9WRA-HT4C".into()));
    }

    /// Reads the real clipboard (never prints it): `cargo test clipboard_reads -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn clipboard_reads() {
        let text = clipboard_text();
        println!("clipboard text: {}", text.map_or("none".into(), |t| format!("{} UTF-16 units", t.encode_utf16().count())));
    }

    #[test]
    fn a_huge_clipboard_is_only_skimmed() {
        let mut text = "я".repeat(200_000);
        text.push_str(" K7QM-2XFD-9WRA-HT4C");
        assert_eq!(find_invite(&text), None);
    }

    #[test]
    fn multibyte_utf8_neighbors_and_skim_edge_work() {
        assert_eq!(find_invite("🎵k7qm-2xfd-9wra-ht4c🎵"), Some("K7QM-2XFD-9WRA-HT4C".into()));
        assert_eq!(find_invite("код:K7QM-2XFD-9WRA-HT4Cя"), Some("K7QM-2XFD-9WRA-HT4C".into()));
        // Code ending exactly at SKIM with a glued ASCII char at SKIM must still be rejected.
        let mut edge = " ".repeat(SKIM - CODE_LEN);
        edge.push_str("K7QM-2XFD-9WRA-HT4CX");
        assert_eq!(find_invite(&edge), None);
    }
}
