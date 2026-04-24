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

## Starting the stack

```bash
docker compose up -d
```

## Rotating credentials

1. Update both `secrets/db_username.txt` and `secrets/db_password.txt`
2. If changing the Neo4j password on an existing volume, first update it via
   the Neo4j browser at http://localhost:7474, then update the secret file
3. Restart the stack: `docker compose restart`