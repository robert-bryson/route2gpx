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
  HEADERS
}

resource "aws_amplify_branch" "main" {
  app_id      = aws_amplify_app.route2gpx.id
  branch_name = "main"
  stage       = "PRODUCTION"
}

resource "aws_amplify_domain_association" "route2gpx" {
  app_id      = aws_amplify_app.route2gpx.id
  domain_name = "rsmb.tv"

  # route2gpx.rsmb.tv → main branch
  sub_domain {
    branch_name = aws_amplify_branch.main.branch_name
    prefix      = "route2gpx"
  }
}
