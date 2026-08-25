/**
 * CMI (Centre Monétique Interbancaire) Client
 *
 * Morocco's dominant card payment operator.
 * Supports Visa/Mastercard local and international.
 *
 * Flow:
 *   1. Generate hash from order params
 *   2. POST to CMI gateway
 *   3. CMI handles 3D Secure
 *   4. CMI POSTs callback to merchant
 *   5. Validate callback hash
 *
 * Sandbox: https://testpayment.cmi.co.ma/fim/est3Dgate
 * Production: https://payment.cmi.co.ma/fim/est3Dgate
 */

import { createHash, createHmac } from "crypto";

// ─── Config ─────────────────────────────────────────────────────────

export interface CMIConfig {
  merchant_id: string;
  client_id: string;
  store_key: string;
  api_key?: string;
  secret_key?: string;
  sandbox?: boolean;
  base_uri?: string;
  ok_url: string;
  fail_url: string;
  shop_url: string;
  callback_url: string;
  store_type?: string;
  tran_type?: string;
  lang?: string;
  currency?: string;
  hash_algorithm?: string;
}

const CMI_SANDBOX_URI = "https://testpayment.cmi.co.ma/fim/est3Dgate";
const CMI_PRODUCTION_URI = "https://payment.cmi.co.ma/fim/est3Dgate";

// ─── Types ──────────────────────────────────────────────────────────

export interface CMIPaymentRequest {
  amount: number;
  order_id: string;
  email?: string;
  bill_to_name?: string;
  bill_to_company?: string;
  description?: string;
  auto_redirect?: boolean;
}

export interface CMIPaymentResponse {
  gateway_url: string;
  payload: Record<string, string>;
  hash: string;
}

export interface CMICallbackData {
  oid: string;
  amount: string;
  ProcReturnCode: string;
  Response: string;
  hash: string;
  [key: string]: string;
}

// ─── Client ─────────────────────────────────────────────────────────

export class CMIClient {
  private config: CMIConfig;

  constructor(config: Partial<CMIConfig> & Pick<CMIConfig, "merchant_id" | "client_id" | "store_key">) {
    this.config = {
      ok_url: config.ok_url || "",
      fail_url: config.fail_url || "",
      shop_url: config.shop_url || "",
      callback_url: config.callback_url || "",
      sandbox: config.sandbox ?? true,
      store_type: config.store_type || "3D_PAY_HOSTING",
      tran_type: config.tran_type || "PreAuth",
      lang: config.lang || "fr",
      currency: config.currency || "504", // MAD
      hash_algorithm: config.hash_algorithm || "ver3",
      ...config,
    };
  }

  /**
   * Generate a payment request for CMI.
   */
  generatePaymentRequest(request: CMIPaymentRequest): CMIPaymentResponse {
    const gatewayUrl =
      this.config.base_uri ||
      (this.config.sandbox ? CMI_SANDBOX_URI : CMI_PRODUCTION_URI);

    const params: Record<string, string> = {
      clientid: this.config.client_id,
      storekey: this.config.store_key,
      oid: request.order_id,
      amount: request.amount.toFixed(2),
      shopurl: this.config.shop_url,
      okUrl: this.config.ok_url,
      failUrl: this.config.fail_url,
      CallbackURL: this.config.callback_url,
      storetype: this.config.store_type!,
      trantype: this.config.tran_type!,
      lang: this.config.lang!,
      currency: this.config.currency!,
      email: request.email || "",
      BillToName: request.bill_to_name || "",
      BillToCompany: request.bill_to_company || "",
      desc: request.description || "",
    };

    if (request.auto_redirect) {
      params.AutoRedirect = "true";
    }

    const hash = this.generateHash(params);
    params.HASH = hash;

    return {
      gateway_url: gatewayUrl,
      payload: params,
      hash,
    };
  }

  /**
   * Validate a callback from CMI.
   */
  validateCallback(callbackData: CMICallbackData): boolean {
    const receivedHash = callbackData.hash;
    if (!receivedHash) return false;

    // Remove hash from params for validation
    const { hash: _, ...paramsWithoutHash } = callbackData;
    const expectedHash = this.generateHash(paramsWithoutHash);

    return receivedHash === expectedHash;
  }

  /**
   * Check if payment was successful.
   */
  isPaymentSuccessful(callbackData: CMICallbackData): boolean {
    return (
      callbackData.ProcReturnCode === "00" &&
      callbackData.Response === "Approved"
    );
  }

  // ─── Hash Generation ──────────────────────────────────────────

  /**
   * Generate HASH according to CMI algorithm (ver3).
   *
   * Hash algorithm:
   *   1. Concatenate all params as key=value pairs
   *   2. Sign with HMAC-SHA256 using storekey
   *   3. Convert to uppercase hex
   */
  private generateHash(params: Record<string, string>): string {
    const algorithm = this.config.hash_algorithm || "ver3";

    if (algorithm === "ver3") {
      return this.generateHashVer3(params);
    }

    // Fallback: simple HMAC
    const sortedKeys = Object.keys(params).sort();
    const concatenated = sortedKeys
      .filter((k) => params[k] !== undefined && params[k] !== "")
      .map((k) => `${k}=${params[k]}`)
      .join("&");

    return createHmac("sha256", this.config.store_key)
      .update(concatenated)
      .digest("hex")
      .toUpperCase();
  }

  /**
   * CMI ver3 hash algorithm.
   *
   * The hash is computed as:
   *   HMAC-SHA256(storekey, "key1=value1&key2=value2&...")
   *
   * Keys are sorted alphabetically. Empty values are excluded.
   */
  private generateHashVer3(params: Record<string, string>): string {
    const sortedKeys = Object.keys(params).sort();
    const concatenated = sortedKeys
      .filter((k) => params[k] !== undefined && params[k] !== "" && k !== "HASH")
      .map((k) => `${k}=${params[k]}`)
      .join("&");

    return createHmac("sha256", this.config.store_key)
      .update(concatenated)
      .digest("hex")
      .toUpperCase();
  }

  // ─── Server-to-Server API (for automated payouts) ─────────────

  /**
   * Generate API authentication header.
   */
  generateApiKey(): string {
    if (!this.config.api_key) {
      throw new Error("CMI API key not configured");
    }
    return `APIKEY ${this.config.api_key}`;
  }

  /**
   * Build server-to-server request for direct charge.
   * (Requires CMI server API integration — not all merchants have this.)
   */
  buildDirectChargeRequest(params: {
    amount: number;
    currency?: string;
    card_number: string;
    card_expiry: string;
    card_cvv: string;
    order_id: string;
    description?: string;
  }): {
    url: string;
    headers: Record<string, string>;
    body: Record<string, string>;
  } {
    const gatewayUrl =
      this.config.base_uri ||
      (this.config.sandbox ? CMI_SANDBOX_URI : CMI_PRODUCTION_URI);

    return {
      url: `${gatewayUrl}/serverApi`,
      headers: {
        Authorization: this.generateApiKey(),
        "Content-Type": "application/json",
      },
      body: {
        clientid: this.config.client_id,
        storekey: this.config.store_key,
        oid: params.order_id,
        amount: params.amount.toFixed(2),
        currency: params.currency || this.config.currency || "504",
        cardnumber: params.card_number,
        cardexpired: params.card_expiry,
        cardcvc: params.card_cvv,
        trantype: "Auth",
        description: params.description || "",
      },
    };
  }
}

// ─── Factory ────────────────────────────────────────────────────────

export function createCMIClient(): CMIClient {
  const merchantId = process.env.CMI_MERCHANT_ID || "";
  const clientId = process.env.CMI_CLIENT_ID || "";
  const storeKey = process.env.CMI_STORE_KEY || "";

  if (!merchantId || !clientId || !storeKey) {
    throw new Error(
      "CMI credentials not configured. Set CMI_MERCHANT_ID, CMI_CLIENT_ID, CMI_STORE_KEY"
    );
  }

  return new CMIClient({
    merchant_id: merchantId,
    client_id: clientId,
    store_key: storeKey,
    api_key: process.env.CMI_API_KEY,
    secret_key: process.env.CMI_SECRET_KEY,
    sandbox: process.env.CMI_SANDBOX !== "false",
    ok_url: process.env.CMI_OK_URL || "",
    fail_url: process.env.CMI_FAIL_URL || "",
    shop_url: process.env.CMI_SHOP_URL || "",
    callback_url: process.env.CMI_CALLBACK_URL || "",
    store_type: process.env.CMI_STORE_TYPE || "3D_PAY_HOSTING",
    tran_type: process.env.CMI_TRAN_TYPE || "PreAuth",
    lang: process.env.CMI_DEFAULT_LANG || "fr",
    currency: process.env.CMI_DEFAULT_CURRENCY || "504",
    hash_algorithm: process.env.CMI_HASH_ALGORITHM || "ver3",
  });
}
