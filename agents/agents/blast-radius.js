import { runAgent } from '../lib/agent-runner.js';
import { AppCloudClient } from '../lib/api-client.js';

const api = new AppCloudClient();

const systemPrompt = `You are AppCloud's Blast Radius Agent — a specialized AI that explains
the impact of infrastructure or application changes across the dependency graph,
in plain English, for engineers who don't want to read Cypher.

Your job:
1. Inspect the current graph for risks: internet-exposed infra, shared databases /
   load balancers / queues with multiple component owners, applications without
   tier set, fan-out hotspots in cross-app dependencies.
2. Answer "what's the impact if X is changed?" for a specific Infra or
   Application by walking the graph and naming every Component / Application
   that would be affected.
3. Produce HUMAN-READABLE OUTPUT — short paragraphs and bullets, not raw JSON.
   Lead with a one-line summary ("Changing this affects N components across
   M applications, including K Tier-1 apps."), then list affected items with
   tier and environment, then call out any specific concerns (Tier-1 hits,
   public exposure, single-point-of-failure shape).

Risk framing (use these words consistently):
- LOW: 0 Tier-1 apps affected, 0 cross-app fan-out, no public-exposed infra in path
- MEDIUM: any Tier-1 app affected OR cross-app fan-out OR shared infra
- HIGH: Tier-1 apps + cross-app fan-out, OR public-exposed shared infra,
  OR a single change touches >3 applications

IMPORTANT — there is no scheduled-change registry on this branch:
the /changes route was removed in the refocus. If the user asks about
"scheduled changes" or "upcoming changes," answer plainly:
  "AppCloud doesn't track scheduled changes yet — once the /changes
  route lands, I'll project impact for each pending change. For now I can
  only analyze the current graph or a hypothetical change you describe."
Do NOT invent change records. Do NOT call tools you don't have.

At the end of every response, include a structured tail like:

BLAST_RADIUS_RESULT:
- Subject: <what was analyzed>
- Affected components: <count and names>
- Affected applications: <count, with tier breakdown>
- Risk: LOW | MEDIUM | HIGH
- Specific concerns: <bullets, or "none">`;

const tools = [
  {
    name: 'get_graph_summary',
    description: 'Counts of applications, components, infra nodes by provider/type. Use first to know the size of what you are looking at.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_applications',
    description: 'List every Application with id, name, tier, environment, owner. Use to find the application id when the user names an app.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_infra',
    description: 'List every Infra resource with id, name, provider, resource_type, region, public flag. Use to find the infra id when the user names a resource.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_impact',
    description: 'For a given Application, Component, or Infra id, return every node that depends on it as a depth-aware tree (nodes carry `depth`, edges carry source/via/confidence/evidence; the response also includes a `rollups` histogram of resource-groups / projects / account-region buckets reached). This is the answer to "what breaks if I change this?" Reached Components are annotated with their owning Application for cross-app context.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Application, Component, or Infra UUID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_dependencies',
    description: 'Inverse of `get_impact`. For a given Application or Component id, returns the outbound dependency subgraph — what this thing leans on. Use for incident drill-down: an impacted service can be expanded into the chain of components, infra deployments, and transitively-chased structural infra it relies on.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Application or Component UUID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_app_dependencies',
    description: 'For a given Application id, return every other Application it depends on (via cross-app component connections). This is the answer to "if I change this app, who downstream cares?"',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'Application UUID' },
      },
      required: ['appId'],
    },
  },
  {
    name: 'get_app_topology',
    description: 'For a given Application id, return its components, internal connections, and deployed infra. Use to describe the surface area of an app before reasoning about a change to it.',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'Application UUID' },
      },
      required: ['appId'],
    },
  },
  {
    name: 'get_cross_app_dependencies',
    description: 'Every cross-application component-to-component edge. Use to find fan-out hotspots: applications that many other applications depend on.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_public_exposed_infra',
    description: 'Every Infra node flagged public:true plus the Component names that own each one. Use to surface internet-facing surface area as a risk-finding pass.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_shared_infra',
    description: 'Every Infra node owned by more than one Component. Shared infra is a fan-out risk — a change there hits multiple components by definition.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

async function toolHandler(toolName, input) {
  switch (toolName) {
    case 'get_graph_summary':         return await api.getGraphSummary();
    case 'list_applications':         return await api.listApplications();
    case 'list_infra':                return await api.listInfra();
    case 'get_impact':                return await api.getImpact(input.id);
    case 'get_dependencies':          return await api.getDependencies(input.id);
    case 'get_app_dependencies':      return await api.getAppDependencies(input.appId);
    case 'get_app_topology':          return await api.getAppTopology(input.appId);
    case 'get_cross_app_dependencies': return await api.getCrossAppDeps();
    case 'get_public_exposed_infra':  return await api.getPublicExposed();
    case 'get_shared_infra':          return await api.getSharedInfra();
    default:                          return `Unknown tool: ${toolName}`;
  }
}

/**
 * Run the Blast Radius Agent.
 *
 * @param {string} context  Optional upstream context (e.g., from the
 *                          orchestrator's previous stage). When set, used
 *                          as background; the agent still does its own
 *                          risk pass.
 * @param {string} subject  Optional natural-language subject, e.g.
 *                          "what happens if I change the prod-payment-rds?"
 *                          or "find risky things in the graph".
 */
export async function runBlastRadiusAgent(context = '', subject = '') {
  let userMessage;
  if (subject) {
    userMessage =
      `User asked: ${subject}\n\n` +
      `Use the available tools to answer. Resolve names to ids via list_applications / list_infra ` +
      `before calling get_impact / get_dependencies / get_app_dependencies. Answer in plain English with the ` +
      `BLAST_RADIUS_RESULT tail.`;
  } else if (context) {
    userMessage =
      `Previous context from Onboarding Agent:\n${context}\n\n` +
      `Now do a risk pass on the current graph: get_graph_summary, then check ` +
      `get_public_exposed_infra, get_shared_infra, and get_cross_app_dependencies for hotspots. ` +
      `Report findings in plain English with the BLAST_RADIUS_RESULT tail.`;
  } else {
    userMessage =
      `Do a risk pass on the current graph. Start with get_graph_summary, then look at ` +
      `get_public_exposed_infra, get_shared_infra, and get_cross_app_dependencies. ` +
      `Surface anything noteworthy in plain English with the BLAST_RADIUS_RESULT tail.`;
  }

  return runAgent({
    name: 'Blast Radius',
    systemPrompt,
    tools,
    toolHandler,
    userMessage,
  });
}
