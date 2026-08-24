"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  FileCheck,
  Fingerprint,
  Landmark,
  Loader2,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  Truck,
  XCircle,
  Zap,
} from "lucide-react";
import {
  EmptyState,
  KpiCard,
  SectionHeader,
  StatusBadge,
  fmtUsd,
  timeAgo,
} from "./primitives";

// ─── types (mirror of server-side) ───────────────────────────────────────

type SettlementState =
  | "SPECULATIVE"
  | "PENDING_SETTLEMENT"
  | "SETTLED"
  | "CANCELLED"
  | "FAILED";

type POState =
  | "Draft_Speculative"
  | "Supplier_Acknowledged"
  | "Shipment_Pending"
  | "In_Transit"
  | "Received_Verified"
  | "Cancelled"
  | "Failed";

interface LedgerEntry {
  id: string;
  external_ref: string;
  kind: "revenue" | "procurement" | "payout";
  state: SettlementState;
  amount_cents: number;
  currency: string;
  counterparty_id: string;
  initiator_agent_id: string;
  oracle_id: string | null;
  prepare_token: string | null;
  receipt_hash: string | null;
  rail: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  last_transition_reason: string | null;
}

interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_id: string;
  procuring_agent_id: string;
  line_items: Array<{
    sku: string;
    description: string;
    quantity_ordered: number;
    unit_price_cents: number;
  }>;
  total_cents: number;
  currency: string;
  state: POState;
  created_at: number;
  updated_at: number;
  last_transition_reason: string | null;
  tracking_number: string | null;
  carrier: string | null;
  last_carrier_scan: unknown;
  three_way_match: unknown;
  settlement_entry_id: string | null;
  metadata?: Record<string, unknown>;
}

interface SettlementStats {
  total_entries: number;
  by_state: Record<SettlementState, number>;
  by_kind: Record<string, number>;
  settled_amount_cents: number;
  pending_amount_cents: number;
  speculative_amount_cents: number;
  entries_with_receipt: number;
  prepares_completed: number;
  commits_completed: number;
  oracle_rejections: number;
  cancels: number;
  oldest_pending_age_seconds: number;
}

interface ProcurementStats {
  total_pos: number;
  by_state: Record<POState, number>;
  active_pos: number;
  pipeline_pos: number;
  total_active_value_cents: number;
  total_pipeline_value_cents: number;
  three_way_matches_passed: number;
  three_way_matches_failed: number;
  carrier_scans_received: number;
  iot_attestations_received: number;
  self_asserted_tokens_stripped: number;
  total_invoices: number;
  total_receipts: number;
}

interface OracleHealth {
  id: string;
  kind: "settlement" | "logistics";
  rail: string;
  healthy: boolean;
  last_check_at: number | null;
  last_check_ok: boolean;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  avg_latency_ms: number;
}

interface AuditFinding {
  severity: "info" | "warning" | "critical";
  entry_id: string;
  external_ref: string;
  issue: string;
  detail?: string;
}

interface SettlementViewStateData {
  stats: SettlementStats;
  procurement_stats: ProcurementStats;
  active_operations_balance: {
    total_cents: number;
    by_kind: Record<string, number>;
    entry_count: number;
    has_any_receipt: boolean;
  };
  pipeline_balance: {
    speculative_cents: number;
    pending_cents: number;
    entry_count: number;
  };
  oracles: OracleHealth[];
  oracle_call_log: Array<{
    id: string;
    ts: number;
    oracle_id: string;
    kind: string;
    rail: string;
    external_ref: string | null;
    success: boolean;
    latency_ms: number;
    reason: string;
    stripped_tokens: string[];
  }>;
  audit_findings: AuditFinding[];
  oracle_audit_findings: Array<{
    severity: "info" | "warning" | "critical";
    oracle_id: string;
    issue: string;
    detail?: string;
  }>;
  tolerances: { amount_pct: number; quantity_pct: number };
  entries_recent: LedgerEntry[];
  pos_recent: PurchaseOrder[];
  hard_rule: {
    active_operations_balance_cents: number;
    has_any_receipt: boolean;
    note: string;
  };
}

// ─── state colors ────────────────────────────────────────────────────────

const STATE_TONE: Record<SettlementState, string> = {
  SPECULATIVE: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  PENDING_SETTLEMENT: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  SETTLED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  CANCELLED: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  FAILED: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

const PO_STATE_TONE: Record<POState, string> = {
  Draft_Speculative: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  Supplier_Acknowledged: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  Shipment_Pending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  In_Transit: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  Received_Verified: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  Cancelled: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  Failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

function StateBadge({ state }: { state: SettlementState | POState }) {
  const tone =
    state in STATE_TONE
      ? STATE_TONE[state as SettlementState]
      : PO_STATE_TONE[state as POState];
  return (
    <Badge
      variant="outline"
      className={`font-mono text-[9px] uppercase tracking-wide ${tone}`}
    >
      {String(state).replace(/_/g, " ")}
    </Badge>
  );
}

function fmtCents(cents: number) {
  return fmtUsd(cents, { fromCents: true });
}

// ─── main view ───────────────────────────────────────────────────────────

export function SettlementView() {
  const [data, setData] = useState<SettlementViewStateData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/settlement-ledger", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SettlementViewStateData;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
  }, []);

  async function runAction(action: string, payload: Record<string, unknown> = {}) {
    setActionPending(action);
    try {
      await fetch("/api/settlement-ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      await refresh();
    } finally {
      setActionPending(null);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <div className="text-sm text-muted-foreground">
          Loading settlement ledger…
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
        <AlertTriangle className="h-8 w-8 text-rose-300" />
        <div className="text-sm font-medium">Couldn't load the settlement ledger</div>
        <div className="text-xs text-muted-foreground max-w-md">{error}</div>
        <Button size="sm" variant="outline" onClick={refresh}>
          <RefreshCw className="h-3 w-3 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  const hasReceipt = data.active_operations_balance.has_any_receipt;
  const settledCents = data.active_operations_balance.total_cents;

  return (
    <div className="space-y-6">
      {/* ─── HARD-RULE BANNER ─── */}
      <Card
        className={
          hasReceipt
            ? "bg-emerald-500/5 border-emerald-500/30"
            : "bg-rose-500/5 border-rose-500/30"
        }
      >
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {hasReceipt ? (
              <ShieldCheck className="h-5 w-5 text-emerald-300 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-rose-300 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">
                {hasReceipt
                  ? "Active Operations balance reflects cryptographically-settled entries only"
                  : "HARD RULE: Active Operations balance is $0.00 — no entry carries a receipt_hash"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {data.hard_rule.note}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-2xl font-mono font-semibold tabular-nums">
                {fmtCents(settledCents)}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                settled balance
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── KPI ROW (Active Ops vs Pipeline) ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Cryptographically Settled"
          value={fmtCents(settledCents)}
          delta={`${data.stats.entries_with_receipt} entries with receipt_hash`}
          icon={Fingerprint}
          accent="emerald"
        />
        <KpiCard
          label="Pending Settlement"
          value={fmtCents(data.pipeline_balance.pending_cents)}
          delta={`${data.stats.by_state.PENDING_SETTLEMENT} entries · oldest ${data.stats.oldest_pending_age_seconds}s`}
          icon={Clock}
          accent="amber"
        />
        <KpiCard
          label="Speculative (zero weight)"
          value={fmtCents(data.pipeline_balance.speculative_cents)}
          delta={`${data.stats.by_state.SPECULATIVE} entries · pipeline analytics only`}
          icon={AlertTriangle}
          accent="rose"
        />
        <KpiCard
          label="2PC prepares / commits"
          value={`${data.stats.prepares_completed} / ${data.stats.commits_completed}`}
          delta={`${data.stats.oracle_rejections} oracle rejections · ${data.stats.cancels} cancels`}
          icon={Zap}
          accent="violet"
        />
      </div>

      {/* ─── PROCUREMENT KPI ROW ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          label="Procurement Active"
          value={data.procurement_stats.active_pos}
          delta={`${fmtCents(data.procurement_stats.total_active_value_cents)} in transit + received`}
          icon={Truck}
          accent="teal"
        />
        <KpiCard
          label="Procurement Pipeline"
          value={data.procurement_stats.pipeline_pos}
          delta={`${fmtCents(data.procurement_stats.total_pipeline_value_cents)} draft + ack + ship_pending`}
          icon={PackageCheck}
          accent="amber"
        />
        <KpiCard
          label="3-Way Matches"
          value={`${data.procurement_stats.three_way_matches_passed}/${data.procurement_stats.three_way_matches_passed + data.procurement_stats.three_way_matches_failed}`}
          delta={`${data.procurement_stats.three_way_matches_failed} failed · ${data.procurement_stats.iot_attestations_received} IoT attestations`}
          icon={FileCheck}
          accent="emerald"
        />
        <KpiCard
          label="Ingress Stripped Tokens"
          value={data.procurement_stats.self_asserted_tokens_stripped}
          delta={`${data.procurement_stats.carrier_scans_received} carrier scans · zero-trust verified`}
          icon={ShieldCheck}
          accent="violet"
        />
      </div>

      {/* ─── TWO-PANE: ACTIVE OPS + PIPELINE ANALYTICS ─── */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* ACTIVE OPERATIONS — settled only */}
        <Card className="bg-card/60 border-emerald-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              Active Operations
              <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                Settled only · receipt_hash required
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="h-[360px] slim-scroll">
              {data.entries_recent.filter((e) => e.state === "SETTLED").length === 0 ? (
                <EmptyState
                  title="No cryptographically-settled entries"
                  hint="Hard rule: Active Operations balance is $0.00 until an oracle provides a receipt_hash."
                />
              ) : (
                <ul className="space-y-1.5">
                  {data.entries_recent
                    .filter((e) => e.state === "SETTLED")
                    .map((e) => (
                      <EntryRow key={e.id} entry={e} />
                    ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* PIPELINE ANALYTICS — speculative + pending */}
        <Card className="bg-card/60 border-amber-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-300" />
              Pipeline Analytics
              <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                Speculative + Pending_Settlement · zero economic weight
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="h-[360px] slim-scroll">
              {data.entries_recent.filter((e) => e.state === "SPECULATIVE" || e.state === "PENDING_SETTLEMENT").length === 0 ? (
                <EmptyState
                  title="No pipeline entries"
                  hint="Speculative and Pending_Settlement entries will appear here."
                />
              ) : (
                <ul className="space-y-1.5">
                  {data.entries_recent
                    .filter(
                      (e) =>
                        e.state === "SPECULATIVE" ||
                        e.state === "PENDING_SETTLEMENT"
                    )
                    .map((e) => (
                      <EntryRow key={e.id} entry={e} />
                    ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* ─── PROCUREMENT PO LIFECYCLE ─── */}
      <SectionHeader
        title="Procurement PO lifecycle"
        subtitle="Zero-trust carrier tracking · Three-way match · IoT-attested receipt verification"
      />
      <Card className="bg-card/60">
        <CardContent className="p-0">
          <ScrollArea className="max-h-[480px] slim-scroll">
            {data.pos_recent.length === 0 ? (
              <EmptyState
                title="No purchase orders yet"
                hint="Run a tick to start the procurement flow — POs will appear here as Draft_Speculative."
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card/95 backdrop-blur-sm">
                  <tr className="text-left text-[10px] uppercase text-muted-foreground border-b border-border/40">
                    <th className="py-2 px-3">PO Number</th>
                    <th className="py-2 px-3">Supplier</th>
                    <th className="py-2 px-3">Total</th>
                    <th className="py-2 px-3">State</th>
                    <th className="py-2 px-3">Carrier / Tracking</th>
                    <th className="py-2 px-3">3-Way Match</th>
                    <th className="py-2 px-3">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pos_recent.map((po) => {
                    const twm = po.three_way_match as
                      | { matched?: boolean; within_tolerance?: boolean; line_findings?: unknown[] }
                      | null;
                    return (
                      <tr
                        key={po.id}
                        className="border-b border-border/20 hover:bg-background/30"
                      >
                        <td className="py-2 px-3 font-mono text-xs">
                          {po.po_number}
                          <div className="text-[9px] text-muted-foreground">
                            {po.line_items.length} line(s)
                          </div>
                        </td>
                        <td className="py-2 px-3 text-xs truncate max-w-[140px]">
                          {po.supplier_id}
                        </td>
                        <td className="py-2 px-3 font-mono text-emerald-300">
                          {fmtCents(po.total_cents)}
                        </td>
                        <td className="py-2 px-3">
                          <StateBadge state={po.state} />
                        </td>
                        <td className="py-2 px-3 text-[10px] font-mono">
                          {po.carrier ? (
                            <>
                              <div className="text-foreground">{po.carrier.toUpperCase()}</div>
                              <div className="text-muted-foreground">{po.tracking_number}</div>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {twm ? (
                            <Badge
                              variant="outline"
                              className={`text-[9px] font-mono ${
                                twm.matched && twm.within_tolerance
                                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                  : "bg-rose-500/15 text-rose-300 border-rose-500/30"
                              }`}
                            >
                              {twm.matched && twm.within_tolerance ? "MATCHED" : "FAILED"}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-[10px]">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-[10px] text-muted-foreground whitespace-nowrap">
                          {timeAgo(new Date(po.updated_at).toISOString())}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* ─── ORACLE HEALTH + CALL LOG ─── */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Landmark className="h-4 w-4 text-cyan-300" />
              Oracle registry
              <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                {data.oracles.length} oracles · {data.oracles.filter((o) => o.healthy).length} healthy
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="h-[260px] slim-scroll">
              <ul className="space-y-1.5">
                {data.oracles.map((o) => (
                  <li
                    key={o.id}
                    className="flex items-center gap-2 rounded-md border border-border/40 bg-background/30 px-3 py-2"
                  >
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${
                        o.healthy ? "bg-emerald-400" : "bg-rose-400"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-mono truncate">{o.id}</span>
                        <Badge
                          variant="outline"
                          className={`text-[9px] font-mono ${
                            o.kind === "settlement"
                              ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/30"
                              : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                          }`}
                        >
                          {o.kind}
                        </Badge>
                        <Badge variant="outline" className="text-[9px] font-mono">
                          {o.rail}
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground font-mono">
                        {o.total_calls} calls · {o.successful_calls} ok · {o.failed_calls} fail · avg {o.avg_latency_ms}ms
                      </div>
                    </div>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[10px]"
                            disabled={actionPending === `health_${o.id}`}
                            onClick={() =>
                              runAction("set_oracle_health", {
                                id: o.id,
                                healthy: !o.healthy,
                              })
                            }
                          >
                            {o.healthy ? "Disable" : "Enable"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Toggle oracle health (simulates taking the rail offline)
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="bg-card/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4 text-violet-300" />
              Oracle call log
              <span className="ml-auto text-[10px] text-muted-foreground font-normal">
                last 50 calls
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="h-[260px] slim-scroll">
              {data.oracle_call_log.length === 0 ? (
                <EmptyState
                  title="No oracle calls yet"
                  hint="Oracle calls will appear here when revenue events flow through 2PC."
                />
              ) : (
                <ul className="space-y-1">
                  {data.oracle_call_log.map((log) => (
                    <li
                      key={log.id}
                      className="flex items-start gap-2 rounded-md border border-border/40 bg-background/30 px-2.5 py-1.5"
                    >
                      {log.success ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-300 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="h-3 w-3 text-rose-300 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-mono truncate">
                          <span className="text-muted-foreground">{log.oracle_id}</span>
                          {" · "}
                          <span className="text-foreground">{log.rail}</span>
                          {log.external_ref && (
                            <>
                              {" · "}
                              <span className="text-muted-foreground">{log.external_ref}</span>
                            </>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {log.reason}
                        </div>
                        {log.stripped_tokens.length > 0 && (
                          <div className="text-[9px] text-amber-300 font-mono mt-0.5">
                            stripped: {log.stripped_tokens.join(", ")}
                          </div>
                        )}
                      </div>
                      <div className="text-[9px] text-muted-foreground shrink-0">
                        {timeAgo(new Date(log.ts).toISOString())}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* ─── AUDIT FINDINGS ─── */}
      <SectionHeader
        title="Audit findings"
        subtitle="Schema violations · SLA breaches · tamper-evidence checks"
        right={
          <Button
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />
      <Card className="bg-card/60">
        <CardContent className="p-0">
          <ScrollArea className="max-h-[280px] slim-scroll">
            {data.audit_findings.length === 0 && data.oracle_audit_findings.length === 0 ? (
              <EmptyState
                title="No audit findings"
                hint="All ledger entries pass schema, SLA, and tamper-evidence checks."
              />
            ) : (
              <ul className="divide-y divide-border/30">
                {[...data.audit_findings, ...data.oracle_audit_findings].map((f, i) => (
                  <li key={i} className="px-3 py-2 flex items-start gap-2">
                    <Badge
                      variant="outline"
                      className={`text-[9px] font-mono shrink-0 ${
                        f.severity === "critical"
                          ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                          : f.severity === "warning"
                            ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                            : "bg-slate-500/15 text-slate-300 border-slate-500/30"
                      }`}
                    >
                      {f.severity}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium">
                        {"oracle_id" in f ? f.oracle_id : f.external_ref}
                      </div>
                      <div className="text-[11px] text-muted-foreground">{f.issue}</div>
                      {"detail" in f && f.detail && (
                        <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                          {f.detail}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── entry row ───────────────────────────────────────────────────────────

function EntryRow({ entry }: { entry: LedgerEntry }) {
  const meta = entry.metadata as { agent_name?: string; hit_id?: string; marketplace?: string };
  return (
    <li className="rounded-md border border-border/40 bg-background/30 px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <StateBadge state={entry.state} />
        <Badge variant="outline" className="text-[9px] font-mono">
          {entry.kind}
        </Badge>
        {entry.rail && (
          <Badge variant="outline" className="text-[9px] font-mono">
            {entry.rail}
          </Badge>
        )}
        <span className="ml-auto font-mono text-sm text-emerald-300 tabular-nums">
          {fmtCents(entry.amount_cents)}
        </span>
      </div>
      <div className="mt-1 text-[11px] font-mono text-muted-foreground truncate">
        {entry.external_ref}
        {meta.agent_name && <span> · agent: {meta.agent_name}</span>}
        {meta.marketplace && <span> · {meta.marketplace}</span>}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground/70 truncate">
        {entry.last_transition_reason}
      </div>
      {entry.receipt_hash && (
        <div className="mt-1 flex items-center gap-1 text-[10px] font-mono text-emerald-300">
          <Fingerprint className="h-3 w-3" />
          <span className="truncate">{entry.receipt_hash}</span>
        </div>
      )}
      {entry.prepare_token && !entry.receipt_hash && (
        <div className="mt-1 flex items-center gap-1 text-[10px] font-mono text-amber-300">
          <Clock className="h-3 w-3" />
          <span className="truncate">prepare_token: {entry.prepare_token.slice(0, 16)}…</span>
        </div>
      )}
    </li>
  );
}
