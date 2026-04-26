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