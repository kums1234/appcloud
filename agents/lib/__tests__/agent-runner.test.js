// Verifies that the agent-runner's OpenAI-compatible callers (Azure OpenAI,
// Gemini, Groq) issue the right URL + auth header + body shape. Stubs global
// fetch so the test runs offline; no API key required.
//
// Uses node:test so we don't need to bring jest into the agents/ workspace.
// Run: node --test agents/lib/__tests__/agent-runner.test.js
//
// The runner picks its provider from config.aiProvider at module-load time
// (callModel = getModelCaller()). To exercise individual callers without
// reloading the module per provider, the runner exports the call functions
// via __testables — production code never reaches them directly.

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV   = { ...process.env };

// Set every provider key so the config import sees a fully-populated
// environment regardless of which test runs first.
process.env.AI_PROVIDER         = 'gemini';     // arbitrary; we test callers directly
process.env.GEMINI_API_KEY      = 'test-gemini-key';
process.env.GEMINI_MODEL        = 'gemini-2.5-flash-lite';
process.env.GROQ_API_KEY        = 'test-groq-key';
process.env.GROQ_MODEL          = 'llama-3.1-8b-instant';
process.env.AZURE_OPENAI_KEY    = 'test-azure-key';
process.env.AZURE_OPENAI_ENDPOINT   = 'https://test.openai.azure.com';
process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o-test';
process.env.AZURE_OPENAI_API_VERSION = '2024-10-21';
process.env.APPCLOUD_API_KEY    = 'test-app-key';

// Dynamic import after env is set — the runner reads config at import time.
const { __testables } = await import('../agent-runner.js');
const { callAzureOpenAI, callGemini, callGroq } = __testables;

// Canned OpenAI-shaped success response — text-only, no tool calls.
const okResponse = () => ({
  ok:   true,
  status: 200,
  json: async () => ({
    choices: [{
      message: { content: 'hello from stub', tool_calls: [] },
      finish_reason: 'stop',
    }],
  }),
});

// Capture the most recent fetch invocation per test.
let captured;
beforeEach(() => {
  captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return okResponse();
  };
});

after(() => {
  global.fetch = ORIGINAL_FETCH;
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

const SYSTEM_PROMPT = 'You are a test assistant.';
const TOOLS = [{
  name: 'echo',
  description: 'Echo back the input',
  input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
}];
const MESSAGES = [{ role: 'user', content: 'ping' }];

describe('callGemini', () => {
  it('targets the OpenAI-compat endpoint with Bearer auth and a body model', async () => {
    await callGemini(SYSTEM_PROMPT, TOOLS, MESSAGES);
    assert.equal(
      captured.url,
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers.Authorization, 'Bearer test-gemini-key');
    assert.equal(captured.opts.headers['Content-Type'], 'application/json');

    const body = JSON.parse(captured.opts.body);
    assert.equal(body.model, 'gemini-2.5-flash-lite');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, SYSTEM_PROMPT);
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[1].content, 'ping');
    // Anthropic tool shape converted to OpenAI function-tool shape.
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 'echo');
    assert.deepEqual(body.tools[0].function.parameters, TOOLS[0].input_schema);
  });

  it('parses the OpenAI-shaped response into {text, toolCalls, rawContent}', async () => {
    const r = await callGemini(SYSTEM_PROMPT, TOOLS, MESSAGES);
    assert.equal(r.text, 'hello from stub');
    assert.deepEqual(r.toolCalls, []);
    assert.deepEqual(r.rawContent, [{ type: 'text', text: 'hello from stub' }]);
  });
});

describe('callGroq', () => {
  it('targets api.groq.com with Bearer auth and a body model', async () => {
    await callGroq(SYSTEM_PROMPT, TOOLS, MESSAGES);
    assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(captured.opts.headers.Authorization, 'Bearer test-groq-key');
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.model, 'llama-3.1-8b-instant');
  });
});

describe('callAzureOpenAI', () => {
  it('encodes the deployment in the URL and uses api-key header (no body model)', async () => {
    await callAzureOpenAI(SYSTEM_PROMPT, TOOLS, MESSAGES);
    assert.equal(
      captured.url,
      'https://test.openai.azure.com/openai/deployments/gpt-4o-test/chat/completions?api-version=2024-10-21',
    );
    assert.equal(captured.opts.headers['api-key'], 'test-azure-key');
    assert.equal(captured.opts.headers.Authorization, undefined);
    const body = JSON.parse(captured.opts.body);
    // Azure encodes the model in the URL; body should NOT carry one.
    assert.equal(body.model, undefined);
  });
});

describe('error handling', () => {
  it('propagates a non-2xx response with provider label and truncated body', async () => {
    global.fetch = async () => ({
      ok:     false,
      status: 429,
      text:   async () => 'rate limited: try again in 60s',
    });
    await assert.rejects(
      () => callGemini(SYSTEM_PROMPT, TOOLS, MESSAGES),
      /Gemini error \(429\): rate limited/,
    );
  });
});

describe('Anthropic→OpenAI tool conversion via the runner', () => {
  it('preserves tool input_schema as OpenAI parameters', async () => {
    const tools = [{
      name:        'lookup',
      description: 'Look something up',
      input_schema: {
        type:       'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
        required:   ['query'],
      },
    }];
    await callGemini(SYSTEM_PROMPT, tools, MESSAGES);
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.tools[0].function.name, 'lookup');
    assert.equal(body.tools[0].function.description, 'Look something up');
    assert.deepEqual(body.tools[0].function.parameters, tools[0].input_schema);
  });
});
