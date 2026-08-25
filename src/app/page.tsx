"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Download, Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Activity,
  Banknote,
  Bot,
  Brain,
  ChevronRight,
  Cpu,
  FastForward,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Network,
  Rocket,
  ScrollText,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Store,
  WorkflowIcon,
  Zap,
  ArrowRight,
  Wallet,
  CreditCard,
  Package,
  Truck,
  GraduationCap,
  Coins,
  Radio,
  Settings,
  GitBranch,
} from "@/components/swarm/icons";
import { Providers, useSwarmState, useTick, useAutopilot } from "@/components/swarm/providers";
import { DashboardView } from "@/components/swarm/dashboard-view";
import { SwarmView } from "@/components/swarm/swarm-view";
import { MissionsView } from "@/components/swarm/missions-view";
import { PipelineView } from "@/components/swarm/pipeline-view";
import { RevenueView } from "@/components/swarm/revenue-view";
import { PayoutsView } from "@/components/swarm/payouts-view";
import { MarketplaceView } from "@/components/swarm/marketplace-view";
import { WorkflowsView } from "@/components/swarm/workflows-view";
import { ModelsView } from "@/components/swarm/models-view";
import { IntegrityView } from "@/components/swarm/integrity-view";
import { GuardrailsView } from "@/components/swarm/guardrails-view";
import { AgentSafetyView } from "@/components/swarm/agent-safety-view";
import { TokenOptimizerView } from "@/components/swarm/token-optimizer-view";
import { OmnigentView } from "@/components/swarm/omnigent-view";
import { SettlementView } from "@/components/swarm/settlement-view";
import { MoneyFlowView } from "@/components/swarm/money-flow-view";
import { AccountsView } from "@/components/swarm/accounts-view";
import { PaymentsView } from "@/components/swarm/payments-view";
import { ConnectorsView } from "@/components/swarm/connectors-view";
import { OrdersView } from "@/components/swarm/orders-view";
import { ShipmentsView } from "@/components/swarm/shipments-view";
import { AuditView } from "@/components/swarm/audit-view";
import { LearningView } from "@/components/swarm/learning-view";
import { CryptoView } from "@/components/swarm/crypto-view";
import { ExecutionView } from "@/components/swarm/execution-view";
import { SwarmSyncView } from "@/components/swarm/swarm-sync-view";
import { VaultView } from "@/components/swarm/vault-view";
import { DeployView } from "@/components/swarm/deploy-view";
import { ResilienceView } from "@/components/swarm/resilience-view";
import { fmtUsd, timeAgo } from "@/components/swarm/primitives";
import type { LucideIcon } from "lucide-react";

type ViewId =
  | "dashboard"
  | "swarm"
  | "accounts"
  | "payments"
  | "connectors"
  | "orders"
  | "shipments"
  | "procurement"
  | "missions"
  | "pipeline"
  | "revenue"
  | "payouts"
  | "marketplace"
  | "workflows"
  | "models"
  | "integrity"
  | "guardrails"
  | "agent-safety"
  | "token-optimizer"
  | "omnigent"
  | "settlement"
  | "money-flow"
  | "audit"
  | "learning"
  | "crypto"
  | "execution"
  | "swarm-sync"
  | "vault"
  | "deploy"
  | "resilience";

interface NavItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  hint: string;
}

const NAV: NavItem[] = [
  { id: "dashboard", label: "Command Center", icon: LayoutDashboard, hint: "Live KPIs and activity feed" },
  { id: "swarm", label: "Swarm", icon: Bot, hint: "Agents and threshold rules" },
  { id: "accounts", label: "Accounts", icon: Wallet, hint: "Owner bank accounts and balances" },
  { id: "payments", label: "Payments", icon: CreditCard, hint: "Payment routing and history" },
  { id: "connectors", label: "Connectors", icon: Landmark, hint: "Banking and PSP integrations" },
  { id: "orders", label: "Orders", icon: Package, hint: "Purchase orders and fulfillment" },
  { id: "shipments", label: "Shipments", icon: Truck, hint: "Carrier tracking and delivery" },
  { id: "procurement", label: "Procurement", icon: ShieldCheck, hint: "PO fulfillment and SLA tracking" },
  { id: "missions", label: "Missions", icon: Rocket, hint: "Revenue-generation missions" },
  { id: "pipeline", label: "HIT Pipeline", icon: ListChecks, hint: "Tasks dispatched to agents" },
  { id: "revenue", label: "Revenue", icon: Activity, hint: "Streams and event ledger" },
  { id: "payouts", label: "Payouts", icon: Banknote, hint: "Batches, items, recipients" },
  { id: "marketplace", label: "Marketplace", icon: Store, hint: "Open HITs feed" },
  { id: "workflows", label: "Workflows", icon: WorkflowIcon, hint: "Reusable node-graphs" },
  { id: "models", label: "Models", icon: Cpu, hint: "Free-tier AI model registry" },
  { id: "token-optimizer", label: "Token Optimizer", icon: Zap, hint: "Symbol extraction · code analysis · MCP" },
  { id: "omnigent", label: "Omnigent", icon: Brain, hint: "Tiered memory + load balancer" },
  { id: "settlement", label: "Settlement", icon: Landmark, hint: "2PC ledger · three-way match" },
  { id: "money-flow", label: "Money Flow", icon: ArrowRight, hint: "Real-time pipeline · stuck funds" },
  { id: "integrity", label: "Integrity", icon: Shield, hint: "Anti-pattern guard + breach log" },
  { id: "guardrails", label: "Guardrails", icon: ShieldAlert, hint: "Risk-category safeguards" },
  { id: "agent-safety", label: "Agent Safety", icon: ShieldCheck, hint: "Per-capability guardrail bindings" },
  { id: "audit", label: "Audit", icon: ScrollText, hint: "Compliance audit trail" },
  { id: "learning", label: "Learning", icon: GraduationCap, hint: "Swarm learning and rewards" },
  { id: "crypto", label: "Crypto", icon: Coins, hint: "On-chain wallets and USDT" },
  { id: "execution", label: "Execution", icon: Rocket, hint: "Pipeline execution engine" },
  { id: "swarm-sync", label: "Swarm Sync", icon: Radio, hint: "Node synchronization" },
  { id: "vault", label: "Vault", icon: Settings, hint: "Secrets and config management" },
  { id: "deploy", label: "Deploy", icon: GitBranch, hint: "Deployment history" },
  { id: "resilience", label: "Resilience", icon: Zap, hint: "Fault tolerance and recovery" },
];

/**
 * Footer "Download Project ZIP" button.
 *
 * Hits GET /api/download, which streams back a zip of the project source
 * (excluding node_modules, .next, .git, db/, upload/, .env*, *.log, etc.).
 * Uses fetch + blob so we can show a spinner; the browser then saves the
 * blob as `swarm-ops-project.zip` via an object URL.
 */
function DownloadZipButton() {
  const [status, setStatus] = useState<"idle" | "building" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string>("");

  async function handleClick() {
    if (status === "building") return;
    setStatus("building");
    setErrMsg("");
    try {
      const res = await fetch("/api/download", { method: "GET" });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) detail = `${j.error}${j.detail ? ` — ${j.detail}` : ""}`;
        } catch {
          /* response wasn't JSON; keep status code */
        }
        throw new Error(detail);
      }
      const blob = await res.blob();
      // Trigger a browser "Save As" download.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "swarm-ops-project.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on next tick so the download has a chance to start.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("idle");
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
      // Auto-clear the error state after 4s so the button is clickable again.
      setTimeout(() => setStatus("idle"), 4000);
    }
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClick}
            disabled={status === "building"}
            className="h-6 px-2 text-[10px] font-mono gap-1 text-muted-foreground hover:text-foreground"
            aria-label="Download project source as ZIP"
          >
            {status === "building" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            <span className="hidden sm:inline">
              {status === "building"
                ? "Building..."
                : status === "error"
                  ? "Failed"
                  : "Download ZIP"}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-[280px]">
          {status === "error" && errMsg ? (
            <span className="text-rose-300">{errMsg}</span>
          ) : (
            <span>
              Download project source as a ZIP archive
              <br />
              <span className="text-muted-foreground">
                (excludes node_modules, .env, db/, upload/, build artifacts)
              </span>
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Shell() {
  const [view, setView] = useState<ViewId>("dashboard");
  const stateQuery = useSwarmState(true, 8000);
  const autopilot = useAutopilot(12000);
  const tick = useTick();

  const state = stateQuery.data;
  const isLoading = stateQuery.isLoading && !state;
  const isError = stateQuery.isError && !state;
  const kpis = state?.kpis;

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground ops-grid-bg">
      {/* TOP BAR */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur-md">
        <div className="flex items-center gap-3 px-4 sm:px-6 h-14">
          {/* Brand */}
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-md bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Network className="h-4 w-4 text-background" />
            </div>
            <div className="hidden sm:block leading-tight">
              <div className="text-sm font-semibold tracking-tight">
                HIT Swarm <span className="text-muted-foreground font-normal">·</span>{" "}
                <span className="text-muted-foreground font-normal">Autonomous Revenue Engine</span>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono">
                agent-swarm.base44.app
              </div>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {/* Live status */}
            <div className="hidden md:flex items-center gap-2 rounded-md border border-border/60 bg-card/40 px-2.5 py-1">
              <span
                className={
                  "h-2 w-2 rounded-full " +
                  (autopilot.on
                    ? "bg-emerald-400 pulse-dot"
                    : stateQuery.isFetching
                      ? "bg-cyan-400"
                      : "bg-slate-500")
                }
              />
              <span className="text-[11px] font-mono text-muted-foreground">
                {autopilot.on
                  ? `AUTOPILOT · ${autopilot.isTicking ? "ticking" : "idle"}`
                  : `LIVE · ${timeAgo(state?.generatedAt)}`}
              </span>
            </div>

            {/* Revenue ticker */}
            {kpis && (
              <div className="hidden lg:flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1">
                <Zap className="h-3 w-3 text-emerald-300" />
                <span className="text-[11px] font-mono text-emerald-300 tabular-nums">
                  {fmtUsd(kpis.confirmedRevenue + kpis.paidOutRevenue)} earned
                </span>
              </div>
            )}

            {/* Autopilot toggle */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/40 px-2.5 py-1">
                    <Sparkles className="h-3 w-3 text-amber-300" />
                    <span className="text-[11px] font-mono text-muted-foreground hidden sm:inline">
                      Autopilot
                    </span>
                    <Switch
                      checked={autopilot.on}
                      onCheckedChange={autopilot.setOn}
                      className="scale-90"
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  When ON, the orchestrator runs a full cycle every 6s: ingest HITs → dispatch → process → payout → enforce thresholds.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Manual tick */}
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={autopilot.on || tick.isPending}
              onClick={() => tick.mutate()}
            >
              <FastForward className="h-3.5 w-3.5 mr-1" />
              {tick.isPending ? "Ticking…" : "Run tick"}
            </Button>
          </div>
        </div>
      </header>

      {/* BODY: SIDEBAR + CONTENT */}
      <div className="flex-1 flex">
        {/* Sidebar */}
        <aside className="hidden sm:flex flex-col w-56 shrink-0 border-r border-border/60 bg-card/30">
          <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto slim-scroll">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={
                    "w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors " +
                    (active
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/40 border border-transparent")
                  }
                >
                  <Icon className={"h-4 w-4 shrink-0 " + (active ? "text-primary" : "")} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">{item.label}</div>
                    <div className="text-[9px] text-muted-foreground/70 truncate">
                      {item.hint}
                    </div>
                  </div>
                  {active && <ChevronRight className="h-3 w-3 text-primary shrink-0" />}
                </button>
              );
            })}
          </nav>
          <div className="p-3 border-t border-border/40">
            <div className="rounded-md border border-border/40 bg-background/40 p-2.5">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1.5">
                <span>Last tick</span>
                <span className="font-mono">
                  {autopilot.lastReport
                    ? `+${fmtUsd(autopilot.lastReport.revenue_cents, { fromCents: true })}`
                    : "—"}
                </span>
              </div>
              {autopilot.lastReport ? (
                <div className="space-y-1 text-[10px] font-mono text-muted-foreground">
                  <div className="flex justify-between">
                    <span>ingested</span>
                    <span>{autopilot.lastReport.ingested}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>dispatched</span>
                    <span>{autopilot.lastReport.dispatched}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>completed</span>
                    <span>{autopilot.lastReport.completed}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>handoffs</span>
                    <span>{autopilot.lastReport.handoffs}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>payout</span>
                    <span>{autopilot.lastReport.payout_swept ? "swept" : "—"}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground/70">
                    <span>elapsed</span>
                    <span>{autopilot.lastReport.elapsed_ms}ms</span>
                  </div>
                </div>
              ) : (
                <div className="text-[10px] text-muted-foreground/60">
                  No tick yet — hit{" "}
                  <span className="font-mono text-foreground/80">Run tick</span> or
                  flip autopilot on.
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* Mobile nav */}
        <div className="sm:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border/60 bg-background/95 backdrop-blur-md">
          <div className="grid grid-cols-15 gap-px">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={
                    "flex flex-col items-center justify-center py-2 " +
                    (active ? "text-primary" : "text-muted-foreground")
                  }
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-[8px] mt-0.5 truncate max-w-full px-0.5">
                    {item.label.split(" ")[0]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Main content */}
        <main className="flex-1 min-w-0 p-4 sm:p-6 pb-24 sm:pb-6">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <div className="text-sm text-muted-foreground">
                Connecting to agent swarm…
              </div>
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
              <div className="h-10 w-10 rounded-full bg-rose-500/15 text-rose-300 flex items-center justify-center">
                <Zap className="h-5 w-5" />
              </div>
              <div className="text-sm font-medium">Couldn't reach the swarm API</div>
              <div className="text-xs text-muted-foreground max-w-md">
                {(stateQuery.error as Error)?.message ||
                  "Check that Base44 is reachable and the API key is valid."}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => stateQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : !state ? null : (
            <>
              {/* Mobile view selector */}
              <div className="sm:hidden mb-4 flex items-center gap-2 overflow-x-auto slim-scroll">
                {NAV.map((item) => {
                  const active = view === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setView(item.id)}
                      className={
                        "shrink-0 rounded-full px-3 py-1 text-xs font-medium " +
                        (active
                          ? "bg-primary text-primary-foreground"
                          : "bg-card/60 text-muted-foreground")
                      }
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              {view === "dashboard" && (
                <DashboardView
                  state={state}
                  lastTick={autopilot.lastReport ?? tick.data}
                  autopilotOn={autopilot.on}
                />
              )}
              {view === "swarm" && <SwarmView state={state} />}
              {view === "accounts" && <AccountsView />}
              {view === "payments" && <PaymentsView />}
              {view === "connectors" && <ConnectorsView />}
              {view === "orders" && <OrdersView />}
              {view === "shipments" && <ShipmentsView />}
              {view === "procurement" && <PayoutsView state={state} />}
              {view === "missions" && <MissionsView state={state} />}
              {view === "pipeline" && <PipelineView state={state} />}
              {view === "revenue" && <RevenueView state={state} />}
              {view === "payouts" && <PayoutsView state={state} />}
              {view === "marketplace" && <MarketplaceView />}
              {view === "workflows" && <WorkflowsView state={state} />}
              {view === "models" && <ModelsView />}
              {view === "integrity" && <IntegrityView />}
              {view === "guardrails" && <GuardrailsView />}
              {view === "agent-safety" && <AgentSafetyView />}
              {view === "token-optimizer" && <TokenOptimizerView />}
              {view === "omnigent" && <OmnigentView />}
              {view === "settlement" && <SettlementView />}
              {view === "money-flow" && <MoneyFlowView />}
              {view === "audit" && <AuditView />}
              {view === "learning" && <LearningView />}
              {view === "crypto" && <CryptoView />}
              {view === "execution" && <ExecutionView />}
              {view === "swarm-sync" && <SwarmSyncView />}
              {view === "vault" && <VaultView />}
              {view === "deploy" && <DeployView />}
              {view === "resilience" && <ResilienceView />}
            </>
          )}
        </main>
      </div>

      {/* FOOTER */}
      <footer className="mt-auto border-t border-border/60 bg-background/85 backdrop-blur-md">
        <div className="px-4 sm:px-6 py-2.5 flex items-center justify-between gap-2 flex-wrap text-[10px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="text-[9px] font-mono bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
            >
              v1.0
            </Badge>
            <span className="font-mono">
              swarm ops · {kpis ? `${kpis.activeAgents}/${kpis.totalAgents} agents` : "—"}
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono">
            <span>API: agent-swarm-efe0bd7e.base44.app</span>
            <Separator orientation="vertical" className="h-3" />
            <span>
              {autopilot.on
                ? `autopilot @ 6s`
                : `manual · refetch 4s`}
            </span>
            <Separator orientation="vertical" className="h-3" />
            <span>{timeAgo(state?.generatedAt)}</span>
            <Separator orientation="vertical" className="h-3" />
            <DownloadZipButton />
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function Home() {
  return (
    <Providers>
      <Shell />
    </Providers>
  );
}
