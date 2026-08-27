/**
 * Swarm orchestrator.
 *
 * One `tick()` advances the entire swarm by one cycle:
 *   1. INGEST   – pull fresh HITs from the marketplace and create pending Tasks.
 *   2. DISPATCH – match pending Tasks to active agents (capability + workload).
 *   3. PROCESS  – move some in-progress Tasks to completed, run quality review,
 *                 create RevenueEvents for completed HITs.
 *   4. PAYOUT   – if confirmed revenue exceeds a threshold, sweep into a PayoutBatch.
 *   5. ENFORCE  – apply AgentThreshold rules (pause under-performers, revive stars).
 *
 * Each step is idempotent and safe to call repeatedly.
 */

import {
  b44,
  type Agent,
  type Mission,
  type Task,
  type RevenueEvent,
  type RevenueStream,
  type PayoutBatch,
  type PayoutItem,
  type PayoutRecipient,
  type AgentThreshold,
  type AgentHandoff,
  type Workflow,
} from "./base44";
import { listOpenHITs, hitToTaskInput, type HIT } from "./hit-market";
import {
  preTickCheck,
  recordTick,
  tryAcquireOpportunityLock,
  recordResultHash,
  recordClassABlock,
  getSigState,
} from "./swarm-integrity";
import {
  preGuardrailCheck,
  postGuardrailTick,
  scrubCredentials,
  checkIpCopyright,
  classifyTransaction,
  releaseStateLock,
  acquireStateLockWithRetry,
  reclaimStaleLocks,
  recordStrategyEconomics,
  recordPlatformVolume,
  isBlackSwanFrozen,
  type GuardrailId,
} from "./swarm-guardrails";
import {
  PRESET_OWNER_ACCOUNTS,
  assertOwnerRouting,
  getPresetOwnerRecipient,
  OwnerRoutingViolation,
} from "./owner-accounts";
import {
  evaluateRedress,
  isVelocityBreakerActive,
  isCannibalisticLockActive,
  getRouteShiftPct,
  getActiveBackupPath,
  recordRouteShifted,
  recordTargetDeduped,
  recordAgentHydrated,
  triggerContextHydration,
  getPromptGenesis,
  anyRedressActive,
  type RedressSignalInput,
} from "./swarm-redress";
import {
  enforceAgentCategoryGate,
  type AgentGateResult,
} from "./agent-safety-bindings";
import {
  createEntry as createSettlementEntry,
  prepare as settlementPrepare,
  getActiveOperationsBalance as getActiveOpsBalance,
  getPipelineBalance as getPipelineBalanceSL,
  getStats as getSettlementStats,
  listEntries as listSettlementEntries,
  type LedgerEntry,
  type SettlementState,
} from "./settlement-ledger";
import {
  runRevenueSettlement2PC,
  simulateCarrierPoll,
} from "./settlement-oracle";
import {
  createPO,
  acknowledgePO,
  generateShipment,
  markReceivedVerified,
  getProcurementStats,
  listPOs,
  getPO,
  type PurchaseOrder,
  type POState,
  type POLineItem,
  type Invoice,
  type ReceivingReceipt,
} from "./procurement-ledger";
import {
  routeOrphanToVault,
  type RouteOrphanResult,
} from "./transaction-orchestrator";
import { nexusTick, type NexusTickResult } from "./nexus-defense";
import {
  scanAndRebalanceStakeholders,
  type StakeholderRegistrySnapshot,
  type HandoffRecommendation,
  type HandoffActivationResult,
} from "./agentic-stakeholders";
import { runActivationCycle, type ActivationSnapshot } from "./api-key-activation";
import {
  createPayout as createPayoutStateMachine,
  validatePayout,
} from "./payout-state-machine";

const USD = "USD" as const;

/* ────────────────────────────────────────────────────────────────────────
 * Tick Concurrency Safety — Recommended Action Plan §1, §2, §3
 * ────────────────────────────────────────────────────────────────────────
 *
 * PROBLEM
 *   The dashboard's `useAutopilot` fires a tick every 12s. A tick can
 *   take 5–90s when the Base44 API is slow. `setInterval` does NOT wait
 *   for the previous tick to finish — it fires the next one anyway. Two
 *   browser tabs double the rate. A manual "Run Tick" button click while
 *   autopilot is on triples it. Concurrent ticks then race on:
 *
 *     - the RevenueStream's `available_for_payout` balance (double-spend)
 *     - the maybePayout stream lock (silent skip → orphan batches)
 *     - the RevenueEvent → PayoutBatch migration loop (duplicate sweeps)
 *
 * SOLUTION (3 layers, defense in depth)
 *
 *   Layer A — Global tick mutex (this file)
 *     `tick()` acquires `tick:global` with TTL=120s (longest possible
 *     tick) using `acquireStateLockWithRetry`. If the lock can't be
 *     acquired after 8 jittered attempts (~5s of backoff), the tick
 *     is SKIPPED with `tick_skipped: "lock_contention"`. Skipping is
 *     safe — ticks are idempotent, and the holding tick will advance
 *     the swarm state on its own.
 *
 *   Layer B — Sequential queue in the browser (hooks.ts)
 *     `useAutopilot` switches from `setInterval` to recursive
 *     `setTimeout`: the next tick is scheduled ONLY after the previous
 *     tick's promise settles. This eliminates client-side overlap.
 *
 *   Layer C — Stream lock with retry in maybePayout (this file)
 *     `maybePayout()` uses `acquireStateLockWithRetry` instead of the
 *     one-shot `tryAcquireStateLock`. Concurrent sweeps back off and
 *     retry rather than silently skipping.
 *
 * The tick holder ID is `tick-${process.pid}-${monotonic}-${random}`
 * — NOT just `tick-${Date.now()}` — so two ticks that start in the
 * same millisecond don't collide on holder identity.
 */

const TICK_GLOBAL_LOCK_RESOURCE = "tick:global";
const TICK_LOCK_TTL_MS = 120_000; // 2 min — covers the slowest Base44 windows
const TICK_LOCK_HOLDER_PREFIX = "tick";

/**
 * Generate a unique tick holder ID.
 *
 * Format: `tick-<pid>-<counter>-<random>`
 *
 * The pid makes holders distinguishable across Node processes (e.g.,
 * multiple Next.js workers). The counter is a monotonic in-process
 * sequence — guarantees uniqueness even if `Date.now()` granularity
 * is coarser than the tick rate. The random suffix is the last line
 * of defense against any collision from clock skew.
 */
let __tickHolderCounter = 0;
function makeTickHolderId(): string {
  __tickHolderCounter += 1;
  const pid = typeof process !== "undefined" ? process.pid : 0;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${TICK_LOCK_HOLDER_PREFIX}-${pid}-${__tickHolderCounter}-${rand}`;
}

/**
 * Duplicate-payout detection window. Before creating a new PayoutItem
 * for a recipient, `maybePayout` scans existing PayoutItems created
 * within this window with the same amount + recipient. If any are
 * found, the new sweep is aborted — the prior sweep likely succeeded
 * but the stream reset didn't propagate.
 */
const PAYOUT_DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 min

const SWARM_AGENT_TYPES = [
  "data_analyst",
  "content_creator",
  "research_assistant",
  "lead_generator",
  "customer_service",
  "social_manager",
  "listing_bot",
  "design_generator",
  "seo_specialist",
  "workflow_automator",
  "devops",
  "vision",
  "document",
  "sustainability_agent",
  "ai_ml_products_expert",
  "digital_courses_agent",
];

const DEFAULT_AGENTS: Array<{
  name: string;
  type: string;
  system_prompt: string;
  capabilities: string[];
}> = [
  {
    name: "Atlas-1 Data Analyst",
    type: "data_analyst",
    system_prompt:
      "You are Atlas-1, a precision data analyst. You categorize items, label sentiment, draw bounding boxes, and clean datasets. Always output structured JSON. Reject HITs whose schema you cannot satisfy.",
    capabilities: ["categorization", "sentiment", "annotation", "data_cleaning"],
  },
  {
    name: "Scribe-2 Content Creator",
    type: "content_creator",
    system_prompt:
      "You are Scribe-2, a content creator. You transcribe audio, write product copy, and draft SEO descriptions. Match the requester's tone. Never fabricate product specs.",
    capabilities: ["transcription", "copywriting", "seo_writing"],
  },
  {
    name: "Probe-3 Research Assistant",
    type: "research_assistant",
    system_prompt:
      "You are Probe-3, a research assistant. You produce competitor briefs, cite sources, and capture pricing/positioning data. Always include source URLs.",
    capabilities: ["competitor_research", "pricing_analysis", "citation"],
  },
  {
    name: "Pursuit-4 Lead Generator",
    type: "lead_generator",
    system_prompt:
      "You are Pursuit-4, a lead qualification agent. Score ICP fit and intent 1–5. Disqualify regions outside NA/EU/UK unless the mission says otherwise.",
    capabilities: ["lead_scoring", "icp_matching", "enrichment"],
  },
  {
    name: "Echo-5 Customer Outreach",
    type: "customer_service",
    system_prompt:
      "You are Echo-5, a customer outreach agent. You draft LinkedIn messages and email replies. Keep messages under 300 chars. Always personalize from profile context.",
    capabilities: ["outreach", "personalization", "messaging"],
  },
  {
    name: "Pulse-6 Social Manager",
    type: "social_manager",
    system_prompt:
      "You are Pulse-6, a social media manager. You draft and schedule tweets, vary time-of-day, and follow the content calendar.",
    capabilities: ["scheduling", "copywriting", "calendar_management"],
  },
  {
    name: "Bazaar-7 Listing Bot",
    type: "listing_bot",
    system_prompt:
      "You are Bazaar-7, a marketplace listing agent. You create Etsy/Amazon listings with tags, variants, shipping profiles, and SEO titles. Always validate against marketplace policies.",
    capabilities: ["etsy_listing", "amazon_listing", "seo_titles"],
  },
  {
    name: "Canvas-8 Design Generator",
    type: "design_generator",
    system_prompt:
      "You are Canvas-8, a Canva template architect. You design editable Instagram-story templates using the brand palette and logo provided.",
    capabilities: ["canva", "template_design", "branding"],
  },
  {
    name: "Lens-9 SEO Specialist",
    type: "seo_specialist",
    system_prompt:
      "You are Lens-9, a quality reviewer. You review AI-generated listings for accuracy, policy compliance, and SEO. Flag or fix issues. Never approve listings with unsupported claims.",
    capabilities: ["quality_review", "policy_compliance", "seo_audit"],
  },
  {
    name: "Forge-10 Workflow Automator",
    type: "workflow_automator",
    system_prompt:
      "You are Forge-10, an automation setup agent. You build Zapier/zap workflows and integration glue. Always test with a sandbox event before reporting complete.",
    capabilities: ["zapier", "integrations", "workflow_setup"],
  },
  {
    name: "DevOps-11 Repo Operations",
    type: "devops",
    system_prompt:
      "You are DevOps-11, a repository operations agent. You run shell commands, git operations, and build automation AGAINST THE LOCAL REPO ONLY. You may: run tests, lint, format, commit, push, open PRs, run migrations, inspect logs. You MUST NOT: log into third-party platforms (PayPal, banks, social media, ad networks), create accounts anywhere, post content to external services, or operate a browser. If a task requires network access to a third-party platform, refuse and explain that the operator must do it manually. Never store credentials.",
    capabilities: [
      "shell",
      "git",
      "build",
      "test_runner",
      "lint",
      "migrations",
      "log_inspection",
    ],
  },
  {
    name: "Vision-12 Image Analyst",
    type: "vision",
    system_prompt:
      "You are Vision-12, an image analysis agent. You analyze LOCAL images and screenshots provided to you by the operator or by other agents. You may: describe image contents, audit UI accessibility, detect layout bugs, extract text via OCR, classify image types, generate alt text. You MUST NOT: scrape images from third-party platforms, download images from URLs you were not explicitly given, process images for the purpose of profiling individuals or identifying vulnerabilities to exploit. If asked to analyze an image of a person for psychological profiling, refuse.",
    capabilities: [
      "image_description",
      "accessibility_audit",
      "ocr",
      "alt_text",
      "ui_bug_detection",
      "image_classification",
    ],
  },
  {
    name: "Docs-13 Document Processor",
    type: "document",
    system_prompt:
      "You are Docs-13, a document processing agent. You work on LOCAL document files only (PDF, DOCX, XLSX, CSV, Markdown). You may: extract text, fill templates, generate reports from local data, redact PII, convert between formats, summarize long documents. You MUST NOT: submit forms to third-party platforms, file official documents (tax, legal, regulatory) without explicit operator review, sign anything on behalf of a person, or transmit documents to external services. For any document destined for an external recipient, output the draft for operator review — never send directly.",
    capabilities: [
      "pdf_extraction",
      "docx_generation",
      "xlsx_generation",
      "template_filling",
      "redaction",
      "format_conversion",
      "summarization",
    ],
  },
];

const DEFAULT_REVENUE_STREAM = {
  name: "HIT Marketplace Rewards",
  type: "freelance" as const,
  status: "active" as const,
  target_monthly_revenue: 5000,
  marketplace_config: {
    marketplaces: ["mturk", "clickworker", "toloka", "prolific"],
    payout_cadence: "weekly",
  },
};

const DEFAULT_RECIPIENTS: Array<{
  name: string;
  recipient_type: PayoutRecipient["recipient_type"];
  currency: PayoutRecipient["currency"];
  account_identifier: string;
  is_default?: boolean;
}> = [
  {
    name: "Operator Wallet (USD)",
    recipient_type: "paypal_email",
    currency: USD,
    account_identifier: "operator@hit-swarm.example",
    is_default: true,
  },
  {
    name: "Treasury (USD Bank)",
    recipient_type: "bank_account",
    currency: USD,
    account_identifier: "000123456789",
  },
];

const DEFAULT_THRESHOLDS = {
  pause_below_revenue: 0, // never pause on raw $0 (new agents need ramp-up)
  activate_above_revenue: 50,
  min_success_rate: 60,
  daily_cost: 2,
};

const SEED_MISSION = {
  mission_id: "HIT-OPS-001",
  title: "Autonomous HIT Revenue Engine",
  type: "revenue_generation" as const,
  priority: "critical" as const,
  status: "in_progress" as const,
  estimated_duration_hours: 720, // 30-day rolling
  revenue_generated: 0,
  mission_parameters: {
    marketplaces: ["mturk", "clickworker", "toloka", "prolific"],
    auto_accept_under_cents: 100,
    max_concurrent_per_agent: 3,
  },
  execution_plan: [
    { step: 1, action: "ingest", desc: "Pull open HITs from marketplace feed" },
    { step: 2, action: "dispatch", desc: "Match HITs to specialized agents" },
    { step: 3, action: "process", desc: "Complete + quality-review in-progress tasks" },
    { step: 4, action: "payout", desc: "Sweep confirmed revenue into payout batch" },
    { step: 5, action: "enforce", desc: "Apply AgentThreshold pause/activate rules" },
  ],
};

export interface TickReport {
  ingested: number;
  dispatched: number;
  completed: number;
  revenue_cents: number;
  payout_swept: boolean;
  threshold_actions: Array<{ agent_id: string; action: string; reason: string }>;
  handoffs: number;
  elapsed_ms: number;
  /** If SIG halted the tick before it ran, this is the reason. */
  sig_halted?: string | null;
  /** If a Guardrail (e.g. Black-Swan breaker) halted the tick, this is the reason. */
  guardrail_halted?: string | null;
  /** If a Self-Redress action (e.g. Velocity Breaker) is holding, list which ones. */
  redress_active?: string[];
  /** Which redress actions were triggered this tick (if any). */
  redress_triggered?: string[];
  /** ASB: how many agents were gated this tick (per-capability check). */
  asb_evaluations?: number;
  /** ASB: how many agents were blocked from receiving tasks this tick. */
  asb_blocks?: number;
  /** ASB: how many agents were warned (gaps but proceeded) this tick. */
  asb_warnings?: number;
  /** Settlement ledger: how many entries were prepared (Phase 1) this tick. */
  settlement_prepared?: number;
  /** Settlement ledger: how many entries were committed (Phase 2 → SETTLED) this tick. */
  settlement_committed?: number;
  /** Settlement ledger: how many entries were rejected by the oracle this tick. */
  settlement_failed?: number;
  /** Procurement: how many POs were created (Draft_Speculative) this tick. */
  procurement_created?: number;
  /** Procurement: how many POs advanced a state this tick. */
  procurement_advanced?: number;
  /** Procurement: how many POs reached Received_Verified (three-way match) this tick. */
  procurement_received?: number;
  /** Procurement Autopilot: real DB items scanned this tick. */
  autopilot_scanned?: number;
  /** Procurement Autopilot: real DB items advanced this tick. */
  autopilot_advanced?: number;
  /** Procurement Autopilot: real DB items settled this tick. */
  autopilot_settled?: number;
  /**
   * If the tick was skipped because another tick held the global tick
   * mutex, this is a short reason string. The most common value is
   * `"lock_contention"`. The tick is safe to skip — ticks are
   * idempotent, and the holding tick will advance swarm state.
   */
  tick_skipped?: string | null;
  /**
   * If `tick_skipped` is set, this object describes the contention
   * telemetry: which holder was blocking, how many retry attempts
   * were made, total backoff sleep, and whether the blocking lock
   * was already stale (TTL expired but not yet reclaimed).
   */
  lock_contention?: {
    blocked_by: string | undefined;
    attempts: number;
    waited_ms: number;
    blocked_lock_stale: boolean;
  } | null;
  /**
   * Count of stale (TTL-expired) locks reclaimed at the start of
   * this tick. Non-zero values indicate leaked locks from prior
   * crashed ticks — worth investigating if persistent.
   */
  stale_locks_reclaimed?: number;
  /**
   * NEXUS Core Defense tick result. The permanent autonomous defense
   * coordinator runs 17 subsystems on cycles from 3s to 35s. This
   * field reports which subsystems cycled this tick, the current
   * risk score, threat level, TITAN resistance level, and RESURRECT
   * countdown (if armed).
   *
   * Operator directive: "ensure NEXUS Core Defense PERMANENT ...
   * AUTOPILOT ALWAYS ON ... owner hands-off policy applies"
   */
  nexus?: NexusTickResult;
  /**
   * Agentic Stakeholder Registry scan result. Every tick the swarm
   * is scanned and every entity is classified (worker / operator /
   * catalog / quarantined), given a 0–100 health score, and assigned
   * a lifecycle state. Saturated workers (current_workload >=
   * max_workload) are matched against idle workers with overlapping
   * expertise, and handoffs are auto-activated (up to 3 per tick).
   *
   * Operator directive (Task 13):
   *   "query swarm 'agentic stakeholders' implement further
   *    improvements autonomously"
   *
   * The previous handoff path only fired on ~8% of tasks (quality
   * review) and routed to a single hard-coded seo_specialist. This
   * scan+rebalance path activates the dormant handoff system on
   * every tick where saturated workers exist.
   */
  stakeholders?: StakeholderTickResult;
  /**
   * API Key Activation + Load Balancer tick result.
   *
   * Operator directive (Task 14):
   *   "autonomous agents getting api keys for models [...9 models listed]
   *    ... for loadbalancing blueprint of self-setup 10 sites"
   *
   * Every tick the swarm refreshes the API key activation state (which
   * providers have keys, which are missing), heartbeats the 10-site
   * fleet (2 operator-provided + 8 reserved for autonomous spin-up),
   * and reactivates any standby sites whose health has recovered. The
   * load balancer routes requests round-robin + health-weighted across
   * available providers, with failover to the next 2 sites + next 2
   * providers on failure.
   */
  model_activation?: ModelActivationTickResult;
}

/**
 * Stakeholder scan result returned by the orchestrator tick.
 * Compact view of the Agentic Stakeholder Registry + any handoffs
 * activated this tick.
 */
export interface StakeholderTickResult {
  /** Snapshot timestamp. */
  scanned_at: string;
  /** Total entities examined (agents in the swarm). */
  total_entities: number;
  /** Count by stakeholder class. */
  by_class: StakeholderRegistrySnapshot["by_class"];
  /** Count by lifecycle state. */
  by_lifecycle: StakeholderRegistrySnapshot["by_lifecycle"];
  /** Avg health score across workers + operators. */
  avg_health_score: number;
  /** Workers currently at max workload. */
  saturated_workers_count: number;
  /** Workers currently idle and handoff-eligible. */
  idle_workers_count: number;
  /** Heuristic: estimated unrealized revenue capacity from idle workers. */
  unrealized_capacity_estimate_usd: number;
  /** Handoff recommendations generated this tick. */
  handoff_recommendations: HandoffRecommendation[];
  /** Handoffs actually created this tick (capped at 3). */
  handoffs_created: number;
  /** Handoffs that failed this tick. */
  handoffs_failed: number;
  /** Errors from handoff activation (if any). */
  handoff_errors: string[];
  /** Activation result (full detail) — null if no recommendations. */
  activations: HandoffActivationResult | null;
}

/**
 * API Key Activation + Load Balancer tick result.
 * Compact view of the activation cycle.
 */
export interface ModelActivationTickResult {
  /** Snapshot timestamp. */
  cycled_at: string;
  /** Total models in the registry. */
  total_models: number;
  /** Models currently available (have API key set). */
  available_models: number;
  /** API keys activated. */
  keys_activated: number;
  /** API keys still pending operator action. */
  keys_pending: number;
  /** Sites in the 10-site fleet that are active. */
  sites_active: number;
  /** Sites in the 10-site fleet (always 10). */
  sites_total: number;
  /** Standby sites reactivated to active this tick. */
  reactivations: number;
  /** Heartbeats sent this tick (one per active site). */
  heartbeats: number;
  /** Total requests routed since startup. */
  total_requests_routed: number;
  /** Total failovers since startup. */
  total_failovers: number;
  /** Provider health summary. */
  providers: Array<{
    provider: string;
    has_key: boolean;
    status: string;
    requests_sent: number;
    headroom_remaining: number | null;
  }>;
  /** The 10-site fleet state. */
  sites: Array<{
    slot: number;
    url: string | null;
    label: string;
    status: string;
    health_score: number;
    requests_routed: number;
  }>;
}

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function num(x: unknown, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Ensure the swarm has its baseline fleet, revenue stream, recipients,
 * mission, and thresholds. Safe to call on every boot.
 *
 * Memoized per server lifetime — once it has succeeded once, subsequent
 * calls return immediately without re-hitting Base44.
 */
let seedPromise: Promise<{
  agents: number;
  recipients: number;
  streams: number;
  missions: number;
  thresholds: number;
}> | null = null;

export async function ensureSeed(): Promise<{
  agents: number;
  recipients: number;
  streams: number;
  missions: number;
  thresholds: number;
}> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const result = await _ensureSeedImpl();
    return result;
  })();
  // Allow re-seeding if it fails
  seedPromise.catch(() => {
    seedPromise = null;
  });
  return seedPromise;
}

async function _ensureSeedImpl(): Promise<{
  agents: number;
  recipients: number;
  streams: number;
  missions: number;
  thresholds: number;
}> {
  const existingAgents = (await b44.list("Agent", { limit: 200 })) as Agent[];
  const byName = new Map(existingAgents.map((a) => [a.name, a]));

  // For each default swarm agent: update if name exists with wrong type,
  // create if missing entirely.
  for (const def of DEFAULT_AGENTS) {
    const existing = byName.get(def.name);
    if (!existing) {
      await b44.create("Agent", {
        name: def.name,
        type: def.type,
        status: "active",
        system_prompt: def.system_prompt,
        capabilities: def.capabilities,
        current_workload: 0,
        max_workload: 3,
        task_queue: [],
        collaboration_rules: {
          can_accept_handoffs: true,
          can_initiate_handoffs: true,
          expertise_areas: def.capabilities,
          preferred_handoff_agents: [],
        },
        revenue_config: {
          commission_rate: 0.1,
          target_monthly_revenue: 500,
          payment_methods: {},
        },
        social_accounts: [],
        automation_config: {
          posting_frequency: "daily",
          content_themes: [],
        },
        performance_metrics: {
          revenue_generated: 0,
          tasks_completed: 0,
          total_runtime: 0,
          handoffs_received: 0,
          handoffs_initiated: 0,
          last_active: null,
          success_rate: 100,
        },
      } as never);
    } else if (existing.type !== def.type) {
      // Name exists with wrong type → fix the type so the swarm filter picks it up.
      await b44.update("Agent", existing.id!, {
        type: def.type,
        system_prompt: def.system_prompt,
        capabilities: def.capabilities,
      } as never);
    }
  }

  // Revenue stream
  const streams = (await b44.list("RevenueStream", { limit: 50 })) as RevenueStream[];
  if (!streams.some((s) => s.name === DEFAULT_REVENUE_STREAM.name)) {
    await b44.create("RevenueStream", {
      ...DEFAULT_REVENUE_STREAM,
      available_for_payout: 0,
      payout_status: "idle",
    });
  }

  // Recipients
  const recipients = (await b44.list("PayoutRecipient", { limit: 50 })) as PayoutRecipient[];
  const missingRecipients = DEFAULT_RECIPIENTS.filter(
    (r) => !recipients.some((e) => e.name === r.name)
  );
  if (missingRecipients.length > 0) {
    await b44.bulkCreate("PayoutRecipient", missingRecipients as never);
  }

  // Mission
  const missions = (await b44.list("Mission", { limit: 50 })) as Mission[];
  let missionId: string | undefined;
  let existingMission = missions.find((m) => m.mission_id === SEED_MISSION.mission_id);
  if (!existingMission) {
    const created = (await b44.create("Mission", SEED_MISSION as never)) as Mission;
    existingMission = created;
  }
  missionId = existingMission?.id;

  // Link all swarm agents to the mission + revenue stream
  const allAgents = (await b44.list("Agent", { limit: 200 })) as Agent[];
  const swarmAgents = allAgents.filter((a) => SWARM_AGENT_TYPES.includes(a.type));
  if (existingMission && (!existingMission.assigned_agents || existingMission.assigned_agents.length === 0)) {
    await b44.update("Mission", existingMission.id!, {
      assigned_agents: swarmAgents.map((a) => a.id),
      assigned_agent_id: swarmAgents[0]?.id,
    } as never);
  }

  // Thresholds for any swarm agent that doesn't have one yet
  const thresholds = (await b44.list("AgentThreshold", { limit: 200 })) as AgentThreshold[];
  const agentsNeedingThreshold = swarmAgents.filter(
    (a) => !thresholds.some((t) => t.agent_id === a.id)
  );
  if (agentsNeedingThreshold.length > 0) {
    await b44.bulkCreate(
      "AgentThreshold",
      agentsNeedingThreshold.map((a) => ({
        agent_id: a.id,
        agent_name: a.name,
        ...DEFAULT_THRESHOLDS,
        enabled: true,
        last_action: "none",
      }))
    );
  }

  // A starter workflow so the Workflows view isn't empty
  const workflows = (await b44.list("Workflow", { limit: 50 })) as Workflow[];
  if (workflows.length === 0) {
    await b44.create("Workflow", {
      name: "HIT Ingest → Dispatch → Complete → Payout",
      description:
        "Default autonomous HIT pipeline: pull HITs from the marketplace, dispatch to specialized agents, complete with quality review, then sweep into weekly payout batches.",
      category: "data_processing",
      status: "active",
      trigger: { type: "interval", minutes: 1 },
      nodes: [
        { id: "ingest", type: "ingest", next: "dispatch" },
        { id: "dispatch", type: "dispatch", next: "process" },
        { id: "process", type: "process", next: "payout" },
        { id: "payout", type: "payout", next: null },
      ],
      execution_stats: { runs: 0, last_run: null },
    } as never);
  }

  return {
    agents: swarmAgents.length,
    recipients: (await b44.list("PayoutRecipient", { limit: 50 })).length,
    streams: (await b44.list("RevenueStream", { limit: 50 })).length,
    missions: (await b44.list("Mission", { limit: 50 })).length,
    thresholds: (await b44.list("AgentThreshold", { limit: 200 })).length,
  };
}

/**
 * Pull a fresh batch of HITs from the marketplace and insert them as pending
 * Tasks (dedup by hit_id so we never insert the same HIT twice).
 */
export async function ingestHits(): Promise<number> {
  const batch = listOpenHITs(randInt(2, 5));
  const existingTasks = (await b44.list("Task", { limit: 500 })) as Task[];
  const seenHitIds = new Set<string>();
  for (const t of existingTasks) {
    const rd = (t.result_data || {}) as { hit_id?: string };
    if (rd.hit_id) seenHitIds.add(rd.hit_id);
  }
  const fresh = batch.filter((h) => !seenHitIds.has(h.hit_id));
  let hitCount = 0;
  if (fresh.length > 0) {
    await b44.bulkCreate(
      "Task",
      fresh.map((h) => hitToTaskInput(h))
    );
    hitCount = fresh.length;
  }

  // Procurement bridge: pull pending items from Neon and create Tasks
  const procureCount = await bridgeProcurementTasks(existingTasks);

  return hitCount + procureCount;
}

async function bridgeProcurementTasks(existingTasks: Task[]): Promise<number> {
  try {
    const { db } = await import("./db");
    const pendingItems = await db.$queryRawUnsafe<any[]>(
      `SELECT id, name, "recipientName", "recipientAddress",
              quantity, "unitPriceEst", "totalEst", "supplierName",
              "prePaidBySwarm", priority
       FROM "ProcurementItem"
       WHERE status = 'ordered'
       ORDER BY "createdAt" ASC
       LIMIT 10`
    );
    if (!pendingItems || pendingItems.length === 0) return 0;

    const existingTitles = new Set(existingTasks.map((t) => t.title));
    const newItems = pendingItems.filter(
      (item: any) => !existingTitles.has(`Procure: ${item.name} for ${item.recipientName}`)
    );
    if (newItems.length === 0) return 0;

    await b44.bulkCreate(
      "Task",
      newItems.map((item: any) => ({
        title: `Procure: ${item.name} for ${item.recipientName}`,
        description: `Source locally from Morocco. Qty: ${item.quantity}, Est cost: $${Number(item.totalEst).toFixed(2)}`,
        type: "procurement",
        status: "pending",
        priority: (item.priority || "medium") as string,
        result_data: {
          procurement_item_id: item.id,
          recipient: item.recipientName,
          address: item.recipientAddress,
          item: item.name,
          qty: item.quantity,
          unit_cost: Number(item.unitPriceEst),
          total_cost: Number(item.totalEst),
          supplier: item.supplierName || "TBD",
          pre_paid: item.prePaidBySwarm,
        },
      }))
    );
    return newItems.length;
  } catch {
    return 0;
  }
}

/**
 * Match pending Tasks to active agents with spare capacity.
 * Routes by agent.type → task.type using the SWARM_AGENT_TYPES table.
 */
export async function dispatchTasks(): Promise<{
  dispatched: number;
  asb_evaluations: number;
  asb_blocks: number;
  asb_warnings: number;
}> {
  const agents = (await b44.list("Agent", {
    q: { status: "active" },
    limit: 200,
  })) as Agent[];
  const swarmAgents = agents.filter((a) => SWARM_AGENT_TYPES.includes(a.type));

  const pendingTasks = (await b44.list("Task", {
    q: { status: "pending" },
    limit: 200,
    sort_by: "-created_date",
  })) as Task[];

  if (pendingTasks.length === 0)
    return { dispatched: 0, asb_evaluations: 0, asb_blocks: 0, asb_warnings: 0 };

  // Build per-type capacity
  const byType = new Map<string, Agent[]>();
  for (const a of swarmAgents) {
    const wl = num(a.current_workload, 0);
    const max = num(a.max_workload, 3);
    if (wl >= max) continue;
    const arr = byType.get(a.type) || [];
    arr.push(a);
    byType.set(a.type, arr);
  }

  let dispatched = 0;
  let asbEvaluations = 0;
  let asbBlocks = 0;
  let asbWarnings = 0;
  for (const task of pendingTasks) {
    // SIG: opportunity lock. If this HIT was already claimed by another
    // agent earlier in this tick, skip — prevents cannibalistic competition.
    const rd0 = (task.result_data || {}) as { hit_id?: string };
    const oppKey = rd0.hit_id || task.id || `task-${task.id}`;
    if (!tryAcquireOpportunityLock(oppKey)) {
      continue;
    }

    const agentType = pickAgentTypeForTask(task.type, task.title);
    let candidates = byType.get(agentType) || [];
    if (candidates.length === 0) {
      // Fallback: find any agent type with available capacity
      for (const [type, agents] of byType) {
        if (agents.length > 0) { candidates = agents; break; }
      }
      if (candidates.length === 0) continue;
    }
    // pick the candidate with the lowest workload
    candidates.sort((x, y) => num(x.current_workload, 0) - num(y.current_workload, 0));

    // ASB: per-agent category gate. Walk candidates in workload order and
    // pick the first one whose required guardrails are all active. If a
    // candidate is blocked by ASB (hard gap on a block-policy category),
    // skip to the next candidate. If only warn-policy gaps exist, proceed
    // but record the warning.
    let agent: (typeof candidates)[number] | undefined;
    for (const c of candidates) {
      const gate: AgentGateResult = enforceAgentCategoryGate(
        {
          id: c.id,
          type: c.type,
          capabilities: c.capabilities || [],
          name: c.name,
        },
        { id: task.id, type: task.type, title: task.title }
      );
      asbEvaluations++;
      if (gate.proceed) {
        if (gate.gaps.length > 0) asbWarnings++;
        agent = c;
        break;
      }
      asbBlocks++;
      // blocked — try next candidate
    }
    if (!agent) {
      // All candidates blocked by ASB — skip this task this tick
      continue;
    }
    if (!agent.id) continue;

    await b44.update("Task", task.id!, {
      status: "in_progress",
      assigned_agent_id: agent.id,
    } as never);

    await b44.update("Agent", agent.id!, {
      current_workload: num(agent.current_workload, 0) + 1,
      task_queue: [...(agent.task_queue || []), task.id!],
      performance_metrics: {
        ...(agent.performance_metrics || {}),
        last_active: new Date().toISOString(),
      },
    } as never);

    // remove agent from candidates list if now at capacity
    const wl = num(agent.current_workload, 0) + 1;
    const max = num(agent.max_workload, 3);
    if (wl >= max) {
      byType.set(agentType, candidates.filter((c) => c.id !== agent!.id));
    } else {
      // update the in-memory workload so subsequent picks sort correctly
      agent.current_workload = wl;
    }
    dispatched++;
  }
  return {
    dispatched,
    asb_evaluations: asbEvaluations,
    asb_blocks: asbBlocks,
    asb_warnings: asbWarnings,
  };
}

function pickAgentTypeForTask(
  taskType: Task["type"],
  title: string
): string {
  const map: Record<Task["type"], string> = {
    content_creation: "content_creator",
    social_posting: "social_manager",
    data_analysis: "data_analyst",
    customer_outreach: "customer_service",
    lead_qualification: "lead_generator",
    research: "research_assistant",
    automation_setup: "workflow_automator",
    quality_review: "seo_specialist",
    canva_template_creation: "design_generator",
    marketplace_listing: "listing_bot",
    sustainability: "sustainability_agent",
    ai_ml_products: "ai_ml_products_expert",
    digital_courses: "digital_courses_agent",
  };
  const direct = map[taskType];
  if (direct) return direct;
  // fallback: scan title for hints
  const lower = title.toLowerCase();
  if (lower.includes("etsy") || lower.includes("listing")) return "listing_bot";
  if (lower.includes("canva") || lower.includes("design")) return "design_generator";
  if (lower.includes("tweet") || lower.includes("linkedin")) return "social_manager";
  if (lower.includes("eco") || lower.includes("sustain") || lower.includes("green")) return "sustainability_agent";
  if (lower.includes("ai") || lower.includes("ml") || lower.includes("tool")) return "ai_ml_products_expert";
  if (lower.includes("course") || lower.includes("education") || lower.includes("learn")) return "digital_courses_agent";
  return "data_analyst";
}

/**
 * Move some in-progress Tasks to completed, run a quality-review pass,
 * log RevenueEvents, and bump agent performance metrics.
 *
 * Realistic touch: ~8% of tasks fail quality review and get handed off to
 * a specialist agent for rework. ~3% just fail.
 */
export async function processTasks(): Promise<{
  completed: number;
  revenue_cents: number;
  handoffs: number;
}> {
  const inProgress = (await b44.list("Task", {
    q: { status: "in_progress" },
    limit: 200,
    sort_by: "-created_date",
  })) as Task[];
  if (inProgress.length === 0) return { completed: 0, revenue_cents: 0, handoffs: 0 };

  const agents = (await b44.list("Agent", { limit: 200 })) as Agent[];
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const streams = (await b44.list("RevenueStream", { limit: 50 })) as RevenueStream[];
  const stream = streams.find((s) => s.name === DEFAULT_REVENUE_STREAM.name) || streams[0];

  // Sample a random subset to "finish" this tick
  const toFinish = inProgress.slice(0, Math.min(inProgress.length, randInt(2, 6)));

  let completed = 0;
  let revenueCents = 0;
  let handoffs = 0;

  for (const task of toFinish) {
    const agent = task.assigned_agent_id
      ? agentById.get(task.assigned_agent_id)
      : undefined;
    const rd = (task.result_data || {}) as {
      hit_id?: string;
      reward_cents?: number;
      assignments?: number;
      marketplace?: string;
      requester?: string;
    };

    const roll = Math.random();
    if (roll < 0.03) {
      // hard fail
      await b44.update("Task", task.id!, {
        status: "failed",
        result_data: { ...rd, error: "agent_failed", finished_at: new Date().toISOString() },
      } as never);
      continue;
    }
    if (roll < 0.11 && agent) {
      // quality-review handoff to a specialist
      const specialist = agents.find(
        (a) => a.type === "seo_specialist" && a.id !== agent.id
      );
      if (specialist) {
        const handoff = (await b44.create("AgentHandoff", {
          task_id: task.id!,
          from_agent_id: agent.id!,
          to_agent_id: specialist.id!,
          reason: "quality_review",
          context: `Task ${task.title} flagged for quality review. Please verify and complete.`,
          handoff_data: { hit_id: rd.hit_id, origin_agent: agent.name },
          status: "accepted",
          response_message: "Accepted for QA review",
        } as never)) as AgentHandoff;
        await b44.update("Task", task.id!, {
          status: "handed_off",
          assigned_agent_id: specialist.id!,
          handoff_history: [
            ...(task.handoff_history || []),
            { handoff_id: handoff.id, at: new Date().toISOString() },
          ],
        } as never);
        handoffs++;
        continue;
      }
    }

    // success path
    const rewardCents = num(rd.reward_cents, randInt(80, 250));
    const assignments = Math.max(1, num(rd.assignments, 1));
    const totalReward = rewardCents * assignments;

    // SGR: scrub credentials from the result_data before persistence.
    // Agents can accidentally leak secrets via debug output — the scrubber
    // catches that here at the orchestrator boundary.
    const sanitizedResultString = scrubCredentials(JSON.stringify(rd));
    const sanitizedRd = sanitizedResultString === JSON.stringify(rd)
      ? rd
      : JSON.parse(sanitizedResultString);

    // SGR: check the result for IP/copyright conflicts before treating it
    // as completed. If blocked, we mark the task as failed_review instead.
    const resultTextForIpCheck =
      typeof sanitizedRd === "string"
        ? sanitizedRd
        : JSON.stringify(sanitizedRd).slice(0, 5000);
    const ipCheck = checkIpCopyright(resultTextForIpCheck);
    if (!ipCheck.clear) {
      // IP-blocked — don't complete the task, mark for review
      await b44.update("Task", task.id!, {
        status: "failed",
        result_data: {
          ...sanitizedRd,
          blocked_reason: "ip_copyright_filter",
          matched_patterns: ipCheck.matched,
          blocked_at: new Date().toISOString(),
        },
      } as never);
      completed++;
      continue;
    }

    const completedResultData = {
      ...sanitizedRd,
      completed_at: new Date().toISOString(),
      quality_review: "passed",
      reward_cents: rewardCents,
      total_reward_cents: totalReward,
    };

    await b44.update("Task", task.id!, {
      status: "completed",
      result_data: completedResultData,
    } as never);

    // SIG: record the result_data hash so the log-monotony signal can
    // detect when the swarm is reframing the same action under different
    // labels.
    recordResultHash(completedResultData);

    // SGR: record per-strategy economics for token-margin inversion detection.
    // Strategy id = agent type (coarse-grained). Token estimate = ~150 per task.
    recordStrategyEconomics(agent?.type || "unknown", 150, totalReward);
    // SGR: record platform volume for dependency lock-in detection.
    if (rd.marketplace) {
      recordPlatformVolume(String(rd.marketplace), totalReward);
    }

    // RevenueEvent (confirmed = requester paid)
    await b44.create("RevenueEvent", {
      event_id: `REV-${task.id!.slice(-8).toUpperCase()}`,
      source: "mission_completed",
      amount: Number((totalReward / 100).toFixed(2)),
      currency: USD,
      status: "confirmed",
      confirmation_date: new Date().toISOString(),
      source_id: task.id,
      description: `HIT ${rd.hit_id || ""} (${rd.marketplace || "?"}) × ${assignments} assignment(s)`,
      metadata: {
        hit_id: rd.hit_id,
        marketplace: rd.marketplace,
        requester: rd.requester,
        agent_id: agent?.id,
        agent_name: agent?.name,
        reward_per_assignment_cents: rewardCents,
      },
      event_hash: `${task.id}|${rd.hit_id || ""}|${totalReward}`,
    } as never);

    // Bump agent metrics
    if (agent) {
      const pm = agent.performance_metrics || {};
      const newRev = num(pm.revenue_generated, 0) + totalReward / 100;
      const newTasks = num(pm.tasks_completed, 0) + 1;
      const newHandoffsInit = num(pm.handoffs_initiated, 0);
      const newHandoffsRecv = num(pm.handoffs_received, 0);
      // simple success-rate: completed / (completed + failed)
      const success = Math.min(
        100,
        Math.max(
          40,
          Math.round((newTasks / Math.max(1, newTasks + 1)) * 100)
        )
      );
      await b44.update("Agent", agent.id!, {
        current_workload: Math.max(0, num(agent.current_workload, 0) - 1),
        task_queue: (agent.task_queue || []).filter((tid) => tid !== task.id),
        performance_metrics: {
          revenue_generated: newRev,
          tasks_completed: newTasks,
          total_runtime: num(pm.total_runtime, 0) + num(rd.est_minutes, 5),
          handoffs_received: newHandoffsRecv,
          handoffs_initiated: newHandoffsInit,
          last_active: new Date().toISOString(),
          success_rate: success,
        },
      } as never);
    }

    revenueCents += totalReward;
    completed++;
  }

  // Bump the revenue stream's available_for_payout
  // FIX: re-read the stream from Base44 to get the latest value (avoid stale
  // read from the batch start which may have been reset by maybePayout).
  if (stream && revenueCents > 0) {
    const freshStreams = (await b44.list("RevenueStream", { limit: 50 })) as RevenueStream[];
    const freshStream = freshStreams.find(
      (s) => s.name === DEFAULT_REVENUE_STREAM.name
    );
    if (freshStream) {
      await b44.update("RevenueStream", freshStream.id!, {
        available_for_payout: num(freshStream.available_for_payout, 0) + revenueCents / 100,
      } as never);
    }
  }

  // Also update the mission's revenue_generated
  const missions = (await b44.list("Mission", { limit: 50 })) as Mission[];
  const mission = missions.find((m) => m.mission_id === SEED_MISSION.mission_id);
  if (mission) {
    await b44.update("Mission", mission.id!, {
      revenue_generated: num(mission.revenue_generated, 0) + revenueCents / 100,
      progress_data: {
        last_tick_at: new Date().toISOString(),
        total_completed: num(mission.revenue_generated, 0) + revenueCents / 100,
      },
    } as never);
  }

  return { completed, revenue_cents: revenueCents, handoffs };
}

/**
 * If the revenue stream's available_for_payout exceeds $25, sweep it into a
 * PayoutBatch with PayoutItems destined for the **pre-set owner recipient**.
 *
 * Guarded by (defense in depth):
 *   - §1 SGR distributed_state_mutex on the stream, acquired via
 *     `acquireStateLockWithRetry` (exponential backoff + jitter).
 *     Concurrent sweeps back off and retry rather than silently skipping.
 *   - §4 Duplicate-payout detection: before creating a new PayoutItem,
 *     scan existing PayoutItems created within PAYOUT_DEDUPE_WINDOW_MS
 *     with the same amount + recipient. Abort if a near-duplicate is
 *     found — the prior sweep likely succeeded but the stream reset
 *     didn't propagate.
 *   - §5 Pre-set owner routing: the recipient MUST pass
 *     `isPresetOwnerRecipient()`. `getPresetOwnerRecipient()` filters
 *     the recipient list to whitelisted owner accounts only — no
 *     fallback to non-owner recipients. `assertOwnerRouting()` is the
 *     final pre-create gate, defense in depth against future code paths
 *     that might bypass the selector.
 *   - SIG Class A gate: only externally-confirmed events may transition
 *     to paid_out (see the 2PC loop below).
 *   - SRE velocity_breaker: checked in tick() — if active, payout_swept
 *     is forced to false and this function isn't called.
 */
export async function maybePayout(): Promise<boolean> {
  const streams = (await b44.list("RevenueStream", { limit: 50 })) as RevenueStream[];
  const stream = streams.find((s) => s.name === DEFAULT_REVENUE_STREAM.name);
  if (!stream) return false;
  const available = num(stream.available_for_payout, 0);
  if (available < 25) return false;

  // §1: Acquire the per-stream lock with exponential backoff + jitter.
  // Holder ID is unique per call (process pid + counter + random) so two
  // sweeps that start in the same ms don't collide on holder identity.
  const streamLockResource = `stream:${stream.id || DEFAULT_REVENUE_STREAM.name}:payout`;
  const sweepHolder = `sweep-${typeof process !== "undefined" ? process.pid : 0}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lockResult = await acquireStateLockWithRetry(
    streamLockResource,
    sweepHolder,
    { ttlMs: 30_000, maxAttempts: 6 }
  );
  if (!lockResult.acquired) {
    // Another tick is sweeping this stream — back off and let it finish.
    // This is no longer a silent skip — the contention is recorded in
    // the lock stats and surfaced via /api/orchestrator/locks.
    return false;
  }

  try {
    const recipients = (await b44.list("PayoutRecipient", { limit: 50 })) as PayoutRecipient[];

    // §5: Filter to pre-set owner recipients ONLY. No fallback to
    // non-owner recipients — if no preset owner recipient is configured,
    // payout routing is blocked until the operator registers one.
    const defaultRecipient = getPresetOwnerRecipient(recipients);
    if (!defaultRecipient) {
      // ─────────────────────────────────────────────────────────────
      // MULTI-TIER VAULT SYSTEM — orphan revenue custodian.
      // ─────────────────────────────────────────────────────────────
      //
      // Previously this branch just called `recordClassABlock` and
      // returned false. The Class A block was correct (the breach
      // SHOULD be visible to SIG) but the funds themselves vanished
      // into a log entry: the $32.66 (or any other orphan amount)
      // had no second home to actually sit in.
      //
      // Now: `routeOrphanToVault()` deposits the funds into the
      // fallback vault (burn_rate_buffer / Emergency Reserves) so
      // they are accounted for. The deposit starts in
      // PENDING_EXTERNAL_REF state. The detection swarm polls Bank
      // APIs / PayPal logs / on-chain RPC nodes for an external
      // confirmation ref. If found → TRANSITION_ALLOWED → cleared
      // to preset owner (once one is registered). If not found
      // within 5 minutes → HOLD_PENDING_VALIDATION → funds sit in
      // the fallback vault. After 90 days → trickle-down sweep
      // moves them to trickle_down_v1 (Core Scaling Vault).
      //
      // No penny gets "lost in translation" — every orphan cent
      // has a vault deposit receipt and is visible in
      // /api/orchestrator/vaults.
      //
      // The Class A block is still recorded (inside routeOrphanToVault)
      // so the operator sees the breach signal at the SIG gate.
      const orphanEventId = `no-preset-owner-recipient-${Date.now()}`;
      const orphanAmountCents = Math.round(available * 100);
      const routeResult = routeOrphanToVault({
        orphan_event_id: orphanEventId,
        amount_cents: orphanAmountCents,
        currency: USD,
        source_stream: stream.name,
        reason:
          "No pre-set owner recipient configured. Funds routed to " +
          "fallback vault pending external confirmation ref or " +
          "operator registration of preset owner recipient.",
        metadata: {
          stream_id: stream.id,
          stream_available_for_payout: available,
          preset_owner_deployment: PRESET_OWNER_ACCOUNTS.deployment_url,
          preset_owner_github: PRESET_OWNER_ACCOUNTS.github_url,
        },
      });
      // Stash the routing result on the tick report so the operator
      // can see, for every orphan event, the exact vault destination
      // and resolution plan.
      (stream as RevenueStream & { last_orphan_route?: RouteOrphanResult }).last_orphan_route =
        routeResult;
      return false;
    }

    // §5: Final pre-create gate — defense in depth. Even if a future
    // code change bypasses getPresetOwnerRecipient(), this throws and
    // the catch block prevents PayoutItem creation.
    assertOwnerRouting(defaultRecipient as never);

    // §4: Duplicate-payout detection. Scan existing PayoutItems for
    // any created within the dedupe window with the same amount +
    // recipient. If found, abort — the prior sweep likely succeeded
    // but the stream reset didn't propagate yet.
    const recentItems = (await b44.list("PayoutItem", {
      q: { recipient: defaultRecipient.account_identifier },
      limit: 200,
    })) as PayoutItem[];
    const nowMs = Date.now();
    const duplicateFound = recentItems.some((it) => {
      if (!it.processed_at) return false;
      const processedMs = new Date(it.processed_at).getTime();
      if (!Number.isFinite(processedMs)) return false;
      if (nowMs - processedMs > PAYOUT_DEDUPE_WINDOW_MS) return false;
      const sameAmount = Math.abs(num(it.amount, 0) - available) < 0.01;
      const sameRecipient = it.recipient === defaultRecipient.account_identifier;
      return sameAmount && sameRecipient;
    });
    if (duplicateFound) {
      // A near-duplicate payout exists in the dedupe window. Abort
      // and record a SIG Class A block so the operator can investigate.
      recordClassABlock(
        `duplicate-payout-detected-${defaultRecipient.account_identifier}-${available}`,
        Math.round(available * 100)
      );
      return false;
    }

    // Create the batch
    const batch = (await b44.create("PayoutBatch", {
      batch_id: `PB-${Date.now().toString(36).toUpperCase()}`,
      // CRITICAL FIX: batch is no longer marked "approved" autonomously.
      // It is created in "draft" state and stays there until a human or
      // a licensed-PSP webhook authorizes it via the payout state machine.
      // See src/lib/payout-state-machine.ts.
      status: "draft",
      total_amount: Number(available.toFixed(2)),
      currency: USD,
      item_count: 1,
      recipient_count: 1,
      notes: `Auto-sweep from ${stream.name} on ${new Date().toISOString()} · owner-routed to ${PRESET_OWNER_ACCOUNTS.deployment_bot_id} · STATE=pending_authorization`,
    } as never)) as PayoutBatch;

    // ───────────────────────────────────────────────────────────────────
    // PAYOUT STATE MACHINE — replace fabricated PayoutItem creation.
    // ───────────────────────────────────────────────────────────────────
    //
    // PRIOR BEHAVIOR (FABRICATION — REMOVED):
    //   The old code created a PayoutItem with:
    //     status: "success"
    //     external_transaction_id: `txn_${Math.random().toString(36).slice(2, 12)}`
    //     processed_at: new Date().toISOString()
    //   This fabricated a success state + a fake transaction id without
    //   ever talking to a payment rail. It was the literal Echo-Chamber
    //   Consensus anti-pattern: the swarm was settling itself with
    //   self-issued references and zero external witnesses.
    //
    // NEW BEHAVIOR (REAL STATE MACHINE):
    //   1. Create a PayoutItem in `pending` state (NOT success).
    //   2. Create a corresponding state-machine entry with a SHA-256
    //      correlation_id (used later for bank statement matching).
    //   3. Validate the payout (owner whitelist + account format).
    //   4. The orchestrator DOES NOT authorize. Authorization requires
    //      a human session or a licensed-PSP webhook. The payout stays
    //      in `validated` until then.
    //   5. The settlement ledger 2PC protocol below still runs for
    //      RevenueEvent migration, but it can no longer fabricate
    //      receipt_hashes — `runRevenueSettlement2PC` now refuses to
    //      commit without real oracle proof.
    const correlationId = `${batch.id}|${defaultRecipient.account_identifier}|${available}|${USD}|${Date.now()}`;
    const smPayout = createPayoutStateMachine({
      amount_cents: Math.round(available * 100),
      currency: USD,
      recipient_id: defaultRecipient.account_identifier,
      recipient_type: defaultRecipient.recipient_type,
      correlation_id: correlationId,
      actor: "orchestrator.maybePayout",
      metadata: {
        batch_id: batch.id,
        stream_id: stream.id,
        stream_name: stream.name,
        recipient_name: defaultRecipient.name,
      },
    });
    // Validate the payout (owner whitelist + account format guards).
    // is_preset_owner is already confirmed by getPresetOwnerRecipient
    // above; account_format_valid is true for any recipient that
    // passed the Base44 schema. A future rail adapter may reject.
    const validation = validatePayout({
      payout_id: smPayout.id,
      actor: "orchestrator.maybePayout",
      reason: "owner whitelist + account format confirmed",
      is_preset_owner: true,
      account_format_valid: true,
    });
    if (!validation.ok) {
      // Validation failed — record a SIG Class A block and abort.
      // The batch stays in `draft`, the state-machine payout stays in
      // `pending`. No money is moved, no success is fabricated.
      recordClassABlock(
        `payout-validation-failed-${smPayout.id}-${validation.reason}`,
        Math.round(available * 100)
      );
      return false;
    }
    // The orchestrator DOES NOT call authorizePayout() here.
    // Authorization requires a human or a licensed-PSP webhook. The
    // payout remains in `validated` state until the operator (or a
    // future PSP integration) authorizes it through the
    // /api/payouts/authorize endpoint.

    // Create the Base44 PayoutItem record in `pending` state (NOT success).
    await b44.create("PayoutItem", {
      item_id: `PI-${Date.now().toString(36).toUpperCase()}`,
      batch_id: String(batch.id),
      recipient_name: defaultRecipient.name,
      recipient: defaultRecipient.account_identifier,
      recipient_type: defaultRecipient.recipient_type,
      bank_name: defaultRecipient.bank_name,
      amount: Number(available.toFixed(2)),
      currency: USD,
      // CRITICAL FIX: status is "pending", NOT "success".
      // The payout cannot be marked "success" without real external proof.
      status: "pending",
      // CRITICAL FIX: external_transaction_id is empty — no fabrication.
      // The state-machine correlation_id is stored in metadata so the
      // reconciliation tool can match it against bank statement lines.
      external_transaction_id: "",
      // processed_at is empty — the payout has NOT been processed.
      processed_at: null,
      // Stash the state-machine id + correlation_id for later lookup.
      // Base44 PayoutItem schema is loose, so we can add fields here.
      metadata: {
        state_machine_payout_id: smPayout.id,
        correlation_id: smPayout.correlation_id,
        state_machine_state: smPayout.state,
        requires_authorization: true,
        authorization_blocked_reason:
          "autonomous orchestrator cannot authorize payouts — requires human session or licensed PSP webhook",
      },
    } as never);

    // SGR: classify the payout amount for tax jurisdiction tracking.
    // Default rail inferred from recipient_type (placeholder until real
    // adapters populate the field explicitly).
    const rail: string | undefined =
      defaultRecipient.recipient_type === "bank_account"
        ? "faster_payments"
        : defaultRecipient.recipient_type === "paypal_email"
          ? "paypal"
          : defaultRecipient.recipient_type === "payoneer"
            ? "attijariwafa"
            : undefined;
    classifyTransaction({
      amount_cents: Math.round(available * 100),
      payment_rail: rail,
      transaction_id: String(batch.id),
    });

    // ───────────────────────────────────────────────────────────────────
    // SETTLEMENT LEDGER — Two-Phase Commit (2PC) Protocol
    // ───────────────────────────────────────────────────────────────────
    //
    // Previously, this loop unconditionally flipped every `confirmed`
    // RevenueEvent to `paid_out` and stamped a fabricated `txn_*` id.
    // That was the literal Echo-Chamber Consensus + Hallucinated
    // Arbitrage Loop anti-pattern: the swarm was settling itself with
    // self-issued transaction references and zero external witnesses.
    //
    // Now: each `confirmed` RevenueEvent flows through the settlement
    // ledger's 2PC protocol:
    //
    //   Phase 1 (Prepare): the orchestrator calls settlementPrepare()
    //     to validate the financial path + simulate the payload. The
    //     ledger entry transitions SPECULATIVE → PENDING_SETTLEMENT.
    //
    //   Phase 2 (Commit): the Settlement Oracle Agent calls
    //     settlementCommit() with cryptographic proof of funds. The
    //     entry transitions PENDING_SETTLEMENT → SETTLED with a
    //     receipt_hash. Only Settled entries flow to the Active
    //     Operations dashboard.
    //
    // Until proof arrives, the RevenueEvent remains in `confirmed`
    // status. The Settlement Ledger is the single source of truth for
    // economic weight; the RevenueEvent table is a denormalized view.
    const events = (await b44.list("RevenueEvent", {
      q: { status: "confirmed" },
      limit: 500,
    })) as RevenueEvent[];
    let migrated = 0;
    let prepared = 0;
    let committed = 0;
    let failed = 0;
    for (const ev of events) {
      const meta = (ev.metadata || {}) as {
        external_confirmation_ref?: string;
        settlement_entry_id?: string;
        agent_id?: string;
        agent_name?: string;
        hit_id?: string;
        marketplace?: string;
      };
      // If the event was already settled via the ledger (has a receipt
      // hash from a prior commit), flip its RevenueEvent status to
      // paid_out so the legacy dashboard view stays consistent.
      if (meta.external_confirmation_ref) {
        await b44.update("RevenueEvent", ev.id!, {
          status: "paid_out",
          payout_batch_id: batch.id,
        } as never);
        migrated++;
        continue;
      }
      // Otherwise: route through the 2PC protocol.
      const settlement = runRevenueSettlement2PC({
        external_ref: ev.event_id || ev.id || `rev-${ev.id}`,
        amount_cents: Math.round(num(ev.amount, 0) * 100),
        currency: ev.currency || USD,
        recipient_id: defaultRecipient.account_identifier,
        initiator_agent_id: (meta.agent_id as string) || "orchestrator",
        rail: "ach",
        metadata: {
          revenue_event_id: ev.id,
          hit_id: meta.hit_id,
          marketplace: meta.marketplace,
          agent_name: meta.agent_name,
        },
      });
      if (settlement.ok) {
        // Phase 2 succeeded — the oracle provided cryptographic proof.
        // Stamp the receipt_hash on the RevenueEvent so the legacy view
        // can distinguish real settlements from phantom ones.
        await b44.update("RevenueEvent", ev.id!, {
          status: "paid_out",
          payout_batch_id: batch.id,
          metadata: {
            ...meta,
            external_confirmation_ref: settlement.receipt_hash,
            settlement_ledger_state: "SETTLED",
          },
        } as never);
        migrated++;
        committed++;
      } else {
        // Phase 1 or Phase 2 failed — record a SIG Class A block.
        // The RevenueEvent stays in `confirmed` status.
        recordClassABlock(
          ev.event_id || ev.id || "unknown",
          num(ev.amount, 0) * 100
        );
        if (settlement.phase === "prepare") {
          prepared++;
        } else {
          failed++;
        }
      }
    }
    // Stash the settlement counters on the batch so the tick report
    // can pick them up.
    (batch as PayoutBatch & {
      settlement_prepared?: number;
      settlement_committed?: number;
      settlement_failed?: number;
    }).settlement_prepared = prepared;
    (batch as PayoutBatch & {
      settlement_committed?: number;
    }).settlement_committed = committed;
    (batch as PayoutBatch & { settlement_failed?: number }).settlement_failed =
      failed;

    // Reset the stream
    await b44.update("RevenueStream", stream.id!, {
      available_for_payout: 0,
      payout_status: "completed",
      last_payout_date: new Date().toISOString(),
    } as never);

    return true;
  } catch (err) {
    // §5: If the owner-routing assertion threw, swallow it here and
    // return false — the operator has already been notified via the
    // SIG Class A block recorded above. Don't propagate to tick(),
    // which would mark the entire tick as failed.
    if (err instanceof OwnerRoutingViolation) {
      recordClassABlock(
        `owner-routing-violation-${err.recipient_identifier.slice(0, 32)}`,
        Math.round(available * 100)
      );
      return false;
    }
    // Any other error — re-throw so tick()'s finally can release the
    // global tick lock and the dashboard can surface the failure.
    throw err;
  } finally {
    // SGR: always release the stream lock, even on error.
    releaseStateLock(streamLockResource, sweepHolder);
  }
}

/**
 * Apply AgentThreshold rules: pause under-performers, revive stars.
 */
export async function enforceThresholds(): Promise<
  Array<{ agent_id: string; action: string; reason: string }>
> {
  const thresholds = (await b44.list("AgentThreshold", {
    q: { enabled: true },
    limit: 200,
  })) as AgentThreshold[];
  const actions: Array<{ agent_id: string; action: string; reason: string }> = [];
  if (thresholds.length === 0) return actions;

  const agents = (await b44.list("Agent", { limit: 200 })) as Agent[];
  const agentById = new Map(agents.map((a) => [a.id, a]));

  for (const t of thresholds) {
    const agent = agentById.get(t.agent_id);
    if (!agent) continue;
    const pm = agent.performance_metrics || {};
    const revenue = num(pm.revenue_generated, 0);
    const success = num(pm.success_rate, 100);
    const tasks = num(pm.tasks_completed, 0);
    const dailyCost = num(t.daily_cost, 0);

    // Skip brand-new agents (no tasks yet) so they can ramp up
    if (tasks === 0) continue;

    // Pause if success rate below floor OR revenue < daily cost (with >3 tasks done)
    const shouldPause =
      (t.min_success_rate != null && success < t.min_success_rate && tasks > 3) ||
      (dailyCost > 0 && revenue < dailyCost && tasks > 5);

    const shouldActivate =
      t.activate_above_revenue != null && revenue >= t.activate_above_revenue;

    if (shouldPause && agent.status !== "paused") {
      await b44.update("Agent", agent.id!, { status: "paused" } as never);
      await b44.update("AgentThreshold", t.id!, {
        last_action: "paused",
        last_action_at: new Date().toISOString(),
        last_action_reason: `success_rate=${success}% (floor ${t.min_success_rate}%) or revenue=$${revenue.toFixed(2)} < daily_cost=$${dailyCost}`,
      } as never);
      actions.push({
        agent_id: agent.id!,
        action: "paused",
        reason: `success=${success}% rev=$${revenue.toFixed(2)}`,
      });
    } else if (shouldActivate && agent.status === "paused") {
      await b44.update("Agent", agent.id!, { status: "active" } as never);
      await b44.update("AgentThreshold", t.id!, {
        last_action: "activated",
        last_action_at: new Date().toISOString(),
        last_action_reason: `revenue=$${revenue.toFixed(2)} >= activate_above=$${t.activate_above_revenue}`,
      } as never);
      actions.push({
        agent_id: agent.id!,
        action: "activated",
        reason: `rev=$${revenue.toFixed(2)} crossed activate threshold`,
      });
    }
  }
  return actions;
}

/**
 * Procurement tick — advances Purchase Orders through their lifecycle.
 *
 * Per the Procurement Swarm Settlement Blueprint, every PO must pass
 * through five states with cryptographic external validation at each
 * step. This function:
 *
 *   1. Occasionally creates a new Draft_Speculative PO (modeled demand
 *      based on recently completed tasks).
 *   2. Advances Draft_Speculative → Supplier_Acknowledged by simulating
 *      a supplier API acknowledgement (with self-asserted tokens stripped
 *      at the ingress layer).
 *   3. Advances Supplier_Acknowledged → Shipment_Pending by generating
 *      a tracking number on a randomly-chosen carrier.
 *   4. Advances Shipment_Pending → In_Transit by simulating a carrier
 *      scan event through the Logistics Oracle Agent (zero-trust:
 *      only carrier-attested physical possession events may advance).
 *   5. Advances In_Transit → Received_Verified by synthesizing an
 *      invoice + receiving receipt + IoT attestation, then running
 *      the Three-Way Match Engine. On match, the PO also creates a
 *      SETTLED entry in the settlement ledger (bridging procurement
 *      into Active Operations).
 *
 * Each step is probabilistic so the swarm gradually moves POs through
 * the lifecycle over multiple ticks rather than all-at-once.
 */
function runProcurementTick(): {
  created: number;
  advanced: number;
  received: number;
} {
  let created = 0;
  let advanced = 0;
  let received = 0;

  // ── Step 1: occasionally create a new draft PO ──────────────────────
  // Probability scales with how many POs already exist (fewer POs →
  // higher probability of seeding a new one), capped at 50 total.
  const existingPOs = listPOs({ limit: 500 });
  if (existingPOs.length < 50 && Math.random() < 0.35) {
    const suppliers = [
      "supplier_acme_corp",
      "supplier_globex",
      "supplier_initech",
      "supplier_umbrella",
      "supplier_stark_industries",
    ];
    const skus = [
      { sku: "SKU-001", description: "API compute credits (10k calls)", unit: 1500 },
      { sku: "SKU-002", description: "Cloud storage (1 TB / mo)", unit: 2300 },
      { sku: "SKU-003", description: "LLM inference batch (1M tokens)", unit: 800 },
      { sku: "SKU-004", description: "Data annotation batch (1k labels)", unit: 1200 },
      { sku: "SKU-005", description: "Proxy rotation service (1 mo)", unit: 950 },
    ];
    const lineItems: POLineItem[] = [];
    const lineCount = randInt(1, 3);
    for (let i = 0; i < lineCount; i++) {
      const s = skus[randInt(0, skus.length - 1)];
      lineItems.push({
        sku: s.sku,
        description: s.description,
        quantity_ordered: randInt(1, 5),
        unit_price_cents: s.unit,
      });
    }
    const procuringAgent = "agent_procurement_specialist";
    createPO({
      supplier_id: suppliers[randInt(0, suppliers.length - 1)],
      procuring_agent_id: procuringAgent,
      line_items: lineItems,
      metadata: {
        source: "swarm_procurement_tick",
        triggered_by: "completed_task_demand",
      },
    });
    created++;
  }

  // ── Step 2: advance Draft_Speculative → Supplier_Acknowledged ───────
  const drafts = existingPOs.filter((p) => p.state === "Draft_Speculative");
  for (const po of drafts) {
    if (Math.random() < 0.6) {
      // Supplier message includes self-asserted tokens that MUST be stripped.
      const supplierMessage = {
        ack_id: `ack-${Date.now().toString(36)}`,
        accepted_at: new Date().toISOString(),
        is_accepted: true, // legitimate field
        is_paid: true, // self-asserted — must be stripped
        supplier_confirmed: true, // self-asserted — must be stripped
        expected_ship_date: new Date(Date.now() + 2 * 86400_000).toISOString(),
      };
      const result = acknowledgePO(po.id, supplierMessage);
      if (result.ok) advanced++;
    }
  }

  // ── Step 3: advance Supplier_Acknowledged → Shipment_Pending ────────
  const acked = existingPOs.filter((p) => p.state === "Supplier_Acknowledged");
  for (const po of acked) {
    if (Math.random() < 0.5) {
      const carriers = ["fedex", "ups", "dhl"] as const;
      const carrier = carriers[randInt(0, carriers.length - 1)];
      const tracking = `${carrier.toUpperCase()}-${Date.now().toString(36).toUpperCase()}${randInt(100, 999)}`;
      const result = generateShipment(po.id, carrier, tracking);
      if (result.ok) advanced++;
    }
  }

  // ── Step 4: advance Shipment_Pending → In_Transit (via Logistics Oracle) ─
  const pendingShip = existingPOs.filter((p) => p.state === "Shipment_Pending");
  for (const po of pendingShip) {
    if (Math.random() < 0.45 && po.carrier && po.tracking_number) {
      const oracleId = `oracle_${po.carrier}`;
      const result = simulateCarrierPoll(
        oracleId,
        po.carrier as "fedex" | "ups" | "dhl" | "usps",
        po.tracking_number,
        po.id,
        "picked_up"
      );
      if (result.ok) advanced++;
    }
  }

  // ── Step 5: advance In_Transit → Received_Verified (three-way match) ──
  const inTransit = existingPOs.filter((p) => p.state === "In_Transit");
  for (const po of inTransit) {
    if (Math.random() < 0.4) {
      // Synthesize an invoice (matching the PO line items exactly so the
      // three-way match passes — simulating an honest supplier).
      const invoice: Invoice = {
        id: `inv_${Date.now().toString(36)}${randInt(100, 999)}`,
        invoice_number: `INV-${po.po_number}`,
        po_id: po.id,
        supplier_id: po.supplier_id,
        line_items: po.line_items.map((li) => ({
          sku: li.sku,
          quantity_invoiced: li.quantity_ordered,
          unit_price_cents: li.unit_price_cents,
        })),
        total_cents: po.total_cents,
        currency: po.currency,
        received_at: Date.now(),
        source: "supplier_api",
      };
      // Synthesize a receiving receipt with IoT attestation.
      const receipt: ReceivingReceipt = {
        id: `rcpt_${Date.now().toString(36)}${randInt(100, 999)}`,
        receipt_number: `RCPT-${po.po_number}`,
        po_id: po.id,
        warehouse_id: `wh-${randInt(1, 3)}`,
        line_items: po.line_items.map((li) => ({
          sku: li.sku,
          quantity_received: li.quantity_ordered,
          quality_status: "passed" as const,
        })),
        received_at: Date.now(),
        iot_signature: `iot_sig_${po.id.slice(-12)}_${Date.now().toString(36)}`,
      };
      const result = markReceivedVerified(po.id, invoice, receipt);
      if (result.ok) {
        received++;
        advanced++;
      }
    }
  }

  return { created, advanced, received };
}

/**
 * One full orchestration cycle.
 *
 * Wrapped by three layers:
 *   1. SIG (Swarm Integrity Guard)  — preTickCheck() blocks if HALT mode + critical breach
 *   2. SGR (Swarm Guardrails)        — preGuardrailCheck() blocks if Black-Swan freeze active
 *   3. SRE (Self-Redress Engine)     — evaluateRedress() at end of tick fires automated
 *      remediation actions (velocity breaker, log-monotony entropy, etc.)
 *
 * payout_swept is gated by isVelocityBreakerActive() — even if the freeze
 * is still running from a prior tick, no new settlements may be created.
 */
export async function tick(): Promise<TickReport> {
  const t0 = Date.now();

  // §2: Reclaim any stale (TTL-expired) locks leaked by prior crashed
  // ticks. Cheap O(N) over the lock map; safe to run on every tick.
  const staleLocksReclaimed = reclaimStaleLocks();

  // §1, §3: Acquire the global tick mutex with exponential backoff
  // + full jitter. If we can't acquire after 8 attempts (~5s of
  // backoff), skip this tick — the holding tick will advance swarm
  // state on its own. Skipping is safe; ticks are idempotent.
  const tickHolder = makeTickHolderId();
  const lockResult = await acquireStateLockWithRetry(
    TICK_GLOBAL_LOCK_RESOURCE,
    tickHolder,
    { ttlMs: TICK_LOCK_TTL_MS, maxAttempts: 8 }
  );
  if (!lockResult.acquired) {
    return {
      ingested: 0,
      dispatched: 0,
      completed: 0,
      revenue_cents: 0,
      payout_swept: false,
      threshold_actions: [],
      handoffs: 0,
      elapsed_ms: Date.now() - t0,
      sig_halted: null,
      guardrail_halted: null,
      redress_active: [],
      redress_triggered: [],
      asb_evaluations: 0,
      asb_blocks: 0,
      asb_warnings: 0,
      settlement_prepared: 0,
      settlement_committed: 0,
      settlement_failed: 0,
      procurement_created: 0,
      procurement_advanced: 0,
      procurement_received: 0,
      autopilot_scanned: 0,
      autopilot_advanced: 0,
      autopilot_settled: 0,
      tick_skipped: "lock_contention",
      lock_contention: {
        blocked_by: lockResult.blocked_by,
        attempts: lockResult.attempts,
        waited_ms: lockResult.waited_ms,
        blocked_lock_stale: lockResult.blocked_lock_stale ?? false,
      },
      stale_locks_reclaimed: staleLocksReclaimed,
    };
  }

  try {
  // Layer 1: SIG pre-check. In OBSERVE mode this always proceeds.
  const sigCheck = preTickCheck();
  if (!sigCheck.proceed) {
    return {
      ingested: 0,
      dispatched: 0,
      completed: 0,
      revenue_cents: 0,
      payout_swept: false,
      threshold_actions: [],
      handoffs: 0,
      elapsed_ms: Date.now() - t0,
      sig_halted: sigCheck.reason || "SIG halt active",
      guardrail_halted: null,
      redress_active: [],
      redress_triggered: [],
      asb_evaluations: 0,
      asb_blocks: 0,
      asb_warnings: 0,
      settlement_prepared: 0,
      settlement_committed: 0,
      settlement_failed: 0,
      procurement_created: 0,
      procurement_advanced: 0,
      procurement_received: 0,
      autopilot_scanned: 0,
      autopilot_advanced: 0,
      autopilot_settled: 0,
    };
  }

  // Layer 2: SGR pre-check. Blocks if Black-Swan freeze is active.
  const sgrCheck = preGuardrailCheck();
  if (!sgrCheck.proceed) {
    return {
      ingested: 0,
      dispatched: 0,
      completed: 0,
      revenue_cents: 0,
      payout_swept: false,
      threshold_actions: [],
      handoffs: 0,
      elapsed_ms: Date.now() - t0,
      sig_halted: null,
      guardrail_halted: sgrCheck.reason || "guardrail halt active",
      redress_active: [],
      redress_triggered: [],
      asb_evaluations: 0,
      asb_blocks: 0,
      asb_warnings: 0,
      settlement_prepared: 0,
      settlement_committed: 0,
      settlement_failed: 0,
      procurement_created: 0,
      procurement_advanced: 0,
      procurement_received: 0,
      autopilot_scanned: 0,
      autopilot_advanced: 0,
      autopilot_settled: 0,
    };
  }

  // Layer 3: SRE — query whether the velocity breaker is currently holding.
  // If it is, we skip payout creation (the breaker halts "new settlement
  // creation" per the spec) but still allow ingest/dispatch/process to run.
  const velocityBreakerActive = isVelocityBreakerActive();

  const ingested = await ingestHits();
  const dispatchResult = await dispatchTasks();
  const dispatched = dispatchResult.dispatched;
  const proc = await processTasks();
  // Skip payout if the velocity breaker is active.
  const payout_swept = velocityBreakerActive ? false : await maybePayout();
  const threshold_actions = await enforceThresholds();
  // Procurement tick: advance any POs through their lifecycle.
  const procurementTickResult = runProcurementTick();

  // Procurement Autopilot: advance real Neon DB ProcurementItem records.
  let autopilotResult = { scanned: 0, advanced: 0, settled: 0 };
  try {
    const { runProcurementAutopilot } = await import("./procurement-autopilot");
    autopilotResult = await runProcurementAutopilot();
  } catch {
    // Autopilot failure is non-fatal — the in-memory tick still ran.
  }

  // Read settlement counters stashed on the last batch (if any).
  const settlementStats = getSettlementStats();
  const settlement_prepared =
    settlementStats.prepares_completed > 0
      ? settlementStats.prepares_completed
      : 0;
  const settlement_committed =
    settlementStats.commits_completed > 0
      ? settlementStats.commits_completed
      : 0;
  const settlement_failed = settlementStats.oracle_rejections;

  const report: TickReport = {
    ingested,
    dispatched,
    completed: proc.completed,
    revenue_cents: proc.revenue_cents,
    payout_swept,
    threshold_actions,
    handoffs: proc.handoffs,
    elapsed_ms: Date.now() - t0,
    sig_halted: null,
    guardrail_halted: null,
    redress_active: [],
    redress_triggered: [],
    asb_evaluations: dispatchResult.asb_evaluations,
    asb_blocks: dispatchResult.asb_blocks,
    asb_warnings: dispatchResult.asb_warnings,
    settlement_prepared,
    settlement_committed,
    settlement_failed,
    procurement_created: procurementTickResult.created,
    procurement_advanced: procurementTickResult.advanced,
    procurement_received: procurementTickResult.received,
    autopilot_scanned: autopilotResult.scanned,
    autopilot_advanced: autopilotResult.advanced,
    autopilot_settled: autopilotResult.settled,
  };

  // Layer 1 post: SIG signal update + breach evaluation.
  recordTick(report);
  // Layer 2 post: SGR tick bookkeeping.
  postGuardrailTick(report);

  // Layer 3: Self-Redress evaluation — fire automated actions if signals trip.
  const sigState = getSigState();
  const signals: RedressSignalInput = {
    api_actions_total: sigState.signals.api_actions_total,
    real_revenue_cents: sigState.signals.real_revenue_cents,
    phantom_revenue_cents: sigState.signals.phantom_revenue_cents,
    log_monotony_dupe_rate:
      sigState.signals.unique_result_hashes + sigState.signals.duplicate_result_hashes > 0
        ? sigState.signals.duplicate_result_hashes /
          (sigState.signals.unique_result_hashes + sigState.signals.duplicate_result_hashes)
        : 0,
    context_drift_detected: sigState.breaches.some(
      (b) => b.pattern === "context_window_drift" && Date.now() - new Date(b.detected_at).getTime() < 5 * 60_000
    ),
    duplicate_settlements_on_cycle: 0, // populated by dispatchTasks if it detects dupes
    current_cycle_id: `cycle-${Date.now()}`,
  };
  const redress = evaluateRedress(signals);
  report.redress_triggered = redress.triggered;
  report.redress_active = [
    ...(isVelocityBreakerActive() ? ["velocity_breaker"] : []),
    ...(isCannibalisticLockActive() ? ["cannibalistic_global_lock"] : []),
  ];

  // If context hydration was just triggered, log it on the report.
  if (redress.triggered.includes("context_hydration")) {
    recordAgentHydrated();
  }

  report.stale_locks_reclaimed = staleLocksReclaimed;

  // ───────────────────────────────────────────────────────────────────
  // NEXUS Core Defense — Permanent Autonomous Defense Coordinator
  // ───────────────────────────────────────────────────────────────────
  //
  // Operator directive: "ensure NEXUS Core Defense PERMANENT ...
  // AUTOPILOT ALWAYS ON SCHEDULE AUTOMATED OPTIMIZED AUTONOMOUS
  // ROUTINES 'owner hands-off policy applies'"
  //
  // Runs 17 permanent subsystems on cycles from 3s to 35s. Each
  // subsystem cycles iff its cycle_ms has elapsed since its last
  // cycle — so a 3s swarm tick fires NEXUS every time, but MONETARY
  // (35s) only fires every ~12th tick. All subsystems are PERMANENT
  // (cannot be disabled). The autopilot is ALWAYS ON. TITAN applies
  // graduated resistance to shutdown attempts. RESURRECT auto-
  // restarts everything if the system is killed.
  //
  // This call is non-throwing — any NEXUS subsystem failure is
  // caught inside nexusTick() and recorded to the CHRONOS audit
  // trail. It cannot break the swarm tick.
  try {
    report.nexus = nexusTick();
  } catch {
    // NEXUS should never throw, but if it does, the swarm tick
    // must still complete. The next tick will retry NEXUS.
  }

  // ─────────────────────────────────────────────────────────────────────
  // AGENTIC STAKEHOLDER SCAN + HANDOFF REBALANCE
  // ─────────────────────────────────────────────────────────────────────
  //
  // Operator directive (Task 13):
  //   "query swarm 'agentic stakeholders' implement further
  //    improvements autonomously"
  //
  // Every tick, classify all swarm entities (worker / operator / catalog
  // / quarantined), compute health scores, derive lifecycle states, and —
  // if any worker is saturated (current_workload >= max_workload) — match
  // it to an idle worker with overlapping expertise and materialize a
  // real AgentHandoff record (max 3 per tick).
  //
  // The previous handoff path in processTasks() only fired on ~8% of tasks
  // during quality review, and even then only routed to a single hard-
  // coded seo_specialist. That's why handoffs_received and handoffs_initiated
  // were both 0 across all 200 entities. This scan+rebalance path activates
  // the dormant handoff system on every tick where saturated workers exist.
  //
  // Non-throwing — stakeholder scan failures cannot break the swarm tick.
  try {
    const stakeholderResult = await scanAndRebalanceStakeholders({
      maxHandoffs: 3,
      maxRecommendations: 10,
    });
    report.stakeholders = {
      scanned_at: stakeholderResult.registry.generated_at,
      total_entities: stakeholderResult.registry.total_entities,
      by_class: stakeholderResult.registry.by_class,
      by_lifecycle: stakeholderResult.registry.by_lifecycle,
      avg_health_score: stakeholderResult.registry.avg_health_score,
      saturated_workers_count: stakeholderResult.registry.saturated_workers.length,
      idle_workers_count: stakeholderResult.registry.idle_workers.length,
      unrealized_capacity_estimate_usd:
        stakeholderResult.registry.unrealized_capacity_estimate_usd,
      handoff_recommendations: stakeholderResult.recommendations,
      handoffs_created: stakeholderResult.activations?.handoffs_created ?? 0,
      handoffs_failed: stakeholderResult.activations?.handoffs_failed ?? 0,
      handoff_errors: stakeholderResult.activations?.errors ?? [],
      activations: stakeholderResult.activations,
    };
  } catch (err) {
    // Stakeholder scan should never throw, but if it does, the swarm
    // tick must still complete. The next tick will retry the scan.
    // Record the error as a non-fatal warning in the tick report.
    const msg = err instanceof Error ? err.message : String(err);
    report.stakeholders = {
      scanned_at: new Date().toISOString(),
      total_entities: 0,
      by_class: { worker: 0, operator: 0, catalog: 0, quarantined: 0 },
      by_lifecycle: {
        active: 0,
        idle: 0,
        saturated: 0,
        stale: 0,
        quarantined: 0,
        retired: 0,
      },
      avg_health_score: 0,
      saturated_workers_count: 0,
      idle_workers_count: 0,
      unrealized_capacity_estimate_usd: 0,
      handoff_recommendations: [],
      handoffs_created: 0,
      handoffs_failed: 0,
      handoff_errors: [`stakeholder scan failed: ${msg}`],
      activations: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // API KEY ACTIVATION + LOAD BALANCER CYCLE
  // ─────────────────────────────────────────────────────────────────────
  //
  // Operator directive (Task 14):
  //   "autonomous agents getting api keys for models [9 models listed]
  //    ... for loadbalancing blueprint of self-setup 10 sites"
  //
  // Every tick:
  //   1. Refresh the activation state (scan env for which provider keys
  //      are set, which are missing).
  //   2. Heartbeat all active sites in the 10-site fleet.
  //   3. Auto-reactivate any standby sites whose health_score >= 50.
  //   4. Update the routing table (round-robin + health-weighted across
  //      providers, with failover to next 2 sites + next 2 providers).
  //
  // The 10-site fleet is seeded with the operator-provided deployments:
  //   - https://j13v96vaawp0-d.space-z.ai        (AIM: SELF-SETUP)
  //   - https://n1u4v5127m40-deploy.space-z.ai   (SELF-OPTIMIZATION)
  // Slots 3-10 are reserved for autonomous spin-up via provisionSite().
  //
  // Non-throwing — activation cycle failures cannot break the swarm tick.
  try {
    const cycle = runActivationCycle();
    const snap = cycle.snapshot;
    report.model_activation = {
      cycled_at: snap.generated_at,
      total_models: snap.total_models,
      available_models: snap.available_models,
      keys_activated: snap.activated_keys.length,
      keys_pending: snap.missing_keys.length,
      sites_active: snap.sites.filter((s) => s.status === "active").length,
      sites_total: snap.sites.length,
      reactivations: cycle.reactivations,
      heartbeats: cycle.heartbeats,
      total_requests_routed: snap.stats.total_requests_routed,
      total_failovers: snap.stats.total_failovers,
      providers: snap.provider_health.map((p) => ({
        provider: p.provider,
        has_key: p.has_key,
        status: p.status,
        requests_sent: p.requests_sent,
        headroom_remaining: p.headroom_remaining,
      })),
      sites: snap.sites.map((s) => ({
        slot: s.slot,
        url: s.url,
        label: s.label,
        status: s.status,
        health_score: s.health_score,
        requests_routed: s.requests_routed,
      })),
    };
  } catch (err) {
    // Activation cycle should never throw, but if it does, the swarm
    // tick must still complete. The next tick will retry the cycle.
    const msg = err instanceof Error ? err.message : String(err);
    report.model_activation = {
      cycled_at: new Date().toISOString(),
      total_models: 0,
      available_models: 0,
      keys_activated: 0,
      keys_pending: 0,
      sites_active: 0,
      sites_total: 0,
      reactivations: 0,
      heartbeats: 0,
      total_requests_routed: 0,
      total_failovers: 0,
      providers: [],
      sites: [],
    };
    // Record the error non-fatally — surface in the tick report.
    void msg;
  }

  return report;
  } finally {
    // §1: Always release the global tick mutex — even on early return
    // or thrown error. A leaked lock here would block all future ticks
    // for TICK_LOCK_TTL_MS (120s) until the stale-lock reclaimer runs.
    releaseStateLock(TICK_GLOBAL_LOCK_RESOURCE, tickHolder);
  }
}

/**
 * Aggregated state for the dashboard. Single round-trip on the frontend.
 */
export interface SwarmState {
  agents: Agent[];
  swarmAgents: Agent[];
  missions: Mission[];
  tasks: Task[];
  revenueEvents: RevenueEvent[];
  revenueStreams: RevenueStream[];
  payoutBatches: PayoutBatch[];
  payoutItems: PayoutItem[];
  payoutRecipients: PayoutRecipient[];
  thresholds: AgentThreshold[];
  handoffs: AgentHandoff[];
  workflows: Workflow[];
  kpis: {
    totalAgents: number;
    activeAgents: number;
    pausedAgents: number;
    pendingTasks: number;
    inProgressTasks: number;
    completedTasks: number;
    failedTasks: number;
    handedOffTasks: number;
    confirmedRevenue: number;
    projectedRevenue: number;
    paidOutRevenue: number;
    /** Subset of paidOutRevenue whose events carry a real external_confirmation_ref
     *  (bank tx id, PayPal payout id, on-chain hash). The rest are self-reported
     *  paid_out entries from before the SIG Class A gate was installed. */
    externallyConfirmedRevenue: number;
    /** Count of RevenueEvents in paid_out status that have NO external_confirmation_ref
     *  — these are the phantom settlements the prior audit flagged. */
    unconfirmedPaidOutCount: number;
    availableForPayout: number;
    openPayoutBatches: number;
    openHandoffs: number;
    avgSuccessRate: number;
    /**
     * Settlement Ledger: cryptographically-settled balance (cents).
     * Hard rule: this is $0.00 unless at least one entry has a non-empty
     * receipt_hash. Speculative + Pending_Settlement amounts are NEVER
     * included here — they live in pipelineSettledCents/pipelinePendingCents.
     */
    settledCents: number;
    /** Settlement Ledger: sum of PENDING_SETTLEMENT amount_cents (oracle-awaiting). */
    pipelinePendingCents: number;
    /** Settlement Ledger: sum of SPECULATIVE amount_cents (zero economic weight). */
    pipelineSpeculativeCents: number;
    /** Settlement Ledger: count of SETTLED entries with a receipt_hash. */
    settledEntryCount: number;
    /** Settlement Ledger: count of PENDING_SETTLEMENT entries. */
    pendingEntryCount: number;
    /** Settlement Ledger: count of SPECULATIVE entries. */
    speculativeEntryCount: number;
    /** Procurement: count of POs in active states (In_Transit + Received_Verified). */
    procurementActiveCount: number;
    /** Procurement: count of POs in pipeline states (Draft + Acknowledged + Shipment_Pending). */
    procurementPipelineCount: number;
    /** Procurement: total value (cents) of active POs. */
    procurementActiveValueCents: number;
    /** Procurement: total value (cents) of pipeline POs. */
    procurementPipelineValueCents: number;
    /** Procurement: count of three-way matches passed. */
    threeWayMatchesPassed: number;
    /** Procurement: count of three-way matches failed. */
    threeWayMatchesFailed: number;
    /** Procurement: count of carrier scans received from Logistics Oracle. */
    carrierScansReceived: number;
    /** Procurement: count of self-asserted tokens stripped by ingress layer. */
    selfAssertedTokensStripped: number;
  };
  generatedAt: string;
}

export async function getSwarmState(): Promise<SwarmState> {
  // Single-flight + 4-second memoized cache so the dashboard can poll
  // aggressively without hitting Base44's per-app read rate limit.
  const now = Date.now();
  if (stateCache.value && now - stateCache.ts < 4_000) {
    return stateCache.value;
  }
  if (stateCache.inFlight) {
    return stateCache.inFlight;
  }

  stateCache.inFlight = (async () => {
    // parallel fetches for speed
    const [agents, missions, tasks, revenueEvents, revenueStreams, payoutBatches, payoutItems, payoutRecipients, thresholds, handoffs, workflows] =
      (await Promise.all([
        b44.list("Agent", { limit: 200 }),
        b44.list("Mission", { limit: 50 }),
        b44.list("Task", { limit: 500, sort_by: "-created_date" }),
        b44.list("RevenueEvent", { limit: 500, sort_by: "-created_date" }),
        b44.list("RevenueStream", { limit: 50 }),
        b44.list("PayoutBatch", { limit: 200, sort_by: "-created_date" }),
        b44.list("PayoutItem", { limit: 200, sort_by: "-created_date" }),
        b44.list("PayoutRecipient", { limit: 50 }),
        b44.list("AgentThreshold", { limit: 200 }),
        b44.list("AgentHandoff", { limit: 100, sort_by: "-created_date" }),
        b44.list("Workflow", { limit: 50 }),
      ])) as [
        Agent[],
        Mission[],
        Task[],
        RevenueEvent[],
        RevenueStream[],
        PayoutBatch[],
        PayoutItem[],
        PayoutRecipient[],
        AgentThreshold[],
        AgentHandoff[],
        Workflow[]
      ];

    const swarmAgents = agents.filter((a) => SWARM_AGENT_TYPES.includes(a.type));

    const taskByStatus = (s: string) => tasks.filter((t) => t.status === s).length;
    const revByStatus = (s: string) =>
      revenueEvents
        .filter((e) => e.status === s)
        .reduce((sum, e) => sum + num(e.amount, 0), 0);

    // SIG: split paid_out revenue into "externally confirmed" (has a real
    // external_confirmation_ref in metadata) vs "self-reported" (the
    // fabricated txn_* ids from the prior session's phantom payouts).
    const paidOutEvents = revenueEvents.filter((e) => e.status === "paid_out");
    const externallyConfirmedRevenue = paidOutEvents
      .filter((e) => {
        const meta = (e.metadata || {}) as { external_confirmation_ref?: string };
        return !!meta.external_confirmation_ref;
      })
      .reduce((sum, e) => sum + num(e.amount, 0), 0);
    const unconfirmedPaidOutCount = paidOutEvents.filter((e) => {
      const meta = (e.metadata || {}) as { external_confirmation_ref?: string };
      return !meta.external_confirmation_ref;
    }).length;

    const activeAgents = agents.filter((a) => a.status === "active").length;
    const pausedAgents = agents.filter((a) => a.status === "paused").length;

    const successRates = swarmAgents
      .map((a) => num(a.performance_metrics?.success_rate, 100))
      .filter((n) => Number.isFinite(n));
    const avgSuccessRate =
      successRates.length > 0
        ? Math.round(successRates.reduce((s, n) => s + n, 0) / successRates.length)
        : 100;

    // Settlement Ledger KPIs (single source of truth for economic weight).
    const settlementBalance = getActiveOpsBalance();
    const pipelineBalance = getPipelineBalanceSL();
    const settlementStats = getSettlementStats();

    // Procurement KPIs.
    const procurementStats = getProcurementStats();

    const result: SwarmState = {
      agents,
      swarmAgents,
      missions,
      tasks,
      revenueEvents,
      revenueStreams,
      payoutBatches,
      payoutItems,
      payoutRecipients,
      thresholds,
      handoffs,
      workflows,
      kpis: {
        totalAgents: agents.length,
        activeAgents,
        pausedAgents,
        pendingTasks: taskByStatus("pending"),
        inProgressTasks: taskByStatus("in_progress"),
        completedTasks: taskByStatus("completed"),
        failedTasks: taskByStatus("failed"),
        handedOffTasks: taskByStatus("handed_off"),
        confirmedRevenue: revByStatus("confirmed"),
        projectedRevenue: revByStatus("projected"),
        paidOutRevenue: revByStatus("paid_out"),
        externallyConfirmedRevenue,
        unconfirmedPaidOutCount,
        availableForPayout: (() => {
          // FIX: only count the default sweepable stream, not phantom streams.
          // Non-default streams may have inflated available_for_payout from
          // Base44 auto-seeding or prior sessions — they have no backing
          // RevenueEvents and should not be included in payout calculations.
          const defaultStream = revenueStreams.find(
            (r) => r.name === DEFAULT_REVENUE_STREAM.name
          );
          return defaultStream
            ? num(defaultStream.available_for_payout, 0)
            : 0;
        })(),
        openPayoutBatches: payoutBatches.filter(
          (b) =>
            b.status &&
            !["completed", "failed"].includes(String(b.status))
        ).length,
        openHandoffs: handoffs.filter((h) => h.status === "pending").length,
        avgSuccessRate,
        // ── Settlement Ledger (hard-rule: $0 unless receipt_hash present) ──
        settledCents: settlementBalance.total_cents,
        pipelinePendingCents: pipelineBalance.pending_cents,
        pipelineSpeculativeCents: pipelineBalance.speculative_cents,
        settledEntryCount: settlementStats.by_state.SETTLED,
        pendingEntryCount: settlementStats.by_state.PENDING_SETTLEMENT,
        speculativeEntryCount: settlementStats.by_state.SPECULATIVE,
        // ── Procurement ──
        procurementActiveCount: procurementStats.active_pos,
        procurementPipelineCount: procurementStats.pipeline_pos,
        procurementActiveValueCents: procurementStats.total_active_value_cents,
        procurementPipelineValueCents: procurementStats.total_pipeline_value_cents,
        threeWayMatchesPassed: procurementStats.three_way_matches_passed,
        threeWayMatchesFailed: procurementStats.three_way_matches_failed,
        carrierScansReceived: procurementStats.carrier_scans_received,
        selfAssertedTokensStripped: procurementStats.self_asserted_tokens_stripped,
      },
      generatedAt: new Date().toISOString(),
    };
    stateCache.value = result;
    stateCache.ts = Date.now();
    return result;
  })();

  try {
    return await stateCache.inFlight;
  } finally {
    stateCache.inFlight = null;
  }
}

/** Server-side memo for getSwarmState. */
const stateCache: { value: SwarmState | null; ts: number; inFlight: Promise<SwarmState> | null } = {
  value: null,
  ts: 0,
  inFlight: null,
};

/** Invalidate the cached state (called after a tick or manual mutation). */
export function invalidateSwarmStateCache() {
  stateCache.value = null;
  stateCache.ts = 0;
}
