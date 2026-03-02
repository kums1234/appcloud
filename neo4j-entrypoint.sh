#!/bin/sh
# neo4j-entrypoint.sh
# Reads credentials from Docker secret files, sets NEO4J_AUTH, then hands
# off to the official Neo4j entrypoint (location varies by image version).

set -e

USERNAME_FILE="${DB_USERNAME_FILE:-/run/secrets/db_username}"
PASSWORD_FILE="${DB_PASSWORD_FILE:-/run/secrets/db_password}"

if [ ! -f "$USERNAME_FILE" ]; then
  echo "ERROR: Username secret file not found at $USERNAME_FILE" >&2
  exit 1
fi

if [ ! -f "$PASSWORD_FILE" ]; then
  echo "ERROR: Password secret file not found at $PASSWORD_FILE" >&2
  exit 1
fi

USERNAME=$(tr -d '[:space:]' < "$USERNAME_FILE")
PASSWORD=$(tr -d '[:space:]' < "$PASSWORD_FILE")

export NEO4J_AUTH="${USERNAME}/${PASSWORD}"

echo "INFO: Neo4j credentials loaded (user: ${USERNAME})"

# Neo4j moved the entrypoint location between versions — find whichever exists
if [ -f "/startup/docker-entrypoint.sh" ]; then
  exec /startup/docker-entrypoint.sh neo4j
elif [ -f "/docker-entrypoint.sh" ]; then
  exec /docker-entrypoint.sh neo4j
else
  echo "ERROR: Cannot find Neo4j docker-entrypoint.sh" >&2
  echo "Searching..." >&2
  find / -name "docker-entrypoint.sh" 2>/dev/null || true
  exit 1
fi