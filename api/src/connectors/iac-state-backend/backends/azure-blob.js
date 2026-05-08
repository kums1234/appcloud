// api/src/connectors/iac-state-backend/backends/azure-blob.js
//
// Fetches Terraform / OpenTofu state files from Azure Blob Storage. Config:
//   {
//     backend:              'azure-blob',
//     engine:               'terraform' | 'opentofu',
//     accountName:          'myaccount',
//     container:            'tfstate',
//     prefix:               'prod/',          // optional
//     blob:                 'prod/terraform.tfstate',  // optional single blob
//     storageAccountKey:    '…',              // encrypted at rest
//     sasToken:             '?sv=…',          // OR SAS token (either-or)
//   }
//
// Auth precedence: storageAccountKey → sasToken. Managed-identity / AAD auth
// can be added later by layering DefaultAzureCredential.

const SDK_IMPORT = '@azure/storage-blob'

async function buildContainer(cfg) {
  const { BlobServiceClient, StorageSharedKeyCredential } = await import(SDK_IMPORT)

  let serviceClient
  if (cfg.storageAccountKey) {
    const cred = new StorageSharedKeyCredential(cfg.accountName, cfg.storageAccountKey)
    serviceClient = new BlobServiceClient(
      `https://${cfg.accountName}.blob.core.windows.net`,
      cred,
    )
  } else if (cfg.sasToken) {
    const sas = cfg.sasToken.startsWith('?') ? cfg.sasToken : `?${cfg.sasToken}`
    serviceClient = new BlobServiceClient(
      `https://${cfg.accountName}.blob.core.windows.net${sas}`,
    )
  } else {
    throw new Error('azure-blob requires storageAccountKey or sasToken')
  }

  return serviceClient.getContainerClient(cfg.container)
}

function looksLikeStateKey(key) {
  return key?.endsWith('.tfstate') || key?.endsWith('.tfstate.json')
}

export async function* listStateFiles(cfg) {
  if (cfg.blob) {
    yield { key: cfg.blob, workspaceId: deriveWorkspaceId(cfg.blob) }
    return
  }

  const container = await buildContainer(cfg)
  const opts = cfg.prefix ? { prefix: cfg.prefix } : undefined

  for await (const blob of container.listBlobsFlat(opts)) {
    if (!looksLikeStateKey(blob.name)) continue
    yield { key: blob.name, workspaceId: deriveWorkspaceId(blob.name) }
  }
}

export async function fetchStateFile(cfg, key) {
  const container = await buildContainer(cfg)
  const blob = container.getBlobClient(key)
  const buf  = await blob.downloadToBuffer()
  return JSON.parse(buf.toString('utf8'))
}

export async function healthCheck(cfg) {
  try {
    const container = await buildContainer(cfg)
    await container.getProperties()
    return { ok: true, detail: `azure://${cfg.accountName}/${cfg.container} reachable` }
  } catch (err) {
    return { ok: false, detail: err.message }
  }
}

function deriveWorkspaceId(key) {
  if (!key) return 'default'
  const envMatch = key.match(/(?:env:?\/)([^/]+)\//)
  if (envMatch) return envMatch[1]
  const segments = key.split('/').filter(Boolean)
  return segments.length > 1 ? segments[segments.length - 2] : 'default'
}
