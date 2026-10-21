// No console window in the Windows build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mfp_desktop_lib::run()
}
