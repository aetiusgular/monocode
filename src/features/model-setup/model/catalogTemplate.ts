/**
 * Codex catalog entry for one model on a provider you set up. Derived from
 * the `gpt-5.5` entry in Codex's bundled `models-manager/models.json` at
 * tag `rust-v0.161.0`, the one entry without code mode or multi-agent.
 *
 * Changed from that entry, as the build plan's step 1 asks and as the 8 Oct
 * run on the Mac needed: reasoning fields off (Ollama refused every request
 * with them), no apply_patch tool type, text input only, no web search, no
 * upgrade or service tiers, and the GPT prompt replaced. The schema moves
 * between Codex versions; this one was not run against 0.161.0 in the app.
 */
const TEMPLATE = {
  slug: "__slug__",
  prefer_websockets: false,
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: null,
  web_search_tool_type: "text_and_image",
  input_modalities: ["text"],
  supports_image_detail_original: false,
  truncation_policy: {
    mode: "tokens",
    limit: 10000,
  },
  supports_parallel_tool_calls: true,
  tool_mode: null,
  multi_agent_version: null,
  multi_agent_reasoning_effort: null,
  use_responses_lite: false,
  supports_reasoning_effort_updates: false,
  include_skills_usage_instructions: true,
  include_apps_usage_instructions: true,
  include_plugin_usage_instructions: true,
  guardian: null,
  node_repl_auto_review_required: false,
  node_repl_disabled: false,
  requires_sandboxed_review: false,
  auto_review_model_override: null,
  model_specialty: null,
  context_window: "__context_window__",
  max_context_window: "__max_context_window__",
  auto_compact_token_limit: null,
  comp_hash: "2911",
  default_reasoning_summary: "none",
  display_name: "__display_name__",
  description: "Local model set up in MonoCode.",
  default_reasoning_level: null,
  supported_reasoning_levels: [],
  shell_type: "shell_command",
  visibility: "list",
  minimal_client_version: "0.124.0",
  supported_in_api: true,
  availability_nux: null,
  upgrade: null,
  priority: 0,
  model_messages: {
    instructions_template: "__INSTRUCTIONS__",
    instructions_variables: null,
    persistent_instructions: null,
    tools: null,
    approvals: null,
    collaboration_modes: null,
    auto_review: null,
    multi_agent: null,
    permissions: null,
    token_budget: null,
    guardian_v2: null,
    confirmation_policies: null,
  },
  experimental_supported_tools: [],
  available_in_plans: [
    "business",
    "edu",
    "edu_plus",
    "edu_pro",
    "education",
    "ent26",
    "enterprise",
    "enterprise_cbp_automation",
    "enterprise_cbp_trial",
    "enterprise_cbp_usage_based",
    "finserv",
    "free",
    "free_workspace",
    "go",
    "hc",
    "k12",
    "plus",
    "pro",
    "prolite",
    "promax",
    "quorum",
    "sci",
    "self_serve_business_prolite",
    "self_serve_business_usage_based",
    "team",
  ],
  supports_search_tool: false,
  supports_experimental_context: false,
  default_service_tier: null,
  service_tiers: [],
  additional_speed_tiers: [],
  supports_reasoning_summary_parameter: false,
  supports_reasoning_summaries: false,
} as const;

export function buildCatalog(input: {
  model: string;
  displayName: string;
  contextWindow?: number;
  instructions: string;
}): { models: Record<string, unknown>[] } {
  const window = input.contextWindow ?? 16_384;
  const entry: Record<string, unknown> = JSON.parse(JSON.stringify(TEMPLATE));
  entry.slug = input.model;
  entry.display_name = input.displayName;
  entry.context_window = window;
  entry.max_context_window = window;
  entry.model_messages = {
    ...(TEMPLATE.model_messages as Record<string, unknown>),
    instructions_template: input.instructions,
  };
  return { models: [entry] };
}
