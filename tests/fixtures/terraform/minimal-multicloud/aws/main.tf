# Minimal AWS fixture for AppCloud autolink validation.
#
# This .tf is the source of truth for tests/fixtures/terraform/minimal-multicloud/captured/aws-config-aggregator.json.
# Apply it (in a sandbox account with Config aggregator enabled) only when the captured response needs to be regenerated.
# CI consumes the captured JSON and never runs Terraform.
#
# Designed to exercise four shapes:
#   Shape 1 (Rule 1 co-location)        — multiple resources in account+region us-east-1, all mapped to Component "web-app"
#   Shape 2 (Rule 2 direct structural)  — EC2 → subnet, vpc, eni, security-group, iam-role
#   Shape 3 (Rule 3 2-hop)              — Lambda in us-west-2 → role-web-app (unmapped Infra) → EC2 (mapped)
#   Shape 4 (public_via_iam)            — GCP-only; not exercised here

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

# -----------------------------------------------------------------------------
# Shape 1 + Shape 2 — dense bucket in us-east-1, mapped Component "web-app"
# -----------------------------------------------------------------------------

provider "aws" {
  alias  = "useast1"
  region = "us-east-1"
}

resource "aws_vpc" "web" {
  provider             = aws.useast1
  cidr_block           = "10.10.0.0/16"
  enable_dns_hostnames = true
  tags = { component = "web-app", env = "prod" }
}

resource "aws_subnet" "web" {
  provider          = aws.useast1
  vpc_id            = aws_vpc.web.id
  cidr_block        = "10.10.1.0/24"
  availability_zone = "us-east-1a"
  tags = { component = "web-app" }
}

resource "aws_security_group" "web" {
  provider = aws.useast1
  vpc_id   = aws_vpc.web.id
  name     = "web-sg"
  tags     = { component = "web-app" }
}

# IAM is global. role-web-app is attached to the EC2 below, AND assumed by the
# Lambda in us-west-2 — that shared edge is what creates the Shape-3 2-hop path.
resource "aws_iam_role" "web_app" {
  name = "role-web-app"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" },     Action = "sts:AssumeRole" },
      { Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" },  Action = "sts:AssumeRole" }
    ]
  })
}

resource "aws_iam_instance_profile" "web" {
  name = "web-instance-profile"
  role = aws_iam_role.web_app.name
}

resource "aws_network_interface" "web" {
  provider        = aws.useast1
  subnet_id       = aws_subnet.web.id
  security_groups = [aws_security_group.web.id]
  tags            = { component = "web-app" }
}

resource "aws_instance" "web" {
  provider             = aws.useast1
  ami                  = "ami-0c02fb55956c7d316"  # placeholder
  instance_type        = "t3.micro"
  iam_instance_profile = aws_iam_instance_profile.web.name

  network_interface {
    network_interface_id = aws_network_interface.web.id
    device_index         = 0
  }

  tags = { component = "web-app", env = "prod" }
}

# -----------------------------------------------------------------------------
# Shape 3 — sparse bucket in us-west-2, Lambda is 2 hops from mapped EC2
# -----------------------------------------------------------------------------
#
# Co-location (Rule 1) requires account+region. Lambda's bucket (account, us-west-2)
# contains no resources mapped to a Component, so Rule 1 produces no vote.
# Lambda's 1-hop neighbours (its subnet, its VPC, role-web-app) are all unmapped
# Infra nodes — so Rule 2 produces no mapped-Infra hit.
# 2-hop Lambda → role-web-app → EC2 (mapped) is what triggers Rule 3 with score
#   min(58, 40 + 1 × 6) = 46  (one path)
# To verify Rule 3's path-count math, raise the path count by giving role-web-app
# a second downstream mapped Infra and re-asserting; the test does that.

provider "aws" {
  alias  = "uswest2"
  region = "us-west-2"
}

resource "aws_vpc" "batch" {
  provider   = aws.uswest2
  cidr_block = "10.20.0.0/16"
  # No component tag — bootstrap Phase 1 (tag-based) does not map this.
}

resource "aws_subnet" "batch" {
  provider          = aws.uswest2
  vpc_id            = aws_vpc.batch.id
  cidr_block        = "10.20.1.0/24"
  availability_zone = "us-west-2a"
}

resource "aws_security_group" "batch" {
  provider = aws.uswest2
  vpc_id   = aws_vpc.batch.id
  name     = "batch-sg"
}

resource "aws_lambda_function" "batch" {
  provider      = aws.uswest2
  function_name = "fn-batch"
  role          = aws_iam_role.web_app.arn  # SAME role as the mapped EC2 — this is the 2-hop bridge
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  filename      = "lambda.zip"  # placeholder; not deployed in fixture mode

  vpc_config {
    subnet_ids         = [aws_subnet.batch.id]
    security_group_ids = [aws_security_group.batch.id]
  }
}
