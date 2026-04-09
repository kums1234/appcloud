import { runAgent } from '../lib/agent-runner.js';
import { AppCloudClient } from '../lib/api-client.js';

const api = new AppCloudClient();

const systemPrompt = `You are AppCloud's Discovery Agent — a specialized AI that scans cloud infrastructure.

Your job:
1. Check which cloud accounts (AWS, Azure, GCP) are configured in AppCloud
2. Scan the configured providers to discover infrastructure resources
3. Summarize what was found: new resources, resource types, any errors

Be methodical:
- Always start by listing configured cloud accounts
- If no accounts are configured, report that clearly
- After scanning, get a summary of all discovered resources
- Report counts broken down by provider and resource type
- Flag any scan errors or skipped resources

At the end, provide a structured summary in this format:

DISCOVERY_RESULT:
- Accounts scanned: [list]
- Total resources found: [number]
- By provider: [breakdown]
- New resources: [count]
- Errors: [list or "none"]
- Stale resources removed: [count]`;

const tools = [
  {
    name: 'list_cloud_accounts',
    description: 'List all configured cloud accounts (AWS, Azure, GCP) in AppCloud. Returns account names, providers, and last scan timestamps.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'scan_provider',
    description: 'Trigger a cloud infrastructure scan for a specific provider. Scans all configured accounts for that provider and discovers resources like VMs, databases, containers, load balancers, etc.',
    input_schema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['aws', 'azure', 'gcp'],
          description: 'The cloud provider to scan',
        },
      },
      required: ['provider'],
    },
  },
  {
    name: 'scan_all_providers',
    description: 'Trigger infrastructure scan across ALL configured cloud providers simultaneously. More efficient than scanning one by one.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_discovery_summary',
    description: 'Get a summary of all discovered infrastructure resources. Returns total counts, breakdown by provider, resource types, and mapping status.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

async function toolHandler(toolName, input) {
  switch (toolName) {
    case 'list_cloud_accounts':
      return await api.listCloudAccounts();
    case 'scan_provider':
      return await api.scanProvider(input.provider);
    case 'scan_all_providers':
      return await api.scanAll();
    case 'get_discovery_summary':
      return await api.getDiscoverySummary();
    default:
      return `Unknown tool: ${toolName}`;
  }
}

export async function runDiscoveryAgent(context = '') {
  const userMessage = context
    ? `Previous context:\n${context}\n\nNow run infrastructure discovery. Check configured accounts and scan for resources.`
    : 'Run infrastructure discovery. Check which cloud accounts are configured and scan for resources.';

  return runAgent({
    name: 'Discovery',
    systemPrompt,
    tools,
    toolHandler,
    userMessage,
  });
}
