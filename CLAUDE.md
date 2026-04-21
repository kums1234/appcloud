# AppCloud — agent conventions

Rules that apply to every Claude session working in this repo. Kept short and
enforceable; deeper context lives in `DEVELOPMENT.md` and the code.

## Git workflow

- **Default to a feature branch in the main repo.** Do NOT use `EnterWorktree`
  unless I explicitly say "worktree" in my message, or I ask you to isolate a
  risky experiment.
- Branch name: `feature/<short-topic>` unless I specify otherwise.
- Commit **incrementally** at logical checkpoints — don't batch every change
  into one commit at the end of a session.
- Use a short imperative subject matching the existing history style ("Add X",
  "Update Y", "Fix Z"). No Conventional-Commits prefix unless I ask for it.
- Never `git push` unless I explicitly ask.
- Never force-push, skip hooks, or `git reset --hard` without explicit
  confirmation.
- Don't `git rm --cached` or untrack files beyond scope of the current task
  without flagging it first.

## Deploy + smoke test

- Deploy command (from repo root): `./k8s/scripts/deploy-minikube.sh --api-only`
  for API changes, `--ui-only` for UI. Use neither (full) only when both
  changed.
- **Known bug in the deploy script's smart-skip:** if the pod image ID differs
  from the local image after a normal `--api-only`, the script silently keeps
  the old minikube image. Workaround when you see stale behaviour:
  `minikube ssh --profile=appcloud -- "docker rmi -f docker.io/library/appcloud-api:latest"`
  then rerun with `--force`.
- OK to run smoke tests after deploy (`kubectl logs`, `kubectl exec curl …`,
  cypher-shell). Don't `docker rm -f` or `kubectl delete` resources you didn't
  create.
- Neo4j credentials live in the `appcloud-db-credentials` k8s secret. Read
  them at smoke-test time; do not hard-code:
  ```
  kubectl -n appcloud get secret appcloud-db-credentials \
    -o jsonpath='{.data.db_password}' | base64 -d
  ```

## Testing

- Jest, ESM via `NODE_OPTIONS='--experimental-vm-modules'`. From `api/`:
  - `npm run test:unit` — unit suite, no Docker
  - `npm run test:integration` — Testcontainers (Postgres + Neo4j); skips
    cleanly on Node 24+ (Testcontainers 10.x bug) or when Docker is absent
  - `npm run test:coverage` — coverage report
- Mock outbound `fetch` with `jest.spyOn(globalThis, 'fetch')`. Node 18+'s
  built-in fetch doesn't share a dispatcher with the npm `undici` package, so
  nock / MockAgent don't intercept reliably.
- Put unit tests next to the code: `<dir>/__tests__/<file>.test.js`.

## Secrets + encryption

- `api/src/utils/encrypt.js` encrypts fields listed in `SECRET_FIELDS` at
  rest (AES-256-GCM). When adding a new connector with a new auth field,
  extend that list so the value is encrypted in the `integrations.config`
  JSONB blob.
- Never log, echo, or commit tenant tokens, API keys, or anything under
  `secrets/`.

## Connector framework

New integrations plug in as connectors under `api/src/connectors/<id>/`
exporting a default `ConnectorSpec`. See `DEVELOPMENT.md` for the directory
layout, spec shape, and step-by-step for adding a new connector. Pure logic
(parsing, aggregation) goes in sibling files so it can be unit-tested
without booting Fastify.

## Don'ts

- No `docker rm -f` on containers Claude didn't start (past incident:
  `appcloud-db` was accidentally killed; data recovered, but the rule
  stands).
- No background nannies / polling loops. If you need to watch a deploy,
  use `run_in_background` or the `Monitor` tool.
- No editing `postgres-init/01-schema.sql` directly — add a new numbered
  SQL file and an `IF NOT EXISTS`-guarded runtime DDL hook in the relevant
  plugin so existing installs pick it up without a volume wipe. Mirror the
  SQL to `k8s/base/postgres-init/` and the `configMapGenerator.files` list
  in `k8s/base/kustomization.yaml`.
