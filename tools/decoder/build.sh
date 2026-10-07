#!/usr/bin/env bash
# Rebuilds vendor/decoder/ from this crate. Needs Linux or macOS with Rust (rustup),
# clang (for the secp256k1 C code inside the Zcash crates) and network access to crates.io.
# Usage, from anywhere:  bash tools/decoder/build.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../../vendor/decoder"
WASM_BINDGEN_VERSION="$(grep -A1 '^name = "wasm-bindgen"$' "$HERE/Cargo.lock" | sed -n 's/^version = "\(.*\)"$/\1/p')"

cd "$HERE"
rustup target add wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null || [ "$(wasm-bindgen --version | awk '{print $2}')" != "$WASM_BINDGEN_VERSION" ]; then
  cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION"
fi

# Native check first: decrypts the offline test vectors with the same code.
cargo test --release --locked

cargo build --release --locked --target wasm32-unknown-unknown

rm -rf "$OUT"
mkdir -p "$OUT"
wasm-bindgen --target nodejs --out-dir "$OUT" \
  target/wasm32-unknown-unknown/release/imani_decoder.wasm

# The glue is CommonJS; the Node project is an ES module package.
printf '{\n  "type": "commonjs"\n}\n' > "$OUT/package.json"

cd "$OUT"
sha256sum imani_decoder.js imani_decoder.d.ts imani_decoder_bg.wasm imani_decoder_bg.wasm.d.ts package.json > SHA256SUMS
cat SHA256SUMS
