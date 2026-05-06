import 'dotenv/config';

export const config = {
  // AI provider: 'ollama' (free, local) | 'anthropic' (API credits) | 'azure_openai' (Azure)
  aiProvider: process.env.AI_PROVIDER || 'ollama',

  // Anthropic settings
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',

  // Azure OpenAI settings
  azureOpenAiKey: process.env.AZURE_OPENAI_KEY || '',
  azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
  azureOpenAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
  azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',

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
  if (config.aiProvider === 'anthropic' && !config.anthropicApiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
    console.error('  Either set AI_PROVIDER=ollama (free, local) or provide an API key.');
    process.exit(1);
  }

  if (config.aiProvider === 'azure_openai' && !config.azureOpenAiKey) {
    console.error('ERROR: AZURE_OPENAI_KEY is required when AI_PROVIDER=azure_openai');
    console.error('  Set AZURE_OPENAI_KEY and AZURE_OPENAI_ENDPOINT in .env');
    process.exit(1);
  }

  if (!config.appcloudApiKey) {
    console.error('ERROR: APPCLOUD_API_KEY is required to call the AppCloud API.');
    console.error('  Use the bootstrap key from the API container or mint one via /admin/api-keys.');
    process.exit(1);
  }

  if (config.aiProvider === 'ollama') {
    console.log(`Using Ollama (${config.ollamaModel}) at ${config.ollamaUrl}`);
  } else if (config.aiProvider === 'azure_openai') {
    console.log(`Using Azure OpenAI (${config.azureOpenAiDeployment}) at ${config.azureOpenAiEndpoint}`);
  } else {
    console.log(`Using Anthropic (${config.claudeModel})`);
  }

  if (config.appcloudTenantSlug) {
    console.log(`AppCloud tenant: ${config.appcloudTenantSlug} (X-Tenant-Slug)`);
  }
}
