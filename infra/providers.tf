
terraform {
  required_version = ">= 1.5"

  backend "s3" {
    bucket = "rsmbtv-terraform-state"
    key    = "route2gpx/terraform.tfstate"
    region = "us-east-1"
    # dynamodb_table = "terraform-locks"
    encrypt = true
    profile = "rsmbtv-admin"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.39"
    }
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "rsmbtv-admin"
}