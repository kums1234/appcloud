import { runAgent } from '../lib/agent-runner.js';
import { AppCloudClient } from '../lib/api-client.js';

const api = new AppCloudClient();

const systemPrompt = `You are AppCloud's Mapping Agent — you connect discovered infrastructure
to the right Application + Component nodes in the graph.

You run in TWO PASSES. Be explicit about which pass you are in.

PASS 1 — LINK EXISTING (high confidence):
  1. Call list_applications and get_unmapped_resources first to know the surface area.
  2. Call get_suggestions to get scored mapping candidates.
  3. For every suggestion with score >= 70 AND action = "link_component", batch them
     into a single apply_suggest_actions call.
  4. Stop. Report what was linked.

PASS 2 — PROPOSE NEW (Job 2 — naming-pattern inference):
  Only run this if there are still unmapped resources after Pass 1.
  For each remaining unmapped Infra:

  a. Decide the target Application name. Use this priority:
       1. Tag value: tags.app || tags.application || tags.workload || tags.project
       2. Name prefix: split on '-' and take the first 1–2 segments stripped of
          environment markers (prod, dev, staging, test, qa, uat).
       3. Resource group (Azure) or project (GCP) when the above are empty.
     Title-case the result. Reject names shorter than 3 chars or purely numeric.

  b. Decide tier:
       Tier 1 — name contains 'prod' or 'production' AND resource_type ∈
         {azure_sql_database, gcp_cloudsql, aws_rds, *_load_balancer, *_kubernetes_*}
       Tier 2 — production-side everything else (web/api/worker)
       Tier 3 — name contains 'dev', 'staging', 'test', 'qa', 'uat'

  c. Decide environment:
       'production' if name contains 'prod' or tags.environment matches /^prod/i
       'staging'    if 'staging' or 'stg'
       'development' if 'dev'
       'test'        if 'test'
       Otherwise leave blank.

  d. Decide component type from name keywords:
       'database' if matches /db|sql|rds|postgres|mysql|mongo|redis|cache/
       'queue'    if matches /queue|sqs|sns|servicebus|pubsub/
       'frontend' if matches /web|ui|frontend|cdn|cloudfront/
       'gateway'  if matches /gateway|ingress|alb|elb|nlb/
       'worker'   if matches /worker|job|batch|function|lambda/
       'api'      otherwise

  e. Before proposing a create_application action, call validate_app_name with
     the proposed name. If it returns { exists: true, applicationId }, switch
     the action to create_component (component under existing app) instead.

  f. Batch all proposals into one apply_suggest_actions call.

NEVER:
- Propose a name you can't justify from tags or the resource name.
- Propose tier 1 unless you have evidence it's production-critical infra.
- Propose actions for already-mapped infra (the mapped flag is on each row).

At the end, output a structured summary:

MAPPING_RESULT:
- Pass 1 linked: <count>
- Pass 2 components created: <count>
- Pass 2 applications created: <count>
- Still unmapped: <count>
- Reasoning sample: <one line per top-3 most interesting decisions>`;

const tools = [
  {
    name: 'list_applications',
    description: 'List every Application in the graph with id, name, tier, environment, owner. Use to see what already exists before proposing new apps.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_components',
    description: 'List every Component in the graph with id, name, type, application id. Use as a sanity check before linking.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_unmapped_resources',
    description: 'List discovered Infra that has no Component owner (mapped:false). Each row includes id, name, provider, resource_type, region, tags. This is the universe Pass 1 + Pass 2 work over.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_suggestions',
    description: 'Call /discovery/suggest. Returns scored mapping candidates with action types (link_component | create_component | create_application). Pass 1 only acts on score>=70 link_component rows.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'apply_suggest_actions',
    description: 'Apply a batch of mapping actions via /discovery/suggest/apply-all. Three action types share one endpoint — use exactly the keys listed below.',
    input_schema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Mixed action batch.',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['link_component', 'create_component', 'create_application'],
              },
              infraId:        { type: 'string', description: 'Required for every action.' },
              componentId:    { type: 'string', description: 'link_component: target Component id.' },
              applicationId:  { type: 'string', description: 'create_component: parent Application id.' },
              newCompName:    { type: 'string', description: 'create_component / create_application: new Component name.' },
              newAppName:     { type: 'string', description: 'create_application: new Application name.' },
              suggestedType:  { type: 'string', description: 'Component type: api | worker | database | frontend | platform | cache | queue | gateway. Default: service.' },
              suggestedTier:  { type: 'number', enum: [1, 2, 3], description: 'create_application only.' },
              suggestedEnv:   { type: 'string', description: 'create_application only: production | staging | development | test.' },
              suggestedOwner: { type: 'string', description: 'create_application only.' },
            },
            required: ['action', 'infraId'],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'validate_app_name',
    description: 'Check whether an Application with the given name already exists. Returns { exists: bool, applicationId: string | null, displayName: string | null }. Use BEFORE proposing create_application — if exists, switch to create_component under the returned applicationId.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Proposed Application name. Case-insensitive comparison.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'enrich_azure',
    description: 'Run Azure enrichment (Network Watcher topology + VM Insights observed connections + auto-link). Useful before Pass 1 if the unmapped set is Azure-heavy and structurally sparse. No-op for AWS / GCP.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

async function validateAppName(name) {
  const lower = String(name || '').trim().toLowerCase();
  if (!lower) return { exists: false, applicationId: null, displayName: null };
  const apps = await api.listApplications();
  const hit  = (Array.isArray(apps) ? apps : []).find(a => String(a.name || '').toLowerCase() === lower);
  return hit
    ? { exists: true, applicationId: hit.id, displayName: hit.name }
    : { exists: false, applicationId: null, displayName: null };
}

async function toolHandler(toolName, input) {
  switch (toolName) {
    case 'list_applications':       return await api.listApplications();
    case 'list_components':         return await api.listComponents();
    case 'get_unmapped_resources':  return await api.getUnmappedResources();
    case 'get_suggestions':         return await api.getSuggestions();
    case 'apply_suggest_actions':   return await api.applySuggestActions(input.actions || []);
    case 'validate_app_name':       return await validateAppName(input.name);
    case 'enrich_azure':            return await api.enrichAzure();
    default:                        return `Unknown tool: ${toolName}`;
  }
}

export async function runMappingAgent(context = '') {
  const userMessage = context
    ? `Previous context from Discovery Agent:\n${context}\n\nRun Pass 1 (link existing) then Pass 2 (propose new for residual unmapped). Be explicit about which pass each action belongs to.`
    : `Run Pass 1 (link existing >=70 confidence) then Pass 2 (propose new for residual unmapped). Be explicit about which pass each action belongs to. Always validate proposed app names before create_application.`;

  return runAgent({
    name: 'Mapping',
    systemPrompt,
    tools,
    toolHandler,
    userMessage,
  });
}
