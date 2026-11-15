fn main() {
    println!("cargo:rerun-if-changed=src/macos.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    cc::Build::new()
        .file("src/macos.m")
        .flag("-fobjc-arc")
        .flag("-Wall")
        .flag("-Wextra")
        .compile("fm1_touch");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=objc");
}
