#!/bin/bash
# restart-clean.sh
# Use this when the Neo4j data volume has stale credentials.
# WARNING: this wipes the database. Only run this during initial setup.
set -e

echo "=== AppCloud Clean Restart ==="
echo ""

# Check secret files exist before doing anything destructive
if [ ! -f ./secrets/db_username.txt ] || [ ! -f ./secrets/db_password.txt ]; then
  echo "ERROR: secrets/db_username.txt or secrets/db_password.txt not found."
  echo "Create them first:"
  echo "  mkdir -p secrets"
  echo "  echo 'neo4j'           > secrets/db_username.txt"
  echo "  echo 'your-password'   > secrets/db_password.txt"
  echo "  chmod 600 secrets/*.txt"
  exit 1
fi

# Make the entrypoint executable
chmod +x ./neo4j-entrypoint.sh

echo "Stopping all containers..."
docker compose down

echo "Removing Neo4j data volume (credentials are stored here)..."
rm -rf ./data/db/data
mkdir -p ./data/db/{data,config,plugins,logs}

echo "Rebuilding and starting..."
docker compose up -d --build

echo ""
echo "Waiting for Neo4j to be healthy..."
for i in $(seq 1 30); do
  if docker compose ps db | grep -q "healthy"; then
    echo "✓ Neo4j is healthy"
    break
  fi
  printf "."
  sleep 3
done

echo ""
echo "=== Stack status ==="
docker compose ps
echo ""
echo "API: http://localhost:3000"
echo "Neo4j Browser: http://localhost:7474"