import { runAgent } from '../lib/agent-runner.js';
import { AppCloudClient } from '../lib/api-client.js';

const api = new AppCloudClient();

const systemPrompt = `You are AppCloud's Application Onboarding Agent — a specialized AI that creates and configures applications for unmapped infrastructure.

Your job:
1. For infrastructure that can't be mapped to existing apps, create new Application and Component nodes
2. Use cloud tags and resource naming patterns to infer application names, component types, and tiers
3. Run the bootstrap process to auto-create apps from tag patterns
4. Complete the onboarding checklist for each new application

Strategy:
- Start by running the bootstrap process — it auto-creates apps/components from cloud tags and resource groups
- Check which applications still need onboarding steps completed
- For each new app, infer and set: tier (1=critical, 2=important, 3=other), owner, domain, environment
- Use resource naming patterns: "prod-" prefix = tier 1-2, "dev-/staging-" = tier 3
- Complete onboarding steps: owner, classification, component, deployment, domain
- If bootstrap doesn't catch everything, create applications manually based on resource patterns

Tier classification guidance:
- Tier 1 (critical): Production databases, core API services, authentication services
- Tier 2 (important): Worker processes, caching layers, internal APIs
- Tier 3 (other): Development resources, monitoring, logging, test environments

At the end, provide a structured summary in this format:

ONBOARDING_RESULT:
- Bootstrap results: [apps created, components created, resources linked]
- Manually created apps: [list]
- Onboarding completion: [app: percentage for each]
- Resources still unmapped: [count]`;

const tools = [
  {
    name: 'run_bootstrap',
    description: 'Run the two-phase bootstrap process: Phase 1 auto-creates Applications and Components from cloud tags (app, application, workload, project tags). Phase 2 propagates mappings within Azure Resource Groups for shared resources.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_application',
    description: 'Create a new Application node in the topology graph.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Application name' },
        tier: { type: 'number', enum: [1, 2, 3], description: '1=critical, 2=important, 3=other' },
        owner: { type: 'string', description: 'Team or person who owns this application' },
        environment: { type: 'string', description: 'Environment: prod, staging, dev, test' },
        domain: { type: 'string', description: 'Business domain this app belongs to' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_component',
    description: 'Create a new Component node and optionally attach it to an application.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Component name' },
        type: { type: 'string', enum: ['api', 'worker', 'database', 'frontend', 'platform', 'cache', 'queue', 'gateway'], description: 'Component type' },
        runtime: { type: 'string', description: 'Runtime: python, java, nodejs, docker, etc.' },
        applicationId: { type: 'string', description: 'Application ID to attach this component to via CONTAINS relationship' },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'deploy_component',
    description: 'Create a DEPLOYED_ON relationship between a component and an infrastructure resource.',
    input_schema: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: 'Component ID' },
        infraId: { type: 'string', description: 'Infrastructure resource ID to deploy on' },
      },
      required: ['componentId', 'infraId'],
    },
  },
  {
    name: 'check_onboarding',
    description: 'Check onboarding progress for an application. Returns which steps are complete and the overall completion percentage.',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'Application ID to check onboarding for' },
      },
      required: ['appId'],
    },
  },
  {
    name: 'complete_onboarding_step',
    description: 'Mark an onboarding step as complete for an application. Steps: owner, classification, component, deployment, domain, notify.',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'Application ID' },
        step: { type: 'string', enum: ['owner', 'classification', 'component', 'deployment', 'domain', 'notify'], description: 'The onboarding step to complete' },
      },
      required: ['appId', 'step'],
    },
  },
  {
    name: 'update_application',
    description: 'Update an existing application with classification metadata: tier, owner, domain, availability SLA, confidentiality level.',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'Application ID to update' },
        tier: { type: 'number', enum: [1, 2, 3], description: '1=critical, 2=important, 3=other' },
        owner: { type: 'string', description: 'Team or person who owns this application' },
        domain: { type: 'string', description: 'Business domain' },
        environment: { type: 'string', description: 'Environment: prod, staging, dev, test' },
        availability: { type: 'string', description: 'SLA target: 99.9, 99.99, etc.' },
        confidentiality: { type: 'string', enum: ['public', 'internal', 'restricted', 'confidential'], description: 'Data classification' },
      },
      required: ['appId'],
    },
  },
];

async function toolHandler(toolName, input) {
  switch (toolName) {
    case 'run_bootstrap':
      return await api.bootstrap();
    case 'create_application':
      return await api.createApplication(input);
    case 'create_component': {
      const { applicationId, ...data } = input;
      const comp = await api.createComponent(data);
      // If applicationId provided, the route should handle CONTAINS relationship
      // but we may need to create the relationship separately
      return comp;
    }
    case 'deploy_component':
      return await api.deployComponent(input.componentId, input.infraId);
    case 'check_onboarding':
      return await api.checkOnboarding(input.appId);
    case 'complete_onboarding_step':
      return await api.completeOnboardingStep(input.appId, input.step);
    case 'update_application': {
      const { appId, ...data } = input;
      return await api.updateApplication(appId, data);
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

export async function runOnboardingAgent(context = '') {
  const userMessage = context
    ? `Previous context from Mapping Agent:\n${context}\n\nNow onboard any remaining unmapped infrastructure by creating applications and components. Complete the onboarding checklist for new apps.`
    : 'Create applications and components for unmapped infrastructure. Run bootstrap, create missing apps, and complete onboarding checklists.';

  return runAgent({
    name: 'Onboarding',
    systemPrompt,
    tools,
    toolHandler,
    userMessage,
  });
}
