/**
 * PSP Registration API
 *
 * GET  /api/psp-registration — list all registrations + status
 * POST /api/psp-registration — register / confirm / activate
 */

import { NextResponse } from "next/server";
import {
  registerChariBaaS,
  createMerchantWallet,
  confirmOTP,
  setPIN,
  checkBalance,
  testCardDeposit,
  getRegistrations,
} from "@/lib/payments/psp-registration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── GET: Status ────────────────────────────────────────────────────

export async function GET() {
  const registrations = await getRegistrations();

  // Check if ChariBaaS API key is configured
  const hasApiKey = !!process.env.CHARIPAY_API_KEY;
  const hasMerchantPhone = !!process.env.CHARIPAY_MERCHANT_PHONE;

  return NextResponse.json({
    ok: true,
    registrations,
    env: {
      CHARIPAY_API_KEY: hasApiKey ? "configured" : "missing",
      CHARIPAY_MERCHANT_PHONE: hasMerchantPhone ? "configured" : "missing",
    },
    next_steps: hasApiKey
      ? [
          "POST /api/psp-registration with action=create_wallet",
          "POST /api/psp-registration with action=confirm_otp (after OTP received)",
          "POST /api/psp-registration with action=set_pin",
          "POST /api/psp-registration with action=test_deposit",
        ]
      : [
          "Register at https://www.baas.ma/en/api-docs (sandbox access form)",
          "Receive API key via email",
          "Set CHARIPAY_API_KEY on Vercel",
          "POST /api/psp-registration with action=register",
        ],
    timestamp: new Date().toISOString(),
  });
}

// ─── POST: Actions ──────────────────────────────────────────────────

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = body.action;

  switch (action) {
    case "register": {
      const reg = await registerChariBaaS();
      return NextResponse.json({
        ok: true,
        registration: reg,
        timestamp: new Date().toISOString(),
      });
    }

    case "create_wallet": {
      const result = await createMerchantWallet();
      return NextResponse.json({
        ok: result.success,
        ...result,
        timestamp: new Date().toISOString(),
      });
    }

    case "confirm_otp": {
      if (!body.phone || !body.code) {
        return NextResponse.json(
          { ok: false, error: "phone and code required" },
          { status: 400 }
        );
      }
      const result = await confirmOTP(body.phone, body.code);
      return NextResponse.json({
        ok: result.success,
        ...result,
        timestamp: new Date().toISOString(),
      });
    }

    case "set_pin": {
      if (!body.phone || !body.pin) {
        return NextResponse.json(
          { ok: false, error: "phone and pin required" },
          { status: 400 }
        );
      }
      const result = await setPIN(body.phone, body.pin);
      return NextResponse.json({
        ok: result.success,
        ...result,
        timestamp: new Date().toISOString(),
      });
    }

    case "check_balance": {
      const phone = body.phone || process.env.CHARIPAY_MERCHANT_PHONE || "+212600000000";
      const result = await checkBalance(phone);
      return NextResponse.json({
        ok: result.success,
        ...result,
        timestamp: new Date().toISOString(),
      });
    }

    case "test_deposit": {
      const phone = body.phone || process.env.CHARIPAY_MERCHANT_PHONE || "+212600000000";
      const amount = body.amount || 100;
      const result = await testCardDeposit(phone, amount);
      return NextResponse.json({
        ok: result.success,
        ...result,
        timestamp: new Date().toISOString(),
      });
    }

    default:
      return NextResponse.json(
        {
          ok: false,
          error: "Invalid action. Use: register, create_wallet, confirm_otp, set_pin, check_balance, test_deposit",
        },
        { status: 400 }
      );
  }
}
