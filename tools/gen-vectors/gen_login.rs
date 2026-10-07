//! Offline login test transactions for the imani login kit.
//!
//! Same approach as gen_vectors.rs: the official librustzcash transaction builder,
//! throwaway seeds, invented transparent funding coins, fixed randomness, never
//! broadcast. Each login payment pays the site's address with a login memo made by
//! test/login/make-offline-inputs.ts, and sends change back to the paying wallet at a
//! wallet-specific address, so two wallets really are two different senders.
//!
//! Run from a zcash-devtool checkout (see README.md):
//!   cargo run --release --example gen_login -- parties
//!   cargo run --release --example gen_login -- build <login-inputs.json> <login-offline.json>

use std::collections::HashMap;
use std::fs;

use orchard::keys::{FullViewingKey, Scope};
use rand::{CryptoRng, RngCore};
use serde_json::{Value, json};
use transparent::{
    address::TransparentAddress,
    builder::TransparentSigningSet,
    bundle::{OutPoint, TxOut},
};
use zcash_client_backend::decrypt_transaction;
use zcash_keys::{address::UnifiedAddress, keys::UnifiedSpendingKey};
use zcash_primitives::transaction::{
    Transaction,
    builder::{BuildConfig, Builder, BundlePadding},
    fees::zip317,
};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, TEST_NETWORK},
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};

fn hash32(label: &str) -> [u8; 32] {
    let h = blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"imani_login_test")
        .hash(label.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(h.as_bytes());
    out
}

/// Deterministic random number stream (BLAKE2b in counter mode). Test use only.
struct DetRng {
    key: [u8; 32],
    counter: u64,
    buf: [u8; 64],
    pos: usize,
}

impl DetRng {
    fn new(label: &str) -> Self {
        DetRng { key: hash32(label), counter: 0, buf: [0; 64], pos: 64 }
    }
    fn refill(&mut self) {
        let mut input = [0u8; 40];
        input[..32].copy_from_slice(&self.key);
        input[32..].copy_from_slice(&self.counter.to_le_bytes());
        let h = blake2b_simd::Params::new().hash_length(64).hash(&input);
        self.buf.copy_from_slice(h.as_bytes());
        self.counter += 1;
        self.pos = 0;
    }
}

impl RngCore for DetRng {
    fn next_u32(&mut self) -> u32 {
        let mut b = [0u8; 4];
        self.fill_bytes(&mut b);
        u32::from_le_bytes(b)
    }
    fn next_u64(&mut self) -> u64 {
        let mut b = [0u8; 8];
        self.fill_bytes(&mut b);
        u64::from_le_bytes(b)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        for d in dest.iter_mut() {
            if self.pos == 64 {
                self.refill();
            }
            *d = self.buf[self.pos];
            self.pos += 1;
        }
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}
impl CryptoRng for DetRng {}

struct Party {
    name: String,
    ufvk: zcash_keys::keys::UnifiedFullViewingKey,
    fvk: FullViewingKey,
    /// Receiving address used by this party in the tests (wallets use a party-specific index).
    addr: orchard::Address,
    ua: String,
}

fn party(name: &str, index: u32) -> Party {
    let seed = hash32(&format!("throwaway login test seed: {name}"));
    let usk = UnifiedSpendingKey::from_seed(&TEST_NETWORK, &seed, zip32::AccountId::ZERO).expect("valid seed");
    let ufvk = usk.to_unified_full_viewing_key();
    let fvk = ufvk.orchard().expect("orchard key").clone();
    let addr = fvk.address_at(index, Scope::External);
    let ua = UnifiedAddress::from_receivers(Some(addr), None, None)
        .expect("orchard receiver")
        .encode(&TEST_NETWORK);
    Party { name: name.into(), ufvk, fvk, addr, ua }
}

fn all_parties() -> Vec<Party> {
    vec![
        party("site shop.example", 0),
        party("site other.example", 0),
        party("user wallet A", 0),
        party("user wallet B", 5),
        party("someone else", 0),
    ]
}

#[derive(Clone, Copy, PartialEq)]
enum Pool {
    Orchard,
    Ironwood,
}

struct Out<'a> {
    from_ovk: Option<&'a Party>,
    to: &'a Party,
    value: u64,
    memo: String,
}

fn make_builder(
    height: u32,
    pool: Pool,
    input_value: u64,
    outs: &[Out],
    tsk: &secp256k1::SecretKey,
    label: &str,
) -> (Builder<zcash_protocol::consensus::TestNetwork, ()>, TransparentSigningSet) {
    let anchor = Some(orchard::Anchor::empty_tree());
    let config = BuildConfig::Standard {
        sapling_anchor: None,
        orchard_anchor: if pool == Pool::Orchard { anchor } else { None },
        ironwood_anchor: if pool == Pool::Ironwood { anchor } else { None },
        orchard_padding: BundlePadding::DEFAULT,
        ironwood_padding: BundlePadding::DEFAULT,
    };
    let mut b = Builder::new(TEST_NETWORK, BlockHeight::from_u32(height), config);
    let mut signing = TransparentSigningSet::new();
    let pk = signing.add_key(*tsk);
    let coin = TxOut::new(
        Zatoshis::from_u64(input_value).unwrap(),
        TransparentAddress::from_pubkey(&pk).script().into(),
    );
    b.add_transparent_p2pkh_input(pk, OutPoint::new(hash32(&format!("fake coin: {label}")), 0), coin)
        .expect("input");
    for o in outs {
        let ovk = o.from_ovk.map(|p| p.fvk.to_ovk(Scope::External));
        let memo = MemoBytes::from(Memo::from_bytes(o.memo.as_bytes()).expect("memo fits"));
        let v = Zatoshis::from_u64(o.value).unwrap();
        match pool {
            Pool::Orchard => b.add_orchard_output::<zip317::FeeError>(ovk, o.to.addr, v, memo),
            Pool::Ironwood => b.add_ironwood_output::<zip317::FeeError>(ovk, o.to.addr, v, memo),
        }
        .expect("output");
    }
    (b, signing)
}

/// The funding coin's key belongs to the paying wallet, so each wallet pays from its own address.
fn build_tx(height: u32, pool: Pool, outs: &[Out], label: &str, wallet: &str) -> Transaction {
    #[allow(deprecated)]
    let fee_rule = zip317::FeeRule::standard();
    let tsk = secp256k1::SecretKey::from_slice(&hash32(&format!("transparent key of {wallet}"))).unwrap();
    let total: u64 = outs.iter().map(|o| o.value).sum();
    let (probe, _) = make_builder(height, pool, total, outs, &tsk, label);
    let fee = u64::from(probe.get_fee(&fee_rule).expect("fee"));
    let (b, signing) = make_builder(height, pool, total + fee, outs, &tsk, label);
    let prover = LocalTxProver::bundled();
    let res = b
        .build(&signing, &[], &[], DetRng::new(label), &prover, &prover, &fee_rule)
        .unwrap_or_else(|e| panic!("build {label}: {e}"));
    res.transaction().clone()
}

fn rust_check(tx: &Transaction, height: u32, viewer: &Party) -> Vec<Value> {
    let mut keys = HashMap::new();
    keys.insert(0u32, viewer.ufvk.clone());
    let d = decrypt_transaction(&TEST_NETWORK, Some(BlockHeight::from_u32(height)), None, tx, &keys);
    let mut v = vec![];
    for (pool, outs) in [("orchard", d.orchard_outputs()), ("ironwood", d.ironwood_outputs())] {
        for o in outs {
            let memo = match Memo::try_from(o.memo()) {
                Ok(Memo::Text(t)) => String::from(t),
                Ok(Memo::Empty) => String::new(),
                _ => "<non-text>".into(),
            };
            v.push(json!({
                "pool": pool,
                "amountZat": o.note().0.value().inner(),
                "memo": memo,
                "transferType": format!("{:?}", o.transfer_type()),
            }));
        }
    }
    v
}

fn parties_json(ps: &[Party]) -> Value {
    let mut m = serde_json::Map::new();
    for p in ps {
        m.insert(p.name.clone(), json!({ "ufvk": p.ufvk.encode(&TEST_NETWORK), "address": p.ua }));
    }
    Value::Object(m)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let ps = all_parties();
    match args.get(1).map(String::as_str) {
        Some("parties") => println!("{}", serde_json::to_string_pretty(&parties_json(&ps)).unwrap()),
        Some("build") => build(&ps, &args[2], &args[3]),
        _ => eprintln!("usage: gen_login parties | gen_login build <inputs.json> <output.json>"),
    }
}

fn build(ps: &[Party], in_path: &str, out_path: &str) {
    let by_name: HashMap<&str, &Party> = ps.iter().map(|p| (p.name.as_str(), p)).collect();
    let input: Value = serde_json::from_str(&fs::read_to_string(in_path).unwrap()).unwrap();
    let mut txs = serde_json::Map::new();
    for p in input["payments"].as_array().unwrap() {
        let label = p["label"].as_str().unwrap();
        let to = by_name[p["to"].as_str().unwrap()];
        let wallet = by_name[p["wallet"].as_str().unwrap()];
        let height = p["height"].as_u64().unwrap() as u32;
        let pool = if p["pool"].as_str().unwrap() == "orchard" { Pool::Orchard } else { Pool::Ironwood };
        let value = p["amountZat"].as_u64().unwrap();
        let memo = p["memo"].as_str().unwrap().to_string();
        eprintln!("building {label} ...");
        // Login payment to the site, plus change back to the paying wallet's own address.
        // Under NU6.3 rules every output goes to Ironwood.
        let outs = vec![
            Out { from_ovk: Some(wallet), to, value, memo },
            Out { from_ovk: Some(wallet), to: wallet, value: 20_000, memo: String::new() },
        ];
        let tx = build_tx(height, pool, &outs, &format!("login {label}"), &wallet.name);
        let mut raw = vec![];
        tx.write(&mut raw).unwrap();
        let branch = BranchId::for_height(&TEST_NETWORK, BlockHeight::from_u32(height));
        Transaction::read(&raw[..], branch).expect("round trip");
        txs.insert(
            label.into(),
            json!({
                "height": height,
                "txVersion": format!("{:?}", tx.version()),
                "pool": p["pool"],
                "txid": tx.txid().to_string(),
                "txHex": hex::encode(&raw),
                "to": to.name,
                "wallet": wallet.name,
                "walletAddress": wallet.ua,
                "siteKeySees": rust_check(&tx, height, to),
            }),
        );
    }
    let doc = json!({
        "source": "Generated offline by imani tools/gen-vectors/gen_login.rs (librustzcash transaction builder). Throwaway test seeds, invented funding coins, never broadcast.",
        "network": "test",
        "parties": parties_json(ps),
        "inputs": input,
        "transactions": txs,
    });
    fs::write(out_path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    eprintln!("wrote {out_path}");
}
