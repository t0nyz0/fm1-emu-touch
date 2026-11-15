fn main() {
    println!("cargo:rerun-if-changed=src/macos.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    // Use explicit platform baselines instead of the build machine's SDK/OS.
    // Honor the same explicit override the Rust linker uses when supplied.
    let deployment_target = std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| {
        match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("x86_64") => "10.12",
            _ => "11.0",
        }
        .into()
    });
    cc::Build::new()
        .file("src/macos.m")
        .flag(format!("-mmacosx-version-min={deployment_target}"))
        .flag("-fobjc-arc")
        .flag("-Wall")
        .flag("-Wextra")
        .compile("fm1_touch");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=objc");
}
