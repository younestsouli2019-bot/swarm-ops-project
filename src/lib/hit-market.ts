/**
 * HIT (Human Intelligence Task) marketplace simulator.
 *
 * Models a web-based crowdsourcing marketplace that lets businesses outsource
 * small, discrete tasks to a global online workforce. We model it as an
 * external HIT feed that the swarm polls — each HIT has a reward, a category
 * that maps to one of our agent specializations, and an estimated completion
 * time. The orchestrator picks these up, dispatches them to the right agent,
 * and books the reward as revenue once completed.
 *
 * In production this module would be replaced by real MTurk / Clickworker /
 * Toloka / Prolific API clients; the interface (listOpenHITs) stays the same.
 */

export interface HIT {
  hit_id: string;
  title: string;
  description: string;
  /** Task type that maps onto the Base44 Task schema. */
  task_type:
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
  /** Agent specialization that should pick this up. */
  agent_type: string;
  /** Reward in USD cents. */
  reward_cents: number;
  /** Estimated minutes for a single worker. */
  est_minutes: number;
  /** Number of assignments requested by the requester. */
  assignments: number;
  marketplace: "mturk" | "clickworker" | "toloka" | "prolific" | "internal";
  requester: string;
  /** ISO date when the HIT expires if not accepted. */
  expires_at: string;
  keywords: string[];
}

const REQUESTERS = [
  "Stanford NLP Lab",
  "Acme Retail Insights",
  "LinguaData Corp",
  "MedLabel AI",
  "ShopWave Commerce",
  "Civis Analytics",
  "GreenLeaf Sustainability",
  "PixelForge Studios",
  "TrustReview Inc",
  "OpenAtlas Maps",
  "Voxware Transcription",
  "BrightLead Marketing",
];

interface HitTemplate {
  weight: number;
  build: () => Omit<HIT, "hit_id" | "expires_at" | "requester" | "marketplace">;
}

const TEMPLATES: HitTemplate[] = [
  {
    weight: 18,
    build: () => ({
      title: "Categorize 50 product listings into taxonomy",
      description:
        "Review 50 e-commerce product titles and assign each to the most specific category in our 4-level taxonomy. Average 8 sec/item.",
      task_type: "data_analysis",
      agent_type: "data_analyst",
      reward_cents: rand(80, 220),
      est_minutes: rand(6, 14),
      assignments: rand(1, 3),
      keywords: ["categorization", "ecommerce", "taxonomy"],
    }),
  },
  {
    weight: 14,
    build: () => ({
      title: "Transcribe 2-min customer-support call",
      description:
        "Listen to a 2-minute call recording and produce a clean verbatim transcript with speaker turns. Ignore hold music.",
      task_type: "content_creation",
      agent_type: "content_creator",
      reward_cents: rand(120, 280),
      est_minutes: rand(5, 10),
      assignments: rand(1, 2),
      keywords: ["transcription", "audio", "verbatim"],
    }),
  },
  {
    weight: 12,
    build: () => ({
      title: "Sentiment-label 100 tweets (pos / neu / neg)",
      description:
        "Label the sentiment of 100 tweets about the brand. Use 'negative' for complaints, 'neutral' for info, 'positive' for praise.",
      task_type: "data_analysis",
      agent_type: "data_analyst",
      reward_cents: rand(60, 160),
      est_minutes: rand(4, 9),
      assignments: rand(1, 5),
      keywords: ["sentiment", "nlp", "social"],
    }),
  },
  {
    weight: 10,
    build: () => ({
      title: "Write 3 product descriptions (60–90 words each)",
      description:
        "Write SEO-optimized product descriptions for 3 SKUs in the home & kitchen category. Include keywords from the brief.",
      task_type: "content_creation",
      agent_type: "content_creator",
      reward_cents: rand(180, 360),
      est_minutes: rand(8, 16),
      assignments: 1,
      keywords: ["copywriting", "seo", "ecommerce"],
    }),
  },
  {
    weight: 9,
    build: () => ({
      title: "Bounding-box annotation: 30 retail images",
      description:
        "Draw tight bounding boxes around each visible product in 30 shelf images. Use the 'product' label only.",
      task_type: "data_analysis",
      agent_type: "data_analyst",
      reward_cents: rand(150, 320),
      est_minutes: rand(10, 18),
      assignments: rand(1, 3),
      keywords: ["cv", "annotation", "bounding-box"],
    }),
  },
  {
    weight: 8,
    build: () => ({
      title: "Qualify inbound leads (ICP fit + intent score)",
      description:
        "Review 25 inbound leads. Score each 1–5 on ICP fit and intent. Disqualify any outside NA / EU / UK.",
      task_type: "lead_qualification",
      agent_type: "lead_generator",
      reward_cents: rand(140, 280),
      est_minutes: rand(7, 12),
      assignments: 1,
      keywords: ["leads", "sales", "icp"],
    }),
  },
  {
    weight: 8,
    build: () => ({
      title: "Research 5 competitors: pricing + positioning",
      description:
        "For each of 5 named competitors, capture pricing tiers, key features, and positioning claim. Cite sources.",
      task_type: "research",
      agent_type: "research_assistant",
      reward_cents: rand(220, 420),
      est_minutes: rand(15, 25),
      assignments: 1,
      keywords: ["competitor", "research", "pricing"],
    }),
  },
  {
    weight: 7,
    build: () => ({
      title: "Draft 3 LinkedIn outreach messages",
      description:
        "Draft 3 personalized LinkedIn outreach messages (under 300 chars each) using the prospect's profile context.",
      task_type: "customer_outreach",
      agent_type: "customer_service",
      reward_cents: rand(120, 240),
      est_minutes: rand(6, 12),
      assignments: 1,
      keywords: ["outreach", "linkedin", "sales"],
    }),
  },
  {
    weight: 6,
    build: () => ({
      title: "Quality-review 10 AI-written product listings",
      description:
        "Review 10 AI-generated product listings for accuracy, policy compliance, and SEO. Flag or fix issues.",
      task_type: "quality_review",
      agent_type: "seo_specialist",
      reward_cents: rand(100, 200),
      est_minutes: rand(5, 10),
      assignments: 1,
      keywords: ["qa", "review", "listing"],
    }),
  },
  {
    weight: 5,
    build: () => ({
      title: "Create 2 Canva templates (Instagram story)",
      description:
        "Design 2 editable Instagram-story templates for a wellness brand. Use brand palette + logo provided.",
      task_type: "canva_template_creation",
      agent_type: "design_generator",
      reward_cents: rand(200, 380),
      est_minutes: rand(10, 18),
      assignments: 1,
      keywords: ["canva", "design", "template"],
    }),
  },
  {
    weight: 5,
    build: () => ({
      title: "List 4 SKUs on Etsy with tags + variants",
      description:
        "Create 4 Etsy listings from provided SKUs. Set tags, variations, shipping profile, and SEO title.",
      task_type: "marketplace_listing",
      agent_type: "listing_bot",
      reward_cents: rand(180, 320),
      est_minutes: rand(8, 14),
      assignments: 1,
      keywords: ["etsy", "listing", "ecommerce"],
    }),
  },
  {
    weight: 4,
    build: () => ({
      title: "Schedule 5 tweets for the week",
      description:
        "Draft and schedule 5 brand tweets for next week using the provided content calendar. Vary time-of-day.",
      task_type: "social_posting",
      agent_type: "social_manager",
      reward_cents: rand(120, 220),
      est_minutes: rand(6, 11),
      assignments: 1,
      keywords: ["social", "twitter", "scheduling"],
    }),
  },
  {
    weight: 4,
    build: () => ({
      title: "Set up Zapier workflow: Stripe → Airtable",
      description:
        "Build a Zapier zap that adds a row to Airtable whenever a new Stripe charge succeeds. Test with sandbox event.",
      task_type: "automation_setup",
      agent_type: "workflow_automator",
      reward_cents: rand(220, 380),
      est_minutes: rand(12, 20),
      assignments: 1,
      keywords: ["zapier", "automation", "integration"],
    }),
  },
];

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickWeighted(): HitTemplate {
  const total = TEMPLATES.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of TEMPLATES) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return TEMPLATES[0];
}

const MARKETPLACES: HIT["marketplace"][] = [
  "mturk",
  "clickworker",
  "toloka",
  "prolific",
  "internal",
];

let counter = 0;
function nextHitId(): string {
  counter += 1;
  const stamp = Date.now().toString(36).slice(-5).toUpperCase();
  return `HIT-${stamp}-${counter.toString(36).toUpperCase().padStart(3, "0")}`;
}

/**
 * Pull a batch of open HITs from the marketplace.
 * @param count number of HITs to fetch (default 5)
 */
export function listOpenHITs(count = 5): HIT[] {
  const out: HIT[] = [];
  for (let i = 0; i < count; i++) {
    const tpl = pickWeighted();
    const base = tpl.build();
    const expiresInMin = rand(15, 240);
    out.push({
      ...base,
      hit_id: nextHitId(),
      requester: REQUESTERS[rand(0, REQUESTERS.length - 1)],
      marketplace: MARKETPLACES[rand(0, MARKETPLACES.length - 1)],
      expires_at: new Date(Date.now() + expiresInMin * 60_000).toISOString(),
    });
  }
  return out;
}

export function hitToTaskInput(hit: HIT) {
  return {
    title: `[${hit.marketplace.toUpperCase()}] ${hit.title}`,
    description: `${hit.description}\n\nReward: $${(
      hit.reward_cents / 100
    ).toFixed(2)} × ${hit.assignments} assignment(s)\nRequester: ${
      hit.requester
    }\nHIT ID: ${hit.hit_id}\nExpires: ${hit.expires_at}\nKeywords: ${hit.keywords.join(
      ", "
    )}`,
    type: hit.task_type,
    priority: hit.reward_cents >= 250 ? "high" : hit.reward_cents >= 130 ? "medium" : "low",
    status: "pending" as const,
    result_data: {
      hit_id: hit.hit_id,
      reward_cents: hit.reward_cents,
      assignments: hit.assignments,
      est_minutes: hit.est_minutes,
      marketplace: hit.marketplace,
      requester: hit.requester,
      keywords: hit.keywords,
    },
  };
}
