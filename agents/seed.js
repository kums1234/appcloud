#!/usr/bin/env node

/**
 * Seed script for AppCloud Multi-Agent Pipeline demo.
 *
 * Populates the `default-test` tenant — and ONLY that tenant — with realistic
 * applications, components, connections, and infra so the agents have data to
 * work against without real cloud accounts.
 *
 * Hard rules:
 *   - The target tenant slug is hard-coded to `default-test`. Not configurable.
 *     Customers cannot create that slug (reserved on the API side); the seeder
 *     is the only path that provisions it, via ?allowReserved=true on
 *     POST /admin/tenants (super-admin only).
 *   - Refuses to run when NODE_ENV=production.
 *
 * Usage:
 *   node seed.js              # Seed (auto-creates default-test if missing)
 *   node seed.js --clean      # Delete previously seeded rows first
 *
 * Requires: AppCloud API running, APPCLOUD_API_KEY set to a super-admin key.
 */

const TENANT_SLUG   = 'default-test';      // hard-coded — see file header
const TENANT_NAME   = 'Seed test tenant';
const API           = process.env.APPCLOUD_API_URL || 'http://localhost:3000';
const API_KEY       = process.env.APPCLOUD_API_KEY  || '';
const doClean       = process.argv.includes('--clean');

if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: agents/seed.js refuses to run with NODE_ENV=production.');
  console.error('  This script writes to a hard-coded `default-test` tenant intended for dev/test only.');
  process.exit(1);
}

if (!API_KEY) {
  console.error('ERROR: APPCLOUD_API_KEY is required (sets the X-API-Key header).');
  console.error('  Use the bootstrap super-admin key from the API container.');
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// reqRaw() does not send X-Tenant-Slug — used for /admin/* calls that resolve
// the target tenant from the body or path, not the header. req() pins every
// other call to the seeded tenant.
async function reqRaw(method, path, body = null) {
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key':    API_KEY,
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok && res.status !== 409) {
    console.error(`  FAIL ${method} ${path} (${res.status}):`, typeof data === 'string' ? data.slice(0, 200) : data);
    return null;
  }
  return data;
}

async function req(method, path, body = null) {
  const headers = {
    'Content-Type':  'application/json',
    'X-API-Key':     API_KEY,
    'X-Tenant-Slug': TENANT_SLUG,
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok && res.status !== 409) {
    console.error(`  FAIL ${method} ${path} (${res.status}):`, typeof data === 'string' ? data.slice(0, 200) : data);
    return null;
  }
  return data;
}

function log(icon, msg) { console.log(`  ${icon}  ${msg}`); }

// ─── Tenant + Auth ──────────────────────────────────────────────────────────
// The target tenant is hard-coded to `default-test`. We auto-create it via
// /admin/tenants?allowReserved=true (super-admin only) when missing, so a
// fresh DB doesn't require any operator pre-step.

async function ensureTenant() {
  const tenants = await reqRaw('GET', '/admin/tenants');
  if (!Array.isArray(tenants)) {
    console.error('ERROR: could not list tenants — does APPCLOUD_API_KEY have super-admin scope?');
    process.exit(1);
  }
  const existing = tenants.find(t => t.slug === TENANT_SLUG);
  if (existing) {
    log('🏢', `Tenant '${TENANT_SLUG}' already exists`);
    return existing;
  }
  log('🏢', `Tenant '${TENANT_SLUG}' missing — creating via ?allowReserved=true`);
  const created = await reqRaw(
    'POST',
    '/admin/tenants?allowReserved=true',
    { slug: TENANT_SLUG, displayName: TENANT_NAME, metadata: { seededBy: 'agents/seed.js' } },
  );
  if (!created?.id) {
    console.error(`ERROR: could not create tenant '${TENANT_SLUG}'.`);
    process.exit(1);
  }
  return created;
}

async function ensureUser() {
  await ensureTenant();
  log('👤', `Authenticated via X-API-Key (tenant=${TENANT_SLUG})`);
  return { id: 'seed-admin', name: 'seed-admin' };
}

// ─── Clean ──────────────────────────────────────────────────────────────────

async function clean() {
  log('🧹', 'Cleaning previous seed data...');

  // Delete changes, then components, then apps, then infra
  const changes = await req('GET', '/changes') || [];
  for (const ch of changes) {
    if (ch.title?.startsWith('[seed]')) {
      await req('DELETE', `/changes/${ch.id}`);
    }
  }

  const apps = await req('GET', '/applications') || [];
  for (const app of apps) {
    if (app.name?.startsWith('[seed]')) {
      await req('DELETE', `/applications/${app.id}`);
    }
  }

  // Infra nodes tagged as seed
  const infra = await req('GET', '/infra') || [];
  for (const node of infra) {
    if (node.name?.startsWith('[seed]')) {
      await req('DELETE', `/infra/${node.id}`);
    }
  }

  log('✓', 'Clean complete');
}

// ─── Seed Data ──────────────────────────────────────────────────────────────

async function seed() {
  const user = await ensureUser();
  if (doClean) await clean();

  console.log('\n── Creating Applications ──');

  const apps = {};
  const appDefs = [
    { name: '[seed] Payment Gateway',  tier: 1, owner: 'payments-team',   environment: 'prod',    domain: 'finance',     availability: '99.99', confidentiality: 'confidential' },
    { name: '[seed] User Portal',      tier: 1, owner: 'platform-team',   environment: 'prod',    domain: 'platform',    availability: '99.95', confidentiality: 'restricted' },
    { name: '[seed] Analytics Engine', tier: 2, owner: 'data-team',       environment: 'prod',    domain: 'analytics',   availability: '99.9',  confidentiality: 'internal' },
    { name: '[seed] Dev Sandbox',      tier: 3, owner: 'engineering',     environment: 'dev',     domain: 'engineering', availability: '95.0',  confidentiality: 'internal' },
    { name: '[seed] Notification Hub', tier: 2, owner: 'platform-team',   environment: 'prod',    domain: 'platform',    availability: '99.9',  confidentiality: 'internal' },
  ];

  for (const def of appDefs) {
    const app = await req('POST', '/applications', def);
    if (app?.id) {
      apps[def.name] = app;
      log('✓', `App: ${def.name} (tier ${def.tier})`);
    }
  }

  console.log('\n── Creating Components ──');

  const comps = {};
  const compDefs = [
    // Payment Gateway
    { name: '[seed] payment-api',      type: 'api',      runtime: 'nodejs',  appName: '[seed] Payment Gateway' },
    { name: '[seed] payment-worker',   type: 'worker',   runtime: 'nodejs',  appName: '[seed] Payment Gateway' },
    { name: '[seed] payment-db',       type: 'database', runtime: 'postgres', appName: '[seed] Payment Gateway' },
    // User Portal
    { name: '[seed] portal-frontend',  type: 'frontend', runtime: 'react',   appName: '[seed] User Portal' },
    { name: '[seed] portal-api',       type: 'api',      runtime: 'python',  appName: '[seed] User Portal' },
    { name: '[seed] portal-db',        type: 'database', runtime: 'postgres', appName: '[seed] User Portal' },
    { name: '[seed] portal-cache',     type: 'cache',    runtime: 'redis',   appName: '[seed] User Portal' },
    // Analytics Engine
    { name: '[seed] analytics-ingest', type: 'worker',   runtime: 'python',  appName: '[seed] Analytics Engine' },
    { name: '[seed] analytics-db',     type: 'database', runtime: 'postgres', appName: '[seed] Analytics Engine' },
    { name: '[seed] analytics-api',    type: 'api',      runtime: 'python',  appName: '[seed] Analytics Engine' },
    // Notification Hub
    { name: '[seed] notif-api',        type: 'api',      runtime: 'nodejs',  appName: '[seed] Notification Hub' },
    { name: '[seed] notif-queue',      type: 'queue',    runtime: 'docker',  appName: '[seed] Notification Hub' },
    // Dev Sandbox — no components (left for onboarding agent to create)
  ];

  for (const def of compDefs) {
    const app = apps[def.appName];
    const comp = await req('POST', '/components', {
      name: def.name,
      type: def.type,
      runtime: def.runtime,
      applicationId: app?.id,
    });
    if (comp?.id) {
      comps[def.name] = comp;
      log('✓', `Component: ${def.name} (${def.type}) → ${def.appName}`);
    }
  }

  console.log('\n── Creating Component Connections ──');

  const connections = [
    // Payment Gateway internal
    { from: '[seed] payment-api',     to: '[seed] payment-db',       protocol: 'tcp',   port: 5432 },
    { from: '[seed] payment-api',     to: '[seed] payment-worker',   protocol: 'amqp',  port: 5672 },
    // User Portal internal
    { from: '[seed] portal-frontend', to: '[seed] portal-api',       protocol: 'https', port: 443 },
    { from: '[seed] portal-api',      to: '[seed] portal-db',        protocol: 'tcp',   port: 5432 },
    { from: '[seed] portal-api',      to: '[seed] portal-cache',     protocol: 'tcp',   port: 6379 },
    // Cross-app: Portal → Payment (critical dependency)
    { from: '[seed] portal-api',      to: '[seed] payment-api',      protocol: 'https', port: 443 },
    // Cross-app: Analytics ← Portal (data feed)
    { from: '[seed] portal-api',      to: '[seed] analytics-ingest', protocol: 'https', port: 443 },
    // Cross-app: Notification from Payment
    { from: '[seed] payment-worker',  to: '[seed] notif-api',        protocol: 'https', port: 443 },
    // Analytics internal
    { from: '[seed] analytics-ingest', to: '[seed] analytics-db',    protocol: 'tcp',   port: 5432 },
    { from: '[seed] analytics-api',    to: '[seed] analytics-db',    protocol: 'tcp',   port: 5432 },
    // Notification internal
    { from: '[seed] notif-api',       to: '[seed] notif-queue',      protocol: 'amqp',  port: 5672 },
  ];

  for (const conn of connections) {
    const from = comps[conn.from];
    const to = comps[conn.to];
    if (from && to) {
      await req('POST', `/components/${from.id}/connections`, {
        targetId: to.id,
        protocol: conn.protocol,
        port: conn.port,
      });
      log('✓', `${conn.from} → ${conn.to} (${conn.protocol}:${conn.port})`);
    }
  }

  console.log('\n── Creating Infrastructure (mapped) ──');

  const infra = {};
  const infraDefs = [
    // AWS — mapped to Payment Gateway
    { name: '[seed] prod-payment-api-1',     provider: 'aws', resource_type: 'ec2_instance',       region: 'us-east-1', deployTo: '[seed] payment-api' },
    { name: '[seed] prod-payment-api-2',     provider: 'aws', resource_type: 'ec2_instance',       region: 'us-east-1', deployTo: '[seed] payment-api' },
    { name: '[seed] prod-payment-rds',       provider: 'aws', resource_type: 'rds_instance',       region: 'us-east-1', deployTo: '[seed] payment-db' },
    { name: '[seed] prod-payment-worker-1',  provider: 'aws', resource_type: 'ec2_instance',       region: 'us-east-1', deployTo: '[seed] payment-worker' },
    { name: '[seed] prod-payment-alb',       provider: 'aws', resource_type: 'load_balancer',      region: 'us-east-1', public: true, deployTo: '[seed] payment-api' },
    // Azure — mapped to User Portal
    { name: '[seed] prod-portal-vm-1',       provider: 'azure', resource_type: 'vm',               region: 'eastus',    deployTo: '[seed] portal-api' },
    { name: '[seed] prod-portal-vm-2',       provider: 'azure', resource_type: 'vm',               region: 'eastus',    deployTo: '[seed] portal-api' },
    { name: '[seed] prod-portal-sql',        provider: 'azure', resource_type: 'sql_server',       region: 'eastus',    deployTo: '[seed] portal-db' },
    { name: '[seed] prod-portal-redis',      provider: 'azure', resource_type: 'redis_cache',      region: 'eastus',    deployTo: '[seed] portal-cache' },
    { name: '[seed] prod-portal-appgw',      provider: 'azure', resource_type: 'application_gateway', region: 'eastus', public: true, deployTo: '[seed] portal-frontend' },
    // GCP — mapped to Analytics
    { name: '[seed] prod-analytics-gke',     provider: 'gcp', resource_type: 'gke_cluster',        region: 'us-central1', deployTo: '[seed] analytics-ingest' },
    { name: '[seed] prod-analytics-cloudsql', provider: 'gcp', resource_type: 'cloud_sql',         region: 'us-central1', deployTo: '[seed] analytics-db' },
    { name: '[seed] prod-analytics-api-vm',  provider: 'gcp', resource_type: 'compute_instance',   region: 'us-central1', deployTo: '[seed] analytics-api' },
    // AWS — mapped to Notification Hub
    { name: '[seed] prod-notif-lambda',      provider: 'aws', resource_type: 'lambda_function',    region: 'us-east-1',  deployTo: '[seed] notif-api' },
    { name: '[seed] prod-notif-sqs',         provider: 'aws', resource_type: 'sqs_queue',          region: 'us-east-1',  deployTo: '[seed] notif-queue' },
  ];

  for (const def of infraDefs) {
    const node = await req('POST', '/infra', {
      name: def.name,
      provider: def.provider,
      resource_type: def.resource_type,
      region: def.region,
      public: def.public || false,
    });
    if (node?.id) {
      infra[def.name] = node;
      // Deploy component to infra
      const comp = comps[def.deployTo];
      if (comp) {
        await req('POST', `/components/${comp.id}/deploy`, { infraId: node.id });
        log('✓', `Infra: ${def.name} (${def.provider}) → ${def.deployTo}`);
      }
    }
  }

  console.log('\n── Creating Infrastructure (unmapped — for agents to discover/map) ──');

  const unmappedDefs = [
    // These have no deployTo — agents should figure out where they belong
    { name: '[seed] prod-mystery-vm-1',      provider: 'azure', resource_type: 'vm',              region: 'eastus' },
    { name: '[seed] prod-mystery-vm-2',      provider: 'azure', resource_type: 'vm',              region: 'eastus' },
    { name: '[seed] dev-sandbox-eks',        provider: 'aws',   resource_type: 'eks_cluster',     region: 'us-west-2' },
    { name: '[seed] dev-sandbox-rds',        provider: 'aws',   resource_type: 'rds_instance',    region: 'us-west-2' },
    { name: '[seed] staging-cache-redis',    provider: 'azure', resource_type: 'redis_cache',     region: 'westus' },
    { name: '[seed] orphan-s3-logs',         provider: 'aws',   resource_type: 's3_bucket',       region: 'us-east-1' },
    { name: '[seed] orphan-cloudrun-cron',   provider: 'gcp',   resource_type: 'cloud_run',       region: 'us-central1' },
  ];

  for (const def of unmappedDefs) {
    const node = await req('POST', '/infra', {
      name: def.name,
      provider: def.provider,
      resource_type: def.resource_type,
      region: def.region,
      public: false,
    });
    if (node?.id) {
      infra[def.name] = node;
      log('⚠', `Unmapped: ${def.name} (${def.provider}) — agents will handle this`);
    }
  }

  console.log('\n── Creating Changes ──');

  const changeDefs = [
    {
      title: '[seed] Upgrade Payment RDS to db.r6g.xlarge',
      description: 'Scale up the payment database for Black Friday traffic. Requires 10-minute maintenance window.',
      type: 'general',
      riskScore: 8,
      modifies: ['[seed] prod-payment-rds'],
      affects: ['[seed] Payment Gateway'],
    },
    {
      title: '[seed] Rotate Portal API TLS certificates',
      description: 'Annual TLS cert rotation for portal-api instances. Rolling restart required.',
      type: 'general',
      riskScore: 5,
      modifies: ['[seed] prod-portal-vm-1', '[seed] prod-portal-vm-2'],
      affects: ['[seed] User Portal'],
    },
    {
      title: '[seed] Migrate Analytics to new GKE node pool',
      description: 'Move analytics workloads to ARM-based node pool for cost savings.',
      type: 'migration',
      riskScore: 6,
      modifies: ['[seed] prod-analytics-gke'],
      affects: ['[seed] Analytics Engine'],
    },
    {
      title: '[seed] Decommission orphan S3 bucket',
      description: 'Remove unused log bucket that has been idle for 6 months.',
      type: 'general',
      riskScore: 2,
      modifies: ['[seed] orphan-s3-logs'],
      affects: [],
    },
  ];

  // We need a user node in Neo4j for SUBMITTED relationship
  await req('POST', '/users', { name: 'seed-admin', email: 'seed@appcloud.local', role: 'admin' });

  // Get the user ID from Neo4j
  const users = await req('GET', '/users') || [];
  const seedUser = users.find(u => u.name === 'seed-admin') || users[0];

  if (seedUser) {
    for (const def of changeDefs) {
      const modifiesIds = def.modifies.map(n => infra[n]?.id).filter(Boolean);
      const affectsIds = def.affects.map(n => apps[n]?.id).filter(Boolean);

      const change = await req('POST', '/changes', {
        title: def.title,
        description: def.description,
        type: def.type,
        riskScore: def.riskScore,
        submittedBy: seedUser.id,
        modifiesIds,
        affectsIds,
      });
      if (change?.id) {
        log(def.riskScore >= 7 ? '🔴' : def.riskScore >= 4 ? '🟡' : '🟢',
          `Change: ${def.title} (risk: ${def.riskScore})`);
      }
    }
  } else {
    log('⚠', 'Skipped changes — no user available for SUBMITTED relationship');
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  SEED COMPLETE');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Applications:    ${Object.keys(apps).length}`);
  console.log(`  Components:      ${Object.keys(comps).length}`);
  console.log(`  Infra (mapped):  ${infraDefs.length}`);
  console.log(`  Infra (unmapped): ${unmappedDefs.length} (for agents to handle)`);
  console.log(`  Connections:     ${connections.length}`);
  console.log(`  Changes:         ${changeDefs.length}`);
  console.log('');
  console.log('  Next steps:');
  console.log('    cd agents');
  console.log('    cp .env.example .env   # add your ANTHROPIC_API_KEY');
  console.log('    node run.js pipeline   # run the multi-agent pipeline');
  console.log('══════════════════════════════════════════════════════════\n');
}

// ─── Run ────────────────────────────────────────────────────────────────────

seed().catch((err) => {
  console.error('\nSeed failed:', err.message);
  process.exit(1);
});
