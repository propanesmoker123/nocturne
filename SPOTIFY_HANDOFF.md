# Spotify experiment in Nocturne

Local branch: `codex/spotify-player`. No GitHub publication or server deployment is part of this experiment. The user wants a functional foundation; visual design comes later.

## What is implemented

The Spotify rail opens the actual Spotify Web Player in a native child WebView2. Recommendations, playlists, search, library and track playback belong to Spotify's website. This supports trying a Free account without the Premium-only Web Playback SDK or a Spotify Developer Client ID. Spotify tracks are deliberately excluded from Nocturne's VK/SC `Track` and streaming pipeline.

“Войти через Chrome” opens a visible, separate Chrome profile created for this login. The user signs in on Spotify, optionally through Google, waits for the web player, then presses “Я вошёл — продолжить” in Nocturne. Native code requests only Spotify cookies from this owned browser, imports them into the Spotify WebView2, verifies the authenticated cookie is applicable to `open.spotify.com`, and closes Chrome. No Google cookies, passwords, personal Chrome profile or browser storage database are read. Credentials and cookie values never enter frontend IPC responses or logs. Login through the installed Spotify application is not implemented.

The Chrome helper uses a random loopback debugging endpoint for the owned profile. It closes on completion, cancellation, player close or a ten-minute timeout. A Windows job object ends its process tree even if Nocturne exits during an async operation. Temporary UUID profiles are removed on close; a canonical, directory-scoped sweep removes abandoned login profiles at startup and before the next login. Spotify's persistent player profile is separate from VK/SC.

## Entry points

- `src/spotify/SpotifyPage.tsx`: native host, Chrome login controls, search/link navigation, filter switch, account state badge, diagnostics, visibility and close.
- `src/spotify/SpotifyMiniPlayer.tsx`: bottom player bar shown on non-Spotify routes while Spotify owns playback (when Spotify's own bottom bar is hidden).
- `src/spotify/runtime.ts`, `src/player/commands.ts` and `src/player/bridges.ts`: playback ownership, live now-playing state (`useSpotify`), and shared commands (play/pause/toggle/next/previous/shuffle/repeat/mute/like/seek/volume) wired to the island, Windows SMTC and `navigator.mediaSession`. VK/SC playback takes ownership and pauses Spotify.
- `src-tauri/src/spotify/mod.rs` and `src-tauri/src/spotify/rules.rs`: lazy native child, navigation policy, popup handoff, bounded control validation, commands and diagnostics. Remote Spotify/auth pages receive no Nocturne IPC capabilities.
- `src-tauri/src/spotify/browser_login.rs`: owned Chrome lifecycle, scoped session import and fixed non-sensitive errors.
- `src-tauri/src/spotify/session_cookies.rs`: acknowledged native WebView2 cookie insertion. Preserve the raw domain: Tauri's generic Cookie API removes a leading dot, which changes WebView2 parent-domain scope.
- `src-tauri/src/spotify/filter.js`: original bounded ad-state experiment, browser playback controls, account status detection and read-only now-playing metadata/progress extraction. The filter installs only on `https://open.spotify.com`.
- `src/app/service.ts`, `router.ts`, `Sidebar.tsx`, `App.tsx`, `src/pages/Settings.tsx`: service/route/settings wiring. Spotify can open without a VK login.

The main native window now contains more than one webview. Tauri's `get_webview_window("main")` and command argument `WebviewWindow` are unsuitable for it. Native window operations use `get_window("main")`; Spotify commands receive the invoking `Webview` and enforce label `main` in addition to command ACLs.

## Ad-filter limits

Only known state-machine messages from Spotify playback endpoints/dealer sockets are inspected. An ad state can be replaced when its advance chain already contains a subsequent music/episode state. There are no extra future-state requests, media/license rewrites or account-token hooks. Unknown shapes, cycles, missing successors, unrelated requests and binary messages pass through. Disabling the filter preserves normal traffic.

Counters describe inspected messages and substituted states, not verified audible ad removal. An ad at an unsupported boundary can still play. The filter remains experimental until tested against real Free-account playback and an actual ad break. Spotify now-playing metadata, cover art, progress and controls are bridged to Nocturne's island, Windows SMTC, MediaSession and `SpotifyMiniPlayer` from the web player's MediaSession/DOM (without audio stream waveform extraction or Connect relay).

## Running and validation

Development: `npm run tauri dev`. A standalone local test build can be produced with `npm run tauri build -- --debug --no-bundle`; it embeds the built frontend and does not require Vite at runtime. No publishing is involved.

Checks run during implementation:

- `npm test -- --maxWorkers=2`: 70 files, 540 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed; existing bundle-size/dynamic-import warnings remain.
- `cargo test --lib --locked` in `src-tauri`: 120 passed, one existing ignored test.
- `cargo run --example spotify_cookie_probe --locked`: offline native fixture confirmed generic parent-domain insertion failed for a subdomain, while the preserved-domain implementation succeeded. Uses a generated test profile and a reserved `.invalid` domain, never an account.
- Native Nocturne opened Spotify without a regional redirect and reported Widevine support. The Chrome login window opened successfully. End-to-end account login, full-track playback and a real ad break still require the user's interactive check.

The user's VPN routes `msedge.exe` directly. An anonymous Edge browser test was redirected to Spotify's regional-unavailability page; Chrome and the native WebView2 reached the player. No VPN rules were changed. The desktop player uses `nocturne.exe` and `msedgewebview2.exe`; login uses `chrome.exe`.

The public GPL project [spotify-web-ads-remover](https://github.com/tomer8007/spotify-web-ads-remover) was inspected as protocol research. Its code was not vendored into this MIT repository. The implementation here is an original bounded experiment.
