import { NextResponse } from "next/server";
import { listOpenHITs } from "@/lib/hit-market";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/marketplace/hits?count=N
 * Returns a preview of open HITs from the marketplace feed (no side effects). */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const count = Math.min(
      50,
      Math.max(1, Number(url.searchParams.get("count") || "8"))
    );
    const hits = listOpenHITs(count);
    return NextResponse.json({ hits });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
