//! Native check of the decoder against the offline test vectors in test/vectors.

use imani_decoder::decrypt_tx_json;
use serde_json::Value;

fn vectors() -> Value {
    let s = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/vectors/offline-vectors.json"))
        .expect("offline-vectors.json");
    serde_json::from_str(&s).unwrap()
}

#[test]
fn every_case_matches_librustzcash_record() {
    let v = vectors();
    for (name, case) in v["cases"].as_object().unwrap() {
        let pool = case["pool"].as_str().unwrap();
        for (party, expected) in case["librustzcashDecrypt"].as_object().unwrap() {
            let key = v["parties"][party]["ufvk"].as_str().unwrap();
            let got: Value = serde_json::from_str(&decrypt_tx_json(case["txHex"].as_str().unwrap(), key).unwrap()).unwrap();
            let outs = got[pool].as_array().unwrap();
            let exp = expected.as_array().unwrap();
            assert_eq!(outs.len(), exp.len(), "{name} / {party}");
            for (o, e) in outs.iter().zip(exp) {
                assert_eq!(o["amountZat"], e["amountZat"], "{name} / {party}");
                assert_eq!(o["memo"], e["memo"], "{name} / {party}");
                assert_eq!(o["transferType"].as_str().unwrap(), e["transferType"].as_str().unwrap().to_lowercase(), "{name} / {party}");
            }
            assert_eq!(got["txid"], case["txid"], "{name}");
        }
    }
}

#[test]
fn bad_key_is_refused() {
    let v = vectors();
    let tx = v["cases"]["orchard_v5_payment"]["txHex"].as_str().unwrap();
    let err = decrypt_tx_json(tx, "not-a-key").unwrap_err();
    assert!(err.contains("UFVK decode failed"), "{err}");
}
