// Share links for the checker page: one link names a round, and opening it re-runs the check in
// the visitor's own browser. Pure functions, so the tests can run them without a page.

export type ShareTarget = { kind: "round" | "external"; id: string };

// Accepts #round=ID, #external=ID, ?round=ID and ?external=ID. The hash wins when both are present.
export function parseShareTarget(search: string, hash: string): ShareTarget | null {
  const fromHash = /^#(round|external)=(.+)$/.exec(hash);
  if (fromHash) return { kind: fromHash[1] as ShareTarget["kind"], id: safeDecode(fromHash[2]) };
  const params = new URLSearchParams(search);
  for (const kind of ["round", "external"] as const) {
    const id = params.get(kind);
    if (id) return { kind, id };
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// The link a reader copies. The base is the checker page address without any query or hash.
export function shareLink(base: string, target: ShareTarget): string {
  const clean = base.split("#")[0].split("?")[0];
  return `${clean}#${target.kind}=${encodeURIComponent(target.id)}`;
}
