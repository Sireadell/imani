# Imani

*Imani means "trust" in Swahili.*

Two small tools for private Zcash apps.

1. **Check a sealed-bid auction.** After an auction closes, the seller can share a one-time read-only key. imani reads the auction's private payments with that key and recomputes the bid count, amounts and refunds, then compares them to the seller's published result: PASS or FAIL.
2. **Sign in with a private Zcash wallet.** A login button any website can add. Your account is tied to a login key, so it survives a change of wallet address.

Status: early build for Zecathon, Core & Tooling track.

Licence: MIT. See THIRD_PARTY.md for the libraries used.
