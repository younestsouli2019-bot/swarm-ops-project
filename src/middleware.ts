import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const bypass = request.headers.get("x-vercel-protection-bypass");
  if (bypass && bypass === process.env.VERCEL_DEPLOYMENT_BYPASS_SECRET) {
    const response = NextResponse.next();
    response.headers.set("x-vercel-protection-bypass", bypass);
    return response;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
