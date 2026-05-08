# AppCloud — Kubernetes Deployment

Kustomize-based deployment. One base, four overlays.

```
k8s/
├── base/                    # All manifests shared across targets
│   ├── namespace.yaml
│   ├── neo4j-configmap.yaml
│   ├── neo4j-{deployment,service,pvc}.yaml
│   ├── postgres-{deployment,service,pvc}.yaml
│   ├── api-{deployment,service}.yaml
│   └── kustomization.yaml
├── overlays/
│   ├── minikube/            # Local dev — builds images in-cluster
│   ├── eks/                 # AWS EKS — images from ECR, ALB ingress
│   ├── aks/                 # Azure AKS — images from ACR, AppGateway ingress
│   └── openshift/           # OpenShift — Routes instead of Ingress, SCC patches
└── scripts/
    ├── deploy-minikube.sh
    ├── deploy-eks.sh
    ├── deploy-aks.sh
    ├── deploy-openshift.sh
    └── teardown.sh
```

## Prerequisites (all targets)

Secret files must exist before any deployment:

```bash
# These should already exist from docker-compose usage.
# If not, create them:
mkdir -p secrets
echo "neo4j"      > secrets/db_username.txt
echo "CHANGE_ME"  > secrets/db_password.txt
echo "appcloud"   > secrets/pg_username.txt
echo "CHANGE_ME"  > secrets/pg_password.txt
openssl rand -hex 32 > secrets/appcloud_api_key.txt
openssl rand -hex 32 > secrets/appcloud_encryption_key.txt
```

Secrets are created as Kubernetes Secrets from these files by each deploy script.
They are never committed to git (add `secrets/` to `.gitignore`).

---

## Minikube (local)

**Requirements:** Docker Desktop, minikube, kubectl

```bash
chmod +x k8s/scripts/*.sh
./k8s/scripts/deploy-minikube.sh
```

The script:
1. Starts a minikube cluster (`appcloud` profile, 4 CPU / 6 GB RAM)
2. Enables the nginx ingress addon
3. Builds the `appcloud-api` Docker image directly into minikube's Docker daemon
4. Creates Kubernetes Secrets from your `secrets/` files
5. Applies the minikube overlay via `kubectl apply -k`
6. Waits for all rollouts to complete
7. Adds `appcloud.local` to `/etc/hosts`

**Access:**
| Service | URL |
|---------|-----|
| API health | http://appcloud.local/health |
| API root | http://appcloud.local |
| Neo4j Browser | `kubectl -n appcloud port-forward svc/neo4j 7474:7474` → http://localhost:7474 |

**After code changes:**
```bash
eval $(minikube docker-env --profile=appcloud)
docker build -t appcloud-api:latest ./api
kubectl -n appcloud rollout restart deployment/api
```

**Skip rebuild:**
```bash
./k8s/scripts/deploy-minikube.sh --skip-build
```

**Teardown:**
```bash
./k8s/scripts/teardown.sh minikube
```

---

## EKS (AWS)

**Requirements:** AWS CLI (authenticated), eksctl, kubectl, docker, jq

**One-time cluster setup** (if not already created):
```bash
eksctl create cluster \
  --name appcloud-cluster \
  --region us-east-1 \
  --nodegroup-name standard \
  --node-type t3.large \
  --nodes 3 \
  --nodes-min 2 \
  --nodes-max 6 \
  --managed

# Install EBS CSI driver (required for gp3 PVCs)
eksctl create addon --name aws-ebs-csi-driver --cluster appcloud-cluster

# Install AWS Load Balancer Controller
# https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html
```

**Edit the overlay** (`k8s/overlays/eks/ingress.yaml`):
- Replace `123456789012` with your AWS account ID
- Replace `us-east-1` with your region
- Replace `appcloud.yourdomain.com` with your domain
- Replace `YOUR-CERT-ARN` with an ACM certificate ARN

**Deploy:**
```bash
export AWS_ACCOUNT_ID=123456789012
export AWS_REGION=us-east-1
export EKS_CLUSTER=appcloud-cluster
chmod +x k8s/scripts/*.sh
./k8s/scripts/deploy-eks.sh
```

**After code changes:**
```bash
docker build -t $ECR_BASE/appcloud-api:latest ./api && docker push $_
kubectl -n appcloud rollout restart deployment/api
```

---

## AKS (Azure)

**Requirements:** Azure CLI (authenticated), kubectl, docker

**One-time cluster setup** (if not already created):
```bash
az group create --name appcloud-rg --location eastus

az acr create --resource-group appcloud-rg \
  --name myregistry --sku Basic

az aks create \
  --resource-group appcloud-rg \
  --name appcloud-cluster \
  --node-count 3 \
  --node-vm-size Standard_D2s_v3 \
  --generate-ssh-keys \
  --attach-acr myregistry

# Install Application Gateway ingress controller (AGIC) OR use nginx:
az aks enable-addons --addons ingress-appgw \
  --appgw-name appcloud-agw \
  --appgw-subnet-cidr 10.225.0.0/16 \
  --resource-group appcloud-rg \
  --name appcloud-cluster
```

**Edit the overlay** (`k8s/overlays/aks/ingress.yaml`):
- Replace `appcloud.yourdomain.com` with your domain

**Deploy:**
```bash
export RESOURCE_GROUP=appcloud-rg
export ACR_NAME=myregistry
export AKS_CLUSTER=appcloud-cluster
chmod +x k8s/scripts/*.sh
./k8s/scripts/deploy-aks.sh
```

---

## OpenShift

**Requirements:** `oc` CLI (logged in), kubectl, docker

**Deploy:**
```bash
export OC_PROJECT=appcloud
oc login https://your-cluster-api:6443 -u your-user
chmod +x k8s/scripts/*.sh
./k8s/scripts/deploy-openshift.sh
```

**Key differences from standard Kubernetes:**
- Routes are used instead of Ingress (`route-api.yaml`)
- The script grants `anyuid` SCC to the default service account so Neo4j (uid 7474) and Postgres (uid 999) can start
- Images are pushed to the OpenShift internal registry at `image-registry.openshift-image-registry.svc:5000`
- Edit `k8s/overlays/openshift/route-api.yaml` to set your cluster's apps domain

---

## Manual `kubectl` usage (any overlay)

If you prefer not to use the scripts:

```bash
# 1. Create secrets manually
kubectl apply -f k8s/base/namespace.yaml
kubectl -n appcloud create secret generic appcloud-db-credentials \
  --from-file=db_username=secrets/db_username.txt \
  --from-file=db_password=secrets/db_password.txt
kubectl -n appcloud create secret generic appcloud-pg-credentials \
  --from-file=pg_username=secrets/pg_username.txt \
  --from-file=pg_password=secrets/pg_password.txt
kubectl -n appcloud create secret generic appcloud-api-key \
  --from-file=appcloud_api_key=secrets/appcloud_api_key.txt
kubectl -n appcloud create secret generic appcloud-encryption-key \
  --from-file=appcloud_encryption_key=secrets/appcloud_encryption_key.txt

# 2. Apply the overlay
kubectl apply -k k8s/overlays/minikube     # or eks / aks / openshift

# 3. Check status
kubectl -n appcloud get pods
kubectl -n appcloud get ingress
```

## Useful commands

```bash
# Watch all pods
kubectl -n appcloud get pods -w

# Tail API logs
kubectl -n appcloud logs -f deploy/api

# Exec into API pod
kubectl -n appcloud exec -it deploy/api -- sh

# Neo4j browser (any target)
kubectl -n appcloud port-forward svc/neo4j 7474:7474 7687:7687

# Postgres shell
kubectl -n appcloud exec -it deploy/postgres -- \
  psql -U $(cat secrets/pg_username.txt) -d appcloud

# Force restart all deployments
kubectl -n appcloud rollout restart deployment/neo4j deployment/postgres deployment/api

# View kustomize output without applying
kubectl kustomize k8s/overlays/minikube
```
