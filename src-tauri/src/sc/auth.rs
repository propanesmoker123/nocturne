//! SoundCloud sign-in, the way soundcloud.com itself does it: an OAuth code with PKCE from
//! `secure.soundcloud.com/web-auth`, handed to `soundcloud.com/signin/callback`. That address is
//! never loaded: the login window catches the navigation and the code is exchanged here.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use sha2::{Digest, Sha256};
use url::Url;

pub const REDIRECT_URI: &str = "https://soundcloud.com/signin/callback";
pub const AUTH_PAGE: &str = "https://secure.soundcloud.com/web-auth";
pub const TOKEN_URL: &str = "https://secure.soundcloud.com/oauth/token";

/// The characters SoundCloud's own client draws its PKCE verifier and nonce from.
const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/// One sign-in attempt: the PKCE verifier and challenge, and the nonce carried in `state`.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub nonce: String,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("system random source");
    buf
}

fn random_word() -> String {
    random_bytes::<64>().iter().map(|b| ABC[*b as usize % ABC.len()] as char).collect()
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn new_pkce() -> Pkce {
    let verifier = random_word();
    Pkce { challenge: challenge_for(&verifier), verifier, nonce: random_word() }
}

/// An anonymous device id in the form the site uses (`NNNNNN-NNNNNN-NNNNNN-NNNNNN`).
pub fn new_device_id() -> String {
    random_bytes::<24>()
        .chunks(6)
        .map(|g| g.iter().map(|b| char::from(b'0' + b % 10)).collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

/// The sign-in page with the site's own parameters. Never `always_redirect` (CloudFront answers
/// 403) nor `embedded_in_iframe`: the page runs top-level and posts its result to itself.
pub fn auth_url(client_id: &str, app_id: &str, device_id: &str, p: &Pkce) -> String {
    let state = STANDARD.encode(serde_json::json!({ "client_id": client_id, "nonce": p.nonce }).to_string());
    let mut url = Url::parse(AUTH_PAGE).expect("auth page url");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("device_id", device_id)
        .append_pair("theme", "dark")
        .append_pair("ui_evo", "true")
        .append_pair("app_id", app_id)
        .append_pair("tracking", "local")
        .append_pair("provider_redirect", "true")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("state", &state)
        .append_pair("code_challenge", &p.challenge)
        .append_pair("code_challenge_method", "S256");
    url.set_fragment(Some("start_view=sign_in&is_visible=true"));
    url.to_string()
}

pub fn is_callback(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("soundcloud.com") && url.path() == "/signin/callback"
}

#[derive(Debug, PartialEq)]
pub enum CallbackError {
    /// The person closed the sign-in form.
    Cancelled,
    /// SoundCloud said no (`error=…`).
    Denied(String),
    /// `state` is not the one this attempt sent.
    BadState,
    Missing,
}

/// The code from the callback address, once `state` proves it answers this attempt.
pub fn code_from_callback(url: &Url, nonce: &str) -> Result<String, CallbackError> {
    let param = |k: &str| url.query_pairs().find(|(name, _)| name == k).map(|(_, v)| v.into_owned());
    if let Some(e) = param("error") {
        return Err(if e == "cancelled" { CallbackError::Cancelled } else { CallbackError::Denied(e) });
    }
    let state = param("state").ok_or(CallbackError::BadState)?;
    // base64 has no spaces: a `+` that reached us unescaped was read as one
    let decoded = STANDARD.decode(state.replace(' ', "+").as_bytes()).map_err(|_| CallbackError::BadState)?;
    let json: serde_json::Value = serde_json::from_slice(&decoded).map_err(|_| CallbackError::BadState)?;
    if json.get("nonce").and_then(|v| v.as_str()) != Some(nonce) {
        return Err(CallbackError::BadState);
    }
    param("code").filter(|c| !c.is_empty()).ok_or(CallbackError::Missing)
}

/// The form `POST TOKEN_URL` takes, as the site sends it.
pub fn token_form(code: &str, verifier: &str, client_id: &str) -> Vec<(&'static str, String)> {
    vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("code_verifier", verifier.to_string()),
        ("redirect_uri", REDIRECT_URI.to_string()),
        ("client_id", client_id.to_string()),
    ]
}

pub fn token_from(body: &serde_json::Value) -> Option<String> {
    body.get("access_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Runs in the login window. Top-level (not in soundcloud.com's iframe), the sign-in page posts its
/// result with `window.parent.postMessage` — to itself: this turns `{action: 'code'}` into a visit
/// to the callback address (which `on_navigation` catches and cancels) and `{action: 'close'}` into
/// a cancelled one.
pub const INIT_SCRIPT: &str = r#"(() => {
  if (window.top !== window || location.hostname !== 'secure.soundcloud.com') return
  const CALLBACK = 'https://soundcloud.com/signin/callback'
  const orig = window.postMessage
  window.postMessage = function (data, ...rest) {
    try {
      const d = typeof data === 'string' ? JSON.parse(data) : data
      if (d && d.action === 'code' && typeof d.query === 'string') { location.href = CALLBACK + '?' + (d.query[0] === '?' ? d.query.slice(1) : d.query); return }
      if (d && d.action === 'close') { location.href = CALLBACK + '?error=cancelled'; return }
    } catch {}
    return orig.apply(this, [data, ...rest])
  }
})()"#;

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use url::Url;

    const ABC: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

    fn state_for(client_id: &str, nonce: &str) -> String {
        let json = serde_json::json!({ "client_id": client_id, "nonce": nonce }).to_string();
        base64::engine::general_purpose::STANDARD.encode(json)
    }

    fn callback(query: &str) -> Url {
        Url::parse(&format!("https://soundcloud.com/signin/callback?{query}")).unwrap()
    }

    #[test]
    fn challenge_matches_rfc7636_example() {
        assert_eq!(challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn pkce_parts_are_random_and_well_formed() {
        let a = new_pkce();
        let b = new_pkce();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.nonce, b.nonce);
        for s in [&a.verifier, &a.nonce] {
            assert_eq!(s.len(), 64);
            assert!(s.chars().all(|c| ABC.contains(c)), "{s}");
        }
        assert_eq!(a.challenge, challenge_for(&a.verifier));
    }

    #[test]
    fn device_id_is_four_groups_of_six_digits() {
        let id = new_device_id();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 4, "{id}");
        assert!(parts.iter().all(|p| p.len() == 6 && p.chars().all(|c| c.is_ascii_digit())), "{id}");
    }

    #[test]
    fn auth_url_has_the_sites_parameters() {
        let p = new_pkce();
        let url = Url::parse(&auth_url("CID", "46941", "111111-222222-333333-444444", &p)).unwrap();
        assert_eq!(url.host_str(), Some("secure.soundcloud.com"));
        assert_eq!(url.path(), "/web-auth");
        let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
        let want = [
            ("client_id", "CID"),
            ("device_id", "111111-222222-333333-444444"),
            ("theme", "dark"),
            ("ui_evo", "true"),
            ("app_id", "46941"),
            ("tracking", "local"),
            ("provider_redirect", "true"),
            ("redirect_uri", "https://soundcloud.com/signin/callback"),
            ("code_challenge", p.challenge.as_str()),
            ("code_challenge_method", "S256"),
        ];
        for (k, v) in want {
            assert_eq!(q.get(k).map(String::as_str), Some(v), "{k}");
        }
        let state = base64::engine::general_purpose::STANDARD.decode(&q["state"]).unwrap();
        let state: serde_json::Value = serde_json::from_slice(&state).unwrap();
        assert_eq!(state, serde_json::json!({ "client_id": "CID", "nonce": p.nonce }));
        assert_eq!(url.fragment(), Some("start_view=sign_in&is_visible=true"));
        assert!(!q.contains_key("always_redirect"));
        assert!(!q.contains_key("embedded_in_iframe"));
    }

    #[test]
    fn callback_gives_the_code_when_the_nonce_matches() {
        let url = callback(&format!("code=C1&state={}", urlencoding::encode(&state_for("CID", "N"))));
        assert_eq!(code_from_callback(&url, "N"), Ok("C1".to_string()));
    }

    #[test]
    fn callback_rejects_a_foreign_nonce() {
        let url = callback(&format!("code=C1&state={}", urlencoding::encode(&state_for("CID", "OTHER"))));
        assert_eq!(code_from_callback(&url, "N"), Err(CallbackError::BadState));
        assert_eq!(code_from_callback(&callback("code=C1&state=%%%"), "N"), Err(CallbackError::BadState));
        let not_json = base64::engine::general_purpose::STANDARD.encode("nope");
        assert_eq!(code_from_callback(&callback(&format!("code=C1&state={not_json}")), "N"), Err(CallbackError::BadState));
    }

    #[test]
    fn a_plus_in_state_that_arrived_unescaped_still_reads() {
        // a nonce whose state encodes with `+`: find one, then put it in the address raw
        let nonce = (0..500).map(|i| format!("n{i}~")).find(|n| state_for("CID", n).contains('+')).unwrap();
        let url = callback(&format!("code=C1&state={}", state_for("CID", &nonce)));
        assert_eq!(code_from_callback(&url, &nonce), Ok("C1".to_string()));
    }

    #[test]
    fn cancel_from_the_page_is_cancelled() {
        assert_eq!(code_from_callback(&callback("error=cancelled"), "N"), Err(CallbackError::Cancelled));
        assert_eq!(code_from_callback(&callback("error=access_denied"), "N"), Err(CallbackError::Denied("access_denied".to_string())));
    }

    #[test]
    fn callback_without_code_is_missing() {
        let url = callback(&format!("state={}", urlencoding::encode(&state_for("CID", "N"))));
        assert_eq!(code_from_callback(&url, "N"), Err(CallbackError::Missing));
    }

    #[test]
    fn is_callback_only_for_that_address() {
        assert!(is_callback(&Url::parse("https://soundcloud.com/signin/callback?x=1").unwrap()));
        for bad in [
            "http://soundcloud.com/signin/callback",
            "https://soundcloud.com/signin",
            "https://evil.com/signin/callback",
            "https://soundcloud.com.evil.com/signin/callback",
        ] {
            assert!(!is_callback(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn token_from_reads_a_nonempty_access_token() {
        assert_eq!(token_from(&serde_json::json!({ "access_token": "abc", "scope": "*" })), Some("abc".to_string()));
        assert_eq!(token_from(&serde_json::json!({})), None);
        assert_eq!(token_from(&serde_json::json!({ "access_token": "" })), None);
    }

    #[test]
    fn token_form_has_the_five_fields() {
        let form = token_form("C", "V", "CID");
        let keys: Vec<&str> = form.iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, ["grant_type", "code", "code_verifier", "redirect_uri", "client_id"]);
        assert_eq!(form[0].1, "authorization_code");
        assert_eq!(form[3].1, REDIRECT_URI);
    }
}
