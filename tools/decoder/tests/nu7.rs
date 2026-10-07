//! Native checks for NU7: offline NU7 vectors, real NU7 testnet transactions, and the
//! named error for a network upgrade this build does not know.

use imani_decoder::{decoder_info_json, decrypt_tx_json};
use serde_json::Value;

fn load(name: &str) -> Value {
    let p = format!("{}/../../test/vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&p).expect(&p)).unwrap()
}

#[test]
fn nu7_offline_cases_match_librustzcash_record() {
    let v = load("nu7-offline.json");
    for (name, case) in v["cases"].as_object().unwrap() {
        for (party, expected) in case["librustzcashDecrypt"].as_object().unwrap() {
            let key = v["parties"][party]["ufvk"].as_str().unwrap();
            let got: Value = serde_json::from_str(&decrypt_tx_json(case["txHex"].as_str().unwrap(), key).unwrap()).unwrap();
            assert_eq!(got["branchId"], "0x77190ad9", "{name}");
            assert_eq!(got["upgrade"], "NU7", "{name}");
            assert_eq!(got["txid"], case["txid"], "{name}");
            let outs = got["ironwood"].as_array().unwrap();
            let exp = expected.as_array().unwrap();
            assert_eq!(outs.len(), exp.len(), "{name} / {party}");
            for (o, e) in outs.iter().zip(exp) {
                assert_eq!(o["amountZat"], e["amountZat"], "{name} / {party}");
                assert_eq!(o["memo"], e["memo"], "{name} / {party}");
                assert_eq!(o["transferType"].as_str().unwrap(), e["transferType"].as_str().unwrap().to_lowercase());
            }
        }
    }
}

#[test]
fn real_nu7_testnet_transactions_parse_and_txids_match() {
    let v = load("nu7-testnet.json");
    let stranger = load("offline-vectors.json")["parties"]["stranger"]["ufvk"].as_str().unwrap().to_string();
    let txs = v["transactions"].as_array().unwrap();
    assert!(txs.len() >= 3);
    for t in txs {
        let got: Value = serde_json::from_str(&decrypt_tx_json(t["txHex"].as_str().unwrap(), &stranger).unwrap()).unwrap();
        assert_eq!(got["txid"], t["txid"]);
        assert_eq!(got["branchId"], "0x77190ad9");
        for pool in ["orchard", "ironwood", "sapling"] {
            assert!(got[pool].as_array().unwrap().is_empty());
        }
    }
}

#[test]
fn unknown_network_upgrade_is_named() {
    let v = load("nu7-offline.json");
    let mut raw = hex::decode(v["cases"]["ironwood_nu7_payment"]["txHex"].as_str().unwrap()).unwrap();
    raw[8..12].copy_from_slice(&0x1234_5678u32.to_le_bytes());
    let key = v["parties"]["seller"]["ufvk"].as_str().unwrap();
    let err = decrypt_tx_json(&hex::encode(raw), key).unwrap_err();
    assert!(err.starts_with("unsupported network upgrade 0x12345678"), "{err}");
}

#[test]
fn info_names_nu7() {
    let info: Value = serde_json::from_str(&decoder_info_json()).unwrap();
    assert_eq!(info["highestUpgrade"], "NU7");
    assert_eq!(info["highestBranchId"], "0x77190ad9");
    assert_eq!(info["librustzcash"]["zcash_primitives"], "0.31.0-pre.1");
}
