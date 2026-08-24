/**
 * Base44 Agent-Swarm API client (server-side only).
 *
 * Uses fetch directly against the REST endpoints documented in the uploaded
 * API reference. All calls go through this module so the api_key stays on
 * the server.
 *
 * Base URL:  https://agent-swarm-efe0bd7e.base44.app/api
 * App ID:    689afeabf1db9c30efe0bd7e
 */

export const BASE44_BASE_URL =
  "https://agent-swarm-efe0bd7e.base44.app/api";

/**
 * API key is read from env, never inlined. Set BASE44_API_KEY in .env
 * (or your secrets manager in production). If it's missing, all b44
 * calls will throw — this is intentional. Never inline secrets in source.
 *
 * See scripts/credential-rotation-checklist.md for the rotation plan.
 * The previously-inlined key (committed in source history) should be
 * treated as compromised and rotated at the Base44 dashboard.
 */
const BASE44_API_KEY = process.env.BASE44_API_KEY;
if (!BASE44_API_KEY && typeof window === "undefined") {
  // Server-side: warn loudly. Don't crash at module-load (would break
  // tooling), but every call will throw.
  console.warn(
    "[base44] BASE44_API_KEY is not set in env. All Base44 API calls will fail. " +
      "Set it in .env (see scripts/credential-rotation-checklist.md)."
  );
}

const COMMON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  ...(BASE44_API_KEY ? { api_key: BASE44_API_KEY } : {}),
};

export type ID = string;

export interface Agent {
  id?: ID;
  name: string;
  description?: string;
  type: string;
  status?: "active" | "paused" | "stopped" | "error";
  system_prompt: string;
  capabilities?: string[];
  current_workload?: number;
  max_workload?: number;
  task_queue?: ID[];
  collaboration_rules?: Record<string, unknown>;
  revenue_config?: Record<string, unknown>;
  social_accounts?: unknown[];
  automation_config?: Record<string, unknown>;
  performance_metrics?: {
    revenue_generated?: number;
    tasks_completed?: number;
    total_runtime?: number;
    handoffs_received?: number;
    handoffs_initiated?: number;
    last_active?: string | null;
    success_rate?: number;
  };
  created_date?: string;
  updated_date?: string;
}

export interface Mission {
  id?: ID;
  mission_id: string;
  title: string;
  type:
    | "financial_transaction"
    | "agent_deployment"
    | "revenue_generation"
    | "generative_enterprise"
    | "product_development"
    | "market_expansion"
    | "api_key_distribution"
    | "custom";
  priority?: "low" | "medium" | "high" | "critical";
  status?:
    | "pending"
    | "assigned"
    | "in_progress"
    | "deployed"
    | "queued"
    | "completed"
    | "failed"
    | "paused";
  assigned_agent_id?: string;
  assigned_agents?: string[];
  mission_parameters?: Record<string, unknown>;
  progress_data?: Record<string, unknown>;
  estimated_duration_hours?: number;
  deadline?: string;
  completion_notes?: string;
  revenue_generated?: number;
  execution_plan?: Array<Record<string, unknown>>;
  created_date?: string;
  updated_date?: string;
}

export interface Task {
  id?: ID;
  title: string;
  description?: string;
  type:
    | "content_creation"
    | "social_posting"
    | "data_analysis"
    | "customer_outreach"
    | "lead_qualification"
    | "research"
    | "automation_setup"
    | "quality_review"
    | "canva_template_creation"
    | "marketplace_listing";
  priority?: "low" | "medium" | "high" | "urgent";
  status?:
    | "pending"
    | "assigned"
    | "in_progress"
    | "completed"
    | "failed"
    | "handed_off";
  assigned_agent_id?: string;
  requesting_agent_id?: string;
  workflow_id?: string;
  dependencies?: ID[];
  handoff_history?: Array<Record<string, unknown>>;
  result_data?: Record<string, unknown>;
  due_date?: string;
  created_date?: string;
  updated_date?: string;
}

export interface RevenueStream {
  id?: ID;
  name: string;
  type:
    | "etsy_pod"
    | "amazon_kdp"
    | "redbubble"
    | "gumroad"
    | "course_sales"
    | "canva_templates"
    | "affiliate"
    | "freelance"
    | "custom";
  status?: "active" | "paused" | "setup" | "blocked";
  target_monthly_revenue: number;
  kpi_metrics?: Record<string, unknown>;
  responsible_agent_ids?: ID[];
  marketplace_config?: Record<string, unknown>;
  available_for_payout?: number;
  payout_status?: "idle" | "pending" | "processing" | "completed" | "failed";
  last_payout_date?: string;
  created_date?: string;
  updated_date?: string;
}

export interface RevenueEvent {
  id?: ID;
  event_id?: string;
  source:
    | "mission_completed"
    | "course_sale"
    | "affiliate_commission"
    | "agent_generated"
    | "manual_entry"
    | "product_sale"
    | "subscription";
  amount: number;
  currency: "USD" | "GBP" | "EUR" | "JPY" | "BTC" | "ETH" | "USDT";
  status?: "projected" | "confirmed" | "paid_out" | "cancelled";
  confirmation_date?: string;
  event_hash?: string;
  source_id?: string;
  payout_batch_id?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  created_date?: string;
  updated_date?: string;
}

export interface PayoutBatch {
  id?: ID;
  batch_id?: string;
  status?:
    | "draft"
    | "pending_approval"
    | "approved"
    | "processing"
    | "completed"
    | "failed"
    | "partially_completed";
  total_amount?: number;
  currency?: "USD" | "GBP" | "EUR" | "JPY";
  item_count?: number;
  recipient_count?: number;
  notes?: string;
  created_date?: string;
  updated_date?: string;
  // extended fields used by the swarm ops UI (kept loose on purpose)
  [key: string]: unknown;
}

export interface PayoutItem {
  id?: ID;
  item_id?: string;
  batch_id: string;
  recipient_name?: string;
  recipient: string;
  recipient_type: "paypal_email" | "bank_account" | "crypto_wallet" | "payoneer";
  bank_name?: string;
  amount: number;
  currency: "USD" | "GBP" | "EUR" | "JPY";
  status?: "pending" | "processing" | "success" | "failed" | "refunded";
  external_transaction_id?: string;
  error_message?: string;
  processed_at?: string;
  created_date?: string;
  updated_date?: string;
}

export interface PayoutRecipient {
  id?: ID;
  name: string;
  recipient_type: "paypal_email" | "bank_account" | "crypto_wallet" | "payoneer";
  currency: "USD" | "GBP" | "EUR" | "JPY" | "BTC" | "ETH" | "USDT";
  bank_name?: string;
  country?: string;
  account_identifier: string;
  routing_number?: string;
  swift_bic?: string;
  sort_code?: string;
  bank_code?: string;
  branch_code?: string;
  bank_address?: string;
  account_type?: "CHECKING" | "SAVINGS" | "CURRENT";
  is_default?: boolean;
  notes?: string;
  created_date?: string;
  updated_date?: string;
}

export interface AgentThreshold {
  id?: ID;
  agent_id: string;
  agent_name: string;
  pause_below_revenue?: number;
  activate_above_revenue?: number;
  min_success_rate?: number;
  daily_cost?: number;
  enabled?: boolean;
  last_action?: "none" | "paused" | "activated";
  last_action_at?: string;
  last_action_reason?: string;
  created_date?: string;
  updated_date?: string;
}

export interface AgentHandoff {
  id?: ID;
  task_id: string;
  from_agent_id: string;
  to_agent_id: string;
  reason:
    | "capability_match"
    | "workload_balance"
    | "specialization_needed"
    | "workflow_requirement"
    | "error_recovery";
  context?: string;
  handoff_data?: Record<string, unknown>;
  status?: "pending" | "accepted" | "rejected" | "completed";
  response_message?: string;
  created_date?: string;
  updated_date?: string;
}

export interface Workflow {
  id?: ID;
  name: string;
  description?: string;
  category:
    | "social_media"
    | "content_creation"
    | "data_processing"
    | "customer_engagement"
    | "lead_generation"
    | "analytics"
    | "custom";
  status?: "active" | "draft" | "paused" | "archived";
  trigger?: Record<string, unknown>;
  nodes?: Array<Record<string, unknown>>;
  execution_stats?: Record<string, unknown>;
  created_date?: string;
  updated_date?: string;
}

export type EntityName =
  | "Agent"
  | "AgentHandoff"
  | "AgentTemplate"
  | "AgentThreshold"
  | "AppProject"
  | "Campaign"
  | "Mission"
  | "PayoutAlert"
  | "PayoutBatch"
  | "PayoutItem"
  | "PayoutRecipient"
  | "ProductListing"
  | "ReconciliationAlert"
  | "RevenueEvent"
  | "RevenueStream"
  | "SocialPost"
  | "Task"
  | "TransactionLog"
  | "Workflow";

async function b44Fetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE44_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...COMMON_HEADERS, ...(init.headers || {}) },
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (!res.ok) {
    const msg =
      (json && typeof json === "object" && "message" in json
        ? String((json as Record<string, unknown>).message)
        : undefined) ?? `${res.status} ${res.statusText}`;
    throw new Error(`Base44 ${init.method || "GET"} ${path} -> ${msg}`);
  }
  return json as T;
}

export const b44 = {
  /** List records. Pass a `q` filter object to narrow. */
  async list<E extends EntityName>(
    entity: E,
    opts: { q?: Record<string, unknown>; limit?: number; skip?: number; sort_by?: string } = {}
  ): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", JSON.stringify(opts.q));
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.skip != null) params.set("skip", String(opts.skip));
    if (opts.sort_by) params.set("sort_by", opts.sort_by);
    const qs = params.toString();
    return b44Fetch<unknown[]>(`/entities/${entity}${qs ? `?${qs}` : ""}`);
  },

  async get<E extends EntityName>(entity: E, id: ID): Promise<unknown> {
    return b44Fetch<unknown>(`/entities/${entity}/${id}`);
  },

  async create<E extends EntityName>(
    entity: E,
    data: Record<string, unknown>
  ): Promise<unknown> {
    return b44Fetch<unknown>(`/entities/${entity}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async update<E extends EntityName>(
    entity: E,
    id: ID,
    data: Record<string, unknown>
  ): Promise<unknown> {
    return b44Fetch<unknown>(`/entities/${entity}/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  async remove<E extends EntityName>(entity: E, id: ID): Promise<void> {
    await b44Fetch<void>(`/entities/${entity}/${id}`, { method: "DELETE" });
  },

  async bulkCreate<E extends EntityName>(
    entity: E,
    records: Record<string, unknown>[]
  ): Promise<unknown[]> {
    return b44Fetch<unknown[]>(`/entities/${entity}/bulk`, {
      method: "POST",
      body: JSON.stringify(records),
    });
  },
};
