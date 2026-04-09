import { config } from './config.js';
import { createLogger } from './logger.js';

// ─── Anthropic Backend ──────────────────────────────────────────────────────

async function callAnthropic(systemPrompt, tools, messages) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 4096,
    system: systemPrompt,
    tools,
    messages,
  });

  const textBlocks = response.content.filter(b => b.type === 'text');
  const toolBlocks = response.content.filter(b => b.type === 'tool_use');

  return {
    text: textBlocks.map(b => b.text).join('\n').trim(),
    toolCalls: toolBlocks.map(b => ({
      id: b.id,
      name: b.name,
      input: b.input,
    })),
    rawContent: response.content,
  };
}

// ─── Azure OpenAI Backend ───────────────────────────────────────────────────

function anthropicToolToOpenAI(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function openAIMessagesFromAnthropic(systemPrompt, messages) {
  const out = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            out.push({
              role: 'tool',
              content: block.content,
              tool_call_id: block.tool_use_id,
            });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      const textParts = Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
        : (msg.content || '');

      const toolCalls = Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'tool_use').map(b => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }))
        : [];

      const assistantMsg = { role: 'assistant', content: textParts || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
    }
  }

  return out;
}

function parseOpenAIResponse(choice) {
  const msg = choice.message;
  const text = msg.content || '';
  const toolCalls = (msg.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments || '{}'),
  }));

  // Build rawContent in Anthropic format for consistent conversation history
  const rawContent = [];
  if (text) rawContent.push({ type: 'text', text });
  for (const tc of toolCalls) {
    rawContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }

  return { text, toolCalls, rawContent };
}

async function callAzureOpenAI(systemPrompt, tools, messages) {
  const openAIMessages = openAIMessagesFromAnthropic(systemPrompt, messages);
  const openAITools = tools.map(anthropicToolToOpenAI);

  // Use Azure OpenAI REST API directly — no extra SDK dependency needed
  const url = `${config.azureOpenAiEndpoint.replace(/\/$/, '')}/openai/deployments/${config.azureOpenAiDeployment}/chat/completions?api-version=${config.azureOpenAiApiVersion}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': config.azureOpenAiKey,
    },
    body: JSON.stringify({
      messages: openAIMessages,
      tools: openAITools,
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Azure OpenAI error (${res.status}): ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  return parseOpenAIResponse(data.choices[0]);
}

// ─── Ollama Backend ─────────────────────────────────────────────────────────

async function callOllama(systemPrompt, tools, messages) {
  const ollamaMessages = openAIMessagesFromAnthropic(systemPrompt, messages);
  const ollamaTools = tools.map(anthropicToolToOpenAI);

  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      messages: ollamaMessages,
      tools: ollamaTools,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const msg = data.message;

  const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
    id: `ollama_${Date.now()}_${i}`,
    name: tc.function.name,
    input: typeof tc.function.arguments === 'string'
      ? JSON.parse(tc.function.arguments)
      : tc.function.arguments,
  }));

  const rawContent = [];
  if (msg.content) rawContent.push({ type: 'text', text: msg.content });
  for (const tc of toolCalls) {
    rawContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }

  return { text: msg.content || '', toolCalls, rawContent };
}

// ─── Provider Selector ──────────────────────────────────────────────────────

function getModelCaller() {
  switch (config.aiProvider) {
    case 'anthropic':    return callAnthropic;
    case 'azure_openai': return callAzureOpenAI;
    case 'ollama':       return callOllama;
    default:
      console.error(`Unknown AI_PROVIDER: ${config.aiProvider}. Use: ollama, anthropic, azure_openai`);
      process.exit(1);
  }
}

const callModel = getModelCaller();

// ─── Unified Agent Runner ───────────────────────────────────────────────────

function getModelLabel() {
  switch (config.aiProvider) {
    case 'anthropic':    return config.claudeModel;
    case 'azure_openai': return config.azureOpenAiDeployment;
    case 'ollama':       return config.ollamaModel;
    default:             return config.aiProvider;
  }
}

/**
 * Run an agent through the agentic tool-use loop.
 */
export async function runAgent({ name, systemPrompt, tools, toolHandler, userMessage, maxTurns = 15 }) {
  const log = createLogger(name);
  log.separator();
  log.info(`Starting agent (${config.aiProvider}: ${getModelLabel()})...`);

  const messages = [{ role: 'user', content: userMessage }];
  let turns = 0;

  while (turns < maxTurns) {
    turns++;

    let response;
    try {
      response = await callModel(systemPrompt, tools, messages);
    } catch (err) {
      log.error(`Model call failed: ${err.message}`);
      return `Agent ${name} failed: ${err.message}`;
    }

    if (response.text) {
      log.thinking(response.text);
    }

    if (response.toolCalls.length === 0) {
      log.response(response.text);
      log.separator();
      return response.text;
    }

    const toolResults = [];
    for (const tc of response.toolCalls) {
      log.tool(tc.name, tc.input);

      let result;
      try {
        result = await toolHandler(tc.name, tc.input);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        log.result(tc.name, resultStr);
      } catch (err) {
        result = `Error: ${err.message}`;
        log.error(`${tc.name}: ${err.message}`);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    messages.push({ role: 'assistant', content: response.rawContent });
    messages.push({ role: 'user', content: toolResults });
  }

  log.error(`Agent reached max turns (${maxTurns}) without completing.`);
  log.separator();
  return `Agent ${name} did not complete within ${maxTurns} turns.`;
}
