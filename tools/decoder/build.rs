// Copies the exact librustzcash crate versions from Cargo.lock into the build, so
// decoderInfo() always reports the versions that were really compiled in.
use std::{env, fs, path::Path};

const CRATES: &[(&str, &str)] = &[
    ("zcash_client_backend", "IMANI_V_ZCASH_CLIENT_BACKEND"),
    ("zcash_primitives", "IMANI_V_ZCASH_PRIMITIVES"),
    ("zcash_protocol", "IMANI_V_ZCASH_PROTOCOL"),
    ("zcash_keys", "IMANI_V_ZCASH_KEYS"),
    ("orchard", "IMANI_V_ORCHARD"),
    ("sapling-crypto", "IMANI_V_SAPLING_CRYPTO"),
];

fn main() {
    let lock = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("Cargo.lock");
    println!("cargo:rerun-if-changed={}", lock.display());
    let text = fs::read_to_string(&lock).expect("Cargo.lock next to Cargo.toml");
    for (name, var) in CRATES {
        let needle = format!("name = \"{name}\"\nversion = \"");
        let start = text.find(&needle).unwrap_or_else(|| panic!("{name} missing from Cargo.lock")) + needle.len();
        let end = start + text[start..].find('"').unwrap();
        println!("cargo:rustc-env={var}={}", &text[start..end]);
    }
}
