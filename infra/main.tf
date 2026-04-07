# Terraform: AWS Amplify App for route2gpx.rsmb.tv
resource "aws_amplify_app" "route2gpx" {
  name                     = "route2gpx"
  platform                 = "WEB"
  repository               = "https://github.com/robert-bryson/route2gpx"
  access_token             = var.github_token
  enable_branch_auto_build = true

  custom_headers = <<-HEADERS
    customHeaders:
      - pattern: '**'
        headers:
          - key: 'X-Content-Type-Options'
            value: 'nosniff'
          - key: 'X-Frame-Options'
            value: 'DENY'
          - key: 'Referrer-Policy'
            value: 'strict-origin-when-cross-origin'
          - key: 'Cache-Control'
            value: 'public, max-age=3600'
          - key: 'Strict-Transport-Security'
            value: 'max-age=31536000; includeSubDomains'
          - key: 'Permissions-Policy'
            value: 'geolocation=(self), camera=(), microphone=()'
      - pattern: '*.js'
        headers:
          - key: 'Cache-Control'
            value: 'public, max-age=31536000, immutable'
  HEADERS

  custom_rule {
    source = "/<*>"
    target = "/index.html"
    status = "404-200"
  }
}

resource "aws_amplify_branch" "main" {
  app_id      = aws_amplify_app.route2gpx.id
  branch_name = var.production_branch
  stage       = "PRODUCTION"
}

resource "aws_amplify_branch" "staging" {
  app_id      = aws_amplify_app.route2gpx.id
  branch_name = var.staging_branch
  stage       = "DEVELOPMENT"
}

resource "aws_amplify_domain_association" "route2gpx" {
  app_id      = aws_amplify_app.route2gpx.id
  domain_name = var.domain_name

  # route2gpx.rsmb.tv → main branch
  sub_domain {
    branch_name = aws_amplify_branch.main.branch_name
    prefix      = var.subdomain
  }
}

# ============ Health Check & Monitoring ============

resource "aws_route53_health_check" "route2gpx" {
  fqdn              = "${var.subdomain}.${var.domain_name}"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/"
  failure_threshold = 3
  request_interval  = 30
  measure_latency   = true

  tags = {
    Name = "route2gpx-health-check"
  }
}

resource "aws_sns_topic" "route2gpx_alerts" {
  name = "route2gpx-alerts"
}

resource "aws_sns_topic_subscription" "email_alert" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.route2gpx_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "health_check_alarm" {
  alarm_name          = "route2gpx-health-check-failed"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthCheckStatus"
  namespace           = "AWS/Route53"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "Route2GPX site is unhealthy"
  alarm_actions       = [aws_sns_topic.route2gpx_alerts.arn]
  ok_actions          = [aws_sns_topic.route2gpx_alerts.arn]

  dimensions = {
    HealthCheckId = aws_route53_health_check.route2gpx.id
  }
}
