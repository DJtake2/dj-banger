// dj-banger floating window — Tauri v2 shell.
//
// The window (always-on-top, frameless, transparent) is configured in tauri.conf.json and
// loads the bundled frontend. The Node engine ("bridge") runs as a sidecar:
//   - dev:     started by `beforeDevCommand` (npm run bridge)
//   - release: spawned here from the app's bundled Resources/sidecar
// The frontend talks to it over http://localhost:4177 (CORS-enabled) and the drag plugin
// (window.__TAURI__.drag) loads a file onto a Serato deck.

/// The engine process, so it can be stopped when the app quits. Without this the Node bridge
/// outlived the window, kept port 4177, and the next launch (or the relaunch after an
/// auto-update) talked to the OLD engine. The bridge also exits by itself if it's orphaned
/// (crash / force-quit) — see BANGER_SIDECAR in bridge.mjs.
static SIDECAR: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

fn stop_sidecar() {
    if let Ok(mut guard) = SIDECAR.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            println!("[banger] sidecar stopped");
        }
    }
}

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
        .env("BANGER_SIDECAR", "1")
        .spawn()
    {
        Ok(child) => {
            println!("[banger] sidecar started (pid {})", child.id());
            if let Ok(mut guard) = SIDECAR.lock() {
                *guard = Some(child);
            }
        }
        Err(e) => eprintln!("[banger] sidecar spawn failed: {e}"),
    }
}

// A tiny drag preview image so the OS shows something under the cursor while dragging a
// track file out to Serato. Reuses the app icon (bundled next to this source).
const DRAG_ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// Start a native OS file-drag of `path` out of the window (drop target = Serato deck).
///
/// The frontend calls this via `invoke("start_file_drag", { path })`. We drive the `drag`
/// crate directly instead of the plugin's JS API (which was never bundled into the webview).
///
/// Two things this MUST get right, both learned from a crash report:
///   1. TIMING — `drag::start_drag` calls `beginDraggingSessionWithItems` on the AppKit view,
///      which only attaches a real drag while the webview's mouse gesture is still live. So we
///      block the command (via `rx.recv`) until the session has been created on the main thread,
///      which keeps the JS `dragstart` await pending and the gesture alive. Returning early
///      (fire-and-forget) fires the drag after the gesture is gone → it silently fails.
///   2. CRASH CONTAINMENT — if AppKit returns a nil session (invalid gesture/state), the objc2
///      binding *panics*, and on the event-loop thread that aborts the whole app. We wrap the
///      call in `catch_unwind` so a failed drag is a harmless no-op instead of a crash.
#[tauri::command]
async fn start_file_drag(
    app: tauri::AppHandle,
    window: tauri::Window,
    path: String,
) -> Result<(), String> {
    use std::sync::mpsc::channel;
    let (tx, rx) = channel();
    app.run_on_main_thread(move || {
        let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drag::start_drag(
                &window,
                drag::DragItem::Files(vec![std::path::PathBuf::from(&path)]),
                drag::Image::Raw(DRAG_ICON.to_vec()),
                |_result, _cursor| {},
                drag::Options::default(),
            )
            .is_ok()
        }))
        .unwrap_or(false);
        let _ = tx.send(ok);
    })
    .map_err(|e| e.to_string())?;
    // Wait for the session to be created (fast — start_drag returns once the drag attaches, not
    // when it drops). A failed/blocked drag is not an error we surface; the row just doesn't drag.
    let _ = rx.recv();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![start_file_drag])
        .setup(|_app| {
            #[cfg(not(debug_assertions))]
            spawn_sidecar(_app);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Banger")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_sidecar();
            }
        });
}
