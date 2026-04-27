# AppCloud — Credentials Setup

Credentials are stored in plain text files that Docker mounts into containers
as secrets. These files are **never committed to git**.

## One-time setup

```bash
# Create the secrets directory
mkdir -p secrets

# Write your credentials (replace with real values)
echo "neo4j" > secrets/db_username.txt
echo "your-strong-password-here" > secrets/db_password.txt
echo "appcloud" > secrets/pg_username.txt
echo "your-strong-password-here" > secrets/pg_password.txt

# Generate the API key (sent as X-API-Key header) and the encryption key
# (used to AES-256-GCM encrypt stored connector credentials at rest).
openssl rand -hex 32 > secrets/appcloud_api_key.txt
openssl rand -hex 32 > secrets/appcloud_encryption_key.txt

# Lock down permissions so only your user can read them
chmod 600 secrets/*.txt
```

Add to `.gitignore` (if not already present):
```
secrets/
```

## How it works

| Location | What reads it | How |
|---|---|---|
| `secrets/db_username.txt` | Neo4j container | `NEO4J_AUTH` is set via entrypoint |
| `secrets/db_password.txt` | Neo4j container | same as above |
| `secrets/db_username.txt` | API container | `DB_USERNAME_FILE=/run/secrets/db_username` → read by `neo4j.js` |
| `secrets/db_password.txt` | API container | `DB_PASSWORD_FILE=/run/secrets/db_password` → read by `neo4j.js` |
| `secrets/appcloud_api_key.txt` | API container | `APPCLOUD_API_KEY_FILE` → read by `plugins/auth.js`; callers send it as `X-API-Key` |
| `secrets/appcloud_encryption_key.txt` | API container | `APPCLOUD_ENCRYPTION_KEY_FILE` → read by `utils/encrypt.js` to AES-encrypt connector secrets at rest |

Docker mounts each secret file at `/run/secrets/<name>` inside the container.
The API reads the file path from the `*_FILE` env var and reads the file content
at startup — no plaintext credential ever appears in an environment variable or
in `docker inspect` output.

## Cloud-account prerequisites

Beyond the credentials in `secrets/`, each cloud account that AppCloud
discovers needs IAM permissions wired up on the cloud side. Without these,
scans return clear errors at the auth boundary and the relevant supplement
layers stay disabled. Configure once per account; AppCloud uses a single
identity per cloud.

### Azure

| Capability | Required role / scope |
|---|---|
| Primary scan (Resource Graph) | **Reader** on the subscription |
| Network Watcher supplement (Layer B) | **Reader** on each Network Watcher resource (typically same subscription) |
| VM Insights supplement (Layer C) | **Log Analytics Reader** on the workspace whose `logAnalyticsWorkspaceId` you pass to the supplement |
| Auto-link Phase 2 | none extra — runs on the graph the scanner produced |

How AppCloud authenticates: service principal (`tenantId` + `clientId` +
`clientSecret`) configured per Azure account in Integrations. Tenant ID is
auto-resolved from the subscription metadata if omitted; client ID and
secret are required. For local dev, `DefaultAzureCredential` (env / CLI /
managed identity chain) is also accepted when no service principal is
configured.

### GCP

| Capability | Required permission / role |
|---|---|
| Primary scan (Cloud Asset Inventory) | `cloudasset.assets.listAssets` on the project (folder/org also work for cross-project scans) |
| IAM Policy supplement | `cloudasset.assets.listAssets` plus permission to read IAM policies on the targeted resources (covered by `roles/cloudasset.viewer` and `roles/iam.securityReviewer`) |

Identity: service-account JSON key (`client_email` + `private_key` etc.)
configured per GCP account in Integrations. Application Default Credentials
are also accepted when no key is provided.

### AWS

| Capability | Required permission / role |
|---|---|
| Primary scan (Config aggregator) | `config:SelectAggregateResourceConfig` on the aggregator |
| Aggregator coverage | AWS Config must be **enabled in every account** in scope, with a Configuration Aggregator (organization-wide or account-list) spanning them; pass the aggregator's name + region in `credentials.aggregatorName` / `credentials.aggregatorRegion` (or `AWS_CONFIG_AGGREGATOR_NAME` / `AWS_REGION`) |
| Advanced resource types | for resource types not in Config's default coverage (e.g., AppRunner, ECR), enable "advanced resource types" on each account's recording configuration |
| Supplement layers | none shipped today; future VPC Flow Logs / IAM Access Analyzer layers will document their additional permissions |

Identity: IAM user access key (`accessKeyId` + `secretAccessKey`,
optionally `sessionToken`) per AWS account in Integrations, or default
credential chain (env / instance profile / `~/.aws/`) when no per-account
credentials are supplied.

### Local-only authentication notes

When `APPCLOUD_API_KEY_FILE` / `APPCLOUD_API_KEY` is unset the API logs
"authentication disabled, all routes open" and skips the X-API-Key check —
useful for local dev, never use in production. The encryption key is
unrelated and is required regardless.

## Starting the stack

```bash
docker compose up -d
```

## Rotating credentials

1. Update both `secrets/db_username.txt` and `secrets/db_password.txt`
2. If changing the Neo4j password on an existing volume, first update it via
   the Neo4j browser at http://localhost:7474, then update the secret file
3. Restart the stack: `docker compose restart`

## Rotating the encryption key

The `APPCLOUD_ENCRYPTION_KEY` master key derives row-level keys for every
encrypted field in `cloud_accounts.config` and `integrations.config`
(API tokens, cloud secret-keys, service-account JSON, etc.). The key is
cached in-process via `scrypt`, and every ciphertext stores its own random
salt. **A leaked master key decrypts every row** — there is no per-row
isolation against an attacker who has the master.

Rotate the master key when:
- The current value has been exposed (logs, screenshot, mistakenly committed).
- Annual / quarterly hygiene rotation per your compliance regime.
- An operator with key access leaves the team.

### Procedure

1. **Generate the new key.**
   ```bash
   openssl rand -hex 32 > /tmp/new-encryption-key
   ```

2. **Stop API replicas** (or scale the deployment to 0) so no live process
   is reading or writing rows during the rotation. The CLI assumes the
   tables are quiescent — concurrent writes from a still-running API
   would land under whichever key the API process holds, which races
   the rotation.
   ```bash
   kubectl scale deployment/api --replicas=0
   ```

3. **Run the rotation CLI** with both keys in env. The CLI reads each
   row's `config` JSONB, decrypts every secret field under the OLD key,
   re-encrypts under the NEW key, and writes back inside a per-row
   transaction. Per-row failures are logged and counted; the CLI exits
   non-zero if any row failed.
   ```bash
   cd api
   APPCLOUD_ENCRYPTION_KEY_OLD="$(cat ../secrets/appcloud_encryption_key.txt)" \
   APPCLOUD_ENCRYPTION_KEY="$(cat /tmp/new-encryption-key)" \
   POSTGRES_HOST=postgres \
   POSTGRES_USER=appcloud \
   POSTGRES_PASSWORD="$(cat ../secrets/pg_password.txt)" \
   POSTGRES_DB=appcloud \
   node scripts/rotate-encryption-key.js
   ```
   Watch for the final `[rotate] TOTALS:` line. Investigate any non-zero
   `failed` count before continuing — those rows are still readable
   under the OLD key, so you can roll forward by fixing whatever broke
   (typically a corrupt ciphertext from a manual edit) and re-running.

4. **Update the secret to the NEW key.**
   ```bash
   mv /tmp/new-encryption-key secrets/appcloud_encryption_key.txt
   chmod 600 secrets/appcloud_encryption_key.txt
   ```
   For K8s, update the `appcloud-encryption-key` Secret resource.

5. **Scale the API back up.** Verify by hitting `GET /integrations`
   (admin) and confirming `__decryptErrors` is absent on every row.
   ```bash
   kubectl scale deployment/api --replicas=2
   curl -H "X-API-Key: $ADMIN_KEY" http://api/integrations | jq '.[].config.__decryptErrors'
   ```

6. **Securely destroy the OLD key.** No row should still be encrypted
   under it after step 3 succeeded; once verified, the OLD key has no
   further use and should be removed from any password manager / vault
   where it was stored.

### What this does NOT cover (today)

- **Per-tenant master keys.** Single-tenancy assumption — every row
  shares one master key. Multi-tenant work (separate database per
  tenant) will replace this with per-tenant keys; rotation will then be
  a per-tenant concern.
- **HSM / KMS-backed master.** The master is currently passed via env
  var, which means it ends up in `/proc/N/environ` and any process-
  inspection-based exfiltration. Wrapping with a KMS-managed KEK
  (envelope encryption) is the next step beyond rotation; tracked under
  `docs/code-audit-2026-04.md` P0.7.
- **Online rotation.** The CLI requires a maintenance window (API
  replicas stopped). An online-rotation pattern would need ciphertexts
  to carry a key-version tag so old + new keys can coexist; that's a
  larger refactor and out of scope for this slice.