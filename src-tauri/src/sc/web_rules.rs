//! What every hidden site session shares: which
//! writes the signed-in person may make, the page script that makes them, and what its answer means.

use serde::Deserialize;
use serde_json::Value;
use url::Url;

use super::api::{self, ScError};

// a session that checks the address on its own side does not need these
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) const SITE: &str = "https://soundcloud.com/";

pub(crate) fn network() -> ScError {
    ScError::Network { message: "SoundCloud browser request did not finish".to_string() }
}

#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn is_site(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("soundcloud.com") && url.port_or_known_default() == Some(443)
}

/// The writes the signed-in person may make here: their own likes and followings.
pub(crate) fn owned_write_path(method: &str, path: &str, me: i64) -> bool {
    if me <= 0 || !api::allowed(method, path) || !matches!(method, "POST" | "PUT" | "DELETE") {
        return false;
    }
    let parts: Vec<_> = path.split('?').next().unwrap_or_default().split('/').collect();
    if parts.get(1) == Some(&"me") {
        return matches!(method, "POST" | "DELETE")
            && parts.get(2) == Some(&"followings")
            && parts.get(3).and_then(|s| s.parse::<i64>().ok()).is_some_and(|id| id > 0 && id != me);
    }
    parts.get(2).and_then(|s| s.parse::<i64>().ok()) == Some(me)
        && parts.get(4).and_then(|s| s.parse::<u64>().ok()).is_some_and(|id| id > 0)
}

#[derive(Deserialize, Debug)]
pub(crate) struct Reply {
    status: Option<u16>,
    #[serde(default)]
    captcha: bool,
    #[serde(default)]
    network: bool,
}

#[derive(Deserialize)]
pub(crate) struct Poll {
    reply: Option<Reply>,
    #[serde(default)]
    challenge: bool,
}

pub(crate) fn result(reply: Reply) -> Result<Value, ScError> {
    if reply.network { return Err(network()); }
    match reply.status {
        Some(200..=299) => Ok(Value::Null),
        Some(403) if reply.captcha => Err(ScError::Challenge),
        Some(status) => Err(ScError::Http { status }),
        None => Err(network()),
    }
}

pub(crate) fn progress(poll: Poll) -> Option<Result<Value, ScError>> {
    // The site's fetch wrapper can hold the response until its challenge is completed. Return
    // control now, leaving its UI visible, rather than letting a network timeout mask the captcha.
    if poll.reply.as_ref().is_some_and(|r| matches!(r.status, Some(200..=299))) {
        return Some(Ok(Value::Null));
    }
    if poll.challenge { return Some(Err(ScError::Challenge)); }
    poll.reply.map(result)
}

pub(crate) fn script(args: Value) -> String {
    format!("({})({args})", include_str!("like.js"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_signed_in_users_likes_and_followings_can_change() {
        assert!(owned_write_path("PUT", "/users/7/track_likes/402", 7));
        assert!(owned_write_path("DELETE", "/users/7/track_likes/402", 7));
        assert!(owned_write_path("DELETE", "/me/followings/12", 7));
        for (method, path, me) in [("DELETE", "/me/followings/7", 7), ("DELETE", "/me/followings/0", 7), ("DELETE", "/me/followings/12", 0)] {
            assert!(!owned_write_path(method, path, me), "{method} {path}");
        }
        for (method, path, me) in [
            ("PUT", "/users/8/track_likes/402", 7), ("PUT", "/users/0/track_likes/402", 0),
            ("GET", "/users/7/track_likes/402", 7), ("PUT", "/users/7/track_likes/0", 7),
            ("PUT", "/users/7/track_likes/402?x=1", 7), ("PUT", "/users/7/track_likes/402/extra", 7),
        ] { assert!(!owned_write_path(method, path, me), "{method} {path}"); }
    }

    #[test]
    fn service_keys_only_go_to_the_site() {
        for url in ["http://soundcloud.com/", "https://soundcloud.com.evil.test/", "https://soundcloud.com:444/"] {
            assert!(!is_site(&Url::parse(url).unwrap()));
        }
        assert!(is_site(&Url::parse(SITE).unwrap()));
    }

    #[test]
    fn a_follow_is_signed_for_another_person_in_the_current_account() {
        assert!(owned_write_path("POST", "/me/followings/12", 7));
        assert!(owned_write_path("POST", "/me/followings/12?signature=1%3A73c1f3", 7));
        for (path, me) in [
            ("/me/followings/7?signature=1:abc", 7),
            ("/me/followings/0?signature=1:abc", 7),
            ("/me/followings/12?signature=1:abc", 0),
            ("/me/followings/12?signature=1:abc&extra=1", 7),
            ("/me/followings/12?signature=", 7),
            ("/me/followings/9223372036854775808?signature=1:abc", 7),
        ] { assert!(!owned_write_path("POST", path, me), "{path}"); }
    }

    #[test]
    fn only_a_successful_status_means_a_like_was_changed() {
        let reply = |status, captcha| Reply { status: Some(status), captcha, network: false };
        assert_eq!(result(reply(204, false)), Ok(Value::Null));
        assert_eq!(result(reply(403, true)), Err(ScError::Challenge));
        assert_eq!(result(reply(403, false)), Err(ScError::Http { status: 403 }));
        assert_eq!(result(reply(401, false)), Err(ScError::Http { status: 401 }));
    }

    #[test]
    fn a_visible_challenge_returns_control_before_a_pending_fetch_times_out() {
        assert_eq!(progress(Poll { reply: None, challenge: true }), Some(Err(ScError::Challenge)));
        assert_eq!(progress(Poll { reply: None, challenge: false }), None);
        let network_reply = Reply { status: None, captcha: false, network: true };
        assert_eq!(progress(Poll { reply: Some(network_reply), challenge: true }), Some(Err(ScError::Challenge)));
    }
}
