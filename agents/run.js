#!/usr/bin/env node

import { validateConfig } from './lib/config.js';
import { runPipeline } from './orchestrator.js';
import { runDiscoveryAgent } from './agents/discovery.js';
import { runMappingAgent } from './agents/mapping.js';
import { runOnboardingAgent } from './agents/onboarding.js';
import { runBlastRadiusAgent } from './agents/blast-radius.js';

const HELP = `
AppCloud Multi-Agent Pipeline

Usage: node run.js <command> [options]

Commands:
  pipeline       Run full pipeline: Discovery -> Mapping -> Onboarding -> Blast Radius
  discover       Run Discovery Agent only (scan cloud accounts)
  map            Run Mapping Agent only (link infra to components)
  onboard        Run Onboarding Agent only (create apps for unmapped infra)
  blast-radius   Run Blast Radius Agent only (analyze change impact)

Options:
  --subject "<question>"  For blast-radius: free-text question, e.g.
                          "what happens if I change prod-payment-rds?"

Examples:
  node run.js pipeline
  node run.js discover
  node run.js blast-radius
  node run.js blast-radius --subject "what breaks if portal-api is restarted?"
`;

const [command, ...args] = process.argv.slice(2);

// Show help without requiring API key
if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(0);
}

validateConfig();

async function main() {
  switch (command) {
    case 'pipeline':
      await runPipeline();
      break;

    case 'discover':
      await runDiscoveryAgent();
      break;

    case 'map':
      await runMappingAgent();
      break;

    case 'onboard':
      await runOnboardingAgent();
      break;

    case 'blast-radius': {
      const subjectIdx = args.indexOf('--subject');
      const subject = subjectIdx !== -1 ? args[subjectIdx + 1] : '';
      await runBlastRadiusAgent('', subject);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
