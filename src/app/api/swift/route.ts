/**
 * POST /api/swift
 *
 * SWIFT → RIB transformer pipeline.
 *
 * Actions:
 *   - parse: Parse raw MT103/pacs.008 messages
 *   - convert: Convert IBANs to Moroccan RIB format
 *   - batch: Process a full batch with reconciliation
 *   - cfonb: Generate CFONB 120 local clearing format
 *   - demo: Run demo with our 25 settlement batches
 *
 * Flow:
 *   SWIFT Input → Parse → IBAN Extract → RIB Convert → CFONB Output
 */

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { b44 } from "@/lib/base44";
import {
  parseMT103,
  parsePacs008,
  ibanToRIB,
  processBatch,
  generateReconciliation,
  formatCFONB120,
} from "@/lib/swift-transformer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Our known beneficiary IBAN (Morocco)
const MOROCCAN_IBAN = "MA78007810000448200061321372";
const BENEFICIARY_NAME = "YOUNES TSOULI";
const BENEFICIARY_BIC = "BMCEMAMX";

// Demo SWIFT messages for our 25 batches
const DEMO_BATCHES = [
  { id: "PB-REV-003-20260824", amount: 27.0, ref: "ATTIJI-MT7LTTPA-3A7594B0" },
  { id: "PB-REV-002-20260824", amount: 150.0, ref: "ATTIJI-MT7LTU2D-0417926E" },
  { id: "PB-REV-001-20260824", amount: 150.0, ref: "ATTIJI-MT7LTUDA-9DA4918D" },
  { id: "PB-20260824-190017", amount: 400.0, ref: "ATTIJI-MT7JKBKF-C0EC63A7" },
  { id: "PB-SWIFT-20260824-182159", amount: 300.0, ref: "ATTIJI-MT7I72GX-25766AAA" },
  { id: "PB-SWIFT-FINAL-20260824-181641", amount: 500.0, ref: "ATTIJI-MT7LSH3R-728C3F8D" },
  { id: "PB-SWIFT-20260824-181058", amount: 500.0, ref: "ATTIJI-MT7LSHTH-CA6E6F39" },
  { id: "PB-ATTIJARI-AUTO-20260824-175311", amount: 250.0, ref: "ATTIJI-MT7H5Z5B-68E5B9E8" },
  { id: "PB-FINAL-TEST-20260824-173415", amount: 150.0, ref: "ATTIJI-MT7GHNZL-5FA4B4A0" },
  { id: "PB-SANDBOX-TEST-20260824-172015", amount: 100.0, ref: "ATTIJI-MT7G0UN1-49C1AB32" },
  { id: "PB-MT759DO1", amount: 201.58, ref: "ATTIJI-MT7M0S1Y-192D9E9F" },
  { id: "PB-MST846BH", amount: 25.68, ref: "ATTIJI-MT7657Y4-6CAF8AB6" },
  { id: "PB-MST719BU", amount: 26.9, ref: "ATTIJI-MT76589N-A4ED84C4" },
  { id: "PB-MST69HNG", amount: 25.53, ref: "ATTIJI-MT7658JB-E65C5655" },
  { id: "PB-MST5V23C", amount: 27.98, ref: "ATTIJI-MT76591Z-2B91B69F" },
  { id: "PB-MST5GOEI", amount: 42.4, ref: "ATTIJI-MT7659B7-0E8C71BF" },
  { id: "PB-MST4VIIA", amount: 45.71, ref: "ATTIJI-MT7659K5-6B2D6D81" },
  { id: "PB-MST4OM93", amount: 28.59, ref: "ATTIJI-MT7659T6-7DD59334" },
  { id: "PB-MST4HGCU", amount: 41.32, ref: "ATTIJI-MT765A1B-42D80A63" },
  { id: "PB-MST49S2P", amount: 43.02, ref: "ATTIJI-MT765AA9-6BD8A000" },
  { id: "PB-MST436TV", amount: 25.04, ref: "ATTIJI-MT765AKV-046DB004" },
  { id: "PB-MST3XXYD", amount: 26.35, ref: "ATTIJI-MT765B1L-269F4BEE" },
  { id: "PB-MST3SLNJ", amount: 25.7, ref: "ATTIJI-MT765C1U-BDA7DF9A" },
  { id: "PB-MST3OWTH", amount: 26.49, ref: "ATTIJI-MT765CEY-74F50B83" },
  { id: "PB-MST3C5XU", amount: 25.1, ref: "ATTIJI-MT765CO8-4BE468ED" },
];

function generateMT103(b: (typeof DEMO_BATCHES)[0]): string {
  const eurAmount = (b.amount / 10.7).toFixed(2);
  return `:20:${b.ref}
:21:${b.ref}
:23B:CRED
:32A:${new Date().toISOString().slice(0, 10).replace(/-/g, "")}EUR${eurAmount}
:50K:/LU774080000041265646
PAYONEER SWIFT
:59:${MOROCCAN_IBAN}
YOUNES TSOULI
CASA 20000
MOROCCO
:70:${b.id}
:71A:SHA`;
}

/**
 * POST /api/swift
 */
export async function POST(request: Request) {
  let body: {
    action?: string;
    messages?: string[];
    batch_id?: string;
    iban?: string;
  };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const action = body.action || "demo";

  // ─── DEMO: Full pipeline with our 25 batches ───
  if (action === "demo") {
    const rawMessages = DEMO_BATCHES.map(generateMT103);
    const batchId = `BATCH-SWIFT-${Date.now().toString(36).toUpperCase()}`;

    // Step 1: Parse all SWIFT messages
    const parsed = processBatch(rawMessages, batchId);

    // Step 2: Generate reconciliation
    const reconciliation = generateReconciliation(parsed);

    // Step 3: Generate CFONB 120 output
    const cfonb = formatCFONB120(parsed);

    // Step 4: Log to Base44
    try {
      await b44.create("Task", {
        task_id: batchId,
        title: `SWIFT→RIB Batch: ${parsed.length} items`,
        agent_id: "swift-transformer",
        type: "swift_transform",
        status: "output_ready",
        priority: "high",
        description: `Processed ${parsed.length} SWIFT messages. ${reconciliation.success_count} converted to RIB. Total: MAD ${reconciliation.total_amount.toFixed(2)}`,
        metadata: JSON.stringify({
          total: reconciliation.total_count,
          success: reconciliation.success_count,
          errors: reconciliation.error_count,
          total_amount: reconciliation.total_amount,
          cfonb_lines: cfonb.split("\n").length,
        }),
      } as never);
    } catch {
      // Non-fatal
    }

    return NextResponse.json({
      ok: true,
      action: "demo",
      batch_id: batchId,
      pipeline: {
        step_1_parse: {
          status: "complete",
          messages_parsed: parsed.length,
          format: "MT103",
        },
        step_2_rib_convert: {
          status: "complete",
          iban: MOROCCAN_IBAN,
          rib: parsed[0]?.rib?.full_rib || "N/A",
          bank_code: parsed[0]?.rib?.bank_code || "N/A",
          branch_code: parsed[0]?.rib?.branch_code || "N/A",
          account_number: parsed[0]?.rib?.account_number || "N/A",
          rib_key: parsed[0]?.rib?.rib_key || "N/A",
        },
        step_3_reconciliation: reconciliation,
        step_4_cfonb: {
          status: "complete",
          format: "CFONB 120",
          lines: cfonb.split("\n").length,
          preview: cfonb.split("\n").slice(0, 5).join("\n"),
        },
      },
      items: parsed.map((p) => ({
        id: p.batch_id,
        status: p.status,
        amount: p.swift_message.amount,
        currency: p.swift_message.currency,
        iban: p.swift_message.beneficiary_iban,
        rib: p.rib?.full_rib,
        ref: p.swift_message.sender_reference,
        error: p.error,
      })),
    });
  }

  // ─── PARSE: Raw SWIFT messages ───
  if (action === "parse" && body.messages) {
    const batchId = body.batch_id || `PARSE-${Date.now().toString(36).toUpperCase()}`;
    const parsed = processBatch(body.messages, batchId);
    const reconciliation = generateReconciliation(parsed);

    return NextResponse.json({
      ok: true,
      action: "parse",
      batch_id: batchId,
      reconciliation,
      items: parsed,
    });
  }

  // ─── IBAN TO RIB: Single IBAN conversion ───
  if (action === "iban_to_rib" && body.iban) {
    try {
      const rib = ibanToRIB(body.iban);
      return NextResponse.json({
        ok: true,
        action: "iban_to_rib",
        iban: body.iban,
        rib,
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        { status: 400 }
      );
    }
  }

  // ─── CFONB: Generate local clearing format ───
  if (action === "cfonb" && body.messages) {
    const batchId = body.batch_id || `CFONB-${Date.now().toString(36).toUpperCase()}`;
    const parsed = processBatch(body.messages, batchId);
    const cfonb = formatCFONB120(parsed);

    return NextResponse.json({
      ok: true,
      action: "cfonb",
      batch_id: batchId,
      format: "CFONB 120",
      content: cfonb,
      lines: cfonb.split("\n").length,
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: "Invalid action. Use: demo, parse, iban_to_rib, cfonb",
      usage: {
        demo: "POST {action: 'demo'} — run full pipeline with 25 batches",
        parse: "POST {action: 'parse', messages: ['...']} — parse MT103 messages",
        iban_to_rib: "POST {action: 'iban_to_rib', iban: 'MA...'} — convert IBAN to RIB",
        cfonb: "POST {action: 'cfonb', messages: ['...']} — generate CFONB 120 file",
      },
    },
    { status: 400 }
  );
}

/**
 * GET /api/swift — info about the transformer
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    name: "SWIFT → RIB Transformer",
    version: "1.0.0",
    capabilities: [
      "MT103 parsing",
      "pacs.008 (ISO 20022) parsing",
      "Moroccan IBAN to RIB conversion",
      "RIB key validation (modulo 97)",
      "CFONB 120 local clearing format",
      "Batch processing with reconciliation",
    ],
    beneficiary: {
      name: BENEFICIARY_NAME,
      iban: MOROCCAN_IBAN,
      bic: BENEFICIARY_BIC,
    },
    actions: ["demo", "parse", "iban_to_rib", "cfonb"],
  });
}
