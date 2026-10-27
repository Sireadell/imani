import { zcashChallengeRoute, zcashReservedChallengeRoute } from "@sireadell/imani/login";
import { kit } from "@/lib/kit";

export const dynamic = "force-dynamic";
export const GET = zcashChallengeRoute(kit);
// The page asks for a code reserved for its own account id, so nobody can use up a code they only saw.
export const POST = zcashReservedChallengeRoute(kit);
