// An app ACL manifest makes every custom command require an explicit permission,
// so remote pages (the vk.ru session window) can never invoke them.
const COMMANDS: &[&str] = &[
    "vk_api",
    "proxy_fetch",
    "session_status",
    "session_login",
    "session_logout",
    "set_user_agent",
    "island_set_hit_rect",
    "island_configure",
    "media_update",
    "import_wallpaper",
    "app_quit",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
