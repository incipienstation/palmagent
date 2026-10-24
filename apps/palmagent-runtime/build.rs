fn main() {
    for (name, fallback) in [
        ("PALMAGENT_PRODUCT_VERSION", "0.0.0"),
        ("PALMAGENT_SOURCE_COMMIT", "development"),
    ] {
        println!("cargo:rerun-if-env-changed={name}");
        println!(
            "cargo:rustc-env={name}={}",
            std::env::var(name).unwrap_or_else(|_| fallback.into())
        );
    }
}
