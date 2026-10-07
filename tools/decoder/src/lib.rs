//! imani decoder: reads the shielded outputs of one raw Zcash transaction that a
//! unified full viewing key (UFVK) can see. It is a thin wrapper around
//! librustzcash `zcash_client_backend::decrypt_transaction`, built to WebAssembly
//! so the Node project can use it without Rust.
//!
//! The caller passes only the raw transaction and the UFVK:
//! - the network (main or test) comes from the UFVK prefix (`uview`/`uvf` for
//!   mainnet, `uviewtest`/`uvftest` for testnet);
//! - the transaction version and consensus branch id come from the transaction bytes.

use std::collections::HashMap;

use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use zcash_client_backend::{DecryptedOutput, TransferType, decrypt_transaction};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, MAIN_NETWORK, NetworkUpgrade, Parameters, TEST_NETWORK},
    memo::{Memo, MemoBytes},
};

/// Transaction versions, as the low 31 bits of the first four bytes.
const TX_V4: u32 = 4;
const TX_V5: u32 = 5;
const TX_V6: u32 = 6;

/// Every network upgrade whose transactions this build reads, oldest first, with
/// the name used in messages. The last entry is the newest one supported.
const SUPPORTED: &[(NetworkUpgrade, &str)] = &[
    (NetworkUpgrade::Canopy, "Canopy"),
    (NetworkUpgrade::Nu5, "NU5"),
    (NetworkUpgrade::Nu6, "NU6"),
    (NetworkUpgrade::Nu6_1, "NU6.1"),
    (NetworkUpgrade::Nu6_2, "NU6.2"),
    (NetworkUpgrade::Nu6_3, "NU6.3"),
    (NetworkUpgrade::Nu7, "NU7"),
];

fn upgrade_name(branch: BranchId) -> &'static str {
    SUPPORTED
        .iter()
        .find(|(nu, _)| nu.branch_id() == branch)
        .map(|(_, n)| *n)
        .unwrap_or("older")
}

fn transfer_type(t: TransferType) -> &'static str {
    match t {
        TransferType::Incoming => "incoming",
        TransferType::Outgoing => "outgoing",
        TransferType::AccountInternal | TransferType::WalletInternal => "internal",
    }
}

/// Memo as text. Text memos are already trimmed of trailing zero bytes by
/// librustzcash. Empty, binary or future-format memos give an empty string,
/// and their raw bytes (trailing zeros trimmed) are returned in `memoHex`.
fn memo_fields(m: &MemoBytes) -> (String, String) {
    let raw = m.as_slice();
    let end = raw.iter().rposition(|b| *b != 0).map(|i| i + 1).unwrap_or(0);
    let hex_trimmed = hex::encode(&raw[..end]);
    let text = match Memo::try_from(m) {
        Ok(Memo::Text(t)) => String::from(t),
        _ => String::new(),
    };
    (text, hex_trimmed)
}

/// Reads the version and consensus branch id from the transaction header.
/// v5 and v6 carry the branch id in bytes 8..12. v4 does not carry one; for v4 we
/// use Canopy, the last upgrade before v5, whose ZIP 212 grace period accepts both
/// note formats so old Sapling payments still decrypt.
fn header_branch(raw: &[u8]) -> Result<(u32, BranchId), String> {
    if raw.len() < 12 {
        return Err("transaction too short".into());
    }
    let header = u32::from_le_bytes(raw[0..4].try_into().unwrap());
    let version = header & 0x7fff_ffff;
    match version {
        TX_V5 | TX_V6 => {
            let id = u32::from_le_bytes(raw[8..12].try_into().unwrap());
            let branch = BranchId::try_from(id).map_err(|_| {
                format!(
                    "unsupported network upgrade 0x{id:08x}: this decoder reads up to {} (branch id 0x{:08x}); a newer decoder build is needed",
                    newest_name(),
                    u32::from(newest_branch()),
                )
            })?;
            Ok((version, branch))
        }
        TX_V4 => Ok((version, BranchId::Canopy)),
        v => Err(format!("unsupported transaction version {v}")),
    }
}

fn newest_name() -> &'static str {
    SUPPORTED.last().unwrap().1
}

fn newest_branch() -> BranchId {
    SUPPORTED.last().unwrap().0.branch_id()
}

/// Height handed to librustzcash for the Sapling note format rule (ZIP 212): the
/// activation height of the upgrade named by the branch id. If this build does not
/// know that height yet (NU7 on mainnet before its date is set), use the newest
/// earlier upgrade with a known height. Every upgrade from NU5 on is past the ZIP 212
/// grace period, so the rule is the same.
fn rule_height<P: Parameters>(params: &P, branch: BranchId) -> Option<BlockHeight> {
    if let Some((start, _)) = branch.height_bounds(params) {
        return Some(start);
    }
    let pos = SUPPORTED.iter().position(|(nu, _)| nu.branch_id() == branch)?;
    SUPPORTED[..pos].iter().rev().find_map(|(nu, _)| params.activation_height(*nu))
}

fn decode<P: Parameters>(params: &P, raw: &[u8], ufvk: UnifiedFullViewingKey) -> Result<Value, String> {
    let (version, branch) = header_branch(raw)?;
    let tx = Transaction::read(raw, branch).map_err(|e| format!("transaction parse failed: {e}"))?;

    let height = rule_height(params, branch);

    let mut keys = HashMap::new();
    keys.insert(0u32, ufvk);
    let d = decrypt_transaction(params, height, None, &tx, &keys);

    let mut sapling = vec![];
    for o in d.sapling_outputs() {
        let (memo, memo_hex) = memo_fields(o.memo());
        sapling.push(json!({
            "index": o.index(),
            "amountZat": o.note().value().inner(),
            "memo": memo,
            "memoHex": memo_hex,
            "transferType": transfer_type(o.transfer_type()),
        }));
    }
    let orchard_family = |outs: &[DecryptedOutput<(orchard::Note, orchard::ValuePool), u32>]| {
        outs.iter()
            .map(|o| {
                let (memo, memo_hex) = memo_fields(o.memo());
                json!({
                    "index": o.index(),
                    "amountZat": o.note().0.value().inner(),
                    "memo": memo,
                    "memoHex": memo_hex,
                    "transferType": transfer_type(o.transfer_type()),
                })
            })
            .collect::<Vec<_>>()
    };
    let orchard_out = orchard_family(d.orchard_outputs());
    let ironwood_out = orchard_family(d.ironwood_outputs());

    // Public shape of the transaction, readable without any key.
    let shape = json!({
        "transparentInputs": tx.transparent_bundle().map(|b| b.vin.len()).unwrap_or(0),
        "transparentOutputs": tx.transparent_bundle().map(|b| b.vout.len()).unwrap_or(0),
        "saplingSpends": tx.sapling_bundle().map(|b| b.shielded_spends().len()).unwrap_or(0),
        "saplingOutputs": tx.sapling_bundle().map(|b| b.shielded_outputs().len()).unwrap_or(0),
        "orchardActions": tx.orchard_bundle().map(|b| b.actions().len()).unwrap_or(0),
        "ironwoodActions": tx.ironwood_bundle().map(|b| b.actions().len()).unwrap_or(0),
    });

    Ok(json!({
        "txid": tx.txid().to_string(),
        "txVersion": version,
        "branchId": format!("0x{:08x}", u32::from(branch)),
        "upgrade": upgrade_name(branch),
        "shape": shape,
        "orchard": orchard_out,
        "ironwood": ironwood_out,
        "sapling": sapling,
    }))
}

/// Pure Rust entry point (also used by the native tests). Returns JSON text.
pub fn decrypt_tx_json(tx_hex: &str, ufvk: &str) -> Result<String, String> {
    let raw = hex::decode(tx_hex.trim()).map_err(|e| format!("transaction hex decode failed: {e}"))?;
    let ufvk = ufvk.trim();
    // ZIP 316 revision 0 keys start "uviewtest1" (testnet) or "uview1" (mainnet);
    // revision 2 keys start "uvftest1" or "uvf1". Anything else is refused.
    let v = if ufvk.starts_with("uviewtest1") || ufvk.starts_with("uvftest1") {
        let k = UnifiedFullViewingKey::decode(&TEST_NETWORK, ufvk)
            .map_err(|e| format!("UFVK decode failed: {e}"))?;
        decode(&TEST_NETWORK, &raw, k)?
    } else if ufvk.starts_with("uview1") || ufvk.starts_with("uvf1") {
        let k = UnifiedFullViewingKey::decode(&MAIN_NETWORK, ufvk)
            .map_err(|e| format!("UFVK decode failed: {e}"))?;
        decode(&MAIN_NETWORK, &raw, k)?
    } else {
        return Err("UFVK decode failed: expected a key starting with uview1 or uvf1 (mainnet), or uviewtest1 or uvftest1 (testnet)".into());
    };
    Ok(v.to_string())
}

/// What this build reads: librustzcash crate versions (taken from Cargo.lock at
/// build time), the newest network upgrade it knows, and every branch id it accepts.
pub fn decoder_info_json() -> String {
    let heights = |nu: NetworkUpgrade| {
        json!({
            "main": MAIN_NETWORK.activation_height(nu).map(u32::from),
            "test": TEST_NETWORK.activation_height(nu).map(u32::from),
        })
    };
    let upgrades: Vec<Value> = SUPPORTED
        .iter()
        .map(|(nu, name)| {
            json!({
                "name": name,
                "branchId": format!("0x{:08x}", u32::from(nu.branch_id())),
                "activationHeight": heights(*nu),
            })
        })
        .collect();
    json!({
        "decoder": env!("CARGO_PKG_VERSION"),
        "librustzcash": {
            "zcash_client_backend": env!("IMANI_V_ZCASH_CLIENT_BACKEND"),
            "zcash_primitives": env!("IMANI_V_ZCASH_PRIMITIVES"),
            "zcash_protocol": env!("IMANI_V_ZCASH_PROTOCOL"),
            "zcash_keys": env!("IMANI_V_ZCASH_KEYS"),
            "orchard": env!("IMANI_V_ORCHARD"),
            "sapling-crypto": env!("IMANI_V_SAPLING_CRYPTO"),
        },
        "highestUpgrade": newest_name(),
        "highestBranchId": format!("0x{:08x}", u32::from(newest_branch())),
        "transactionVersions": [4, 5, 6],
        "upgrades": upgrades,
    })
    .to_string()
}

/// JavaScript entry point: `decryptTx(txHex, ufvk)` returns
/// `{ txid, txVersion, branchId, upgrade, shape, orchard: [...], ironwood: [...], sapling: [...] }`.
/// `shape` counts the public parts (transparent inputs and outputs, Sapling spends and
/// outputs, Orchard and Ironwood actions).
/// Each output is `{ index, amountZat, memo, memoHex, transferType }`.
/// Throws an Error with a readable message on a bad key or a bad transaction.
/// A transaction from a network upgrade this build does not know throws
/// "unsupported network upgrade 0x...".
#[wasm_bindgen(js_name = decryptTx)]
pub fn decrypt_tx(tx_hex: &str, ufvk: &str) -> Result<JsValue, JsError> {
    let s = decrypt_tx_json(tx_hex, ufvk).map_err(|e| JsError::new(&e))?;
    js_sys::JSON::parse(&s).map_err(|_| JsError::new("internal JSON error"))
}

/// JavaScript entry point: `decoderInfo()` returns
/// `{ decoder, librustzcash: {crate: version}, highestUpgrade, highestBranchId,
///    transactionVersions, upgrades: [{ name, branchId, activationHeight: { main, test } }] }`.
#[wasm_bindgen(js_name = decoderInfo)]
pub fn decoder_info() -> Result<JsValue, JsError> {
    js_sys::JSON::parse(&decoder_info_json()).map_err(|_| JsError::new("internal JSON error"))
}
