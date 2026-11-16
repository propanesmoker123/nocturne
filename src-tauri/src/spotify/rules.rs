use url::Url;

pub fn allowed_navigation(url: &Url) -> bool {
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(url.host_str(), Some("open.spotify.com" | "accounts.spotify.com" | "www.spotify.com"
            | "accounts.google.com" | "appleid.apple.com" | "idmsa.apple.com" | "www.facebook.com"))
}

pub fn target_url(page: &str, value: Option<&str>) -> Result<Url, String> {
    let mut url = Url::parse("https://open.spotify.com/").unwrap();
    match page {
        "home" | "resume" => {},
        "library" => url.set_path("/collection/playlists"),
        "liked" => url.set_path("/collection/tracks"),
        "login" => url = Url::parse("https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F").unwrap(),
        "search" => {
            let term = value.unwrap_or_default().trim();
            if term.chars().count() > 500 { return Err("Поисковый запрос слишком длинный".into()); }
            url.path_segments_mut().unwrap().pop_if_empty().push("search").push(term);
        },
        "link" => {
            let input = value.unwrap_or_default().trim();
            let raw = if input.starts_with("spotify:") {
                format!("https://open.spotify.com/{}", input.trim_start_matches("spotify:").replace(':', "/"))
            } else { input.to_owned() };
            let candidate = Url::parse(&raw).map_err(|_| "Некорректная ссылка Spotify")?;
            if !allowed_navigation(&candidate) || candidate.host_str() != Some("open.spotify.com") { return Err("Нужна ссылка open.spotify.com".into()); }
            let segments: Vec<_> = candidate.path_segments().into_iter().flatten().filter(|s| !s.is_empty()).collect();
            let content = if segments.first().is_some_and(|s| *s == "embed" || s.starts_with("intl-")) { &segments[1..] } else { &segments[..] };
            if content.len() != 2 || !matches!(content[0], "track" | "playlist" | "album" | "artist") || content[1].len() != 22 || !content[1].bytes().all(|c| c.is_ascii_alphanumeric()) {
                return Err("Нужна ссылка на трек, плейлист, альбом или исполнителя Spotify".into());
            }
            url.set_path(&format!("/{}/{}", content[0], content[1]));
        },
        _ => return Err("Неизвестный раздел Spotify".into()),
    }
    Ok(url)
}

pub fn valid_bounds(x: f64, y: f64, width: f64, height: f64, outer_width: f64, outer_height: f64) -> bool {
    [x,y,width,height,outer_width,outer_height].iter().all(|v| v.is_finite())
        && x >= 0.0 && y >= 0.0 && width >= 100.0 && height >= 100.0
        && x + width <= outer_width + 1.0 && y + height <= outer_height + 1.0
}

/// Buttons take no value; seek is seconds into a track (under a day), volume is 0..1.
pub fn control_allowed(action: &str, value: Option<f64>) -> bool {
    match (action, value) {
        ("toggle" | "play" | "pause" | "next" | "previous" | "shuffle" | "repeat" | "mute" | "like" | "reload", None) => true,
        ("seek", Some(v)) => v.is_finite() && (0.0..=86_400.0).contains(&v),
        ("volume", Some(v)) => v.is_finite() && (0.0..=1.0).contains(&v),
        _ => false,
    }
}

pub fn valid_spotify_id(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|c| c.is_ascii_alphanumeric())
}

fn split_entity_route<'a>(route: &'a str, prefix: &str) -> Option<(&'a str, Option<&'a str>)> {
    let rest = route.strip_prefix(prefix)?;
    let (id, sub) = match rest.split_once('/') {
        Some((id, sub)) => (id, Some(sub)),
        None => (rest, None),
    };
    valid_spotify_id(id).then_some((id, sub))
}

pub fn valid_api_path(method: &str, path: &str) -> bool {
    if !path.starts_with('/') || path.len() > 600 || path.contains("..") || path.bytes().any(|b| b <= 32) {
        return false;
    }
    let route = path.split('?').next().unwrap_or_default();
    match method {
        "GET" => {
            matches!(
                route,
                "/me"
                    | "/me/tracks"
                    | "/me/playlists"
                    | "/me/albums"
                    | "/me/following"
                    | "/me/editable-playlists"
                    | "/me/top/tracks"
                    | "/me/top/artists"
                    | "/me/player/recently-played"
                    | "/home"
                    | "/browse"
                    | "/radio"
                    | "/search"
                    | "/recommendations"
            ) || split_entity_route(route, "/playlists/").is_some_and(|(_, sub)| matches!(sub, None | Some("tracks")))
                || split_entity_route(route, "/albums/").is_some_and(|(_, sub)| matches!(sub, None | Some("tracks")))
                || split_entity_route(route, "/artists/").is_some_and(|(_, sub)| matches!(sub, None | Some("top-tracks" | "albums" | "related" | "related-artists")))
                || split_entity_route(route, "/tracks/").is_some_and(|(_, sub)| matches!(sub, None | Some("lyrics" | "related")))
                || route.strip_prefix("/audio-analysis/").is_some_and(valid_spotify_id)
        }
        "POST" => split_entity_route(route, "/playlists/").is_some_and(|(_, sub)| sub == Some("tracks")),
        "PUT" | "DELETE" => {
            matches!(route, "/me/tracks" | "/me/albums" | "/me/following")
                || split_entity_route(route, "/playlists/").is_some_and(|(_, sub)| matches!(sub, Some("tracks" | "followers")))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_on_real_https_provider_origins() {
        // Spotify's social sign-in links redirect the current view, not only popups.
        for url in ["https://open.spotify.com/", "https://accounts.spotify.com/login", "https://www.spotify.com/int/why-not-available/", "https://accounts.google.com/o/oauth2/v2/auth", "https://appleid.apple.com/auth/authorize", "https://idmsa.apple.com/appleauth/auth/authorize/signin", "https://www.facebook.com/v2.0/dialog/oauth"] {
            assert!(allowed_navigation(&url::Url::parse(url).unwrap()), "{url}");
        }
        for url in ["http://open.spotify.com/", "https://open.spotify.com.evil.test/", "https://user@open.spotify.com/", "https://open.spotify.com:444/", "file:///C:/private", "https://accounts.google.com.evil.test/", "https://user:password@accounts.google.com/", "http://accounts.google.com/", "https://accounts.google.com:8443/", "https://google.com/"] {
            assert!(!allowed_navigation(&url::Url::parse(url).unwrap()), "{url}");
        }
    }
    #[test]
    fn target_urls_accept_only_known_spotify_content_or_short_searches() {
        assert_eq!(target_url("home", None).unwrap().as_str(), "https://open.spotify.com/");
        assert_eq!(target_url("library", None).unwrap().path(), "/collection/playlists");
        assert_eq!(target_url("search", Some("Deftones / White Pony")).unwrap().path(), "/search/Deftones%20%2F%20White%20Pony");
        assert!(target_url("link", Some("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=share")).unwrap().query().is_none());
        for value in ["https://evil.test/", "https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC", "https://user@open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "https://open.spotify.com/settings", "javascript:alert(1)"] {
            assert!(target_url("link", Some(value)).is_err(), "{value}");
        }
        assert!(target_url("search", Some(&"x".repeat(501))).is_err());
        assert!(target_url("arbitrary", None).is_err());
    }
    #[test]
    fn child_bounds_are_finite_and_inside_the_main_window() {
        assert!(valid_bounds(10.0, 30.0, 900.0, 500.0, 1240.0, 800.0));
        for (x,y,w,h) in [(f64::NAN,0.0,900.0,500.0),(-1.0,0.0,900.0,500.0),(0.0,0.0,0.0,500.0),(10.0,30.0,1500.0,500.0),(0.0,0.0,900.0,f64::INFINITY)] {
            assert!(!valid_bounds(x,y,w,h,1240.0,800.0));
        }
    }
    #[test]
    fn controls_are_a_fixed_list_with_bounded_values() {
        for action in ["toggle", "play", "pause", "next", "previous", "shuffle", "repeat", "mute", "like", "reload"] {
            assert!(control_allowed(action, None), "{action}");
            assert!(!control_allowed(action, Some(1.0)), "{action}");
        }
        assert!(control_allowed("seek", Some(61.5)));
        assert!(control_allowed("volume", Some(0.4)));
        for (action, value) in [("seek", None), ("seek", Some(-1.0)), ("seek", Some(f64::NAN)), ("seek", Some(1e9)), ("volume", Some(1.5)), ("volume", Some(f64::INFINITY)), ("eval", None), ("click", None)] {
            assert!(!control_allowed(action, value), "{action} {value:?}");
        }
    }

    #[test]
    fn api_paths_allow_expected_spotify_routes_and_reject_unsafe_ones() {
        let id = "4uLU6hMCjMI75M1A2tKUQC";
        for (method, path) in [
            ("GET", "/me"),
            ("GET", "/me/tracks?limit=50&offset=0"),
            ("GET", "/me/playlists?limit=50"),
            ("GET", "/me/albums?limit=50"),
            ("GET", "/me/following?limit=50"),
            ("GET", "/me/editable-playlists"),
            ("GET", "/me/player/recently-played?limit=30"),
            ("GET", "/home"),
            ("GET", "/browse"),
            ("GET", "/browse?uri=spotify%3Apage%3A0JQ5DAqbMKFEC4WFtoNRpw&q=Pop"),
            ("GET", &format!("/radio?uri=spotify:track:{id}")),
            ("GET", &format!("/playlists/{id}/tracks?offset=50")),
            ("GET", &format!("/albums/{id}")),
            ("GET", &format!("/artists/{id}/related")),
            ("GET", &format!("/artists/{id}/related-artists")),
            ("GET", &format!("/tracks/{id}/lyrics")),
            ("GET", &format!("/tracks/{id}/related")),
            ("GET", &format!("/audio-analysis/{id}")),
            ("POST", &format!("/playlists/{id}/tracks?ids={id}")),
            ("PUT", &format!("/me/tracks?ids={id}")),
            ("DELETE", &format!("/me/albums?ids={id}")),
            ("PUT", &format!("/me/following?ids={id}")),
            ("PUT", &format!("/playlists/{id}/followers")),
            ("DELETE", &format!("/playlists/{id}/followers")),
            ("DELETE", &format!("/playlists/{id}/tracks?uids=uid1")),
        ] {
            assert!(valid_api_path(method, path), "{method} {path}");
        }
        for (method, path) in [
            ("GET", "me"),
            ("GET", "/../me"),
            ("GET", "/me\n"),
            ("GET", "/tracks/bad-id"),
            ("GET", &format!("/tracks/{id}/evil")),
            ("GET", &format!("/artists/{id}/evil")),
            ("POST", "/me/tracks"),
            ("PUT", "/home"),
            ("DELETE", &format!("/tracks/{id}")),
        ] {
            assert!(!valid_api_path(method, path), "{method} {path}");
        }
    }
}
