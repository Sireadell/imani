import { send } from "@/lib/sim-chain";

export const dynamic = "force-dynamic";

// The pretend wallet. Not part of the login kit and not for a real site.
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { uri?: string };
    return Response.json({ ok: true, ...send(String(body.uri ?? "")) });
  } catch (e) {
    return Response.json({ ok: false, message: e instanceof Error ? e.message : "The pretend wallet could not send." }, { status: 400 });
  }
}
