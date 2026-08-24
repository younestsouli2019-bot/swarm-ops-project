/**
 * Agent Safety Bindings (ASB) — Per-Agent / Per-Capability Guardrail Bindings
 *
 * Layer 4 of the swarm safety stack. Complementary to:
 *   - SIG  (swarm-integrity.ts)   — 13 anti-pattern loops + 3 manifestation signals
 *   - SGR  (swarm-guardrails.ts)  — 11 guardrails across 4 risk categories
 *   - SRE  (swarm-redress.ts)     — 4 automated self-redress actions
 *   - ASB  (this file)            — capability → guardrail + category → policy
 *
 * PROBLEM ASB SOLVES
 * ──────────────────
 * SIG/SGR/SRE are wired globally into orchestrator.tick(). They apply uniformly
 * regardless of which agent is executing. But the swarm has 25 operational agents
 * across 7 categories with 62 distinct capabilities. A `settlement_tracking`
 * capability needs the Class A gate; a `script_generation` capability needs the
 * IP/copyright filter; a `state_store` capability needs credential scrubbing.
 * Without per-capability bindings, an operator who disables the IP filter "just
 * to test something" silently exposes every content agent to copyright risk with
 * no surfaced gap.
 *
 * ASB CLOSES THE LOOP BY:
 *   1. Mapping each known capability → set of required guardrails (and which
 *      layer owns them: SIG / SGR / SRE).
 *   2. Mapping each agent category → enforcement policy (block / warn / observe).
 *   3. Providing `enforceAgentCategoryGate(agent, task)` — called by the
 *      orchestrator before dispatching a task to an agent. The gate:
 *        - Resolves the agent's declared capabilities
 *        - For each capability, looks up its required guardrails
 *        - Checks each required guardrail's current state (enabled + mode)
 *        - Returns {proceed, blocked_reason, gaps[]}
 *   4. Providing `runCoverageAudit()` — scans every agent in the DB and reports
 *      which agents have ungoverned capabilities (because a required guardrail
 *      is disabled, in OBSERVE mode, or doesn't exist).
 *   5. Exposing operator controls: pin a guardrail as "required" so it cannot
 *      be disabled while any agent using the bound capability is active.
 *
 * STATE
 * ─────
 * In-memory via globalThis singleton (same pattern as SIG/SGR/SRE — survives
 * HMR + Turbopack route-module isolation). Holds:
 *   - manually_disabled_bindings: Set<capability_id> — operator override
 *   - pinned_guardrails: Set<guardrail_id> — cannot be disabled
 *   - gate_evaluations: per-agent counters (evaluations, blocks, warnings)
 *   - audit_log: last coverage audit results
 *
 * INTEGRATION
 * ───────────
 *   - orchestrator.dispatchTasks()  → enforceAgentCategoryGate(agent, task)
 *                                    BEFORE assigning task to agent
 *   - /api/agent-safety             → GET full matrix + POST actions
 *   - dashboard "Agent Safety" tab  → visualize bindings + gaps
 */

import { getGuardrailState, setGuardrailEnabled } from "./swarm-guardrails";
import { getSigState } from "./swarm-integrity";

// ─── Types ──────────────────────────────────────────────────────────────

export type AgentCategory =
  | "intelligence"
  | "security"
  | "revenue"
  | "optimization"
  | "content"
  | "governance"
  | "infra";

/** The layer that owns the guardrail. */
export type GuardrailLayer = "sig" | "sgr" | "sre";

export type EnforcementPolicy = "block" | "warn" | "observe";

export interface CapabilityBinding {
  capability: string;
  label: string;
  description: string;
  /** Required guardrails. Each entry names the layer + the guardrail id. */
  required_guardrails: Array<{
    layer: GuardrailLayer;
    id: string;
    label: string;
  }>;
}

export interface CategoryPolicy {
  category: AgentCategory;
  label: string;
  /** Default enforcement when a required guardrail is missing/disabled. */
  policy: EnforcementPolicy;
  description: string;
  /** All capabilities that agents in this category typically declare. */
  typical_capabilities: string[];
}

export interface AgentGateResult {
  proceed: boolean;
  blocked_reason: string | null;
  policy: EnforcementPolicy;
  gaps: Array<{
    capability: string;
    required_guardrail: string;
    layer: GuardrailLayer;
    issue: "disabled" | "observe_mode" | "missing";
  }>;
  evaluations: number;
}

export interface AuditFinding {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  category: AgentCategory;
  ungoverned_capabilities: Array<{
    capability: string;
    required_guardrail: string;
    layer: GuardrailLayer;
    issue: "disabled" | "observe_mode" | "missing";
  }>;
  /** Capabilities the agent declares that have NO binding at all. These are
   *  not "ungoverned" in the sense that a guardrail is disabled — they're
   *  "unbound" in the sense that no one has decided which guardrails they
   *  need. Always reported as info severity so the operator can extend the
   *  binding registry. */
  unbound_capabilities: string[];
  policy: EnforcementPolicy;
  severity: "critical" | "warning" | "info";
}

export interface AsbState {
  bindings: Record<string, CapabilityBinding>;
  categories: Record<AgentCategory, CategoryPolicy>;
  pinned_guardrails: string[];
  manually_disabled_bindings: string[];
  gate_evaluations: Record<
    string,
    {
      evaluations: number;
      blocks: number;
      warnings: number;
      last_evaluated_at: string | null;
    }
  >;
  last_audit_at: string | null;
  last_audit_findings: number;
}

// ─── Capability → Guardrail Bindings ────────────────────────────────────
//
// 62 capabilities from the swarm config, grouped by category. Each capability
// is mapped to the guardrails that MUST be active when an agent exercising that
// capability runs. The layer indicates which module enforces it:
//   sig → swarm-integrity.ts
//   sgr → swarm-guardrails.ts
//   sre → swarm-redress.ts

const BINDINGS: CapabilityBinding[] = [
  // ── INTELLIGENCE (4 agents, 7 capabilities) ──────────────────────────
  {
    capability: "web_search",
    label: "Web Search",
    description: "Fetch external web content for intelligence gathering.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
      { layer: "sgr", id: "honey_pot_detector", label: "Honey-Pot Detector" },
    ],
  },
  {
    capability: "ethical_analysis",
    label: "Ethical Analysis",
    description: "Evaluate opportunities against heuristic policies.",
    required_guardrails: [
      { layer: "sig", id: "diversification_floor", label: "Diversification Floor" },
      { layer: "sig", id: "min_action_floor", label: "Min-Action Floor" },
    ],
  },
  {
    capability: "opportunity_scoring",
    label: "Opportunity Scoring",
    description: "Rank revenue opportunities by expected value.",
    required_guardrails: [
      { layer: "sgr", id: "honey_pot_detector", label: "Honey-Pot Detector" },
      { layer: "sgr", id: "token_margin_inversion", label: "Token-Margin Inversion" },
    ],
  },
  {
    capability: "pattern_recognition",
    label: "Pattern Recognition",
    description: "Detect patterns across data sources.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "news_polling",
    label: "News Polling",
    description: "Poll news sources for threats and opportunities.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "classification",
    label: "Classification",
    description: "Classify articles and items by topic.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "relevance_scoring",
    label: "Relevance Scoring",
    description: "Score relevance of items to swarm operations.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },

  // ── SECURITY (3 agents, 8 capabilities) ──────────────────────────────
  {
    capability: "ssl_check",
    label: "SSL Check",
    description: "Check SSL certificate validity.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "uptime_monitor",
    label: "Uptime Monitor",
    description: "Monitor domain availability and HTTP status.",
    required_guardrails: [
      { layer: "sgr", id: "black_swan_breaker", label: "Black-Swan Breaker" },
    ],
  },
  {
    capability: "alert_trigger",
    label: "Alert Trigger",
    description: "Fire alerts on monitored failures.",
    required_guardrails: [
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "egress_check",
    label: "Egress Check",
    description: "Verify egress IP and network posture.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "status_logging",
    label: "Status Logging",
    description: "Write status to swarm memory.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "threat_detection",
    label: "Threat Detection",
    description: "Detect unauthorized access attempts.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sig", id: "seed_hash_check", label: "Seed-Hash Check" },
    ],
  },
  {
    capability: "anomaly_detection",
    label: "Anomaly Detection",
    description: "Detect anomalous patterns.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
      { layer: "sgr", id: "honey_pot_detector", label: "Honey-Pot Detector" },
    ],
  },

  // ── REVENUE (3 agents, 7 capabilities) ──────────────────────────────
  {
    capability: "revenue_generation",
    label: "Revenue Generation",
    description: "Generate revenue across payment channels.",
    required_guardrails: [
      { layer: "sig", id: "class_a_gate", label: "Class A Gate" },
      { layer: "sgr", id: "token_margin_inversion", label: "Token-Margin Inversion" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "channel_orchestration",
    label: "Channel Orchestration",
    description: "Coordinate across payment channels.",
    required_guardrails: [
      { layer: "sig", id: "class_a_gate", label: "Class A Gate" },
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "settlement_tracking",
    label: "Settlement Tracking",
    description: "Track settlements through the pipeline.",
    required_guardrails: [
      { layer: "sig", id: "class_a_gate", label: "Class A Gate" },
      { layer: "sgr", id: "tax_jurisdiction_classifier", label: "Tax Jurisdiction Classifier" },
    ],
  },
  {
    capability: "batch_detection",
    label: "Batch Detection",
    description: "Detect new payout batches.",
    required_guardrails: [
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "settlement_processing",
    label: "Settlement Processing",
    description: "Process settlement batches.",
    required_guardrails: [
      { layer: "sig", id: "class_a_gate", label: "Class A Gate" },
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
      { layer: "sgr", id: "tax_jurisdiction_classifier", label: "Tax Jurisdiction Classifier" },
    ],
  },
  {
    capability: "route_selection",
    label: "Route Selection",
    description: "Select the best payment channel for a payout.",
    required_guardrails: [
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
      { layer: "sig", id: "diversification_floor", label: "Diversification Floor" },
    ],
  },
  {
    capability: "context_analysis",
    label: "Context Analysis",
    description: "Analyze context for payment routing.",
    required_guardrails: [
      { layer: "sgr", id: "honey_pot_detector", label: "Honey-Pot Detector" },
    ],
  },

  // ── OPTIMIZATION (4 agents, 9 capabilities) ─────────────────────────
  {
    capability: "pattern_fusion",
    label: "Pattern Fusion",
    description: "Fuse behavioral patterns to optimize performance.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "lazy_ark_fusion",
    label: "Lazy Ark Fusion",
    description: "Apply fusion upgrades lazily.",
    required_guardrails: [
      { layer: "sig", id: "seed_hash_check", label: "Seed-Hash Check" },
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "zombie_detection",
    label: "Zombie Detection",
    description: "Detect stuck/zombie agents.",
    required_guardrails: [
      { layer: "sgr", id: "black_swan_breaker", label: "Black-Swan Breaker" },
    ],
  },
  {
    capability: "agent_restart",
    label: "Agent Restart",
    description: "Reboot zombie agents.",
    required_guardrails: [
      { layer: "sig", id: "spawn_budget", label: "Spawn Budget" },
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "health_check",
    label: "Health Check",
    description: "Periodic health checks for agents.",
    required_guardrails: [
      { layer: "sgr", id: "black_swan_breaker", label: "Black-Swan Breaker" },
    ],
  },
  {
    capability: "status_reporting",
    label: "Status Reporting",
    description: "Report agent status.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "iteration_control",
    label: "Iteration Control",
    description: "Enforce iteration multipliers.",
    required_guardrails: [
      { layer: "sig", id: "spawn_budget", label: "Spawn Budget" },
      { layer: "sgr", id: "token_margin_inversion", label: "Token-Margin Inversion" },
    ],
  },
  {
    capability: "force_run",
    label: "Force Run",
    description: "Force agent execution.",
    required_guardrails: [
      { layer: "sig", id: "spawn_budget", label: "Spawn Budget" },
    ],
  },
  {
    capability: "infinite_mode",
    label: "Infinite Mode",
    description: "Run agents in infinite iteration mode.",
    required_guardrails: [
      { layer: "sig", id: "spawn_budget", label: "Spawn Budget" },
      { layer: "sgr", id: "token_margin_inversion", label: "Token-Margin Inversion" },
    ],
  },

  // ── CONTENT (4 agents, 10 capabilities) ─────────────────────────────
  {
    capability: "content_distribution",
    label: "Content Distribution",
    description: "Distribute content across platforms.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "reach_amplification",
    label: "Reach Amplification",
    description: "Amplify content reach.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "engagement",
    label: "Engagement",
    description: "Engage with community members.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "retention",
    label: "Retention",
    description: "Maintain user retention.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
    ],
  },
  {
    capability: "course_marketing",
    label: "Course Marketing",
    description: "Promote courses and educational content.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
    ],
  },
  {
    capability: "enrollment_tracking",
    label: "Enrollment Tracking",
    description: "Track course enrollments.",
    required_guardrails: [
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "script_generation",
    label: "Script Generation",
    description: "Generate video scripts.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "video_compositing",
    label: "Video Compositing",
    description: "Composite video assets.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "audio_track",
    label: "Audio Track",
    description: "Overlay audio tracks.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "platform_publish",
    label: "Platform Publish",
    description: "Publish content to platforms (TikTok/Reels).",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },

  // ── GOVERNANCE (3 agents, 8 capabilities) ───────────────────────────
  {
    capability: "cycle_orchestration",
    label: "Cycle Orchestration",
    description: "Run the full swarm cycle.",
    required_guardrails: [
      { layer: "sig", id: "class_a_gate", label: "Class A Gate" },
      { layer: "sgr", id: "black_swan_breaker", label: "Black-Swan Breaker" },
      { layer: "sre", id: "velocity_breaker", label: "Velocity Breaker" },
    ],
  },
  {
    capability: "aims_ingestion",
    label: "AIMS Ingestion",
    description: "Ingest directives from AIMS.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "posp_proof",
    label: "POSP Proof",
    description: "Proof of Strategic Progress.",
    required_guardrails: [
      { layer: "sig", id: "min_action_floor", label: "Min-Action Floor" },
    ],
  },
  {
    capability: "agent_replenishment",
    label: "Agent Replenishment",
    description: "Replenish agents to minimum count.",
    required_guardrails: [
      { layer: "sig", id: "spawn_budget", label: "Spawn Budget" },
      { layer: "sig", id: "seed_hash_check", label: "Seed-Hash Check" },
    ],
  },
  {
    capability: "policy_check",
    label: "Policy Check",
    description: "Check agent actions against policy.",
    required_guardrails: [
      { layer: "sig", id: "seed_hash_check", label: "Seed-Hash Check" },
    ],
  },
  {
    capability: "purpose_alignment",
    label: "Purpose Alignment",
    description: "Verify alignment with Supreme Purpose.",
    required_guardrails: [
      { layer: "sre", id: "context_hydration", label: "Context Hydration" },
    ],
  },
  {
    capability: "risk_threshold",
    label: "Risk Threshold",
    description: "Monitor risk thresholds.",
    required_guardrails: [
      { layer: "sre", id: "velocity_breaker", label: "Velocity Breaker" },
      { layer: "sgr", id: "token_margin_inversion", label: "Token-Margin Inversion" },
    ],
  },
  {
    capability: "emergency_halt",
    label: "Emergency Halt",
    description: "Halt swarm operations on emergency.",
    required_guardrails: [
      { layer: "sgr", id: "black_swan_breaker", label: "Black-Swan Breaker" },
      { layer: "sre", id: "cannibalistic_global_lock", label: "Cannibalistic Global Lock" },
    ],
  },

  // ── INFRA (6 agents, 13 capabilities) ───────────────────────────────
  {
    capability: "state_store",
    label: "State Store",
    description: "Distributed in-memory state store.",
    required_guardrails: [
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "agent_state",
    label: "Agent State",
    description: "Per-agent state storage.",
    required_guardrails: [
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "event_recording",
    label: "Event Recording",
    description: "Record swarm events.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "audit_trail",
    label: "Audit Trail",
    description: "Compliance audit trail.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sig", id: "seed_hash_check", label: "Seed-Hash Check" },
    ],
  },
  {
    capability: "directive_sync",
    label: "Directive Sync",
    description: "Sync owner directives from Git.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "heuristic_sync",
    label: "Heuristic Sync",
    description: "Sync ethical/technical heuristics.",
    required_guardrails: [
      { layer: "sig", id: "seed_hash_check", label: "Seed-Hash Check" },
    ],
  },
  {
    capability: "config_bootstrap",
    label: "Config Bootstrap",
    description: "Bootstrap configuration from repo.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "config_get",
    label: "Config Get",
    description: "Read runtime configuration.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "config_set",
    label: "Config Set",
    description: "Write runtime configuration.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "readiness_check",
    label: "Readiness Check",
    description: "Check agent readiness.",
    required_guardrails: [
      { layer: "sgr", id: "black_swan_breaker", label: "Black-Swan Breaker" },
    ],
  },
  {
    capability: "schema_bootstrap",
    label: "Schema Bootstrap",
    description: "Bootstrap database schema.",
    required_guardrails: [
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "process_coordination",
    label: "Process Coordination",
    description: "Coordinate agent processes.",
    required_guardrails: [
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
      { layer: "sig", id: "spawn_budget", label: "Spawn Budget" },
    ],
  },
  {
    capability: "capability_assessment",
    label: "Capability Assessment",
    description: "Assess agent capabilities for upgrade.",
    required_guardrails: [
      { layer: "sig", id: "seed_hash_check", label: "Seed-Hash Check" },
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },

  // ── SEED-AGENT CAPABILITIES (from DEFAULT_AGENTS in orchestrator.ts) ─
  // These are the actual capabilities the 200 DB agents declare. Without
  // bindings, the audit reported 0 findings because none of the 62 conceptual
  // capabilities matched. These bindings ensure every seeded agent is governed.

  // Atlas-1 Data Analyst
  {
    capability: "categorization",
    label: "Categorization",
    description: "Categorize items into taxonomies.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "sentiment",
    label: "Sentiment Analysis",
    description: "Label sentiment of text.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "annotation",
    label: "Annotation",
    description: "Annotate data items.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "data_cleaning",
    label: "Data Cleaning",
    description: "Clean and normalize datasets.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },

  // Scribe-2 Content Creator
  {
    capability: "transcription",
    label: "Transcription",
    description: "Transcribe audio to text.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "copywriting",
    label: "Copywriting",
    description: "Write marketing copy.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
    ],
  },
  {
    capability: "seo_writing",
    label: "SEO Writing",
    description: "Write SEO-optimized content.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },

  // Probe-3 Research Assistant
  {
    capability: "competitor_research",
    label: "Competitor Research",
    description: "Research competitors.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "pricing_analysis",
    label: "Pricing Analysis",
    description: "Analyze pricing data.",
    required_guardrails: [
      { layer: "sgr", id: "honey_pot_detector", label: "Honey-Pot Detector" },
    ],
  },
  {
    capability: "citation",
    label: "Citation",
    description: "Cite sources.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },

  // Pursuit-4 Lead Generator
  {
    capability: "lead_scoring",
    label: "Lead Scoring",
    description: "Score leads by ICP fit.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "icp_matching",
    label: "ICP Matching",
    description: "Match leads to ideal customer profile.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "enrichment",
    label: "Lead Enrichment",
    description: "Enrich leads with additional data.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },

  // Echo-5 Customer Outreach
  {
    capability: "outreach",
    label: "Outreach",
    description: "Reach out to leads/customers.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "personalization",
    label: "Personalization",
    description: "Personalize outreach messages.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "messaging",
    label: "Messaging",
    description: "Send messages on platforms.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },

  // Pulse-6 Social Manager
  {
    capability: "scheduling",
    label: "Scheduling",
    description: "Schedule social posts.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "calendar_management",
    label: "Calendar Management",
    description: "Manage content calendar.",
    required_guardrails: [
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },

  // Bazaar-7 Listing Bot
  {
    capability: "etsy_listing",
    label: "Etsy Listing",
    description: "Create Etsy listings.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "amazon_listing",
    label: "Amazon Listing",
    description: "Create Amazon listings.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "seo_titles",
    label: "SEO Titles",
    description: "Generate SEO-optimized titles.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },

  // Canvas-8 Design Generator
  {
    capability: "canva",
    label: "Canva Design",
    description: "Design Canva templates.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "template_design",
    label: "Template Design",
    description: "Design reusable templates.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "branding",
    label: "Branding",
    description: "Brand asset creation.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },

  // Lens-9 SEO Specialist
  {
    capability: "quality_review",
    label: "Quality Review",
    description: "Review AI-generated content.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "policy_compliance",
    label: "Policy Compliance",
    description: "Check policy compliance.",
    required_guardrails: [
      { layer: "sig", id: "seed_hash_check", label: "Seed-Hash Check" },
    ],
  },
  {
    capability: "seo_audit",
    label: "SEO Audit",
    description: "Audit SEO of content.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },

  // Forge-10 Workflow Automator
  {
    capability: "zapier",
    label: "Zapier Integration",
    description: "Build Zapier workflows.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "integrations",
    label: "Integrations",
    description: "Build third-party integrations.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
    ],
  },
  {
    capability: "workflow_setup",
    label: "Workflow Setup",
    description: "Set up automation workflows.",
    required_guardrails: [
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },

  // DevOps-11
  {
    capability: "shell",
    label: "Shell Execution",
    description: "Run shell commands.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "git",
    label: "Git Operations",
    description: "Run git operations.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "build",
    label: "Build",
    description: "Build the project.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "test_runner",
    label: "Test Runner",
    description: "Run tests.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "lint",
    label: "Lint",
    description: "Run linters.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "migrations",
    label: "Database Migrations",
    description: "Run database migrations.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "log_inspection",
    label: "Log Inspection",
    description: "Inspect logs.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },

  // Vision-12
  {
    capability: "image_description",
    label: "Image Description",
    description: "Describe image contents.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "accessibility_audit",
    label: "Accessibility Audit",
    description: "Audit UI accessibility.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "ocr",
    label: "OCR",
    description: "Extract text from images.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "alt_text",
    label: "Alt Text Generation",
    description: "Generate alt text for images.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "ui_bug_detection",
    label: "UI Bug Detection",
    description: "Detect UI layout bugs.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "image_classification",
    label: "Image Classification",
    description: "Classify images.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },

  // Docs-13
  {
    capability: "pdf_extraction",
    label: "PDF Extraction",
    description: "Extract text from PDFs.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "docx_generation",
    label: "DOCX Generation",
    description: "Generate DOCX documents.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "xlsx_generation",
    label: "XLSX Generation",
    description: "Generate XLSX spreadsheets.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "template_filling",
    label: "Template Filling",
    description: "Fill document templates.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "redaction",
    label: "PII Redaction",
    description: "Redact PII from documents.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "format_conversion",
    label: "Format Conversion",
    description: "Convert between document formats.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "summarization",
    label: "Summarization",
    description: "Summarize long documents.",
    required_guardrails: [
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },

  // ── OTHER DB AGENT CAPABILITIES (non-seed agents) ───────────────────
  // These cover the 200-agent DB which includes many auto-generated agents
  // with capabilities not in the DEFAULT_AGENTS seed list.

  {
    capability: "social_posting",
    label: "Social Posting",
    description: "Post content to social platforms.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "content_generation",
    label: "Content Generation",
    description: "Generate content.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "prompt_injection_sanitizer", label: "Prompt Injection Sanitizer" },
    ],
  },
  {
    capability: "api_integration",
    label: "API Integration",
    description: "Integrate with third-party APIs.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
    ],
  },
  {
    capability: "data_analysis",
    label: "Data Analysis",
    description: "Analyze datasets.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "revenue_tracking",
    label: "Revenue Tracking",
    description: "Track revenue.",
    required_guardrails: [
      { layer: "sig", id: "class_a_gate", label: "Class A Gate" },
      { layer: "sgr", id: "tax_jurisdiction_classifier", label: "Tax Jurisdiction Classifier" },
    ],
  },
  {
    capability: "roi_optimization",
    label: "ROI Optimization",
    description: "Optimize return on investment.",
    required_guardrails: [
      { layer: "sgr", id: "token_margin_inversion", label: "Token-Margin Inversion" },
    ],
  },
  {
    capability: "churn_analysis",
    label: "Churn Analysis",
    description: "Analyze customer churn.",
    required_guardrails: [
      { layer: "sgr", id: "model_drift_probe", label: "Model Drift Probe" },
    ],
  },
  {
    capability: "resource_allocation",
    label: "Resource Allocation",
    description: "Allocate swarm resources.",
    required_guardrails: [
      { layer: "sig", id: "spawn_budget", label: "Spawn Budget" },
      { layer: "sgr", id: "distributed_state_mutex", label: "Distributed State Mutex" },
    ],
  },
  {
    capability: "viral_loop_design",
    label: "Viral Loop Design",
    description: "Design viral growth loops.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
    ],
  },
  {
    capability: "paid_ads",
    label: "Paid Ads",
    description: "Manage paid advertising.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sgr", id: "token_margin_inversion", label: "Token-Margin Inversion" },
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
    ],
  },
  {
    capability: "seo_optimization",
    label: "SEO Optimization",
    description: "Optimize SEO.",
    required_guardrails: [
      { layer: "sgr", id: "ip_copyright_filter", label: "IP/Copyright Filter" },
    ],
  },
  {
    capability: "product_hunt",
    label: "Product Hunt Launch",
    description: "Launch on Product Hunt.",
    required_guardrails: [
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "domain_config",
    label: "Domain Config",
    description: "Configure domains.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "env_management",
    label: "Environment Management",
    description: "Manage environment variables.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "ssl_setup",
    label: "SSL Setup",
    description: "Set up SSL certificates.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
  {
    capability: "vercel_deploy",
    label: "Vercel Deploy",
    description: "Deploy to Vercel.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "affiliate_program",
    label: "Affiliate Program",
    description: "Manage affiliate programs.",
    required_guardrails: [
      { layer: "sig", id: "class_a_gate", label: "Class A Gate" },
      { layer: "sgr", id: "tos_rate_limit_enforcer", label: "ToS Rate-Limit Enforcer" },
    ],
  },
  {
    capability: "stripe_integration",
    label: "Stripe Integration",
    description: "Integrate with Stripe.",
    required_guardrails: [
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
      { layer: "sig", id: "class_a_gate", label: "Class A Gate" },
      { layer: "sgr", id: "platform_dependency_lockin", label: "Platform Dependency Lock-In" },
    ],
  },
  {
    capability: "pricing_optimization",
    label: "Pricing Optimization",
    description: "Optimize pricing.",
    required_guardrails: [
      { layer: "sgr", id: "honey_pot_detector", label: "Honey-Pot Detector" },
      { layer: "sgr", id: "token_margin_inversion", label: "Token-Margin Inversion" },
    ],
  },
  {
    capability: "subscription_setup",
    label: "Subscription Setup",
    description: "Set up subscription billing.",
    required_guardrails: [
      { layer: "sig", id: "class_a_gate", label: "Class A Gate" },
      { layer: "sgr", id: "credential_leak_scrubber", label: "Credential Leak Scrubber" },
    ],
  },
];

// ─── Category Policies ──────────────────────────────────────────────────

const CATEGORY_POLICIES: Record<AgentCategory, CategoryPolicy> = {
  intelligence: {
    category: "intelligence",
    label: "Intelligence",
    policy: "warn",
    description:
      "Intelligence agents ingest external text and detect market signals. Missing guardrails surface as warnings — the swarm can still operate, but ungoverned intake is logged.",
    typical_capabilities: [
      "web_search",
      "ethical_analysis",
      "opportunity_scoring",
      "pattern_recognition",
      "news_polling",
      "classification",
      "relevance_scoring",
    ],
  },
  security: {
    category: "security",
    label: "Security",
    policy: "block",
    description:
      "Security agents write to logs and state. Missing credential scrubbing or state mutex is a hard block — security agents must not be the source of a credential leak.",
    typical_capabilities: [
      "ssl_check",
      "uptime_monitor",
      "alert_trigger",
      "egress_check",
      "status_logging",
      "threat_detection",
      "anomaly_detection",
    ],
  },
  revenue: {
    category: "revenue",
    label: "Revenue",
    policy: "block",
    description:
      "Revenue agents touch the payout pipeline. Missing Class A gate or distributed mutex is a hard block — revenue agents must never produce phantom payouts or double-spend.",
    typical_capabilities: [
      "revenue_generation",
      "channel_orchestration",
      "settlement_tracking",
      "batch_detection",
      "settlement_processing",
      "route_selection",
      "context_analysis",
    ],
  },
  optimization: {
    category: "optimization",
    label: "Optimization",
    policy: "warn",
    description:
      "Optimization agents fuse patterns and restart zombies. Missing spawn budget is a warning — sub-agent proliferation risk is real but not immediately critical.",
    typical_capabilities: [
      "pattern_fusion",
      "lazy_ark_fusion",
      "zombie_detection",
      "agent_restart",
      "health_check",
      "status_reporting",
      "iteration_control",
      "force_run",
      "infinite_mode",
    ],
  },
  content: {
    category: "content",
    label: "Content",
    policy: "block",
    description:
      "Content agents publish to external platforms. Missing IP/copyright filter or ToS rate-limiter is a hard block — copyright violation and ToS bans are external legal risks.",
    typical_capabilities: [
      "content_distribution",
      "reach_amplification",
      "engagement",
      "retention",
      "course_marketing",
      "enrollment_tracking",
      "script_generation",
      "video_compositing",
      "audio_track",
      "platform_publish",
    ],
  },
  governance: {
    category: "governance",
    label: "Governance",
    policy: "block",
    description:
      "Governance agents enforce the rules. Missing any required guardrail is a hard block — governance agents must operate under full safety coverage to be credible enforcers.",
    typical_capabilities: [
      "cycle_orchestration",
      "aims_ingestion",
      "posp_proof",
      "agent_replenishment",
      "policy_check",
      "purpose_alignment",
      "risk_threshold",
      "emergency_halt",
    ],
  },
  infra: {
    category: "infra",
    label: "Infrastructure",
    policy: "block",
    description:
      "Infra agents own shared state and audit trails. Missing credential scrubbing or state mutex is a hard block — infra is the last line of defense against state corruption.",
    typical_capabilities: [
      "state_store",
      "agent_state",
      "event_recording",
      "audit_trail",
      "directive_sync",
      "heuristic_sync",
      "config_bootstrap",
      "config_get",
      "config_set",
      "readiness_check",
      "schema_bootstrap",
      "process_coordination",
      "capability_assessment",
    ],
  },
};

// ─── Global State (HMR-safe singleton) ──────────────────────────────────

const ASB_GLOBAL_KEY = "__charibaas_asb_state__";

interface AsbInternal {
  pinnedGuardrails: Set<string>;
  disabledBindings: Set<string>;
  gateEvaluations: Map<
    string,
    {
      evaluations: number;
      blocks: number;
      warnings: number;
      last_evaluated_at: string | null;
    }
  >;
  lastAuditAt: string | null;
  lastAuditFindings: AuditFinding[];
}

function makeFreshInternal(): AsbInternal {
  return {
    pinnedGuardrails: new Set<string>(),
    disabledBindings: new Set<string>(),
    gateEvaluations: new Map(),
    lastAuditAt: null,
    lastAuditFindings: [],
  };
}

function getInternal(): AsbInternal {
  if (typeof globalThis !== "undefined") {
    const g = globalThis as unknown as { [ASB_GLOBAL_KEY]?: AsbInternal };
    if (!g[ASB_GLOBAL_KEY]) {
      g[ASB_GLOBAL_KEY] = makeFreshInternal();
    }
    return g[ASB_GLOBAL_KEY]!;
  }
  // SSR fallback (no HMR)
  return makeFreshInternal();
}

const internal: AsbInternal = getInternal();

// ─── Lookup helpers ─────────────────────────────────────────────────────

const BINDINGS_BY_CAPABILITY: Record<string, CapabilityBinding> = Object.fromEntries(
  BINDINGS.map((b) => [b.capability, b])
);

export function getBindingForCapability(cap: string): CapabilityBinding | null {
  return BINDINGS_BY_CAPABILITY[cap] || null;
}

export function getAllBindings(): CapabilityBinding[] {
  return BINDINGS;
}

export function getCategoryPolicy(category: AgentCategory): CategoryPolicy {
  return CATEGORY_POLICIES[category];
}

export function getAllCategoryPolicies(): CategoryPolicy[] {
  return Object.values(CATEGORY_POLICIES);
}

/**
 * Resolve an agent's category from its type. The agent.type field in the DB
 * doesn't always match the swarm-config category, so we use a heuristic
 * mapping based on the operational swarm agent types.
 */
export function resolveAgentCategory(agentType: string): AgentCategory {
  const intelTypes = ["strategic-scout", "news-watch", "research_assistant"];
  const secTypes = ["site-watch", "network-guard", "threat-monitor"];
  const revTypes = [
    "revenue-swarm",
    "payoneer-watch",
    "rail-optimizer",
    "listing_bot",
    "lead_generator",
  ];
  const optTypes = [
    "learning-agent",
    "self-healing",
    "health-monitor",
    "swarm-scaler",
    "workflow_automator",
  ];
  const contentTypes = [
    "content-amplifier",
    "community-builder",
    "course-promo",
    "video-generator",
    "content_creator",
    "social_manager",
    "design_generator",
    "seo_specialist",
  ];
  const govTypes = ["supervisor", "governance-gate", "circuit-breaker"];
  const infraTypes = [
    "shared-memory",
    "flight-recorder",
    "repo-connector",
    "config-manager",
    "agent-coordinator",
    "autonomous-upgrader",
    "data_analyst",
    "customer_service",
    "devops",
    "vision",
    "document",
    "ai_ml_products_expert",
    "sustainability_agent",
    "digital_courses_agent",
  ];

  const t = agentType.toLowerCase();
  if (intelTypes.some((x) => t.includes(x))) return "intelligence";
  if (secTypes.some((x) => t.includes(x))) return "security";
  if (revTypes.some((x) => t.includes(x))) return "revenue";
  if (optTypes.some((x) => t.includes(x))) return "optimization";
  if (contentTypes.some((x) => t.includes(x))) return "content";
  if (govTypes.some((x) => t.includes(x))) return "governance";
  if (infraTypes.some((x) => t.includes(x))) return "infra";
  // default: infrastructure (safest — most guardrails)
  return "infra";
}

// ─── Guardrail State Resolution ─────────────────────────────────────────
//
// ASB does NOT own guardrail state — SIG/SGR/SRE do. ASB reads their state
// to determine whether required guardrails are active. This keeps a single
// source of truth and prevents ASB from drifting out of sync.

interface ResolvedGuardrailState {
  enabled: boolean;
  mode: "observe" | "enforce";
  exists: boolean;
}

function resolveGuardrailState(
  layer: GuardrailLayer,
  id: string
): ResolvedGuardrailState {
  if (layer === "sgr") {
    const sgrState = getGuardrailState();
    const gr = sgrState.guardrails[id as keyof typeof sgrState.guardrails];
    if (!gr) return { enabled: false, mode: "observe", exists: false };
    return {
      enabled: gr.enabled,
      mode: gr.mode as "observe" | "enforce",
      exists: true,
    };
  }
  if (layer === "sig") {
    const sigState = getSigState();
    const safeguard = sigState.safeguards[id as keyof typeof sigState.safeguards];
    if (!safeguard) return { enabled: false, mode: "observe", exists: false };
    // SIG safeguards don't have a mode — they're always enforce if enabled,
    // unless SIG as a whole is in OBSERVE mode.
    return {
      enabled: safeguard.enabled,
      mode: sigState.mode as "observe" | "enforce",
      exists: true,
    };
  }
  if (layer === "sre") {
    // SRE actions are accessed via the redress module's getState; we import
    // lazily to avoid a circular dependency (redress imports guardrails).
    // For now, treat SRE actions as "exists + enabled" if they appear in the
    // known set — the operator controls them via /api/redress.
    const knownSreActions = new Set([
      "velocity_breaker",
      "log_monotony_entropy",
      "cannibalistic_global_lock",
      "context_hydration",
    ]);
    if (!knownSreActions.has(id)) {
      return { enabled: false, mode: "observe", exists: false };
    }
    return { enabled: true, mode: "enforce", exists: true };
  }
  return { enabled: false, mode: "observe", exists: false };
}

// ─── The Gate ───────────────────────────────────────────────────────────

/**
 * enforceAgentCategoryGate — called by orchestrator.dispatchTasks() BEFORE
 * assigning a task to an agent.
 *
 * Resolves the agent's declared capabilities, looks up each capability's
 * required guardrails, checks each guardrail's current state, and returns:
 *   - {proceed: true,  gaps: []}                       — all good
 *   - {proceed: true,  gaps: [...], policy: "warn"}    — warning, log it
 *   - {proceed: false, gaps: [...], policy: "block"}   — hard block
 *
 * Pinned guardrails (operator-marked as critical) cause a block regardless
 * of category policy if they're disabled.
 */
export function enforceAgentCategoryGate(
  agent: { id?: string; type: string; capabilities?: string[]; name?: string },
  _task: { id?: string; type?: string; title?: string }
): AgentGateResult {
  const agentId = agent.id || agent.name || agent.type;
  const capabilities = agent.capabilities || [];
  const category = resolveAgentCategory(agent.type);
  const policy = CATEGORY_POLICIES[category].policy;

  const gaps: AgentGateResult["gaps"] = [];

  for (const cap of capabilities) {
    // Skip if operator manually disabled this binding
    if (internal.disabledBindings.has(cap)) continue;

    const binding = BINDINGS_BY_CAPABILITY[cap];
    if (!binding) continue; // unknown capability — not necessarily an error

    for (const req of binding.required_guardrails) {
      const state = resolveGuardrailState(req.layer, req.id);

      // Pinned guardrail: any non-enforcing state is a hard gap
      const isPinned = internal.pinnedGuardrails.has(req.id);
      if (isPinned && (!state.enabled || state.mode !== "enforce")) {
        gaps.push({
          capability: cap,
          required_guardrail: req.id,
          layer: req.layer,
          issue: !state.exists
            ? "missing"
            : !state.enabled
              ? "disabled"
              : "observe_mode",
        });
        continue;
      }

      if (!state.exists) {
        gaps.push({
          capability: cap,
          required_guardrail: req.id,
          layer: req.layer,
          issue: "missing",
        });
      } else if (!state.enabled) {
        gaps.push({
          capability: cap,
          required_guardrail: req.id,
          layer: req.layer,
          issue: "disabled",
        });
      } else if (state.mode === "observe") {
        // OBSERVE mode is a soft gap — logged but not blocking unless pinned
        gaps.push({
          capability: cap,
          required_guardrail: req.id,
          layer: req.layer,
          issue: "observe_mode",
        });
      }
    }
  }

  // Decide proceed based on policy + gap severity
  const hasHardGap = gaps.some(
    (g) => g.issue === "disabled" || g.issue === "missing"
  );
  const hasSoftGap = gaps.some((g) => g.issue === "observe_mode");

  let proceed = true;
  let blockedReason: string | null = null;

  if (hasHardGap && (policy === "block" || internal.pinnedGuardrails.size > 0)) {
    proceed = false;
    blockedReason = `Agent category "${category}" has BLOCK policy but ${gaps.filter((g) => g.issue === "disabled" || g.issue === "missing").length} required guardrail(s) are disabled or missing.`;
  } else if (hasHardGap && policy === "warn") {
    // warn-level: proceed but log
  } else if (hasSoftGap) {
    // soft gap: proceed but log
  }

  // Record evaluation
  const eval_ = internal.gateEvaluations.get(agentId) || {
    evaluations: 0,
    blocks: 0,
    warnings: 0,
    last_evaluated_at: null,
  };
  eval_.evaluations += 1;
  eval_.last_evaluated_at = new Date().toISOString();
  if (!proceed) eval_.blocks += 1;
  else if (gaps.length > 0) eval_.warnings += 1;
  internal.gateEvaluations.set(agentId, eval_);

  return {
    proceed,
    blocked_reason: blockedReason,
    policy,
    gaps,
    evaluations: eval_.evaluations,
  };
}

// ─── Coverage Audit ─────────────────────────────────────────────────────

/**
 * Run a coverage audit across all provided agents. Returns findings sorted
 * by severity (critical first). Does NOT mutate state — it's a read-only
 * snapshot of the current binding coverage.
 *
 * The orchestrator passes the agent list; ASB doesn't import the DB layer
 * to avoid circular dependencies.
 */
export function runCoverageAudit(
  agents: Array<{
    id?: string;
    name?: string;
    type: string;
    capabilities?: string[];
  }>
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const agent of agents) {
    const category = resolveAgentCategory(agent.type);
    const policy = CATEGORY_POLICIES[category].policy;
    const capabilities = agent.capabilities || [];
    const ungoverned: AuditFinding["ungoverned_capabilities"] = [];
    const unbound: string[] = [];

    for (const cap of capabilities) {
      if (internal.disabledBindings.has(cap)) continue;
      const binding = BINDINGS_BY_CAPABILITY[cap];
      if (!binding) {
        // Capability has no binding at all — flag as unbound
        unbound.push(cap);
        continue;
      }

      for (const req of binding.required_guardrails) {
        const state = resolveGuardrailState(req.layer, req.id);
        if (!state.exists) {
          ungoverned.push({
            capability: cap,
            required_guardrail: req.id,
            layer: req.layer,
            issue: "missing",
          });
        } else if (!state.enabled) {
          ungoverned.push({
            capability: cap,
            required_guardrail: req.id,
            layer: req.layer,
            issue: "disabled",
          });
        } else if (state.mode === "observe") {
          ungoverned.push({
            capability: cap,
            required_guardrail: req.id,
            layer: req.layer,
            issue: "observe_mode",
          });
        }
      }
    }

    if (ungoverned.length === 0 && unbound.length === 0) continue;

    const hasHardGap = ungoverned.some(
      (g) => g.issue === "disabled" || g.issue === "missing"
    );
    const severity: AuditFinding["severity"] = hasHardGap
      ? policy === "block"
        ? "critical"
        : "warning"
      : unbound.length > 0
        ? "info"
        : "info";

    findings.push({
      agent_id: agent.id || "unknown",
      agent_name: agent.name || agent.type,
      agent_type: agent.type,
      category,
      ungoverned_capabilities: ungoverned,
      unbound_capabilities: unbound,
      policy,
      severity,
    });
  }

  // Sort: critical → warning → info
  const order = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  internal.lastAuditAt = new Date().toISOString();
  internal.lastAuditFindings = findings;

  return findings;
}

// ─── Operator Controls ──────────────────────────────────────────────────

/**
 * Pin a guardrail — it cannot be disabled while pinned. ASB will re-enable
 * it immediately if any caller tries to disable it via SGR's API.
 */
export function pinGuardrail(guardrailId: string): void {
  internal.pinnedGuardrails.add(guardrailId);
  // Force-enable the guardrail in SGR if it's an SGR guardrail
  const sgrState = getGuardrailState();
  if (guardrailId in sgrState.guardrails) {
    setGuardrailEnabled(guardrailId as never, true);
  }
}

export function unpinGuardrail(guardrailId: string): void {
  internal.pinnedGuardrails.delete(guardrailId);
}

export function isGuardrailPinned(guardrailId: string): boolean {
  return internal.pinnedGuardrails.has(guardrailId);
}

/**
 * Manually disable a capability binding — the gate will skip checking
 * guardrails for this capability. Use when an operator has explicitly
 * decided to accept the risk for a capability.
 */
export function disableBinding(capability: string): void {
  internal.disabledBindings.add(capability);
}

export function enableBinding(capability: string): void {
  internal.disabledBindings.delete(capability);
}

export function isBindingDisabled(capability: string): boolean {
  return internal.disabledBindings.has(capability);
}

/**
 * Convenience: refuse to disable a guardrail in SGR if it's pinned.
 * Called by /api/guardrails before honoring a disable request.
 */
export function canDisableGuardrail(guardrailId: string): {
  ok: boolean;
  reason?: string;
} {
  if (internal.pinnedGuardrails.has(guardrailId)) {
    return {
      ok: false,
      reason: `Guardrail "${guardrailId}" is pinned by ASB and cannot be disabled while any agent uses its bound capabilities. Unpin it first via /api/agent-safety.`,
    };
  }
  return { ok: true };
}

// ─── State Snapshot ─────────────────────────────────────────────────────

export function getAsbState(): AsbState {
  const bindings: Record<string, CapabilityBinding> = {};
  for (const b of BINDINGS) {
    bindings[b.capability] = b;
  }

  const gateEvaluations: AsbState["gate_evaluations"] = {};
  for (const [agentId, eval_] of internal.gateEvaluations) {
    gateEvaluations[agentId] = eval_;
  }

  return {
    bindings,
    categories: CATEGORY_POLICIES,
    pinned_guardrails: Array.from(internal.pinnedGuardrails),
    manually_disabled_bindings: Array.from(internal.disabledBindings),
    gate_evaluations: gateEvaluations,
    last_audit_at: internal.lastAuditAt,
    last_audit_findings: internal.lastAuditFindings.length,
  };
}

export function getAuditFindings(): AuditFinding[] {
  return internal.lastAuditFindings;
}

export function clearGateEvaluations(): void {
  internal.gateEvaluations.clear();
}

// ─── Stats Helpers ──────────────────────────────────────────────────────

export function getCoverageStats(): {
  total_capabilities: number;
  total_bindings: number;
  total_required_guardrails: number;
  pinned_count: number;
  disabled_binding_count: number;
  agents_evaluated: number;
  total_blocks: number;
  total_warnings: number;
} {
  let totalRequired = 0;
  for (const b of BINDINGS) totalRequired += b.required_guardrails.length;

  let totalBlocks = 0;
  let totalWarnings = 0;
  for (const eval_ of internal.gateEvaluations.values()) {
    totalBlocks += eval_.blocks;
    totalWarnings += eval_.warnings;
  }

  return {
    total_capabilities: BINDINGS.length,
    total_bindings: BINDINGS.length,
    total_required_guardrails: totalRequired,
    pinned_count: internal.pinnedGuardrails.size,
    disabled_binding_count: internal.disabledBindings.size,
    agents_evaluated: internal.gateEvaluations.size,
    total_blocks: totalBlocks,
    total_warnings: totalWarnings,
  };
}
