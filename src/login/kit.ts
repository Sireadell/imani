import { createChallenge, MemoryChallengeStore, networkOfViewingKey, addressMatchesNetwork, type ChallengeStore, type Network } from "./challenge.ts";
import { verifyLoginPayment, type Failure, type LoginSuccess, type TxReader } from "./verify.ts";

export interface LoginKitOptions {
  /** Site id shown in every login memo, usually the domain, for example shop.example. */
  siteId: string;
  /** The site's own receiving address (a throwaway address used only for logins is best). */
  siteAddress: string;
  /** The site's read-only unified full viewing key for that address. Never a spending key. */
  viewingKey: string;
  store?: ChallengeStore;
  ttlSeconds?: number;
  minZat?: number;
  /** Clock override in seconds, for tests. */
  clock?: () => number;
  readTx?: TxReader;
  log?: (event: string) => void;
}

/** What the browser receives when it asks for a code. Public data only. */
export interface PublicChallenge {
  nonce: string;
  siteId: string;
  siteAddress: string;
  network: Network;
  expiresAt: number;
  minZat: number;
  /** Echoed back when the code was reserved for one account id. */
  accountId?: string;
}

/**
 * One site's login setup, shared by the Express and Auth.js adapters.
 * It keeps the viewing key private and never prints or serialises it.
 */
export class LoginKit {
  #opts: LoginKitOptions;
  #store: ChallengeStore;
  readonly network: Network;

  constructor(opts: LoginKitOptions) {
    if (/^(secret-extended-key|zxsk|uivk|usk)/.test(opts.viewingKey)) throw new Error("Give the kit a full viewing key (read-only), never a spending key.");
    const network = networkOfViewingKey(opts.viewingKey);
    if (!network) throw new Error("The site's viewing key must be a unified full viewing key (uview1 or uviewtest1).");
    if (!addressMatchesNetwork(opts.siteAddress, network)) throw new Error("The site's address and viewing key are on different networks.");
    this.#opts = { ...opts };
    this.#store = opts.store ?? new MemoryChallengeStore();
    this.network = network;
  }

  #now(): number {
    return this.#opts.clock ? this.#opts.clock() : Math.floor(Date.now() / 1000);
  }

  /**
   * Make a one-time code. Pass the page's account id (its site key's public half) to reserve the code for it:
   * then only that key can use the code, and someone who merely sees it cannot burn it.
   */
  async newChallenge(accountId?: string): Promise<PublicChallenge> {
    const c = await createChallenge(this.#store, {
      siteId: this.#opts.siteId,
      siteAddress: this.#opts.siteAddress,
      network: this.network,
      ttlSeconds: this.#opts.ttlSeconds,
      minZat: this.#opts.minZat,
      now: this.#now(),
      accountId,
    });
    return {
      nonce: c.nonce,
      siteId: c.siteId,
      siteAddress: c.siteAddress,
      network: c.network,
      expiresAt: c.expiresAt,
      minZat: c.minZat,
      ...(c.accountId !== undefined ? { accountId: c.accountId } : {}),
    };
  }

  /** Check a login payment. `proof` comes from the user's page (buildLoginProof); without it nobody logs in. */
  verify(txHex: string, proof?: string): Promise<LoginSuccess | Failure> {
    return verifyLoginPayment(txHex, this.#opts.viewingKey, this.#store, {
      siteId: this.#opts.siteId,
      siteAddress: this.#opts.siteAddress,
      proof,
      now: this.#now(),
      readTx: this.#opts.readTx,
      log: this.#opts.log,
    });
  }

  toJSON(): string {
    return `[LoginKit ${this.#opts.siteId}]`;
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `[LoginKit ${this.#opts.siteId}]`;
  }
}
