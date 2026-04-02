output "amplify_app_id" {
  value = aws_amplify_app.route2gpx.id
}

output "amplify_default_domain" {
  value = aws_amplify_app.route2gpx.default_domain
}

output "production_url" {
  value = "https://${var.subdomain}.${var.domain_name}"
}

output "health_check_id" {
  value = aws_route53_health_check.route2gpx.id
}

output "sns_topic_arn" {
  value = aws_sns_topic.route2gpx_alerts.arn
}
