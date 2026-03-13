#!/bin/bash

# Update config.json with environment variables
jq \
  --arg url "$deployment_url" \
  --arg token "$auth_token" \
  --argjson pid "$project_id" \
  --argjson tout "$timeout" \
  --arg aws_access_key_id "$AWS_ACCESS_KEY_ID" \
  --arg aws_secret_access_key "$AWS_SECRET_ACCESS_KEY" \
  --arg anthropic_model "$ANTHROPIC_MODEL" \
  '.deployment_url = $url
   | .auth_token = $token
   | .project_id = $pid
   | .timeout = $tout
   | .servers.gatling_mcp.env.AWS_ACCESS_KEY_ID = $aws_access_key_id
   | .servers.gatling_mcp.env.AWS_SECRET_ACCESS_KEY = $aws_secret_access_key
   | .servers.gatling_mcp.env.ANTHROPIC_MODEL = $anthropic_model' \
  /root/.config/alita-mcp-client/config.json > config.tmp && mv config.tmp /root/.config/alita-mcp-client/config.json

# Configure Git to use the credentials for GitLab
git config --global credential.helper store

# Store credentials in a file that Git uses
echo "https://${GIT_USER}:${GIT_TOKEN}@${GIT_URL}/" > ~/.git-credentials

git config --global user.email "${GIT_EMAIL}"
git config --global user.name "${GIT_USER}"

# Start alita-mcp serve
alita-mcp serve
