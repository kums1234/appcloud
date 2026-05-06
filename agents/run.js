#!/usr/bin/env node

import { validateConfig } from './lib/config.js';
import { runPipeline } from './orchestrator.js';
import { runDiscoveryAgent } from './agents/discovery.js';
import { runMappingAgent } from './agents/mapping.js';
import { runBlastRadiusAgent } from './agents/blast-radius.js';

const HELP = `
AppCloud Multi-Agent Pipeline

Usage: node run.js <command> [options]

Commands:
  pipeline       Run full pipeline: Discovery -> Mapping -> Blast Radius
  discover       Run Discovery Agent only (scan cloud accounts)
  map            Run Mapping Agent only (two-pass: link existing,
                  then propose new apps/components for residual unmapped)
  blast-radius   Run Blast Radius Agent only (analyze change impact)
  chat           Open the AI Assistant interactive chat (POST /ai/chat)

Options:
  --subject "<question>"  For blast-radius: free-text question, e.g.
                          "what happens if I change prod-payment-rds?"

Examples:
  node run.js pipeline
  node run.js discover
  node run.js map
  node run.js blast-radius
  node run.js blast-radius --subject "what breaks if portal-api is restarted?"
  node run.js chat
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

    case 'blast-radius': {
      const subjectIdx = args.indexOf('--subject');
      const subject = subjectIdx !== -1 ? args[subjectIdx + 1] : '';
      await runBlastRadiusAgent('', subject);
      break;
    }

    case 'chat':
      // Re-exec into the chat REPL — readline owns stdin and we don't want
      // run.js's switch returning to clean state in the middle of an interactive
      // session. await import() runs main() inside chat.js as a side effect.
      await import('./chat.js');
      return;

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
