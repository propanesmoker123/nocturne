//! Where the SoundCloud key lives between runs: Windows Credential Manager (protected by the
//! user's Windows account). Elsewhere nothing is kept yet — the Android fork brings its own.

pub const SERVICE: &str = "Nocturne";
pub const ACCOUNT: &str = "soundcloud";

pub fn load_token() -> Option<String> {
    load_in(ACCOUNT)
}

pub fn save_token(t: &str) -> Result<(), String> {
    save_in(ACCOUNT, t)
}

pub fn clear_token() {
    clear_in(ACCOUNT)
}

#[cfg(windows)]
fn load_in(account: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, account).ok()?.get_password().ok().filter(|t| !t.is_empty())
}

#[cfg(windows)]
fn save_in(account: &str, t: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, account).and_then(|e| e.set_password(t)).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn clear_in(account: &str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, account) {
        let _ = e.delete_credential();
    }
}

#[cfg(not(windows))]
fn load_in(_account: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
fn save_in(_account: &str, _t: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
fn clear_in(_account: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn token_round_trip_in_credential_manager() {
        const TEST: &str = "soundcloud-test";
        clear_in(TEST);
        assert_eq!(load_in(TEST), None);
        save_in(TEST, "k-123").unwrap();
        assert_eq!(load_in(TEST), Some("k-123".to_string()));
        clear_in(TEST);
        assert_eq!(load_in(TEST), None);
    }
}
