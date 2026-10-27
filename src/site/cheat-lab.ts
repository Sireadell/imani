// The "Cheat lab" panel: each button re-checks a copy of the real round with one fact changed
// and shows which checks failed. All checking is done by the page's own checker (deps.runExample).
import type { Verdict } from "./engine.ts";

export interface Cheat {
  exampleId: string;
  label: string;
  line: string;
  /** The result line; {failedNames} is filled from the checker's failed check ids. */
  caught: string;
}

export const RESET_LABEL = "Undo the cheat";

export const CHEATS: Cheat[] = [
  {
    exampleId: "testnet-broken/01-hidden-losing-bid",
    label: "Hide a bid",
    line: "The seller drops a losing bid of 1,500,000 zat from the files, so the price can fall.",
    caught: "Caught. The check read every block and found the missing bid ({failedNames}).",
  },
  {
    exampleId: "broken/04-short-refund",
    label: "Short a refund",
    line: "Carol lost and got 1,400,000 back, not her 1,500,000. The seller's file still says 1,500,000.",
    caught: "Caught. The chain shows Carol was paid 100,000 short ({failedNames}).",
  },
  {
    exampleId: "pricing-broken/04-leaves-out-the-lowest-winner",
    label: "Name the wrong winner",
    line: "Carol's 1,500,000 is on the chain but the seller's list leaves it out and raises the price to Bob's bid, 2,000,000.",
    caught: "Caught. The winners don't match the lot's own rules ({failedNames}).",
  },
];

/** The caught line for a verdict, or null when the check did not fail. */
export function caughtLine(cheat: Cheat, verdict: Pick<Verdict, "result" | "failed">): string | null {
  if (verdict.result !== "FAIL" || verdict.failed.length === 0) return null;
  return cheat.caught.replace("{failedNames}", verdict.failed.join(", "));
}

export interface CheatLabDeps {
  runExample(id: string): Pick<Verdict, "result" | "failed">;
}

/** Wire the panel (markup from cheat-lab.html) inside root. */
export function mountCheatLab(root: HTMLElement, deps: CheatLabDeps): void {
  const out = root.querySelector<HTMLElement>(".cheat-result");
  const reset = root.querySelector<HTMLButtonElement>(".cheat-reset");
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-cheat]"));
  if (!out || !reset) return;
  const clear = () => {
    out.textContent = "";
    out.hidden = true;
    reset.hidden = true;
    for (const b of buttons) b.classList.remove("on");
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const cheat = CHEATS.find((c) => c.exampleId === b.dataset.cheat);
      if (!cheat) return;
      const line = caughtLine(cheat, deps.runExample(cheat.exampleId));
      clear();
      if (!line) return;
      b.classList.add("on");
      out.textContent = line;
      out.hidden = false;
      reset.hidden = false;
    });
  }
  reset.addEventListener("click", clear);
  clear();
}
