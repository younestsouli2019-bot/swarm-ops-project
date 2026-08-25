/**
 * Autonomous PSP Registration System
 *
 * Registers the swarm with Moroccan payment providers.
 * ChariBaaS has a sandbox API — we can register and test immediately.
 * CMI/Payzone require business documents — swarm prepares everything, owner signs.
 *
 * Flow:
 *   1. Auto-register with ChariBaaS sandbox (API key from form)
 *   2. Create merchant wallet
 *   3. Complete KYC/KYB
 *   4. Enable card payments
 *   5. Test with sandbox card
 *   6. Promote to production
 */

import { createHash } from "crypto";
import { b44 } from "@/lib/base44";

// ─── Types ──────────────────────────────────────────────────────────

export type PSPRegistrationStatus =
  | "not_started"
  | "sandbox_pending"
  | "sandbox_active"
  | "kyc_pending"
  | "kyc_submitted"
  | "kyc_approved"
  | "production_pending"
  | "production_active"
  | "failed"
  | "owner_action_required";

export interface PSPRegistration {
  id: string;
  provider: "charipay" | "cmi" | "payzone";
  status: PSPRegistrationStatus;
  sandbox_api_key?: string;
  production_api_key?: string;
  merchant_id?: string;
  wallet_phone?: string;
  wallet_iban?: string;
  documents_submitted: string[];
  documents_pending: string[];
  error?: string;
  created_at: string;
  updated_at: string;
  owner_action?: {
    type: string;
    instructions: string;
    deadline?: string;
  };
}

// ─── ChariBaaS Auto-Registration ────────────────────────────────────

const CHARIBAAS_SANDBOX_URL = "https://sandbox.charimoney.com";
const CHARIBAAS_DOCS_URL = "https://www.baas.ma/en/api-docs";

/**
 * Auto-submit sandbox access request to ChariBaaS.
 * In production, this would fill the form at baas.ma.
 * For now, we prepare the request and track status.
 */
export async function registerChariBaaS(): Promise<PSPRegistration> {
  const regId = `PSP-${Date.now().toString(36).toUpperCase()}`;

  const registration: PSPRegistration = {
    id: regId,
    provider: "charipay",
    status: "sandbox_pending",
    documents_submitted: [],
    documents_pending: [
      "business_registration",
      "tax_id",
      "bank_account_proof",
      "identity_document",
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Try to submit sandbox access request
  try {
    const response = await fetch("https://www.baas.ma/api/sandbox-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_name: "HIT Swarm Operations",
        contact_name: "Younes Tsouli",
        email: process.env.OWNER_EMAIL || "younestsouli2019@gmail.com",
        phone: process.env.OWNER_PHONE || "+212600000000",
        website: "https://swarm-ops-project.vercel.app",
        use_case: "Autonomous AI swarm payment settlement",
        volume: "low_initial",
      }),
    });

    if (response.ok) {
      registration.status = "sandbox_pending";
      registration.owner_action = {
        type: "email_confirmation",
        instructions:
          "Check email for ChariBaaS sandbox access confirmation. API key will be provided via secure link.",
        deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      };
    }
  } catch {
    // Form submission may not be available via API
    registration.status = "sandbox_pending";
    registration.owner_action = {
      type: "manual_form_submission",
      instructions: [
        "1. Go to https://www.baas.ma/en/api-docs",
        "2. Scroll to 'Get sandbox access' form",
        "3. Fill in:",
        "   - Company: HIT Swarm Operations",
        "   - Contact: Younes Tsouli",
        "   - Email: younestsouli2019@gmail.com",
        "   - Phone: (your Moroccan number)",
        "   - Use case: Autonomous AI swarm payment settlement",
        "4. Submit form",
        "5. Receive sandbox API key via email",
        `6. Set env var CHARIPAY_API_KEY=<received_key>`,
        "7. Run POST /api/psp-registration with action=activate_sandbox",
      ].join("\n"),
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  // Persist registration
  await persistRegistration(registration);
  return registration;
}

/**
 * Create a merchant wallet on ChariBaaS.
 * Requires sandbox API key.
 */
export async function createMerchantWallet(): Promise<{
  success: boolean;
  phone?: string;
  iban?: string;
  error?: string;
}> {
  const apiKey = process.env.CHARIPAY_API_KEY;
  if (!apiKey) {
    return { success: false, error: "CHARIPAY_API_KEY not set" };
  }

  // Use a test Moroccan phone number for sandbox
  const testPhone = process.env.CHARIPAY_MERCHANT_PHONE || "+212600000000";

  try {
    // Step 1: Check number status
    const statusRes = await fetch(
      `${CHARIBAAS_SANDBOX_URL}/api/customers/status?phoneNumber=${testPhone}`,
      {
        headers: {
          "Chari-Api-Key": apiKey,
          "C-Request-Id": crypto.randomUUID(),
        },
      }
    );

    const statusData = await statusRes.json();

    // Step 2: Register merchant wallet
    if (statusData.data?.status === 0) {
      // Number doesn't exist — register it
      const regRes = await fetch(
        `${CHARIBAAS_SANDBOX_URL}/api/customers/register`,
        {
          method: "POST",
          headers: {
            "Chari-Api-Key": apiKey,
            "C-Request-Id": crypto.randomUUID(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            phoneNumber: testPhone,
            firstName: "HIT",
            lastName: "Swarm",
            cin: "TEST00000",
            walletType: "C", // C = Merchant
          }),
        }
      );

      const regData = await regRes.json();

      if (regData.data === true) {
        return {
          success: true,
          phone: testPhone,
          error: "OTP sent — confirm with POST /api/psp-registration action=confirm_otp",
        };
      }

      return { success: false, error: `Registration failed: ${JSON.stringify(regData)}` };
    }

    if (statusData.data?.status === 3) {
      // Already active — get info
      const infoRes = await fetch(
        `${CHARIBAAS_SANDBOX_URL}/api/customers/info?phoneNumber=${testPhone}`,
        {
          headers: {
            "Chari-Api-Key": apiKey,
            "C-Request-Id": crypto.randomUUID(),
          },
        }
      );

      const infoData = await infoRes.json();
      return {
        success: true,
        phone: testPhone,
        iban: infoData.data?.rib,
      };
    }

    return {
      success: false,
      error: `Number status: ${statusData.data?.status} (${statusData.data?.message})`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Confirm OTP for ChariBaaS registration.
 */
export async function confirmOTP(
  phone: string,
  code: string
): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.CHARIPAY_API_KEY;
  if (!apiKey) {
    return { success: false, error: "CHARIPAY_API_KEY not set" };
  }

  try {
    const res = await fetch(`${CHARIBAAS_SANDBOX_URL}/api/customers/confirm`, {
      method: "POST",
      headers: {
        "Chari-Api-Key": apiKey,
        "C-Request-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phoneNumber: phone, code }),
    });

    const data = await res.json();
    return { success: data.data === true, error: data.data ? undefined : JSON.stringify(data) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Set PIN for wallet activation.
 */
export async function setPIN(
  phone: string,
  pin: string
): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.CHARIPAY_API_KEY;
  if (!apiKey) {
    return { success: false, error: "CHARIPAY_API_KEY not set" };
  }

  try {
    const res = await fetch(`${CHARIBAAS_SANDBOX_URL}/api/customers/pin`, {
      method: "POST",
      headers: {
        "Chari-Api-Key": apiKey,
        "C-Request-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phoneNumber: phone, pin }),
    });

    const data = await res.json();
    return { success: data.data === true, error: data.data ? undefined : JSON.stringify(data) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Check wallet balance.
 */
export async function checkBalance(
  phone: string
): Promise<{ success: boolean; balance?: number; error?: string }> {
  const apiKey = process.env.CHARIPAY_API_KEY;
  if (!apiKey) {
    return { success: false, error: "CHARIPAY_API_KEY not set" };
  }

  try {
    const res = await fetch(
      `${CHARIBAAS_SANDBOX_URL}/api/customers/balance?phoneNumber=${phone}`,
      {
        headers: {
          "Chari-Api-Key": apiKey,
          "C-Request-Id": crypto.randomUUID(),
        },
      }
    );

    const data = await res.json();
    return {
      success: true,
      balance: data.data?.balance,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Test card deposit on ChariBaaS sandbox.
 */
export async function testCardDeposit(
  phone: string,
  amount: number = 100
): Promise<{
  success: boolean;
  redirect?: boolean;
  redirect_url?: string;
  error?: string;
}> {
  const apiKey = process.env.CHARIPAY_API_KEY;
  if (!apiKey) {
    return { success: false, error: "CHARIPAY_API_KEY not set" };
  }

  try {
    const res = await fetch(
      `${CHARIBAAS_SANDBOX_URL}/api/operations/cashin/card?phoneNumber=${phone}`,
      {
        method: "POST",
        headers: {
          "Chari-Api-Key": apiKey,
          "C-Request-Id": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          firstName: "HIT",
          lastName: "Swarm",
          cvv: "123",
          amount,
          pan: "4918914107195005",
          expiryDate: "2608",
          keepAlive: true,
          cardName: "test_card",
        }),
      }
    );

    const data = await res.json();
    return {
      success: true,
      redirect: data.data?.redirect,
      redirect_url: data.data?.redirectionURL,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Preview merchant card payment.
 */
export async function previewMerchantPayment(
  phone: string,
  amount: number
): Promise<{ success: boolean; fees?: number; error?: string }> {
  const apiKey = process.env.CHARIPAY_API_KEY;
  if (!apiKey) {
    return { success: false, error: "CHARIPAY_API_KEY not set" };
  }

  try {
    const res = await fetch(
      `${CHARIBAAS_SANDBOX_URL}/api/operations/merchant/payment/card/preview?phoneNumber=${phone}`,
      {
        method: "POST",
        headers: {
          "Chari-Api-Key": apiKey,
          "C-Request-Id": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount }),
      }
    );

    const data = await res.json();
    return {
      success: true,
      fees: data.data?.feesAmount,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

async function persistRegistration(reg: PSPRegistration): Promise<void> {
  try {
    await b44.create("PSPRegistration", {
      registration_id: reg.id,
      provider: reg.provider,
      status: reg.status,
      merchant_id: reg.merchant_id || "",
      wallet_phone: reg.wallet_phone || "",
      wallet_iban: reg.wallet_iban || "",
      documents_submitted: JSON.stringify(reg.documents_submitted),
      documents_pending: JSON.stringify(reg.documents_pending),
      error: reg.error || "",
      environment: "sandbox",
    } as never);
  } catch {
    // Non-fatal
  }
}

// ─── Get All Registrations ──────────────────────────────────────────

export async function getRegistrations(): Promise<PSPRegistration[]> {
  try {
    const regs = await b44.list("PSPRegistration", { limit: 100 });
    return (regs || []).map((r: Record<string, unknown>) => ({
      id: r.registration_id || r.id,
      provider: r.provider,
      status: r.status,
      sandbox_api_key: r.sandbox_api_key,
      production_api_key: r.production_api_key,
      merchant_id: r.merchant_id,
      wallet_phone: r.wallet_phone,
      wallet_iban: r.wallet_iban,
      documents_submitted: JSON.parse((r.documents_submitted as string) || "[]"),
      documents_pending: JSON.parse((r.documents_pending as string) || "[]"),
      error: r.error,
      created_at: r.created_at || r.createdAt,
      updated_at: r.updated_at || r.updatedAt,
    })) as PSPRegistration[];
  } catch {
    return [];
  }
}
