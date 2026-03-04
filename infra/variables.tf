variable "github_token" {
  description = "GitHub personal access token with repo and admin:repo_hook scopes"
  type        = string
  sensitive   = true
}
