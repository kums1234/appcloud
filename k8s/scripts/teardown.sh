#!/usr/bin/env bash
# teardown.sh — Remove AppCloud from Kubernetes (any target)
# Usage: ./k8s/scripts/teardown.sh [minikube|eks|aks|openshift]
set -euo pipefail

TARGET="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

case "$TARGET" in
  minikube)
    echo "► Deleting minikube cluster (profile: appcloud)..."
    minikube delete --profile=appcloud
    echo "► Removing /etc/hosts entry..."
    sudo sed -i '/appcloud.local/d' /etc/hosts
    ;;
  eks|aks|openshift)
    echo "► Removing kustomize overlay ($TARGET)..."
    kubectl delete -k "$K8S_DIR/overlays/$TARGET" --ignore-not-found
    echo "► Removing namespace..."
    kubectl delete namespace appcloud --ignore-not-found
    ;;
  *)
    echo "► Removing kustomize resources from current context..."
    kubectl delete namespace appcloud --ignore-not-found
    echo "Specify a target for full teardown: minikube | eks | aks | openshift"
    ;;
esac
echo "✓ Teardown complete"
