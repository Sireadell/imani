// What the "check any round" page says before it requests anything. Nothing is fetched until the
// reader presses the button this text goes with. Built from the same server list the fetch code
// uses, so the page can never name one set of servers and use another.
import { DEFAULT_SERVERS, hostOf, type Network } from "../fetch/servers.ts";

export interface AskText {
  button: string;
  body: string;
}

const list = (xs: string[]) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function askText(network: Network, pageHost: string, from: number, to: number): AskText {
  const n = to - from + 1;
  const hosts = [...new Set(DEFAULT_SERVERS[network].map(hostOf))];
  const which = hosts.length === 2 ? `the two public Zcash servers ${list(hosts)}` : `public Zcash servers, two at a time, from this list: ${list(hosts)}`;
  return {
    button: "Yes, contact a public Zcash server and check",
    body:
      `To check this round, the page needs blocks ${from} to ${to} of the Zcash ${network === "test" ? "test" : "main"} network (${n} ${n === 1 ? "block" : "blocks"}). ` +
      `When you press the button, the page sends one request per block to ${pageHost}, the site this page came from. That site fetches the block from ${which}, run by different operators, and passes it back only if both give the same block. ` +
      `Each request says the network and the block number, nothing else. Your key is not sent: it stays in this tab. ` +
      `The site and those servers can see which blocks were asked for, and the site sees your IP address, as any website does. ` +
      `If you would rather send nothing, check from a saved block file instead.`,
  };
}
