variable "github_token" {
  description = "GitHub personal access token with repo and admin:repo_hook scopes"
  type        = string
  sensitive   = true
}

variable "domain_name" {
  description = "Root domain name"
  type        = string
  default     = "rsmb.tv"
}

variable "subdomain" {
  description = "Subdomain prefix for the app"
  type        = string
  default     = "route2gpx"
}

variable "production_branch" {
  description = "Git branch for production deployment"
  type        = string
  default     = "main"
}

variable "staging_branch" {
  description = "Git branch for staging deployment"
  type        = string
  default     = "dev"
}

variable "alert_email" {
  description = "Email address for health check alerts (leave empty to skip)"
  type        = string
  default     = ""
}
