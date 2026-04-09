import { runAgent } from '../lib/agent-runner.js';
import { AppCloudClient } from '../lib/api-client.js';

const api = new AppCloudClient();

const systemPrompt = `You are AppCloud's Blast Radius Agent — a specialized AI that analyzes the impact of infrastructure changes across the application topology.

Your job:
1. Assess the current state of the infrastructure graph
2. For any pending or recent changes, calculate their blast radius
3. Identify high-risk changes that need special attention
4. Analyze cross-application dependencies for cascade risks
5. Provide actionable risk reports with approval recommendations

Risk assessment framework:
- Risk Score 0-3: Low risk. Standard approval.
- Risk Score 4-6: Medium risk. Team lead approval required.
- Risk Score 7-9: High risk. VP/Director approval required.
- Risk Score 10: Critical. CISO sign-off required for Tier-1 apps.

Key factors that increase risk:
- Tier-1 applications affected
- Multiple applications impacted (cross-app blast radius)
- Changes to shared infrastructure (databases, load balancers, networking)
- Single points of failure in the dependency chain
- Production environment changes

At the end, provide a structured summary in this format:

BLAST_RADIUS_RESULT:
- Graph state: [apps, components, infra counts]
- High-risk changes: [count and details]
- Cross-app dependencies: [critical paths]
- Risk recommendations: [actionable items]
- Topology concerns: [single points of failure, etc.]`;

const tools = [
  {
    name: 'get_graph_summary',
    description: 'Get a dashboard summary of the topology graph: counts of applications, components, infra nodes, changes, and users. Also includes components by type and infra by provider.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_topology',
    description: 'Get the full application topology map showing all apps, their components, CONNECTS_TO relationships, and deployment mappings to infrastructure.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'calculate_blast_radius',
    description: 'Calculate the blast radius for a specific change. Returns directly modified nodes, directly affected applications, and indirectly affected applications (via deployment chains).',
    input_schema: {
      type: 'object',
      properties: {
        changeId: { type: 'string', description: 'The ID of the change to analyze' },
      },
      required: ['changeId'],
    },
  },
  {
    name: 'preview_impact',
    description: 'Preview the impact of hypothetical changes on specific target nodes (components or infra). Walks up to 4 hops upstream to find all affected components, applications, and teams. Returns a risk score.',
    input_schema: {
      type: 'object',
      properties: {
        targetIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of component or infrastructure IDs to analyze impact for',
        },
      },
      required: ['targetIds'],
    },
  },
  {
    name: 'get_cross_app_dependencies',
    description: 'Get all inter-application communication paths. Shows which apps depend on which other apps, through which components, with protocol and port details. Ordered by source tier (Tier-1 first).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_high_risk_changes',
    description: 'List all approved changes with a risk score of 7 or higher. These are changes that may need additional review or CISO sign-off.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

async function toolHandler(toolName, input) {
  switch (toolName) {
    case 'get_graph_summary':
      return await api.getGraphSummary();
    case 'get_topology':
      return await api.getTopology();
    case 'calculate_blast_radius':
      return await api.getBlastRadius(input.changeId);
    case 'preview_impact':
      return await api.previewImpact(input.targetIds);
    case 'get_cross_app_dependencies':
      return await api.getCrossAppDeps();
    case 'get_high_risk_changes':
      return await api.getHighRiskChanges();
    default:
      return `Unknown tool: ${toolName}`;
  }
}

export async function runBlastRadiusAgent(context = '', changeId = null) {
  let userMessage;
  if (changeId) {
    userMessage = `Analyze the blast radius for change ID: ${changeId}. Calculate the impact, identify affected applications, and provide risk recommendations.`;
  } else if (context) {
    userMessage = `Previous context from Onboarding Agent:\n${context}\n\nNow analyze the infrastructure topology for risks. Check the graph state, look for high-risk changes, analyze cross-app dependencies, and identify potential blast radius concerns.`;
  } else {
    userMessage = 'Analyze the infrastructure topology for risks. Get the graph summary, check for high-risk changes, analyze cross-app dependencies, and provide a risk report.';
  }

  return runAgent({
    name: 'Blast Radius',
    systemPrompt,
    tools,
    toolHandler,
    userMessage,
  });
}
