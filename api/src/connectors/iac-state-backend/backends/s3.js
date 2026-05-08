// api/src/connectors/iac-state-backend/backends/s3.js
//
// Fetches Terraform / OpenTofu state files from AWS S3. Config shape:
//   {
//     backend:          's3',
//     engine:           'terraform' | 'opentofu',
//     region:           'us-east-1',
//     bucket:           'my-tf-state',
//     prefix:           'env/prod/'        // optional — list only this prefix
//     key:              'env/prod/terraform.tfstate'  // optional — single file
//     awsAccessKeyId:   '…',               // optional — default chain is used
//     secretAccessKey:  '…',               // (encrypted at rest via SECRET_FIELDS)
//     roleArn:          'arn:aws:iam::…'   // optional — STS assume-role
//   }
//
// Either `key` OR `prefix` may be supplied. When both are empty every .tfstate
// under the bucket is scanned.

const CLIENT_IMPORT = '@aws-sdk/client-s3'

async function buildClient(cfg) {
  const { S3Client } = await import(CLIENT_IMPORT)
  /** @type {import('@aws-sdk/client-s3').S3ClientConfig} */
  const opts = { region: cfg.region }
  if (cfg.awsAccessKeyId && cfg.secretAccessKey) {
    opts.credentials = {
      accessKeyId:     cfg.awsAccessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    }
  }
  // STS assume-role is implemented by injecting a credential provider —
  // deferred until we have a concrete use-case with an IAM role arn.
  return new S3Client(opts)
}

function looksLikeStateKey(key) {
  return key?.endsWith('.tfstate') || key?.endsWith('.tfstate.json')
}

/**
 * Lists candidate state keys under the configured bucket/prefix.
 * @returns {AsyncGenerator<{ key:string, workspaceId?:string }>}
 */
export async function* listStateFiles(cfg) {
  if (cfg.key) {
    yield { key: cfg.key, workspaceId: deriveWorkspaceId(cfg.key) }
    return
  }

  const client = await buildClient(cfg)
  const { ListObjectsV2Command } = await import(CLIENT_IMPORT)

  let continuationToken
  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: cfg.bucket,
      Prefix: cfg.prefix || undefined,
      ContinuationToken: continuationToken,
    }))
    for (const obj of (resp.Contents || [])) {
      if (!looksLikeStateKey(obj.Key)) continue
      yield { key: obj.Key, workspaceId: deriveWorkspaceId(obj.Key) }
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
  } while (continuationToken)

  client.destroy()
}

/**
 * Fetch one state file and return the parsed JSON.
 */
export async function fetchStateFile(cfg, key) {
  const client = await buildClient(cfg)
  const { GetObjectCommand } = await import(CLIENT_IMPORT)
  const resp = await client.send(new GetObjectCommand({
    Bucket: cfg.bucket,
    Key:    key,
  }))
  const text = await streamToString(resp.Body)
  client.destroy()
  return JSON.parse(text)
}

export async function healthCheck(cfg) {
  try {
    const client = await buildClient(cfg)
    const { HeadBucketCommand } = await import(CLIENT_IMPORT)
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }))
    client.destroy()
    return { ok: true, detail: `s3://${cfg.bucket} reachable` }
  } catch (err) {
    return { ok: false, detail: err.message }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function deriveWorkspaceId(key) {
  // Terraform Cloud-style `env:/<workspace>/...` or `env/<workspace>/...`
  // prefixes are treated as the workspace id; otherwise the basename.
  if (!key) return 'default'
  const envMatch = key.match(/(?:env:?\/)([^/]+)\//)
  if (envMatch) return envMatch[1]
  const segments = key.split('/').filter(Boolean)
  return segments.length > 1 ? segments[segments.length - 2] : 'default'
}

async function streamToString(stream) {
  if (typeof stream.transformToString === 'function') return stream.transformToString()
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
