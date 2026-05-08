# Minimal GCP fixture for AppCloud autolink validation.
#
# This .tf is the source of truth for these captures:
#   tests/fixtures/terraform/minimal-multicloud/captured/gcp-cloud-asset.json
#   tests/fixtures/terraform/minimal-multicloud/captured/gcp-iam-policy.json
#
# CI consumes the captured JSON; this file is for re-deploying when captures need regeneration.
#
# Designed to exercise four shapes:
#   Shape 1 (Rule 1 co-location)        — multiple resources in project gcp-web-prod-001, mapped to Component "web-app"
#   Shape 2 (Rule 2 direct structural)  — VM → subnet, vpc, service-account, disk
#   Shape 3 (Rule 3 2-hop)              — Cloud Run in gcp-batch-002 → sa-batch (unmapped Infra) → bucket-public (mapped, cross-project IAM binding)
#   Shape 4 (public_via_iam)            — bucket-public has IAM binding `allUsers:roles/storage.objectViewer`
#                                         → gcp-iam-policy supplement flips `public = true` and stamps `public_via_iam = roles/storage.objectViewer`

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}

# -----------------------------------------------------------------------------
# Shape 1 + Shape 2 + Shape 4 — dense project bucket "gcp-web-prod-001"
# -----------------------------------------------------------------------------

provider "google" {
  alias   = "web"
  project = "gcp-web-prod-001"
  region  = "us-central1"
}

resource "google_compute_network" "web" {
  provider                = google.web
  name                    = "vpc-web"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "web" {
  provider      = google.web
  name          = "subnet-web"
  ip_cidr_range = "10.30.1.0/24"
  region        = "us-central1"
  network       = google_compute_network.web.id
}

resource "google_service_account" "web" {
  provider     = google.web
  account_id   = "sa-web"
  display_name = "Web app service account"
}

resource "google_compute_disk" "web" {
  provider = google.web
  name     = "disk-web"
  type     = "pd-standard"
  zone     = "us-central1-a"
  size     = 32
  labels   = { component = "web-app" }
}

resource "google_compute_instance" "web" {
  provider     = google.web
  name         = "vm-web"
  machine_type = "e2-micro"
  zone         = "us-central1-a"
  labels       = { component = "web-app", env = "prod" }

  boot_disk {
    initialize_params { image = "debian-cloud/debian-12" }
  }

  attached_disk {
    source = google_compute_disk.web.self_link
  }

  network_interface {
    subnetwork = google_compute_subnetwork.web.id
  }

  service_account {
    email  = google_service_account.web.email
    scopes = ["cloud-platform"]
  }
}

# Shape 4 — public bucket. The gcp-iam-policy supplement reads the IAM_POLICY
# content type from CAI, finds allUsers:roles/storage.objectViewer, and:
#   - flips this node's `public` property to true
#   - stamps `public_via_iam = "roles/storage.objectViewer"`
resource "google_storage_bucket" "public" {
  provider = google.web
  name     = "bucket-public-fixture-001"
  location = "US"
  labels   = { component = "web-app" }
}

resource "google_storage_bucket_iam_binding" "public_viewer" {
  provider = google.web
  bucket   = google_storage_bucket.public.name
  role     = "roles/storage.objectViewer"
  members  = ["allUsers"]
}

# -----------------------------------------------------------------------------
# Shape 3 — sparse project "gcp-batch-002": Cloud Run + cross-project IAM grant
# -----------------------------------------------------------------------------
#
# Rule 1: gcp-batch-002 has only Cloud Run + sa-batch. No mapped resources →
#         no Component vote.
# Rule 2: cloud-run → sa-batch (1-hop, sa-batch unmapped). No mapped-Infra hit.
# Rule 3: cloud-run → sa-batch → bucket-public (2-hop, mapped) → score
#         min(58, 40 + 1×6) = 46.

provider "google" {
  alias   = "batch"
  project = "gcp-batch-002"
  region  = "us-central1"
}

resource "google_service_account" "batch" {
  provider     = google.batch
  account_id   = "sa-batch"
  display_name = "Batch service account"
}

resource "google_cloud_run_v2_service" "batch" {
  provider = google.batch
  name     = "svc-batch"
  location = "us-central1"

  template {
    service_account = google_service_account.batch.email
    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello"
    }
  }
}

# Cross-project IAM binding — sa-batch in gcp-batch-002 gets storage.objectAdmin
# on bucket-public in gcp-web-prod-001. This is the edge that makes Shape 3 work.
resource "google_storage_bucket_iam_member" "batch_writes_public" {
  provider = google.web
  bucket   = google_storage_bucket.public.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.batch.email}"
}
