//! The decoder reports who each output was paid to, and can split an address into receivers.

use imani_decoder::{decrypt_tx_json, parse_address_json};
use serde_json::Value;

fn round() -> Value {
    let s = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/vectors/auction-round.json"))
        .expect("auction-round.json");
    serde_json::from_str(&s).unwrap()
}

fn orchard_receiver(v: &Value, party: &str) -> String {
    let a: Value = serde_json::from_str(&parse_address_json(v["parties"][party]["address"].as_str().unwrap()).unwrap()).unwrap();
    a["orchard"].as_str().unwrap().to_string()
}

#[test]
fn outgoing_refund_shows_the_bidders_address() {
    let v = round();
    let lot = v["parties"]["lot LOT-01"]["ufvk"].as_str().unwrap();
    for (tx, who, other) in [("refund_alice_change", "bidder alice", "bidder bob"), ("refund_bob_change", "bidder bob", "bidder alice")] {
        let got: Value = serde_json::from_str(&decrypt_tx_json(v["transactions"][tx]["txHex"].as_str().unwrap(), lot).unwrap()).unwrap();
        let outs = got["ironwood"].as_array().unwrap();
        let out = outs.iter().find(|o| o["transferType"] == "outgoing").expect("outgoing output");
        assert_eq!(out["recipientHex"].as_str().unwrap(), orchard_receiver(&v, who), "{tx}");
        assert_ne!(out["recipientHex"].as_str().unwrap(), orchard_receiver(&v, other), "{tx}");
    }
}

#[test]
fn incoming_output_shows_the_lot_address() {
    let v = round();
    let lot = v["parties"]["lot LOT-01"]["ufvk"].as_str().unwrap();
    let got: Value = serde_json::from_str(&decrypt_tx_json(v["transactions"]["bid_alice"]["txHex"].as_str().unwrap(), lot).unwrap()).unwrap();
    let out = got["ironwood"].as_array().unwrap().iter().find(|o| o["transferType"] == "incoming").unwrap();
    assert_eq!(out["recipientHex"].as_str().unwrap(), orchard_receiver(&v, "lot LOT-01"));
}

#[test]
fn bad_address_is_refused() {
    assert!(parse_address_json("not-an-address").is_err());
}
