// Example command kept as the first JavaScript-to-Rust IPC reference. The
// current viewport does not call it yet; future project-file services will use
// the same #[tauri::command] and invoke_handler registration pattern.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Builder configures native plugins and commands, creates the WebView window
    // from tauri.conf.json, and then enters Tauri's desktop event loop.
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
