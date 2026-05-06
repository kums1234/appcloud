import { createLogger } from './lib/logger.js';
import { runDiscoveryAgent } from './agents/discovery.js';
import { runMappingAgent } from './agents/mapping.js';
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
 * Discovery → Mapping (two-pass: link existing + propose new) → Blast Radius.
 *
 * The standalone Onboarding stage was removed in this branch — its only
 * useful job (inferring Application/Component from naming patterns when no
 * mapping candidate clears threshold) is now Pass 2 of the Mapping agent.
 */
export async function runPipeline() {
  const startTime = Date.now();

  log.separator();
  log.info('Starting multi-agent pipeline...');
  log.info('Pipeline: Discovery → Mapping → Blast Radius');
  log.separator();

  // Stage 1: Discovery
  log.info('Stage 1/3: Discovery');
  const discoveryResult = await runDiscoveryAgent();
  const discoveryContext = extractResult(discoveryResult, 'DISCOVERY_RESULT');

  // Stage 2: Mapping (two-pass — Pass 2 absorbs old Onboarding's Job 2)
  log.info('Stage 2/3: Mapping & Linking');
  const mappingResult = await runMappingAgent(discoveryContext);
  const mappingContext = extractResult(mappingResult, 'MAPPING_RESULT');

  // Stage 3: Blast Radius
  log.info('Stage 3/3: Blast Radius Analysis');
  const blastRadiusResult = await runBlastRadiusAgent(mappingContext);

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
  console.log('\n--- Blast Radius ---');
  console.log(extractResult(blastRadiusResult, 'BLAST_RADIUS_RESULT'));
  console.log('\n========================\n');

  return {
    discovery: discoveryResult,
    mapping: mappingResult,
    blastRadius: blastRadiusResult,
    duration,
  };
}
