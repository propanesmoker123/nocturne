// An app ACL manifest makes every custom command require an explicit permission,
// so remote pages (the vk.ru session window) can never invoke them.
const COMMANDS: &[&str] = &[
    "vk_api",
    "proxy_fetch",
    "lyrics_fetch",
    "lyrics_ai",
    "whisper_probe_asset",
    "whisper_fetch_asset",
    "whisper_model_status",
    "whisper_model_clear",
    "session_status",
    "session_login",
    "session_logout",
    "sc_status",
    "sc_login",
    "sc_logout",
    "sc_api",
    "sc_stream",
    "spotify_open",
    "spotify_bounds",
    "spotify_filter",
    "spotify_close",
    "spotify_control",
    "spotify_status",
    "spotify_login_start",
    "spotify_login_finish",
    "spotify_login_cancel",
    "set_user_agent",
    "island_set_hit_rect",
    "island_configure",
    "search_open",
    "search_hide",
    "clipboard_invite_code",
    "media_update",
    "set_close_to_tray",
    "import_wallpaper",
    "list_wallpapers",
    "delete_wallpaper",
    "journal_write",
    "journal_tail",
    "journal_open_dir",
    "app_quit",
];

fn main() {
    // Native fixture executables need the same common-controls activation as the app binary.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-examples=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
