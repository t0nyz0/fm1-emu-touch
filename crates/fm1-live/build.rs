mod buildinfo {
    include!("../fm1-emu/build.rs");
    pub fn emit() { main(); }
}

fn main() {
    buildinfo::emit();
    println!("cargo:rerun-if-changed=Info.plist");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // A command-line Mach-O has no .app bundle. Embed the opt-in so AppKit
        // does not also inject legacy mouse-emulation recognizers for minifb.
        let plist = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("Info.plist");
        println!("cargo:rustc-link-arg-bin=fm1-live=-Wl,-sectcreate,__TEXT,__info_plist,{}", plist.display());
    }
}
