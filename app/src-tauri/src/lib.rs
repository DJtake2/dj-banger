// dj-banger floating window — Tauri v2 shell.
//
// The window (always-on-top, frameless, transparent) is configured in tauri.conf.json and
// loads the bundled frontend. The Node engine ("bridge") runs as a sidecar:
//   - dev:     started by `beforeDevCommand` (npm run bridge)
//   - release: spawned here from the app's bundled Resources/sidecar
// The frontend talks to it over http://localhost:4177 (CORS-enabled) and the drag plugin
// (window.__TAURI__.drag) loads a file onto a Serato deck.

#[cfg(not(debug_assertions))]
fn spawn_sidecar(app: &tauri::App) {
    use std::os::unix::fs::PermissionsExt;
    use tauri::Manager;

    let res = match app.path().resource_dir() {
        Ok(p) => p,
        Err(e) => { eprintln!("[banger] no resource dir: {e}"); return; }
    };
    let node = res.join("sidecar/bin/node");
    let bridge = res.join("sidecar/app/bridge.mjs");
    let public = res.join("sidecar/app/public");
    let home = std::env::var("HOME").unwrap_or_default();

    // ensure the bundled node is executable (resource copy can drop the bit)
    if let Ok(meta) = std::fs::metadata(&node) {
        let mut perm = meta.permissions();
        perm.set_mode(0o755);
        let _ = std::fs::set_permissions(&node, perm);
    }

    let path = format!(
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    );
    match std::process::Command::new(&node)
        .arg(&bridge)
        .env("BANGER_PUBLIC", &public)
        .env("BANGER_CACHE", format!("{home}/dj-banger/.cache/energy.json"))
        .env("BANGER_CONFIG", format!("{home}/dj-banger/.config.json"))
        .env("FFMPEG_PATH", "/opt/homebrew/bin/ffmpeg")
        .env("PATH", path)
        .spawn()
    {
        Ok(_) => println!("[banger] sidecar started"),
        Err(e) => eprintln!("[banger] sidecar spawn failed: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .setup(|_app| {
            #[cfg(not(debug_assertions))]
            spawn_sidecar(_app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Banger");
}
