// Ensure the embedded frontend directory exists before the crate is compiled.
//
// `static_files.rs` embeds the built frontend via rust-embed's
// `#[derive(Embed)] #[folder = "../../dist"]`, and that derive *requires the
// folder to exist at compile time*. But `dist/` is gitignored and only created
// by `npm run build:web` / `npm run build`, so a fresh checkout that runs
// `cargo clippy --workspace` (or `cargo check`) without building the frontend
// first fails to compile session-web — even though the desktop/web release
// flows always build the frontend before cargo.
//
// A real build creates `dist/` with the actual assets first, so this only ever
// creates an *empty* placeholder during a frontend-less cargo check; the
// runtime SPA fallback in `static_handler` already returns a clear
// "Frontend not found. Build with `npm run build:web` first." message in that
// case. This has zero effect on packaging.
use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is always set");
    let dist = Path::new(&manifest_dir).join("../../dist");
    if !dist.exists() {
        let _ = fs::create_dir_all(&dist);
    }
    // Re-run only when the embedded folder changes, so a later real frontend
    // build is picked up without rebuilding session-web on every unrelated edit.
    println!("cargo:rerun-if-changed=../../dist");
}
