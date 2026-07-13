// dj-banger floating window — Tauri v2 shell.
//
// The window itself (always-on-top, frameless, transparent, small) is fully configured in
// tauri.conf.json; this file just wires the runtime + the native drag-out plugin.
//
// Drag-into-Serato: tauri-plugin-drag exposes `startDrag` to the webview (available as
// window.__TAURI__.drag.startDrag because withGlobalTauri is on). The frontend calls it with
// the suggestion's absolute file path; the OS then performs a real file drag that Serato's
// deck accepts — exactly the Banger Button one-motion load.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .run(tauri::generate_context!())
        .expect("error while running Banger");
}
