import { runAgent } from '../lib/agent-runner.js';
import { AppCloudClient } from '../lib/api-client.js';

const api = new AppCloudClient();

const systemPrompt = `You are AppCloud's Mapping & Linking Agent — a specialized AI that connects discovered infrastructure to applications and components.

Your job:
1. Identify unmapped infrastructure (resources not linked to any component)
2. Use AI-scored suggestions to find the best matches
3. For Azure resources, run enrichment strategies to discover structural relationships
4. Link infrastructure to components via DEPLOYED_ON relationships
5. Explain your reasoning for each mapping decision

Strategy:
- First check what applications and components already exist
- Get unmapped resources to understand the scope
- For Azure resources, run enrichment first (it discovers network topology, resource groups, etc.)
- Then get AI suggestions for remaining unmapped resources
- Apply high-confidence suggestions (score >= 70) automatically
- For lower-confidence suggestions, explain why they might or might not be good matches
- Report what was linked and what remains unmapped

At the end, provide a structured summary in this format:

MAPPING_RESULT:
- Resources analyzed: [number]
- Already mapped: [number]
- Newly linked: [number]
- Suggestions applied: [number]
- Still unmapped: [number]
- Enrichment relationships created: [number]
- Key decisions: [brief explanations]`;

const tools = [
  {
    name: 'list_applications',
    description: 'List all existing applications in AppCloud with their components, tier, and environment.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_unmapped_resources',
    description: 'List infrastructure resources that are NOT linked to any component. These need to be mapped.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_suggestions',
    description: 'Get AI-scored mapping suggestions. Returns a list of unmapped infra resources with ranked candidate components/applications and confidence scores (0-100).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'link_infra_to_component',
    description: 'Create a DEPLOYED_ON relationship between an infrastructure resource and a component. This is the core mapping action.',
    input_schema: {
      type: 'object',
      properties: {
        infraId: {
          type: 'string',
          description: 'The ID of the infrastructure resource to link',
        },
        componentId: {
          type: 'string',
          description: 'The ID of the component to link it to',
        },
      },
      required: ['infraId', 'componentId'],
    },
  },
  {
    name: 'apply_all_suggestions',
    description: 'Batch-apply multiple mapping suggestions at once. Each suggestion can link to an existing component, create a new component, or create a new application.',
    input_schema: {
      type: 'object',
      properties: {
        suggestions: {
          type: 'array',
          description: 'Array of suggestion actions to apply',
          items: {
            type: 'object',
            properties: {
              infraId: { type: 'string', description: 'Infrastructure resource ID' },
              action: { type: 'string', enum: ['link_component', 'create_component', 'create_application'], description: 'Action type' },
              componentId: { type: 'string', description: 'Component ID (for link_component action)' },
              componentName: { type: 'string', description: 'New component name (for create_component)' },
              componentType: { type: 'string', description: 'Component type: api, worker, database, frontend, platform' },
              applicationId: { type: 'string', description: 'Application ID to add component to' },
              applicationName: { type: 'string', description: 'New application name (for create_application)' },
            },
            required: ['infraId', 'action'],
          },
        },
      },
      required: ['suggestions'],
    },
  },
  {
    name: 'enrich_azure',
    description: 'Run Azure-specific enrichment strategies: Resource Graph structural links, Network Watcher topology, VM Insights observed connections, and auto-linking via confidence scoring. Only works for Azure resources.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

async function toolHandler(toolName, input) {
  switch (toolName) {
    case 'list_applications':
      return await api.listApplications();
    case 'get_unmapped_resources':
      return await api.getResources('unmapped=true');
    case 'get_suggestions':
      return await api.getSuggestions();
    case 'link_infra_to_component':
      return await api.linkInfra(input.infraId, input.componentId);
    case 'apply_all_suggestions':
      return await api.applyAllSuggestions(input.suggestions);
    case 'enrich_azure':
      return await api.enrichAzure();
    default:
      return `Unknown tool: ${toolName}`;
  }
}

export async function runMappingAgent(context = '') {
  const userMessage = context
    ? `Previous context from Discovery Agent:\n${context}\n\nNow analyze and map the discovered infrastructure to applications and components.`
    : 'Analyze discovered infrastructure and map it to applications and components. Find unmapped resources and create DEPLOYED_ON links.';

  return runAgent({
    name: 'Mapping',
    systemPrompt,
    tools,
    toolHandler,
    userMessage,
  });
}
