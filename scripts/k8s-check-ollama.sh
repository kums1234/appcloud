#!/usr/bin/env bash
# Run from your machine with kubectl configured. Diagnoses API → Ollama in AppCloud.
set -euo pipefail
NS="${1:-appcloud}"

echo "=== Pods (app=ollama, app=api) — $NS ==="
kubectl get pods -n "$NS" -l 'app in (ollama,api)' -o wide

echo ""
echo "=== Service + Endpoints (ollama must have pod IPs) — $NS ==="
kubectl get svc -n "$NS" ollama -o wide
kubectl get endpoints -n "$NS" ollama -o yaml | sed -n '1,40p'

echo ""
echo "=== From API pod: HTTP GET ollama:11434/api/tags ==="
kubectl exec -n "$NS" deploy/api -- sh -c '
  if command -v wget >/dev/null 2>&1; then wget -qO- --timeout=5 http://ollama:11434/api/tags | head -c 200; echo
  elif command -v curl >/dev/null 2>&1; then curl -sS -m 5 http://ollama:11434/api/tags | head -c 200; echo
  else node -e "fetch(\"http://ollama:11434/api/tags\").then(r=>r.text().then(t=>console.log(t.slice(0,200)))).catch(e=>console.error(e))"
  fi
'

echo ""
echo "=== From API pod: Node fetch (same as API runtime) ==="
kubectl exec -n "$NS" deploy/api -- node -e "
fetch('http://ollama:11434/api/tags',{signal:AbortSignal.timeout(8000)})
  .then(r=>r.json().then(j=>console.log('status',r.status,'models',(j.models||[]).map(m=>m.name).join(','))))
  .catch(e=>console.error('FAIL',e.message,e.cause));
"

echo ""
echo "=== Last ollama logs — $NS ==="
kubectl logs -n "$NS" deploy/ollama --tail=25 2>&1 || true
