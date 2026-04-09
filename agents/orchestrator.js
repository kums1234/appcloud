import { createLogger } from './lib/logger.js';
import { runDiscoveryAgent } from './agents/discovery.js';
import { runMappingAgent } from './agents/mapping.js';
import { runOnboardingAgent } from './agents/onboarding.js';
import { runBlastRadiusAgent } from './agents/blast-radius.js';

const log = createLogger('Orchestrator');

/**
 * Extract the structured result block from an agent's response.
 * Looks for patterns like DISCOVERY_RESULT:, MAPPING_RESULT:, etc.
 */
function extractResult(response, tag) {
  const marker = `${tag}:`;
  const idx = response.indexOf(marker);
  if (idx === -1) return response; // fallback to full response
  return response.slice(idx);
}

/**
 * Run the full multi-agent pipeline:
 * Discovery → Mapping → Onboarding → Blast Radius
 */
export async function runPipeline() {
  const startTime = Date.now();

  log.separator();
  log.info('Starting multi-agent pipeline...');
  log.info('Pipeline: Discovery → Mapping → Onboarding → Blast Radius');
  log.separator();

  // Stage 1: Discovery
  log.info('Stage 1/4: Discovery');
  const discoveryResult = await runDiscoveryAgent();
  const discoveryContext = extractResult(discoveryResult, 'DISCOVERY_RESULT');

  // Stage 2: Mapping
  log.info('Stage 2/4: Mapping & Linking');
  const mappingResult = await runMappingAgent(discoveryContext);
  const mappingContext = extractResult(mappingResult, 'MAPPING_RESULT');

  // Stage 3: Onboarding
  log.info('Stage 3/4: Application Onboarding');
  const onboardingResult = await runOnboardingAgent(mappingContext);
  const onboardingContext = extractResult(onboardingResult, 'ONBOARDING_RESULT');

  // Stage 4: Blast Radius
  log.info('Stage 4/4: Blast Radius Analysis');
  const blastRadiusResult = await runBlastRadiusAgent(onboardingContext);

  // Final report
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log.separator();
  log.info(`Pipeline complete in ${duration}s`);
  log.separator();

  console.log('\n=== PIPELINE SUMMARY ===\n');
  console.log('--- Discovery ---');
  console.log(discoveryContext);
  console.log('\n--- Mapping ---');
  console.log(mappingContext);
  console.log('\n--- Onboarding ---');
  console.log(onboardingContext);
  console.log('\n--- Blast Radius ---');
  console.log(extractResult(blastRadiusResult, 'BLAST_RADIUS_RESULT'));
  console.log('\n========================\n');

  return {
    discovery: discoveryResult,
    mapping: mappingResult,
    onboarding: onboardingResult,
    blastRadius: blastRadiusResult,
    duration,
  };
}
