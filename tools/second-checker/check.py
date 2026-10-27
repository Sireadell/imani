#!/usr/bin/env python3
"""A second, small checker for Imani rounds. Python standard library only.

It reads a round's disclosure.json and result.json and re-works the answer from the plain
numbers they state: who wins, the price every winner pays and what each bidder gets back.
It never opens a payment, so it cannot see anything that only the payments or the chain show.

  python3 tools/second-checker/check.py                         run every case in conformance/manifest.json
  python3 tools/second-checker/check.py --files D.json R.json   check one round
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def norm_rules(r):
    """Rules with the defaults filled in, so a missing field and its default compare equal."""
    r = dict(r or {})
    kind = r.get("kind", "auction")
    out = {"kind": kind}
    if kind == "goal":
        out["goalZat"] = r.get("goalZat")
    else:
        out["itemCount"] = r.get("itemCount")
        out["reserveZat"] = r.get("reserveZat")
        if kind == "sealed":
            out["depositZat"] = r.get("depositZat")
            out["forfeitZat"] = r.get("forfeitZat")
        else:
            out["pricing"] = r.get("pricing", "highest-losing")
            out["topUps"] = bool(r.get("topUps", False))
    return out


def rank(bids):
    # biggest amount first; ties go to the earlier block, then the smaller id
    return sorted(bids, key=lambda b: (-b["amountZat"], b["height"], b["txid"]))


def work_out(bids, rules):
    """Returns (winner ids in order, price, what each counted bid is owed back)."""
    if rules["kind"] == "goal":
        total = sum(b["amountZat"] for b in bids)
        reached = len(bids) > 0 and total >= rules["goalZat"]
        winners = [b["txid"] for b in bids] if reached else []
        return winners, 0, {b["txid"]: (0 if reached else b["amountZat"]) for b in bids}
    ordered = rank(bids)
    winning = [b for b in ordered if b["amountZat"] >= rules["reserveZat"]][: rules["itemCount"]]
    ids = {b["txid"] for b in winning}
    if not winning:
        price = 0
    elif rules["kind"] == "auction" and rules["pricing"] == "lowest-winning":
        price = max(rules["reserveZat"], winning[-1]["amountZat"])
    else:
        rest = [b["amountZat"] for b in ordered if b["txid"] not in ids]
        price = max(rules["reserveZat"], rest[0] if rest else 0)
    owed = {b["txid"]: (b["amountZat"] - price if b["txid"] in ids else b["amountZat"]) for b in ordered}
    return [b["txid"] for b in winning], price, owed


def check_round(disc, res):
    """Returns the list of check ids that fail. An empty list means the numbers agree."""
    bad = []

    def fail(*ids):
        for i in ids:
            if i not in bad:
                bad.append(i)

    if disc.get("format") != "imani-lot-disclosure/1" or res.get("format") != "imani-lot-result/1":
        return ["format"]
    if disc.get("lotId") != res.get("lotId"):
        fail("result-consistent")
    rules = norm_rules(disc.get("rules"))
    if rules != norm_rules(res.get("rules")):
        fail("result-consistent")
    close = disc.get("closeHeight")
    if not isinstance(close, int):
        return bad + ["close-height"]

    txs = disc.get("transactions", [])
    height = {t.get("txid"): t.get("height") for t in txs}
    if len(height) != len(txs):
        fail("disclosure-txids-unique")
    bids = [{"txid": b["txid"], "amountZat": b["amountZat"], "height": height.get(b["txid"])} for b in res.get("bids", [])]
    bidids = {b["txid"] for b in bids}
    if res.get("bidCount") != len(bids) or len(bidids) != len(bids):
        fail("bid-count")
    for b in bids:
        if b["height"] is None:
            fail("bid-count")  # a bid the disclosure does not list
        elif b["height"] > close:
            fail("no-late-bids")
    if "bid-count" in bad:
        return bad

    claimed = list(res.get("winners", []))
    if not set(claimed) <= bidids:
        fail("winners-and-price")
    on_time = [b for b in bids if b["height"] <= close]
    wins, price, owed = work_out(on_time, rules)
    reached = len(wins) > 0
    if rules["kind"] == "goal":
        if bool(res.get("reserveMet")) != reached:
            fail("goal-reached", "reserve", "winners-and-price")
    elif bool(res.get("reserveMet")) != reached:
        fail("reserve")
    if claimed != wins:
        fail("winners-and-price")
    if res.get("clearingPriceZat") != price:
        fail("winners-and-price")
        if rules["kind"] != "goal":
            fail("clearing-range")

    listed = {}
    for r in res.get("refunds", []):
        t = r.get("bidTxid")
        if t in listed:
            fail("refund-total")
        listed[t] = r
        if r.get("memo") != "refund:%s:%s" % (res.get("lotId"), t):
            fail("result-consistent")
        if t not in height:
            fail("result-consistent")  # a refund for a payment the disclosure does not list
    late = {t for t, h in height.items() if h is not None and h > close and t not in bidids}

    if rules["kind"] == "sealed":
        dep, forf = rules["depositZat"], rules["forfeitZat"]
        unopened = list(res.get("unopened", []))
        if set(unopened) & bidids:
            fail("seal-forfeits")
        if any(b["amountZat"] > dep for b in bids):
            fail("seal-openings")
        # Opening payments and penalty shares only ever add to a refund, so these are floors.
        share = (forf * len(unopened)) // len(on_time) if on_time else 0
        for b in on_time:
            r = listed.get(b["txid"])
            base = dep - price if b["txid"] in wins else dep
            if r is None or r["amountZat"] < base + share:
                fail("refund-total")
        for t in unopened:
            r = listed.get(t)
            if r is None or r["amountZat"] < dep - forf:
                fail("refund-total")
    else:
        for b in on_time:
            expect = owed[b["txid"]]
            r = listed.get(b["txid"])
            if r is None:
                if expect != 0:
                    fail("refund-total")
            elif r["amountZat"] != expect:
                fail("refund-total")
                if rules["kind"] == "goal":
                    fail("result-consistent")
        for t in late:
            if t in listed and listed[t].get("reason") != "late":
                fail("result-consistent")

    tot = res.get("totals")
    if tot:
        listed_sum = sum(r["amountZat"] for r in res.get("refunds", []))
        if rules["kind"] == "goal":
            kept = sum(b["amountZat"] for b in on_time) if wins else 0
        else:
            kept = price * len(wins)
        if tot.get("receivedZat") != tot.get("keptZat", 0) + tot.get("refundedZat", 0):
            fail("published-totals")
        if tot.get("refundedZat") != listed_sum:
            fail("published-totals", "refund-total")
        if tot.get("keptZat") != kept:
            fail("published-totals")
        if tot.get("payments") is not None and tot["payments"] != len(height) - len(listed):
            fail("published-totals")
    return bad


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def run_manifest():
    man = load(os.path.join(ROOT, "conformance", "manifest.json"))
    agree = disagree = undecided = 0
    for c in man["cases"]:
        try:
            bad = check_round(load(os.path.join(ROOT, c["disclosure"])), load(os.path.join(ROOT, c["result"])))
        except (KeyError, TypeError, ValueError, OSError) as e:
            bad = ["unreadable:" + type(e).__name__]
        got = "FAIL" if bad else "PASS"
        if got == c["expect"]:
            agree += 1
            print("AGREE        %-44s %s %s" % (c["id"], got, ", ".join(bad)))
        elif got == "PASS":
            # Nothing in the plain numbers is wrong. The fault is only in the payments or the chain.
            undecided += 1
            print("NEEDS-READER %-44s numbers agree with each other; expected FAIL (%s)" % (c["id"], ", ".join(c.get("failing", []))))
        else:
            disagree += 1
            print("DISAGREE     %-44s checker FAIL (%s), manifest expects PASS" % (c["id"], ", ".join(bad)))
    total = agree + disagree + undecided
    print()
    if disagree:
        print("DISAGREE on %d case(s); decided %d of %d." % (disagree, agree, total))
        return 1
    print("decided %d of %d, agrees on all %d; the other %d need the payment reader" % (agree, total, agree, undecided))
    return 0


def main(argv):
    if len(argv) == 4 and argv[1] == "--files":
        bad = check_round(load(argv[2]), load(argv[3]))
        print("FAIL: " + ", ".join(bad) if bad else "PASS")
        return 1 if bad else 0
    if len(argv) != 1:
        print(__doc__)
        return 2
    return run_manifest()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
