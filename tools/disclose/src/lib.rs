//! imani disclose: proves one shielded Zcash payment to someone who holds no viewing key.
//!
//! Every Orchard and Ironwood payment is encrypted with a fresh one-time secret (the
//! "ephemeral secret key", 32 bytes). Whoever holds it can open that one payment and no
//! other: amount, memo and the address it was paid to. librustzcash checks the opened
//! note against the note commitment and the ephemeral public key that are fixed in the
//! transaction, so a wrong or made-up secret never opens anything.
//!
//! Two parties can work out the secret of a payment: the receiver, with their viewing key
//! (here, the lot owner for a bid), and the sender, when their wallet kept a copy under
//! its outgoing viewing key. `discloseOutputs` gives the secret of every payment a viewing
//! key can see. `openOutput` opens one payment with only its secret. It is the same idea
//! as the payment disclosures of ZIP 311, for one payment of the Orchard family.

use std::collections::HashMap;

use orchard::note_encryption::{IronwoodDomain, OrchardDomain};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use zcash_client_backend::{DecryptedOutput, TransferType, decrypt_transaction};
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_note_encryption::{Domain, OUT_PLAINTEXT_SIZE, OutPlaintextBytes, try_output_recovery_with_pkd_esk};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, MAIN_NETWORK, NetworkUpgrade, Parameters, TEST_NETWORK},
    memo::{Memo, MemoBytes},
};

/// Upgrades whose transactions this build reads, oldest first. Same list as tools/decoder.
const SUPPORTED: &[NetworkUpgrade] = &[
    NetworkUpgrade::Canopy,
    NetworkUpgrade::Nu5,
    NetworkUpgrade::Nu6,
    NetworkUpgrade::Nu6_1,
    NetworkUpgrade::Nu6_2,
    NetworkUpgrade::Nu6_3,
    NetworkUpgrade::Nu7,
];

fn memo_fields(raw: &[u8]) -> (String, String) {
    let end = raw.iter().rposition(|b| *b != 0).map(|i| i + 1).unwrap_or(0);
    let hex_trimmed = hex::encode(&raw[..end]);
    let text = match MemoBytes::from_bytes(raw).ok().and_then(|m| Memo::try_from(&m).ok()) {
        Some(Memo::Text(t)) => String::from(t),
        _ => String::new(),
    };
    (text, hex_trimmed)
}

fn transfer_type(t: TransferType) -> &'static str {
    match t {
        TransferType::Incoming => "incoming",
        TransferType::Outgoing => "outgoing",
        TransferType::AccountInternal | TransferType::WalletInternal => "internal",
    }
}

/// Reads the transaction. Only versions 5 and 6 carry Orchard or Ironwood payments.
fn read_tx(tx_hex: &str) -> Result<(Transaction, BranchId), String> {
    let raw = hex::decode(tx_hex.trim()).map_err(|e| format!("transaction hex decode failed: {e}"))?;
    if raw.len() < 12 {
        return Err("transaction too short".into());
    }
    let version = u32::from_le_bytes(raw[0..4].try_into().unwrap()) & 0x7fff_ffff;
    if version != 5 && version != 6 {
        return Err(format!("transaction version {version} has no Orchard or Ironwood payments"));
    }
    let id = u32::from_le_bytes(raw[8..12].try_into().unwrap());
    let branch = BranchId::try_from(id).map_err(|_| format!("unsupported network upgrade 0x{id:08x}"))?;
    let tx = Transaction::read(&raw[..], branch).map_err(|e| format!("transaction parse failed: {e}"))?;
    Ok((tx, branch))
}

fn rule_height<P: Parameters>(params: &P, branch: BranchId) -> Option<BlockHeight> {
    if let Some((start, _)) = branch.height_bounds(params) {
        return Some(start);
    }
    let pos = SUPPORTED.iter().position(|nu| nu.branch_id() == branch)?;
    SUPPORTED[..pos].iter().rev().find_map(|nu| params.activation_height(*nu))
}

/// The one-payment secret of an Orchard-family note, as 32 bytes of hex.
fn esk_hex(note: &orchard::Note) -> String {
    let esk = <OrchardDomain as Domain>::derive_esk(note).expect("Orchard notes always have one");
    let op = <OrchardDomain as Domain>::outgoing_plaintext_bytes(note, &esk);
    hex::encode(&op.0[32..OUT_PLAINTEXT_SIZE])
}

fn disclose<P: Parameters>(params: &P, tx_hex: &str, ufvk: UnifiedFullViewingKey) -> Result<Value, String> {
    let (tx, branch) = read_tx(tx_hex)?;
    let height = rule_height(params, branch);
    let mut keys = HashMap::new();
    keys.insert(0u32, ufvk);
    let d = decrypt_transaction(params, height, None, &tx, &keys);
    let family = |pool: &str, outs: &[DecryptedOutput<(orchard::Note, orchard::ValuePool), u32>]| {
        outs.iter()
            .map(|o| {
                let note = &o.note().0;
                let (memo, memo_hex) = memo_fields(o.memo().as_slice());
                json!({
                    "pool": pool,
                    "index": o.index(),
                    "transferType": transfer_type(o.transfer_type()),
                    "amountZat": note.value().inner(),
                    "memo": memo,
                    "memoHex": memo_hex,
                    "recipientHex": hex::encode(note.recipient().to_raw_address_bytes()),
                    "eskHex": esk_hex(note),
                })
            })
            .collect::<Vec<_>>()
    };
    let mut outputs = family("orchard", d.orchard_outputs());
    outputs.extend(family("ironwood", d.ironwood_outputs()));
    Ok(json!({ "txid": tx.txid().to_string(), "outputs": outputs }))
}

/// Pure Rust entry point: the one-payment secret of every Orchard and Ironwood payment
/// the viewing key can see in the transaction.
pub fn disclose_outputs_json(tx_hex: &str, ufvk: &str) -> Result<String, String> {
    let ufvk = ufvk.trim();
    let v = if ufvk.starts_with("uviewtest1") || ufvk.starts_with("uvftest1") {
        let k = UnifiedFullViewingKey::decode(&TEST_NETWORK, ufvk).map_err(|e| format!("UFVK decode failed: {e}"))?;
        disclose(&TEST_NETWORK, tx_hex, k)?
    } else if ufvk.starts_with("uview1") || ufvk.starts_with("uvf1") {
        let k = UnifiedFullViewingKey::decode(&MAIN_NETWORK, ufvk).map_err(|e| format!("UFVK decode failed: {e}"))?;
        disclose(&MAIN_NETWORK, tx_hex, k)?
    } else {
        return Err("UFVK decode failed: expected a key starting with uview1 or uvf1 (mainnet), or uviewtest1 or uvftest1 (testnet)".into());
    };
    Ok(v.to_string())
}

/// Opens one action with its secret, for the receiver given. Same steps for both pools.
macro_rules! open_action {
    ($domain:ty, $action:expr, $op:expr) => {{
        let pk_d = <$domain as Domain>::extract_pk_d(&$op);
        let esk = <$domain as Domain>::extract_esk(&$op);
        match (pk_d, esk) {
            (Some(pk_d), Some(esk)) => {
                let domain = <$domain>::for_action($action);
                try_output_recovery_with_pkd_esk(&domain, pk_d, esk, $action)
            }
            _ => None,
        }
    }};
}

/// Pure Rust entry point: opens payment `index` of `pool` ("orchard" or "ironwood") with its
/// one-payment secret, for the 43-byte raw receiver given. Fails unless the secret, the
/// receiver and the note commitment in the transaction all agree.
pub fn open_output_json(tx_hex: &str, pool: &str, index: u32, receiver_hex: &str, esk_hex: &str) -> Result<String, String> {
    let (tx, _) = read_tx(tx_hex)?;
    let receiver: [u8; 43] = hex::decode(receiver_hex.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the receiver must be 43 bytes of hex")?;
    let esk: [u8; 32] = hex::decode(esk_hex.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the one-payment key must be 32 bytes of hex")?;
    let mut op = [0u8; OUT_PLAINTEXT_SIZE];
    op[..32].copy_from_slice(&receiver[11..43]);
    op[32..].copy_from_slice(&esk);
    let op = OutPlaintextBytes(op);

    let bundle = match pool {
        "orchard" => tx.orchard_bundle(),
        "ironwood" => tx.ironwood_bundle(),
        _ => return Err(format!("unknown pool {pool}: use orchard or ironwood")),
    }
    .ok_or_else(|| format!("the transaction has no {pool} payments"))?;
    let count = bundle.actions().len();
    let action = bundle
        .actions()
        .get(index as usize)
        .ok_or_else(|| format!("the transaction has {count} {pool} actions, so there is no number {index}"))?;
    let opened = if pool == "orchard" {
        open_action!(OrchardDomain, action, op)
    } else {
        open_action!(IronwoodDomain, action, op)
    };
    let (note, to, memo) = opened.ok_or("the key does not open this payment for that receiver")?;
    if to.to_raw_address_bytes() != receiver {
        return Err("the payment opens, but it was paid to a different address of that wallet".into());
    }
    let (memo_text, memo_hex) = memo_fields(&memo);
    Ok(json!({
        "txid": tx.txid().to_string(),
        "pool": pool,
        "index": index,
        "actions": count,
        "amountZat": note.value().inner(),
        "memo": memo_text,
        "memoHex": memo_hex,
        "recipientHex": hex::encode(to.to_raw_address_bytes()),
    })
    .to_string())
}

/// Pure Rust entry point: a unified address holding only the given Orchard receiver.
pub fn orchard_address_json(receiver_hex: &str, network: &str) -> Result<String, String> {
    let receiver: [u8; 43] = hex::decode(receiver_hex.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the receiver must be 43 bytes of hex")?;
    let addr = Option::<orchard::Address>::from(orchard::Address::from_raw_address_bytes(&receiver)).ok_or("not an Orchard receiver")?;
    let ua = UnifiedAddress::from_receivers(Some(addr), None, None, None, None).ok_or("could not build the address")?;
    let s = match network {
        "main" => ua.encode(&MAIN_NETWORK),
        "test" => ua.encode(&TEST_NETWORK),
        _ => return Err("network must be main or test".into()),
    };
    Ok(Value::String(s).to_string())
}

fn to_js(r: Result<String, String>) -> Result<JsValue, JsError> {
    let s = r.map_err(|e| JsError::new(&e))?;
    js_sys::JSON::parse(&s).map_err(|_| JsError::new("internal JSON error"))
}

/// JavaScript: `discloseOutputs(txHex, ufvk)` returns `{ txid, outputs: [{ pool, index,
/// transferType, amountZat, memo, memoHex, recipientHex, eskHex }] }`.
#[wasm_bindgen(js_name = discloseOutputs)]
pub fn disclose_outputs(tx_hex: &str, ufvk: &str) -> Result<JsValue, JsError> {
    to_js(disclose_outputs_json(tx_hex, ufvk))
}

/// JavaScript: `openOutput(txHex, pool, index, receiverHex, eskHex)` returns `{ txid, pool,
/// index, actions, amountZat, memo, memoHex, recipientHex }`, or throws.
#[wasm_bindgen(js_name = openOutput)]
pub fn open_output(tx_hex: &str, pool: &str, index: u32, receiver_hex: &str, esk_hex: &str) -> Result<JsValue, JsError> {
    to_js(open_output_json(tx_hex, pool, index, receiver_hex, esk_hex))
}

/// JavaScript: `orchardAddress(receiverHex, network)` returns the address as text.
#[wasm_bindgen(js_name = orchardAddress)]
pub fn orchard_address(receiver_hex: &str, network: &str) -> Result<JsValue, JsError> {
    to_js(orchard_address_json(receiver_hex, network))
}
