import 'dotenv/config';

export const config = {
  // AI provider:
  //   ollama       — free, local
  //   anthropic    — API credits
  //   azure_openai — Azure-hosted OpenAI
  //   gemini       — Google Gemini via OpenAI-compat endpoint (recommended free tier)
  //   groq         — Groq via OpenAI-compat endpoint (highest req/day on free tier)
  aiProvider: process.env.AI_PROVIDER || 'ollama',

  // Anthropic settings
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',

  // Azure OpenAI settings
  azureOpenAiKey: process.env.AZURE_OPENAI_KEY || '',
  azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
  azureOpenAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
  azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',

  // Google Gemini (via OpenAI-compat endpoint at generativelanguage.googleapis.com).
  // gemini-2.5-flash-lite has the most permissive free tier — 15 RPM,
  // 1,000 req/day. Switch to gemini-2.5-flash for higher quality at 250 req/day.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel:  process.env.GEMINI_MODEL  || 'gemini-2.5-flash-lite',

  // Groq (OpenAI-compat). llama-3.1-8b-instant has the most permissive
  // free tier — 30 RPM, 14,400 req/day, 500K daily tokens. For higher
  // quality switch to llama-3.3-70b-versatile (1,000 req/day cap).
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel:  process.env.GROQ_MODEL  || 'llama-3.1-8b-instant',

  // Ollama settings
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',

  // AppCloud API
  appcloudApiUrl: process.env.APPCLOUD_API_URL || 'http://localhost:3000',
  // X-API-Key value. The bootstrap key is exposed via APPCLOUD_API_KEY in the
  // API container; for tenant-scoped use, mint a key under /admin/api-keys.
  appcloudApiKey: process.env.APPCLOUD_API_KEY || '',
  // Optional X-Tenant-Slug for super-admin keys acting on a specific tenant.
  // Tenant-bound keys ignore this header — leave blank.
  appcloudTenantSlug: process.env.APPCLOUD_TENANT_SLUG || '',
};

export function validateConfig() {
  const provider = config.aiProvider;

  if (provider === 'anthropic' && !config.anthropicApiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
    console.error('  Either set AI_PROVIDER=ollama (free, local) or provide an API key.');
    process.exit(1);
  }

  if (provider === 'azure_openai' && !config.azureOpenAiKey) {
    console.error('ERROR: AZURE_OPENAI_KEY is required when AI_PROVIDER=azure_openai');
    console.error('  Set AZURE_OPENAI_KEY and AZURE_OPENAI_ENDPOINT in .env');
    process.exit(1);
  }

  if (provider === 'gemini' && !config.geminiApiKey) {
    console.error('ERROR: GEMINI_API_KEY is required when AI_PROVIDER=gemini');
    console.error('  Get a free key at https://aistudio.google.com/ — no card required.');
    process.exit(1);
  }

  if (provider === 'groq' && !config.groqApiKey) {
    console.error('ERROR: GROQ_API_KEY is required when AI_PROVIDER=groq');
    console.error('  Get a free key at https://console.groq.com/ — no card required.');
    process.exit(1);
  }

  if (!['ollama', 'anthropic', 'azure_openai', 'gemini', 'groq'].includes(provider)) {
    console.error(`ERROR: AI_PROVIDER=${provider} is not recognised.`);
    console.error('  Use: ollama | anthropic | azure_openai | gemini | groq');
    process.exit(1);
  }

  if (!config.appcloudApiKey) {
    console.error('ERROR: APPCLOUD_API_KEY is required to call the AppCloud API.');
    console.error('  Use the bootstrap key from the API container or mint one via /admin/api-keys.');
    process.exit(1);
  }

  switch (provider) {
    case 'ollama':       console.log(`Using Ollama (${config.ollamaModel}) at ${config.ollamaUrl}`);       break;
    case 'azure_openai': console.log(`Using Azure OpenAI (${config.azureOpenAiDeployment}) at ${config.azureOpenAiEndpoint}`); break;
    case 'gemini':       console.log(`Using Gemini (${config.geminiModel}) — free tier`);                  break;
    case 'groq':         console.log(`Using Groq (${config.groqModel}) — free tier`);                      break;
    case 'anthropic':    console.log(`Using Anthropic (${config.claudeModel})`);                           break;
  }

  if (config.appcloudTenantSlug) {
    console.log(`AppCloud tenant: ${config.appcloudTenantSlug} (X-Tenant-Slug)`);
  }
}
