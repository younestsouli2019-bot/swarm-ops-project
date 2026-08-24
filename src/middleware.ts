import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const bypass = request.headers.get("x-vercel-protection-bypass");
  if (bypass && bypass === process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET) {
    return NextResponse.next();
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
