output "amplify_app_id" {
  value = aws_amplify_app.route2gpx.id
}

output "amplify_default_domain" {
  value = aws_amplify_app.route2gpx.default_domain
}

output "production_url" {
  value = "https://route2gpx.rsmb.tv"
}
