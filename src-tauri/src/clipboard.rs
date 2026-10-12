//! Picks the invite code for listening together out of the clipboard. Only the code leaves this
//! module: whatever else was copied never reaches the interface. Reading here, natively, also
//! spares the person WebView's «the site wants to see your clipboard» prompt.

/// The first `XXXX-XXXX-XXXX-XXXX` group of letters and digits in `text`, upper-cased, or None.
/// Like the interface's `findCode`, a group glued to more letters or digits does not count.
pub fn find_invite(text: &str) -> Option<String> {
    // An invite is a short message; a huge clipboard is only skimmed
    let chars: Vec<char> = text.chars().take(SKIM).collect();
    let sym = |c: char| c.is_ascii_alphanumeric();
    'start: for start in 0..chars.len().saturating_sub(CODE_LEN - 1) {
        if start > 0 && sym(chars[start - 1]) {
            continue;
        }
        for (i, &c) in chars[start..start + CODE_LEN].iter().enumerate() {
            let fits = if i % 5 == 4 { c == '-' } else { sym(c) };
            if !fits {
                continue 'start;
            }
        }
        if chars.get(start + CODE_LEN).is_some_and(|&c| sym(c)) {
            continue;
        }
        return Some(chars[start..start + CODE_LEN].iter().collect::<String>().to_ascii_uppercase());
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
        if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 || OpenClipboard(std::ptr::null_mut()) == 0 {
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
pub fn clipboard_invite_code() -> Option<String> {
    clipboard_text().as_deref().and_then(find_invite)
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
}
