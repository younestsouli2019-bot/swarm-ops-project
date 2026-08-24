"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { LucideIcon } from "lucide-react";

/* ---------- formatters ---------- */

export function fmtUsd(centsOrDollars: number, opts: { fromCents?: boolean } = {}) {
  const v = opts.fromCents ? centsOrDollars / 100 : centsOrDollars;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtNum(n: number) {
  return Number(n || 0).toLocaleString("en-US");
}

export function timeAgo(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

/* ---------- status badges ---------- */

const STATUS_TONE: Record<string, string> = {
  // agents
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  paused: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  stopped: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  // tasks
  pending: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  assigned: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  in_progress: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  handed_off: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  // revenue
  projected: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  confirmed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  paid_out: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  cancelled: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  // mission
  queued: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  deployed: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  // payouts
  draft: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  pending_approval: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  approved: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  processing: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  partially_completed: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  success: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  refunded: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  // workflow
  archived: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  // threshold last_action
  none: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  activated: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

export function StatusBadge({ status, className }: { status?: string; className?: string }) {
  if (!status) return null;
  const tone = STATUS_TONE[status] || "bg-slate-500/15 text-slate-300 border-slate-500/30";
  return (
    <Badge
      variant="outline"
      className={cn("font-mono text-[10px] uppercase tracking-wide", tone, className)}
    >
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

/* ---------- KPI card ---------- */

export function KpiCard({
  label,
  value,
  delta,
  icon: Icon,
  hint,
  accent = "emerald",
}: {
  label: string;
  value: string | number;
  delta?: string;
  icon?: LucideIcon;
  hint?: string;
  accent?: "emerald" | "teal" | "amber" | "rose" | "violet";
}) {
  const accentMap = {
    emerald: "text-emerald-300 bg-emerald-500/10",
    teal: "text-teal-300 bg-teal-500/10",
    amber: "text-amber-300 bg-amber-500/10",
    rose: "text-rose-300 bg-rose-500/10",
    violet: "text-violet-300 bg-violet-500/10",
  };
  return (
    <Card className="bg-card/60 backdrop-blur-sm border-border/60">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            <div className="mt-1.5 text-2xl sm:text-3xl font-semibold tabular-nums truncate">
              {value}
            </div>
            {delta && (
              <div className="mt-1 text-xs text-muted-foreground">{delta}</div>
            )}
          </div>
          {Icon && (
            <div className={cn("rounded-md p-2 shrink-0", accentMap[accent])}>
              <Icon className="h-4 w-4" />
            </div>
          )}
        </div>
        {hint && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="mt-2 text-[10px] text-muted-foreground/70 truncate cursor-help">
                  {hint}
                </div>
              </TooltipTrigger>
              <TooltipContent>{hint}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------- workload bar ---------- */

export function WorkloadBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (current / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <Progress value={pct} className="h-1.5 flex-1" />
      <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
        {current}/{max}
      </span>
    </div>
  );
}

/* ---------- empty state ---------- */

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="text-sm font-medium text-muted-foreground">{title}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

/* ---------- section header ---------- */

export function SectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
      <div>
        <h2 className="text-lg sm:text-xl font-semibold tracking-tight">{title}</h2>
        {subtitle && (
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        )}
      </div>
      {right}
    </div>
  );
}

/* ---------- agent type chip ---------- */

const AGENT_TYPE_TONES: Record<string, string> = {
  data_analyst: "bg-cyan-500/10 text-cyan-300 border-cyan-500/20",
  content_creator: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  research_assistant: "bg-violet-500/10 text-violet-300 border-violet-500/20",
  lead_generator: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  customer_service: "bg-teal-500/10 text-teal-300 border-teal-500/20",
  social_manager: "bg-rose-500/10 text-rose-300 border-rose-500/20",
  listing_bot: "bg-orange-500/10 text-orange-300 border-orange-500/20",
  design_generator: "bg-pink-500/10 text-pink-300 border-pink-500/20",
  seo_specialist: "bg-lime-500/10 text-lime-300 border-lime-500/20",
  workflow_automator: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  devops: "bg-indigo-500/10 text-indigo-300 border-indigo-500/20",
  vision: "bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/20",
  document: "bg-stone-500/10 text-stone-300 border-stone-500/20",
};

export function AgentTypeChip({ type }: { type: string }) {
  const tone = AGENT_TYPE_TONES[type] || "bg-slate-500/10 text-slate-300 border-slate-500/20";
  return (
    <Badge variant="outline" className={cn("text-[10px] font-mono", tone)}>
      {type.replace(/_/g, " ")}
    </Badge>
  );
}
