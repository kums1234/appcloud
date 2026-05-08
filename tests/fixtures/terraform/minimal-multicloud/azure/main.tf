# Minimal Azure fixture for AppCloud autolink validation.
#
# This .tf is the source of truth for tests/fixtures/terraform/minimal-multicloud/captured/azure-resource-graph.json.
# CI consumes the captured JSON; this file is for re-deploying when the capture needs regeneration.
#
# Designed to exercise four shapes:
#   Shape 1 (Rule 1 co-location)        — multiple resources in resource group rg-web-prod, all tagged component=web-app
#   Shape 2 (Rule 2 direct structural)  — VM → nic → subnet → vnet, VM → disk, app → app-service-plan
#                                         (Azure-specific via "app-service-plan" carries score 85)
#   Shape 3 (Rule 3 2-hop)              — Storage account in rg-batch with private endpoint into rg-web-prod's subnet:
#                                         storage → subnet (unmapped) → vm (mapped)
#   Shape 4 (public_via_iam)            — GCP-only; not exercised here

terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.0" }
  }
}

provider "azurerm" {
  features {}
}

# -----------------------------------------------------------------------------
# Shape 1 + Shape 2 — dense RG bucket "rg-web-prod", mapped Component "web-app"
# -----------------------------------------------------------------------------

resource "azurerm_resource_group" "web" {
  name     = "rg-web-prod"
  location = "eastus"
  tags     = { component = "web-app", env = "prod" }
}

resource "azurerm_virtual_network" "web" {
  name                = "vnet-web"
  address_space       = ["10.10.0.0/16"]
  location            = azurerm_resource_group.web.location
  resource_group_name = azurerm_resource_group.web.name
  tags                = { component = "web-app" }
}

resource "azurerm_subnet" "web" {
  name                 = "subnet-web"
  resource_group_name  = azurerm_resource_group.web.name
  virtual_network_name = azurerm_virtual_network.web.name
  address_prefixes     = ["10.10.1.0/24"]
}

resource "azurerm_network_interface" "web" {
  name                = "nic-web"
  location            = azurerm_resource_group.web.location
  resource_group_name = azurerm_resource_group.web.name
  tags                = { component = "web-app" }

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.web.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_managed_disk" "web" {
  name                 = "disk-web"
  location             = azurerm_resource_group.web.location
  resource_group_name  = azurerm_resource_group.web.name
  storage_account_type = "Standard_LRS"
  create_option        = "Empty"
  disk_size_gb         = 32
  tags                 = { component = "web-app" }
}

resource "azurerm_linux_virtual_machine" "web" {
  name                  = "vm-web"
  location              = azurerm_resource_group.web.location
  resource_group_name   = azurerm_resource_group.web.name
  size                  = "Standard_B1s"
  admin_username        = "azureuser"
  network_interface_ids = [azurerm_network_interface.web.id]
  tags                  = { component = "web-app", env = "prod" }

  admin_ssh_key {
    username   = "azureuser"
    public_key = "ssh-rsa AAAA..."  # placeholder
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts"
    version   = "latest"
  }
}

# Exercises the Azure-specific via "app-service-plan" (score 85)
resource "azurerm_service_plan" "web" {
  name                = "asp-web"
  location            = azurerm_resource_group.web.location
  resource_group_name = azurerm_resource_group.web.name
  os_type             = "Linux"
  sku_name            = "B1"
  tags                = { component = "web-app" }
}

resource "azurerm_linux_web_app" "web" {
  name                = "app-web-fixture"
  location            = azurerm_resource_group.web.location
  resource_group_name = azurerm_resource_group.web.name
  service_plan_id     = azurerm_service_plan.web.id
  tags                = { component = "web-app" }
  site_config {}
}

# -----------------------------------------------------------------------------
# Shape 3 — sparse RG "rg-batch": storage account with private endpoint
# crossing into rg-web-prod's subnet. 2-hop to mapped VM.
# -----------------------------------------------------------------------------
#
# Rule 1: rg-batch contains only the storage account and the private endpoint.
#         No mapped resources here → no Component vote.
# Rule 2: storage → subnet (1-hop) — subnet is unmapped Infra, not a mapped Component.
#         → no Rule 2 hit.
# Rule 3: storage → subnet → vm (2-hop, vm is mapped) → score min(58, 40 + 1×6) = 46.

resource "azurerm_resource_group" "batch" {
  name     = "rg-batch"
  location = "eastus"
  # No component tag — bootstrap Phase 1 does not map this.
}

resource "azurerm_storage_account" "batch" {
  name                     = "stbatchfixture001"
  resource_group_name      = azurerm_resource_group.batch.name
  location                 = azurerm_resource_group.batch.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_private_endpoint" "batch_to_web_subnet" {
  name                = "pe-batch-to-web"
  location            = azurerm_resource_group.batch.location
  resource_group_name = azurerm_resource_group.batch.name
  subnet_id           = azurerm_subnet.web.id  # crosses into rg-web-prod

  private_service_connection {
    name                           = "psc-batch"
    private_connection_resource_id = azurerm_storage_account.batch.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }
}
