// Hide the extra Windows console in release builds. Debug builds retain it so
// Rust/Tauri startup errors remain visible during development.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    super_tex_kid_lib::run()
}
