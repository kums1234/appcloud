// api/src/connectors/iac-state-backend/backends/gcs.js
//
// Fetches Terraform / OpenTofu state files from Google Cloud Storage. Config:
//   {
//     backend:             'gcs',
//     engine:              'terraform' | 'opentofu',
//     bucket:              'my-tf-state',
//     prefix:              'env/prod/',        // optional
//     object:              'env/prod/default.tfstate', // optional single object
//     serviceAccountJson:  '{ "type": "service_account", … }',  // encrypted JSON string
//     projectId:           'my-project'        // optional — read from creds otherwise
//   }

const SDK_IMPORT = '@google-cloud/storage'

async function buildBucket(cfg) {
  const { Storage } = await import(SDK_IMPORT)
  const storageOpts = {}
  if (cfg.projectId) storageOpts.projectId = cfg.projectId

  if (cfg.serviceAccountJson) {
    try {
      storageOpts.credentials = typeof cfg.serviceAccountJson === 'string'
        ? JSON.parse(cfg.serviceAccountJson)
        : cfg.serviceAccountJson
    } catch (err) {
      throw new Error(`gcs: serviceAccountJson is not valid JSON: ${err.message}`)
    }
  }

  const storage = new Storage(storageOpts)
  return storage.bucket(cfg.bucket)
}

function looksLikeStateKey(key) {
  return key?.endsWith('.tfstate') || key?.endsWith('.tfstate.json')
}

export async function* listStateFiles(cfg) {
  if (cfg.object) {
    yield { key: cfg.object, workspaceId: deriveWorkspaceId(cfg.object) }
    return
  }

  const bucket = await buildBucket(cfg)
  const opts = cfg.prefix ? { prefix: cfg.prefix, autoPaginate: true } : { autoPaginate: true }
  const [files] = await bucket.getFiles(opts)
  for (const file of files) {
    if (!looksLikeStateKey(file.name)) continue
    yield { key: file.name, workspaceId: deriveWorkspaceId(file.name) }
  }
}

export async function fetchStateFile(cfg, key) {
  const bucket = await buildBucket(cfg)
  const [buf]  = await bucket.file(key).download()
  return JSON.parse(buf.toString('utf8'))
}

export async function healthCheck(cfg) {
  try {
    const bucket = await buildBucket(cfg)
    const [exists] = await bucket.exists()
    return exists
      ? { ok: true,  detail: `gs://${cfg.bucket} reachable` }
      : { ok: false, detail: `bucket gs://${cfg.bucket} not found or not accessible` }
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
