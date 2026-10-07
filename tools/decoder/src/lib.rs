//! imani decoder: reads the shielded outputs of one raw Zcash transaction that a
//! unified full viewing key (UFVK) can see. It is a thin wrapper around
//! librustzcash `zcash_client_backend::decrypt_transaction`, built to WebAssembly
//! so the Node project can use it without Rust.
//!
//! The caller passes only the raw transaction and the UFVK:
//! - the network (main or test) comes from the UFVK prefix (`uview` or `uviewtest`);
//! - the transaction version and consensus branch id come from the transaction bytes.

use std::collections::HashMap;

use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
use zcash_client_backend::{DecryptedOutput, TransferType, decrypt_transaction};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, MAIN_NETWORK, Parameters, TEST_NETWORK},
    memo::{Memo, MemoBytes},
};

/// Transaction versions, as the low 31 bits of the first four bytes.
const TX_V4: u32 = 4;
const TX_V5: u32 = 5;
const TX_V6: u32 = 6;

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
            let branch = BranchId::try_from(id)
                .map_err(|_| format!("unknown consensus branch id 0x{id:08x}"))?;
            Ok((version, branch))
        }
        TX_V4 => Ok((version, BranchId::Canopy)),
        v => Err(format!("unsupported transaction version {v}")),
    }
}

fn decode<P: Parameters>(params: &P, raw: &[u8], ufvk: UnifiedFullViewingKey) -> Result<Value, String> {
    let (version, branch) = header_branch(raw)?;
    let tx = Transaction::read(raw, branch).map_err(|e| format!("transaction parse failed: {e}"))?;

    // The decrypt call wants a height only to pick the Sapling note format rule
    // (ZIP 212). We use the activation height of the upgrade named by the branch id.
    let height: Option<BlockHeight> = branch.height_bounds(params).map(|(start, _)| start);

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

    Ok(json!({
        "txid": tx.txid().to_string(),
        "txVersion": version,
        "branchId": format!("0x{:08x}", u32::from(branch)),
        "orchard": orchard_out,
        "ironwood": ironwood_out,
        "sapling": sapling,
    }))
}

/// Pure Rust entry point (also used by the native tests). Returns JSON text.
pub fn decrypt_tx_json(tx_hex: &str, ufvk: &str) -> Result<String, String> {
    let raw = hex::decode(tx_hex.trim()).map_err(|e| format!("transaction hex decode failed: {e}"))?;
    let ufvk = ufvk.trim();
    // "uviewtest1..." is testnet, "uview1..." is mainnet. Anything else is refused.
    let v = if ufvk.starts_with("uviewtest1") {
        let k = UnifiedFullViewingKey::decode(&TEST_NETWORK, ufvk)
            .map_err(|e| format!("UFVK decode failed: {e}"))?;
        decode(&TEST_NETWORK, &raw, k)?
    } else if ufvk.starts_with("uview1") {
        let k = UnifiedFullViewingKey::decode(&MAIN_NETWORK, ufvk)
            .map_err(|e| format!("UFVK decode failed: {e}"))?;
        decode(&MAIN_NETWORK, &raw, k)?
    } else {
        return Err("UFVK decode failed: expected a key starting with uview1 (mainnet) or uviewtest1 (testnet)".into());
    };
    Ok(v.to_string())
}

/// JavaScript entry point: `decryptTx(txHex, ufvk)` returns
/// `{ txid, txVersion, branchId, orchard: [...], ironwood: [...], sapling: [...] }`.
/// Each output is `{ index, amountZat, memo, memoHex, transferType }`.
/// Throws an Error with a readable message on a bad key or a bad transaction.
#[wasm_bindgen(js_name = decryptTx)]
pub fn decrypt_tx(tx_hex: &str, ufvk: &str) -> Result<JsValue, JsError> {
    let s = decrypt_tx_json(tx_hex, ufvk).map_err(|e| JsError::new(&e))?;
    js_sys::JSON::parse(&s).map_err(|_| JsError::new("internal JSON error"))
}
