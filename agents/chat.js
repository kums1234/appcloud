#!/usr/bin/env node

/**
 * AppCloud AI Assistant — interactive CLI chat.
 *
 * Posts conversations to the API's POST /ai/chat endpoint. Maintains in-memory
 * message history across turns. The /ai/chat endpoint injects a live snapshot
 * of the graph (apps, infra, unmapped resources, cross-app deps) into the
 * system prompt, so the assistant always answers against current data.
 *
 * Slash commands:
 *   :help              Show this help
 *   :exit / :quit      Exit the REPL
 *   :clear             Clear conversation history (keeps system messages)
 *   :status            Show /ai/status (which provider is wired up)
 *   :tenant <slug>     Switch X-Tenant-Slug for subsequent calls
 *   :local             Toggle useLocal (force Ollama instead of cloud)
 *   :save <file>       Save conversation to a JSON file
 *   :load <file>       Load conversation from a JSON file
 *
 * Usage:
 *   node chat.js                 (uses APPCLOUD_TENANT_SLUG env var)
 *   node run.js chat
 */

import readline from 'node:readline';
import fs       from 'node:fs/promises';
import path     from 'node:path';
import { AppCloudClient } from './lib/api-client.js';
import { config }         from './lib/config.js';

if (!config.appcloudApiKey) {
  console.error('ERROR: APPCLOUD_API_KEY is required.');
  console.error('  Use the bootstrap key from the API container or mint one via /admin/api-keys.');
  process.exit(1);
}

let api      = new AppCloudClient();
let messages = [];                                   // conversation history
let useLocal = false;                                // force Ollama if true
let tenant   = config.appcloudTenantSlug || '';

function banner() {
  console.log('');
  console.log('  AppCloud AI Assistant — interactive chat');
  console.log(`  API: ${config.appcloudApiUrl}${tenant ? `  tenant=${tenant}` : ''}${useLocal ? '  [local]' : ''}`);
  console.log('  Type :help for commands. Ctrl+C or :exit to quit.');
  console.log('');
}

function help() {
  console.log('');
  console.log('  Slash commands:');
  console.log('    :help              Show this help');
  console.log('    :exit / :quit      Exit');
  console.log('    :clear             Clear conversation history');
  console.log('    :status            Show /ai/status');
  console.log('    :tenant <slug>     Switch X-Tenant-Slug');
  console.log('    :local             Toggle useLocal (force Ollama)');
  console.log('    :save <file>       Save conversation to JSON');
  console.log('    :load <file>       Load conversation from JSON');
  console.log('');
}

async function showStatus() {
  try {
    const s = await api.aiStatus();
    console.log('');
    console.log('  /ai/status:');
    console.log(`    local:  available=${s.local?.available}  model=${s.local?.model || '-'}  url=${s.local?.baseUrl || '-'}`);
    console.log(`    cloud:  available=${s.cloud?.available}  provider=${s.cloud?.provider || '-'}  model=${s.cloud?.model || '-'}`);
    console.log('');
  } catch (err) {
    console.error(`  status failed: ${err.message}`);
  }
}

function setTenant(slug) {
  tenant = slug || '';
  api    = new AppCloudClient(config.appcloudApiUrl, config.appcloudApiKey, tenant);
  console.log(`  tenant set to: ${tenant || '(none)'}`);
}

async function saveConv(file) {
  if (!file) return console.error('  usage: :save <file>');
  await fs.writeFile(path.resolve(file), JSON.stringify(messages, null, 2));
  console.log(`  saved ${messages.length} messages to ${file}`);
}

async function loadConv(file) {
  if (!file) return console.error('  usage: :load <file>');
  const raw  = await fs.readFile(path.resolve(file), 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('expected a JSON array of messages');
  messages = data;
  console.log(`  loaded ${messages.length} messages from ${file}`);
}

async function send(userInput) {
  messages.push({ role: 'user', content: userInput });
  const opts = useLocal ? { useLocal: true } : {};
  let res;
  try {
    res = await api.chat(messages, opts);
  } catch (err) {
    // Roll back the optimistic push so the user can retry without the failed turn polluting history.
    messages.pop();
    console.error(`  chat error: ${err.message}`);
    return;
  }

  const reply = res?.choices?.[0]?.message?.content ?? res?.output ?? '(no content)';
  messages.push({ role: 'assistant', content: reply });

  console.log('');
  console.log(reply);
  console.log('');
  const meta = [
    res?.provider && `provider=${res.provider}`,
    res?.model    && `model=${res.model}`,
    res?.action   && `action=${res.action}`,
    res?.tokens?.total_tokens && `tokens=${res.tokens.total_tokens}`,
  ].filter(Boolean).join('  ');
  if (meta) console.log(`  [${meta}]`);
}

async function handleSlash(line) {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case 'help':                       help();                       break;
    case 'exit': case 'quit':          process.exit(0);
    case 'clear':                       messages = []; console.log('  history cleared'); break;
    case 'status':                      await showStatus();            break;
    case 'tenant':                      setTenant(arg);                break;
    case 'local':                       useLocal = !useLocal; console.log(`  useLocal=${useLocal}`); break;
    case 'save':                        await saveConv(arg);            break;
    case 'load':                        await loadConv(arg);            break;
    default:                            console.log(`  unknown command: :${cmd} (try :help)`);
  }
}

async function main() {
  banner();
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });

  rl.on('SIGINT', () => { console.log('\n  bye'); process.exit(0); });
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); continue; }
    try {
      if (trimmed.startsWith(':')) {
        await handleSlash(trimmed);
      } else {
        await send(trimmed);
      }
    } catch (err) {
      console.error(`  error: ${err.message}`);
    }
    rl.prompt();
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
