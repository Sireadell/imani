# Login scorecard

A small check you can point at any login that works by paying a tiny shielded amount with a code in the memo. It runs six checks from the outside, the way a user and a copycat would use the login, and prints PASS, FAIL or SKIPPED for each one with a plain sentence about what happened.

```sh
npm run login:scorecard
```

That prints two cards: this repo's own login (6 passed) and a deliberately weak example login we wrote for the test (1 passed, 5 failed), so you can see the card go red. Add `-- --json` for JSON.

## The six checks

| # | Check | Passes when |
|---|---|---|
| 1 | A login code works once | The same payment, and a second payment with the same code, are both refused after one login |
| 2 | An old code is refused | A payment submitted after the code's lifetime is refused |
| 3 | A new wallet address keeps the same account | One user paying from two wallet addresses lands in one account, and a different user lands in another |
| 4 | The payment link holds no secret and pays one address | None of the login's secrets are in the link or its memo, and the link has no hidden second payee |
| 5 | The site never learns the paying wallet's address | That address is not in anything the site stored or replied |
| 6 | Someone who only saw the payment cannot log in as the user | A copycat with the public payment is refused, and the real user can still use the same payment |

Each check runs with its own users. A login that throws an error fails the check. The error text is dropped, so nothing from the login can end up on the card.

## Scoring another login

Write an adapter: an object with `name`, `ttlSeconds` and five small functions. The scorecard never reads the login's code.

```ts
import { runScorecard, scorecardText, type LoginUnderTest } from "@sireadell/imani/login";

const adapter: LoginUnderTest = {
  name: "my login",
  ttlSeconds: 600,
  begin: async (user) => ({ handle, link }),            // a user starts a login; return the payment link
  pay: async (handle, link, wallet) => ({ payment, walletAddress }),   // the wallet pays the link
  submit: async (handle, payment, by) => ({ ok, account, raw }),       // by is "owner" or "copycat"
  advance: (seconds) => {},                             // move the site's clock
  secrets: (handle) => [accountKey, proof],             // values that must stay off the link
  stored: async () => JSON.stringify(db),               // optional: what the site stored
};
console.log(scorecardText(await runScorecard(adapter)));
```

A working adapter for this repo's login is in `tools/scorecard-adapters.ts`. `test/login/scorecard.test.ts` breaks that login one way at a time and shows each check turns red on its own.

## What the scorecard does not tell you

| Limit | Meaning |
|---|---|
| It scores the adapter, not the login | A wrong adapter gives a wrong card. It is as honest as the person who wrote it. |
| It tests six behaviours, not everything | A PASS is not a security audit. Rate limits, session cookies and your own database are not covered. |
| Check 5 needs `stored` | Without it the check is SKIPPED, never passed. |
| We have not scored anyone else's login | The only logins scored here are this repo's and a weak example we wrote. |
