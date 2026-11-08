fn main() {
    let target = std::env::var("TARGET").expect("Cargo did not expose TARGET");
    println!("cargo:rustc-env=OMNI_TARGET_TRIPLE={target}");
    println!("cargo:rerun-if-env-changed=TARGET");
    tauri_build::build()
}
