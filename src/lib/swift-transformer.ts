/**
 * SWIFT MT103 Parser & IBAN-to-RIB Transformer
 *
 * Parses SWIFT MT103 messages and extracts:
 *   - Sender's Reference (Field 20)
 *   - Value Date (Field 30)
 *   - Interbank Settled Amount (Field 32)
 *   - Beneficiary IBAN (Field 59)
 *   - Ordering Customer (Field 50)
 *   - Sender BIC (Field 21)
 *
 * Then converts IBAN to Moroccan RIB format:
 *   Bank Code (5) + Branch Code (5) + Account (11) + Key (2) = 23 digits
 */

export interface ParsedSWIFT {
  message_type: "MT103" | "pacs.008" | "unknown";
  sender_reference: string;
  value_date: string;
  amount: number;
  currency: string;
  beneficiary_iban: string;
  beneficiary_name: string;
  beneficiary_bank_bic: string;
  ordering_customer: string;
  sender_bic: string;
  remittance_info: string;
  raw_fields: Record<string, string>;
}

export interface RIB {
  bank_code: string;       // 5 digits
  branch_code: string;     // 5 digits
  account_number: string;  // 11 characters
  rib_key: string;         // 2 digits
  full_rib: string;        // 23 characters
  iban: string;
  country: string;
}

export interface BatchItem {
  batch_id: string;
  swift_message: ParsedSWIFT;
  rib: RIB;
  status: "parsed" | "validated" | "transformed" | "output_ready" | "error";
  error?: string;
  created_at: string;
}

/**
 * Parse a SWIFT MT103 message into structured data
 */
export function parseMT103(raw: string): ParsedSWIFT {
  const fields: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);

  // Parse SWIFT field tags (e.g., :20:, :32B:, :59:)
  let currentTag = "";
  let currentValue = "";

  for (const line of lines) {
    const tagMatch = line.match(/^:(\d{2}[A-Z]?):(.*?)$/);
    if (tagMatch) {
      if (currentTag) {
        fields[currentTag] = currentValue.trim();
      }
      currentTag = tagMatch[1];
      currentValue = tagMatch[2];
    } else if (currentTag) {
      currentValue += " " + line.trim();
    }
  }
  if (currentTag) {
    fields[currentTag] = currentValue.trim();
  }

  // Extract amount from Field 32B (Amount/Currency)
  let amount = 0;
  let currency = "EUR";
  const amountField = fields["32A"] || fields["32B"] || fields["32"] || "";
  const amountMatch = amountField.match(/([A-Z]{3})([\d,]+\.?\d*)/);
  if (amountMatch) {
    currency = amountMatch[1];
    amount = parseFloat(amountMatch[2].replace(",", "."));
  }

  // Extract beneficiary IBAN from Field 59
  // Field 59 contains: IBAN + name + address on separate lines
  // Extract just the IBAN (first alphanumeric sequence matching IBAN pattern)
  const field59Raw = fields["59"] || fields["59A"] || fields["59F"] || "";
  const ibanMatch = field59Raw.match(/([A-Z]{2}\d{2}[A-Z0-9]{11,34})/i);
  const beneficiaryIBAN = ibanMatch ? ibanMatch[1].toUpperCase() : "";

  // Extract beneficiary name (text after IBAN in field 59)
  const field59Lines = field59Raw.split(/\s{2,}|\n/);
  const beneficiaryName = field59Lines
    .filter((l: string) => !l.match(/^[A-Z]{2}\d{2}[A-Z0-9]/i))
    .map((l: string) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/[^A-Z\s]/gi, "")
    .trim()
    .slice(0, 30);

  return {
    message_type: "MT103",
    sender_reference: fields["20"] || fields["21"] || `MT103-${Date.now()}`,
    value_date: fields["30"] || new Date().toISOString().split("T")[0],
    amount,
    currency,
    beneficiary_iban: beneficiaryIBAN,
    beneficiary_name: beneficiaryName,
    beneficiary_bank_bic: fields["57A"] || fields["57"] || "",
    ordering_customer: fields["50K"] || fields["50A"] || "",
    sender_bic: fields["21"] || "",
    remittance_info: fields["70"] || fields["71A"] || "",
    raw_fields: fields,
  };
}

/**
 * Parse ISO 20022 pacs.008 XML message
 */
export function parsePacs008(xml: string): ParsedSWIFT {
  // Extract key elements via regex (simplified — production would use XML parser)
  const get = (tag: string): string => {
    const match = xml.match(
      new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i")
    );
    return match ? match[1].trim() : "";
  };

  return {
    message_type: "pacs.008",
    sender_reference: get("MsgId") || get("EndToEndId") || `PACS-${Date.now()}`,
    value_date: get("IntrBkSttlmDt") || get("ReqdExctnDt") || "",
    amount: parseFloat(get("InstdAmt") || get("DbtrAmt") || "0"),
    currency: get("InstdAmt")?.match(/[A-Z]{3}/)?.[0] || "EUR",
    beneficiary_iban: get("CdtrAcctId") || get("IBAN") || "",
    beneficiary_name: get("Nm") || "",
    beneficiary_bank_bic: get("BICFI") || get("FinInstnId") || "",
    ordering_customer: get("DbtrNm") || "",
    sender_bic: get("InstgAgt") || "",
    remittance_info: get("AddtlRmtInf") || get("RmtInf") || "",
    raw_fields: {},
  };
}

/**
 * Convert IBAN to Moroccan RIB format
 *
 * Moroccan IBAN: MA + 2 check digits + 5-digit bank code + 5-digit branch + 11-char account
 * Example: MA78 0078 1000 0448 2000 6132 1372
 *          MA 78 00781 00004 482000613213 72
 *          │  │   │     │      │           │
 *          │  │   │     │      │           └─ RIB Key (2)
 *          │  │   │     │      └─ Account Number (11)
 *          │  │   │     └─ Branch Code (5)
 *          │  │   └─ Bank Code (5)
 *          │  └─ Check Digits (2)
 *          └─ Country Code (MA)
 */
export function ibanToRIB(iban: string): RIB {
  // Clean IBAN
  const clean = iban.replace(/\s/g, "").toUpperCase();

  // Validate format
  if (!clean.startsWith("MA")) {
    throw new Error(`Not a Moroccan IBAN: ${iban}`);
  }

  // Remove country code and check digits (first 4 chars)
  const numeric = clean.slice(4);

  if (numeric.length !== 24) {
    throw new Error(`Invalid Moroccan IBAN length: ${clean}`);
  }

  const bankCode = numeric.slice(0, 5);
  const branchCode = numeric.slice(5, 10);
  const accountNumber = numeric.slice(10, 21);
  const ribKey = numeric.slice(21, 23);

  // Calculate RIB key using modulo 97
  // RIB key = 97 - (numeric IBAN mod 97)
  const ibanNumeric =
    numeric.slice(0, 22) + "00"; // Replace key with 00 for calculation
  const mod = bigIntMod(ibanNumeric, 97);
  const calculatedKey = String(97 - mod).padStart(2, "0");

  return {
    bank_code: bankCode,
    branch_code: branchCode,
    account_number: accountNumber,
    rib_key: calculatedKey,
    full_rib: `${bankCode}${branchCode}${accountNumber}${calculatedKey}`,
    iban: clean,
    country: "MA",
  };
}

/**
 * Calculate modulo 97 for large numbers (RIB key calculation)
 */
function bigIntMod(numStr: string, divisor: number): number {
  // Process in chunks to avoid overflow
  let remainder = 0;
  for (let i = 0; i < numStr.length; i++) {
    remainder = (remainder * 10 + parseInt(numStr[i], 10)) % divisor;
  }
  return remainder;
}

/**
 * Validate a Moroccan RIB key
 */
export function validateRIBKey(rib: RIB): boolean {
  const numeric =
    rib.bank_code + rib.branch_code + rib.account_number + "00";
  const mod = bigIntMod(numeric, 97);
  const expected = String(97 - mod).padStart(2, "0");
  return expected === rib.rib_key;
}

/**
 * Format RIB into Moroccan CFONB 120 layout (local clearing format)
 */
export function formatCFONB120(batch: BatchItem[]): string {
  const lines: string[] = [];

  // Header record
  const headerDate = new Date().toISOString().split("T")[0].replace(/-/g, "");
  lines.push(
    `01${headerDate}0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`
  );

  for (const item of batch) {
    if (item.status !== "transformed" || !item.rib) continue;

    const swift = item.swift_message;
    const rib = item.rib;

    // Amount in centimes
    const amountCentimes = String(Math.round(swift.amount * 100)).padStart(
      12,
      "0"
    );

    // Value date YYYYMMDD
    const valueDate = swift.value_date.replace(/-/g, "").slice(0, 8);

    // Reference (20 chars max)
    const ref = swift.sender_reference.slice(0, 20).padEnd(20, " ");

    // Beneficiary name (30 chars)
    const name = swift.beneficiary_name.slice(0, 30).padEnd(30, " ");

    // Detail line (CFONB 120)
    lines.push(
      `03${rib.bank_code}${rib.branch_code}${rib.account_number}${rib.rib_key}000${amountCentimes}${valueDate}${ref}${name}                    `
    );
  }

  // Footer record
  const totalAmount = batch
    .filter((b) => b.status === "transformed" && b.rib)
    .reduce((sum, b) => sum + (b.swift_message.amount || 0), 0);
  const totalCentimes = String(Math.round(totalAmount * 100)).padStart(14, "0");
  const count = String(
    batch.filter((b) => b.status === "transformed" && b.rib).length
  ).padStart(6, "0");

  lines.push(
    `040000000000000000${totalCentimes}${count}0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`
  );

  return lines.join("\n");
}

/**
 * Process a full batch of SWIFT messages
 */
export function processBatch(
  rawMessages: string[],
  batchId: string
): BatchItem[] {
  return rawMessages.map((raw, index) => {
    const id = `${batchId}-${String(index + 1).padStart(3, "0")}`;

    try {
      // Determine message type and parse
      let swift: ParsedSWIFT;
      if (raw.includes("MT103") || raw.match(/^:/)) {
        swift = parseMT103(raw);
      } else if (raw.includes("pacs.008") || raw.includes("<Document")) {
        swift = parsePacs008(raw);
      } else {
        throw new Error("Unrecognized SWIFT message format");
      }

      // Convert IBAN to RIB
      let rib: RIB | undefined;
      if (swift.beneficiary_iban && swift.beneficiary_iban.startsWith("MA")) {
        rib = ibanToRIB(swift.beneficiary_iban);
      } else if (swift.beneficiary_iban) {
        // Non-Moroccan IBAN — try to extract RIB components
        throw new Error(
          `Non-Moroccan IBAN: ${swift.beneficiary_iban}. RIB conversion requires MA prefix.`
        );
      } else {
        throw new Error("No beneficiary IBAN found in SWIFT message");
      }

      return {
        batch_id: id,
        swift_message: swift,
        rib,
        status: "transformed" as const,
        created_at: new Date().toISOString(),
      };
    } catch (err) {
      return {
        batch_id: id,
        swift_message: {
          message_type: "unknown" as const,
          sender_reference: `ERR-${id}`,
          value_date: "",
          amount: 0,
          currency: "EUR",
          beneficiary_iban: "",
          beneficiary_name: "",
          beneficiary_bank_bic: "",
          ordering_customer: "",
          sender_bic: "",
          remittance_info: "",
          raw_fields: {},
        },
        rib: undefined,
        status: "error" as const,
        error: err instanceof Error ? err.message : String(err),
        created_at: new Date().toISOString(),
      };
    }
  });
}

/**
 * Generate reconciliation report for a batch
 */
export function generateReconciliation(batch: BatchItem[]): {
  total_count: number;
  success_count: number;
  error_count: number;
  total_amount: number;
  items: Array<{
    id: string;
    status: string;
    rib?: string;
    amount?: number;
    error?: string;
  }>;
} {
  const success = batch.filter((b) => b.status === "transformed");
  const errors = batch.filter((b) => b.status === "error");

  return {
    total_count: batch.length,
    success_count: success.length,
    error_count: errors.length,
    total_amount: success.reduce(
      (sum, b) => sum + (b.swift_message.amount || 0),
      0
    ),
    items: batch.map((b) => ({
      id: b.batch_id,
      status: b.status,
      rib: b.rib?.full_rib,
      amount: b.swift_message.amount,
      error: b.error,
    })),
  };
}
