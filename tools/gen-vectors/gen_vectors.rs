//! Offline Zcash test transaction generator for the imani reader tests.
//!
//! Builds fake but well-formed testnet transactions with the official
//! librustzcash transaction builder. Nothing is broadcast and no real coins are
//! involved: each transaction is funded by an invented transparent coin (the
//! builder never checks that a coin exists on chain). All keys come from fixed
//! throwaway seeds, and all randomness comes from a fixed seed, so the output is
//! the same on every run with the same Cargo.lock.
//!
//! Run from a zcash-devtool checkout (see README.md):
//!   cargo run --example gen_vectors -- <output.json>

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

/// Height inside NU6.1 on testnet: the builder emits a version 5 transaction.
const HEIGHT_NU6_1: u32 = 3_600_000;
/// Height inside NU6.2 on testnet (new consensus branch id, still Orchard payments).
const HEIGHT_NU6_2: u32 = 4_060_000;
/// Height inside NU6.3 on testnet: the builder emits a version 6 transaction,
/// the first version that can carry an Ironwood bundle.
const HEIGHT_NU6_3: u32 = 4_200_000;

fn hash32(label: &str) -> [u8; 32] {
    let h = blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"imani_testvector")
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
    name: &'static str,
    ufvk: zcash_keys::keys::UnifiedFullViewingKey,
    fvk: FullViewingKey,
    addr: orchard::Address,
    ua: String,
}

fn party(name: &'static str) -> Party {
    let seed = hash32(&format!("throwaway test seed: {name}"));
    let usk = UnifiedSpendingKey::from_seed(&TEST_NETWORK, &seed, zip32::AccountId::ZERO)
        .expect("valid seed");
    let ufvk = usk.to_unified_full_viewing_key();
    let fvk = ufvk.orchard().expect("orchard key").clone();
    let addr = fvk.address_at(0u32, Scope::External);
    let ua = UnifiedAddress::from_receivers(Some(addr), None, None)
        .expect("orchard receiver")
        .encode(&TEST_NETWORK);
    Party { name, ufvk, fvk, addr, ua }
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
    memo: &'a str,
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

fn build_tx(height: u32, pool: Pool, outs: &[Out], label: &str) -> Transaction {
    #[allow(deprecated)]
    let fee_rule = zip317::FeeRule::standard();
    let tsk = secp256k1::SecretKey::from_slice(&hash32(&format!("fake coin key: {label}"))).unwrap();
    let total: u64 = outs.iter().map(|o| o.value).sum();
    // First pass only to learn the fee, second pass balanced exactly.
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("auction") {
        auction(args.get(2).cloned().unwrap_or_else(|| "auction-round.json".into()), false);
    } else if args.get(1).map(String::as_str) == Some("sealed") {
        sealed(args.get(2).cloned().unwrap_or_else(|| "sealed-round.json".into()));
    } else if args.get(1).map(String::as_str) == Some("auction-memo") {
        auction(args.get(2).cloned().unwrap_or_else(|| "auction-round-memo.json".into()), true);
    } else {
        reader_cases(args.get(1).cloned().unwrap_or_else(|| "offline-vectors.json".into()));
    }
}

/// Lot used by the auction checker examples.
const LOT_ID: &str = "LOT-01";
/// Last block height at which a bid still counts.
const CLOSE_HEIGHT: u32 = 4_200_100;
/// Number of identical items sold in the lot, and the lowest price the seller accepts.
const ITEM_COUNT: u64 = 2;
const RESERVE_ZAT: u64 = 1_000_000;

fn write_tx(tx: &Transaction, height: u32) -> Vec<u8> {
    let mut raw = vec![];
    tx.write(&mut raw).unwrap();
    let branch = BranchId::for_height(&TEST_NETWORK, BlockHeight::from_u32(height));
    Transaction::read(&raw[..], branch).expect("round trip");
    raw
}

/// A fake 3-bid sealed-bid round for one lot, plus one late bid and a few extra
/// transactions used to build broken copies and guard tests. Every transaction is
/// Ironwood, version 6, testnet NU6.3 rules. Bids are paid into the lot address with
/// a "bid:<lotId>:<nonce>" memo. Refunds are paid from the lot (recorded under the
/// lot's outgoing viewing key) with a "refund:<lotId>:<bid txid>" memo.
fn auction(out_path: String, memo_addresses: bool) {
    let lot = party("lot LOT-01");
    let alice = party("bidder alice");
    let bob = party("bidder bob");
    let carol = party("bidder carol");
    let dave = party("bidder dave");
    let stranger = party("stranger");

    let mut txs = serde_json::Map::new();
    let mut txids: HashMap<&str, String> = HashMap::new();

    let add = |label: &'static str, height: u32, outs: Vec<Out>, txs: &mut serde_json::Map<String, Value>| {
        eprintln!("building {label} ...");
        let tx = build_tx(height, Pool::Ironwood, &outs, &format!("auction {label}"));
        let raw = write_tx(&tx, height);
        let txid = tx.txid().to_string();
        txs.insert(
            label.into(),
            json!({
                "height": height,
                "txid": txid,
                "txHex": hex::encode(&raw),
                "outputs": outs.iter().map(|o| json!({
                    "to": o.to.name,
                    "senderOvk": o.from_ovk.map(|p| p.name),
                    "amountZat": o.value,
                    "memo": o.memo,
                })).collect::<Vec<_>>(),
                "lotKeySees": rust_check(&tx, height, &lot),
            }),
        );
        txid
    };

    // Bids: (label, bidder, amount, memo, height). Dave's bid lands after the close.
    // With memo_addresses each bidder writes their own refund address after the word:
    // "bid:<lotId>:<word>:<refund address>". The seller cannot choose it.
    let bid_memo = |word: &str, who: &Party| -> String {
        if memo_addresses { format!("bid:LOT-01:{word}:{}", who.ua) } else { format!("bid:LOT-01:{word}") }
    };
    let bids: [(&'static str, &Party, u64, String, u32); 4] = [
        ("bid_alice", &alice, 3_000_000, bid_memo("q7k2", &alice), 4_200_010),
        ("bid_bob", &bob, 2_000_000, bid_memo("m3x8", &bob), 4_200_020),
        ("bid_carol", &carol, 1_500_000, bid_memo("t5w1", &carol), 4_200_030),
        ("bid_dave_late", &dave, 1_200_000, bid_memo("z9p4", &dave), 4_200_105),
    ];
    for (label, _who, value, memo, height) in bids.iter() {
        let id = add(*label, *height, vec![Out { from_ovk: None, to: &lot, value: *value, memo: memo.as_str() }], &mut txs);
        txids.insert(*label, id);
    }

    // Extra payments into the lot address, used only by broken copies and tests.
    let extras: [(&'static str, &Party, u64, String, u32); 3] = [
        ("stray_payment", &stranger, 50_000, "coffee order 7".to_string(), 4_200_040),
        ("bid_other_lot", &stranger, 800_000, "bid:LOT-02:r2d6".to_string(), 4_200_050),
        ("bid_alice_replay", &alice, 3_000_000, bid_memo("q7k2", &alice), 4_200_060),
    ];
    for (label, _who, value, memo, height) in extras.iter() {
        add(*label, *height, vec![Out { from_ovk: None, to: &lot, value: *value, memo: memo.as_str() }], &mut txs);
    }

    // Refunds: (label, recipient, amount, bid label, height). With 2 items, a reserve of
    // 1,000,000 and the uniform price rule (clearing price = highest losing bid, never below
    // the reserve), Alice and Bob win at 1,500,000 each and get the rest of their bid back,
    // Carol loses and gets all of it back, and Dave's late bid is returned in full.
    // refund_carol_short pays Carol 100,000 too little, for one broken copy.
    let mut refunds: Vec<(&'static str, &Party, u64, &str, u32)> = vec![
        ("refund_alice_change", &alice, 1_500_000, "bid_alice", 4_200_120),
        ("refund_bob_change", &bob, 500_000, "bid_bob", 4_200_121),
        ("refund_carol", &carol, 1_500_000, "bid_carol", 4_200_122),
        ("refund_dave_late", &dave, 1_200_000, "bid_dave_late", 4_200_123),
        ("refund_carol_short", &carol, 1_400_000, "bid_carol", 4_200_122),
    ];
    // Memo round only: Carol's refund paid to Dave's address instead of the one in her bid memo.
    if memo_addresses {
        refunds.push(("refund_carol_elsewhere", &dave, 1_500_000, "bid_carol", 4_200_122));
    }
    for (label, who, value, bid_label, height) in refunds.iter() {
        let memo = format!("refund:{LOT_ID}:{}", txids[*bid_label]);
        add(*label, *height, vec![Out { from_ovk: Some(&lot), to: who, value: *value, memo: &memo }], &mut txs);
    }

    let mut parties = serde_json::Map::new();
    for p in [&lot, &alice, &bob, &carol, &dave, &stranger] {
        parties.insert(p.name.into(), json!({ "ufvk": p.ufvk.encode(&TEST_NETWORK), "address": p.ua }));
    }
    let doc = json!({
        "source": "Generated offline by imani tools/gen-vectors (librustzcash transaction builder). Throwaway test seeds, invented funding coins, never broadcast.",
        "network": "test",
        "lotId": LOT_ID,
        "closeHeight": CLOSE_HEIGHT,
        "rules": { "itemCount": ITEM_COUNT, "reserveZat": RESERVE_ZAT },
        "parties": parties,
        "transactions": txs,
    });
    fs::write(&out_path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    eprintln!("wrote {out_path}");
}

fn reader_cases(out_path: String) {
    let buyer = party("buyer");
    let seller = party("seller");
    let stranger = party("stranger");

    let pay_memo = "imani order 42: 2 bags of rice";
    let refund_memo = "imani refund for order 42";

    // Payment: the buyer pays the seller from a transparent coin, with a text memo.
    // Refund: the seller sends money back to the buyer and keeps an outgoing
    // record by encrypting it to the seller's own outgoing viewing key.
    let pay = || vec![Out { from_ovk: None, to: &seller, value: 1_250_000, memo: pay_memo }];
    let refund =
        || vec![Out { from_ovk: Some(&seller), to: &buyer, value: 400_000, memo: refund_memo }];

    // (case name, height, pool, outputs)
    let cases: Vec<(&str, u32, Pool, Vec<Out>)> = vec![
        ("orchard_v5_payment", HEIGHT_NU6_1, Pool::Orchard, pay()),
        ("orchard_v5_refund", HEIGHT_NU6_1, Pool::Orchard, refund()),
        // No Orchard payment under NU6.3: the builder refuses it (CrossAddressDisabled),
        // because from NU6.3 the Orchard pool only accepts change, and payments to other
        // people go to Ironwood.
        ("orchard_nu6_2_payment", HEIGHT_NU6_2, Pool::Orchard, pay()),
        ("ironwood_v6_payment", HEIGHT_NU6_3, Pool::Ironwood, pay()),
        ("ironwood_v6_refund", HEIGHT_NU6_3, Pool::Ironwood, refund()),
    ];

    let mut case_json = serde_json::Map::new();
    for (name, height, pool, outs) in &cases {
        eprintln!("building {name} ...");
        let tx = build_tx(*height, *pool, outs, name);
        let mut raw = vec![];
        tx.write(&mut raw).unwrap();
        // Round trip: the bytes must parse back with the branch the builder used.
        let branch = BranchId::for_height(&TEST_NETWORK, BlockHeight::from_u32(*height));
        Transaction::read(&raw[..], branch).expect("round trip");
        let mut checks = serde_json::Map::new();
        for p in [&buyer, &seller, &stranger] {
            checks.insert(p.name.into(), Value::Array(rust_check(&tx, *height, p)));
        }
        case_json.insert(
            (*name).into(),
            json!({
                "height": height,
                "branch": format!("{branch:?}"),
                "txVersion": format!("{:?}", tx.version()),
                "pool": if *pool == Pool::Orchard { "orchard" } else { "ironwood" },
                "txid": tx.txid().to_string(),
                "txHex": hex::encode(&raw),
                "outputs": outs.iter().map(|o| json!({
                    "to": o.to.name,
                    "senderOvk": o.from_ovk.map(|p| p.name),
                    "amountZat": o.value,
                    "memo": o.memo,
                })).collect::<Vec<_>>(),
                "librustzcashDecrypt": checks,
            }),
        );
    }

    let mut parties = serde_json::Map::new();
    for p in [&buyer, &seller, &stranger] {
        parties.insert(
            p.name.into(),
            json!({ "ufvk": p.ufvk.encode(&TEST_NETWORK), "address": p.ua }),
        );
    }

    let doc = json!({
        "source": "Generated offline by imani tools/gen-vectors (librustzcash transaction builder). Throwaway test seeds, invented funding coin, never broadcast.",
        "network": "test",
        "parties": parties,
        "cases": case_json,
    });
    fs::write(&out_path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    eprintln!("wrote {out_path}");
}

/// sha256("imani-seal/1|" + lotId + "|" + word + "|" + amountZat + "|" + salt + "|" + refundAddressOrEmpty), hex.
fn seal_hash(lot: &str, word: &str, amount: u64, salt: &str, addr: &str) -> String {
    use sha2::{Digest, Sha256};
    let text = format!("imani-seal/1|{lot}|{word}|{amount}|{salt}|{addr}");
    hex::encode(Sha256::digest(text.as_bytes()))
}

struct SealCase<'a> {
    label: &'static str,
    who: &'a Party,
    word: &'static str,
    sealed: u64,
    salt: &'static str,
    paid: u64,
    height: u32,
    open: Option<u64>,
}

/// A fake sealed-lot round for LOT-01 (see docs/SELLER_BLIND_PLAN.md): every seal pays the same
/// 5,000,000 deposit and carries only a hash of the real price. Prices are opened after the close.
/// 2 items, reserve 1,000,000, forfeit 500,000, close 4,200,100, openings until 4,200,200.
fn sealed(out_path: String) {
    const DEPOSIT: u64 = 5_000_000;
    const FORFEIT: u64 = 500_000;
    const OPEN_PAY: u64 = 10_000;
    let lot = party("lot LOT-01");
    let alice = party("bidder alice");
    let bob = party("bidder bob");
    let carol = party("bidder carol");
    let dave = party("bidder dave");
    let erin = party("bidder erin");
    let frank = party("bidder frank");
    let gina = party("bidder gina");

    let mut txs = serde_json::Map::new();
    let add = |label: &str, height: u32, outs: Vec<Out>, txs: &mut serde_json::Map<String, Value>| {
        eprintln!("building {label} ...");
        let tx = build_tx(height, Pool::Ironwood, &outs, &format!("sealed {label}"));
        let raw = write_tx(&tx, height);
        let txid = tx.txid().to_string();
        txs.insert(
            label.into(),
            json!({
                "height": height,
                "txid": txid,
                "txHex": hex::encode(&raw),
                "outputs": outs.iter().map(|o| json!({
                    "to": o.to.name,
                    "senderOvk": o.from_ovk.map(|p| p.name),
                    "amountZat": o.value,
                    "memo": o.memo,
                })).collect::<Vec<_>>(),
                "lotKeySees": rust_check(&tx, height, &lot),
            }),
        );
        txid
    };

    let seals = [
        SealCase { label: "seal_alice", who: &alice, word: "q7k2", sealed: 3_000_000, salt: "00112233445566778899aabbccddeeff", paid: DEPOSIT, height: 4_200_010, open: Some(3_000_000) },
        SealCase { label: "seal_bob", who: &bob, word: "m3x8", sealed: 2_000_000, salt: "a1b2c3d4e5f60718293a4b5c6d7e8f90", paid: DEPOSIT, height: 4_200_020, open: Some(2_000_000) },
        SealCase { label: "seal_carol", who: &carol, word: "t5w1", sealed: 1_500_000, salt: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", paid: DEPOSIT, height: 4_200_030, open: Some(1_500_000) },
        SealCase { label: "seal_dave_unopened", who: &dave, word: "z9p4", sealed: 1_200_000, salt: "11223344556677889900aabbccddeeff", paid: DEPOSIT, height: 4_200_035, open: None },
        SealCase { label: "seal_erin_badhash", who: &erin, word: "w2v6", sealed: 900_000, salt: "ffeeddccbbaa00998877665544332211", paid: DEPOSIT, height: 4_200_040, open: Some(800_000) },
        SealCase { label: "seal_frank_wrong_deposit", who: &frank, word: "r8n3", sealed: 1_000_000, salt: "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a", paid: DEPOSIT - 1, height: 4_200_045, open: None },
        SealCase { label: "seal_gina_late", who: &gina, word: "h4c9", sealed: 1_100_000, salt: "9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c", paid: DEPOSIT, height: 4_200_105, open: None },
    ];
    let mut ids: HashMap<&str, String> = HashMap::new();
    for s in seals.iter() {
        let hash = seal_hash(LOT_ID, s.word, s.sealed, s.salt, &s.who.ua);
        let memo = format!("seal:{LOT_ID}:{}:{}:{}", s.word, hash, s.who.ua);
        let id = add(s.label, s.height, vec![Out { from_ovk: None, to: &lot, value: s.paid, memo: &memo }], &mut txs);
        ids.insert(s.label, id);
    }
    // Openings after the close.
    let mut open_pay: HashMap<&str, u64> = HashMap::new();
    let mut open_h = 4_200_110;
    for s in seals.iter() {
        if let Some(amount) = s.open {
            let memo = format!("open:{LOT_ID}:{}:{}:{}", s.word, amount, s.salt);
            add(&s.label.replace("seal_", "open_"), open_h, vec![Out { from_ovk: None, to: &lot, value: OPEN_PAY, memo: &memo }], &mut txs);
            open_pay.insert(s.label, OPEN_PAY);
            open_h += 1;
        }
    }

    // Worked refunds (rules 7 and 8 of the plan). Counted: alice, bob, carol. Price 1,500,000.
    let counted = ["seal_alice", "seal_bob", "seal_carol"];
    let winners = ["seal_alice", "seal_bob"];
    let price: u64 = 1_500_000;
    let penalties = 2 * FORFEIT; // dave unopened, erin bad opening
    let share = penalties / counted.len() as u64;
    let leftover = penalties - share * counted.len() as u64;
    let lowest = *counted.iter().min_by_key(|l| ids[**l].clone()).unwrap();
    let mut refund_plan = serde_json::Map::new();
    let mut refunds: Vec<(String, &Party, u64, &str)> = vec![];
    for s in seals.iter() {
        let opened = open_pay.get(s.label).copied().unwrap_or(0);
        let owed = if counted.contains(&s.label) {
            DEPOSIT - if winners.contains(&s.label) { price } else { 0 } + opened + share + if lowest == s.label { leftover } else { 0 }
        } else if s.label == "seal_dave_unopened" || s.label == "seal_erin_badhash" {
            DEPOSIT - FORFEIT + opened
        } else {
            s.paid
        };
        refund_plan.insert(s.label.into(), json!(owed));
        refunds.push((format!("refund_{}", s.label.trim_start_matches("seal_")), s.who, owed, s.label));
    }
    let mut rh = 4_200_120;
    for (label, who, value, seal_label) in refunds.iter() {
        let memo = format!("refund:{LOT_ID}:{}", ids[*seal_label]);
        add(label, rh, vec![Out { from_ovk: Some(&lot), to: who, value: *value, memo: &memo }], &mut txs);
        rh += 1;
    }
    // Broken copy only: Alice refunded without her share of the penalties.
    let short = refund_plan["seal_alice"].as_u64().unwrap() - share - if lowest == "seal_alice" { leftover } else { 0 };
    let memo = format!("refund:{LOT_ID}:{}", ids["seal_alice"]);
    add("refund_alice_noshare", 4_200_120, vec![Out { from_ovk: Some(&lot), to: &alice, value: short, memo: &memo }], &mut txs);

    let mut parties = serde_json::Map::new();
    for p in [&lot, &alice, &bob, &carol, &dave, &erin, &frank, &gina] {
        parties.insert(p.name.into(), json!({ "ufvk": p.ufvk.encode(&TEST_NETWORK), "address": p.ua }));
    }
    let doc = json!({
        "source": "Generated offline by imani tools/gen-vectors (librustzcash transaction builder). Throwaway test seeds, invented funding coins, never broadcast.",
        "network": "test",
        "lotId": LOT_ID,
        "closeHeight": CLOSE_HEIGHT,
        "openByHeight": 4_200_200,
        "rules": { "kind": "sealed", "itemCount": ITEM_COUNT, "reserveZat": RESERVE_ZAT, "depositZat": DEPOSIT, "forfeitZat": FORFEIT },
        "parties": parties,
        "refundPlan": refund_plan,
        "transactions": txs,
    });
    fs::write(&out_path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    eprintln!("wrote {out_path}");
}
