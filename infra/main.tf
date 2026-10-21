# Azure Container Apps deployment. Secrets live in the Container App's secret
# store, never in the image or in Terraform outputs.
terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

provider "azurerm" {
  features {}
}

variable "location" {
  type    = string
  default = "westeurope"
}

variable "image" {
  type        = string
  description = "Container image, e.g. ghcr.io/raphgm/authkit-ts:<sha>"
}

variable "gemini_api_key" {
  type      = string
  sensitive = true
}

variable "token_secrets" {
  type        = string
  sensitive   = true
  description = "Comma-separated; the first signs, the rest still verify (rotation)."
}

variable "daily_request_budget" {
  type    = number
  default = 5000
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-authkit-ts"
  location = var.location
}

resource "azurerm_log_analytics_workspace" "logs" {
  name                = "log-authkit-ts"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "env" {
  name                       = "cae-authkit-ts"
  location                   = azurerm_resource_group.rg.location
  resource_group_name        = azurerm_resource_group.rg.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.logs.id
}

resource "azurerm_container_app" "app" {
  name                         = "authkit-ts"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = azurerm_resource_group.rg.name
  revision_mode                = "Single"

  secret {
    name  = "gemini-api-key"
    value = var.gemini_api_key
  }
  secret {
    name  = "token-secrets"
    value = var.token_secrets
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    # One replica: the rate limiter is in memory. Move it to Redis before raising this.
    min_replicas = 0
    max_replicas = 1

    container {
      name   = "authkit"
      image  = var.image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name        = "GEMINI_API_KEY"
        secret_name = "gemini-api-key"
      }
      env {
        name        = "TOKEN_SECRETS"
        secret_name = "token-secrets"
      }
      env {
        name  = "TRUST_PROXY"
        value = "true"
      }
      env {
        name  = "DAILY_REQUEST_BUDGET"
        value = tostring(var.daily_request_budget)
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }
      readiness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }
    }
  }
}

output "url" {
  value = "https://${azurerm_container_app.app.ingress[0].fqdn}"
}
