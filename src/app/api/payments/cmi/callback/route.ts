/**
 * CMI Payment Callback Handler
 *
 * CMI POSTs payment results here after the customer completes (or fails) payment.
 * We validate the hash and update the settlement queue.
 */

import { NextResponse } from "next/server";
import { b44 } from "@/lib/base44";
import { detectMoroccanPSP } from "@/lib/payments/moroccan-psp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const psp = detectMoroccanPSP();

  if (psp.provider !== "cmi" || !psp.enabled) {
    return NextResponse.json(
      { ok: false, error: "CMI not configured" },
      { status: 503 }
    );
  }

  try {
    const formData = await request.formData();
    const data: Record<string, string> = {};
    formData.forEach((value, key) => {
      data[key] = String(value);
    });

    // Validate hash
    const { CMIClient } = await import("@/lib/payments/cmi");
    const client = new CMIClient({
      merchant_id: process.env.CMI_MERCHANT_ID || "",
      client_id: process.env.CMI_CLIENT_ID || "",
      store_key: process.env.CMI_STORE_KEY || "",
      ok_url: process.env.CMI_OK_URL || "",
      fail_url: process.env.CMI_FAIL_URL || "",
      shop_url: process.env.CMI_SHOP_URL || "",
      callback_url: process.env.CMI_CALLBACK_URL || "",
    });

    const valid = client.validateCallback(
      data as Parameters<CMIClient["validateCallback"]>[0]
    );

    if (!valid) {
      return NextResponse.json(
        { ok: false, error: "Invalid hash" },
        { status: 400 }
      );
    }

    const successful = client.isPaymentSuccessful(
      data as Parameters<CMIClient["isPaymentSuccessful"]>[0]
    );

    // Record in Base44
    try {
      await b44.create("PaymentCallback", {
        provider: "cmi",
        order_id: data.oid || "",
        amount: data.amount || "",
        currency: "MAD",
        status: successful ? "approved" : "declined",
        proc_return_code: data.ProcReturnCode || "",
        response: data.Response || "",
        hash_valid: valid,
        raw_data: JSON.stringify(data),
        received_at: new Date().toISOString(),
      } as never);
    } catch {
      // Non-fatal
    }

    // Update settlement queue
    try {
      const queueItems = await b44.list("SettlementQueue", {
        filter: `order_id="${data.oid}"`,
        limit: 1,
      });

      if (queueItems && queueItems.length > 0) {
        await b44.update("SettlementQueue", queueItems[0].id, {
          status: successful ? "completed" : "failed",
          provider_reference: data.oid || "",
          completed_at: successful ? new Date().toISOString() : undefined,
          error: successful ? "" : `CMI declined: ${data.ProcReturnCode}`,
        } as never);
      }
    } catch {
      // Non-fatal
    }

    return NextResponse.json({
      ok: true,
      successful,
      order_id: data.oid,
      amount: data.amount,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Callback processing failed",
      },
      { status: 500 }
    );
  }
}
