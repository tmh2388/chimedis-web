#!/bin/bash

###############################################################################
# Chimedis Setup Script
# Automates GitHub repo creation, configuration, and deployment setup
###############################################################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
cat << "EOF"
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║         🏥 CHIMEDIS SETUP — Automated Configuration 🏥         ║
║                                                                ║
║     Chinese Medical Terminology Discovery Platform            ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

echo -e "${YELLOW}This script will:${NC}"
echo "  1. Create GitHub repository"
echo "  2. Configure GitHub Secrets"
echo "  3. Setup local environment"
echo "  4. Build API from Google Sheets"
echo "  5. Deploy to Hostinger & Cloudflare"
echo ""

# ===== STEP 1: Gather Information =====

echo -e "${BLUE}STEP 1: Gathering Configuration${NC}"
echo ""

# GitHub
read -p "📍 GitHub Token (created at github.com/settings/tokens): " GITHUB_TOKEN
read -p "📍 GitHub Username (e.g., tmh2388): " GITHUB_USERNAME
read -p "📍 Repository Name (default: chimedis-web): " REPO_NAME
REPO_NAME=${REPO_NAME:-chimedis-web}

# Google
read -p "📍 Google Sheets ID: " GOOGLE_SHEETS_ID
read -p "📍 Path to credentials.json (or paste full JSON): " CREDS_INPUT

# Handle credentials input
if [ -f "$CREDS_INPUT" ]; then
    GOOGLE_CREDENTIALS_JSON=$(cat "$CREDS_INPUT")
else
    GOOGLE_CREDENTIALS_JSON="$CREDS_INPUT"
fi

# Hostinger
echo ""
echo -e "${YELLOW}Hostinger Configuration (optional for now, needed for deployment):${NC}"
read -p "📍 Hostinger cPanel URL (e.g., cpanel.hostinger.com:2083): " HOSTINGER_HOST
read -p "📍 Hostinger cPanel Username: " HOSTINGER_USERNAME
read -p "📍 Hostinger cPanel Password: " HOSTINGER_PASSWORD

# Cloudflare
echo ""
echo -e "${YELLOW}Cloudflare Configuration (optional for now, needed for PWA deployment):${NC}"
read -p "📍 Cloudflare API Token: " CLOUDFLARE_API_TOKEN
read -p "📍 Cloudflare Account ID: " CLOUDFLARE_ACCOUNT_ID

# ===== STEP 2: Create GitHub Repo =====

echo ""
echo -e "${BLUE}STEP 2: Creating GitHub Repository${NC}"

API_URL="https://api.github.com/user/repos"
REPO_JSON=$(cat <<EOF
{
  "name": "$REPO_NAME",
  "description": "Chimedis - Chinese Medical Terminology Discovery Platform",
  "homepage": "https://$REPO_NAME.pages.dev",
  "private": false,
  "has_issues": true,
  "has_projects": false,
  "has_downloads": false,
  "has_wiki": false,
  "is_template": false,
  "topics": ["chimedis", "tcm", "medical", "terminology", "pwа", "progressive-web-app"],
  "delete_branch_on_merge": true
}
EOF
)

echo "Creating repository: $REPO_NAME..."

REPO_RESPONSE=$(curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  -d "$REPO_JSON" \
  $API_URL)

REPO_URL=$(echo $REPO_RESPONSE | grep -o '"clone_url": "[^"]*' | cut -d'"' -f4)

if [ -z "$REPO_URL" ]; then
    echo -e "${RED}✗ Failed to create repository${NC}"
    echo "Response: $REPO_RESPONSE"
    exit 1
fi

echo -e "${GREEN}✓ Repository created: $REPO_URL${NC}"

# ===== STEP 3: Configure GitHub Secrets =====

echo ""
echo -e "${BLUE}STEP 3: Configuring GitHub Secrets${NC}"

add_secret() {
    local SECRET_NAME=$1
    local SECRET_VALUE=$2
    
    echo "Setting secret: $SECRET_NAME..."
    
    # For simplicity, show instructions instead of automating
    # (automating would require additional library)
    echo "  → Manual step: Go to:"
    echo "    Settings > Secrets and variables > Actions > New repository secret"
    echo "    Name: $SECRET_NAME"
    echo "    Value: [provided below]"
}

echo ""
echo -e "${YELLOW}⚠️  GitHub Secrets (Manual Setup Required):${NC}"
echo ""
echo "Go to: https://github.com/$GITHUB_USERNAME/$REPO_NAME/settings/secrets/actions"
echo ""
echo "Add these secrets:"
echo ""
echo "1. GOOGLE_SHEETS_ID"
echo "   Value: $GOOGLE_SHEETS_ID"
echo ""
echo "2. GOOGLE_CREDENTIALS_JSON"
echo "   Value: (paste contents of your credentials.json file)"
echo ""
echo "3. CLOUDFLARE_API_TOKEN"
echo "   Value: $CLOUDFLARE_API_TOKEN"
echo ""
echo "4. CLOUDFLARE_ACCOUNT_ID"
echo "   Value: $CLOUDFLARE_ACCOUNT_ID"
echo ""
echo "5. HOSTINGER_HOST"
echo "   Value: $HOSTINGER_HOST"
echo ""
echo "6. HOSTINGER_USERNAME"
echo "   Value: $HOSTINGER_USERNAME"
echo ""
echo "7. HOSTINGER_PASSWORD"
echo "   Value: $HOSTINGER_PASSWORD"
echo ""

read -p "Press Enter once you've added the secrets in GitHub..."

# ===== STEP 4: Setup Local Environment =====

echo ""
echo -e "${BLUE}STEP 4: Setting Up Local Environment${NC}"

# Initialize git
if [ ! -d .git ]; then
    echo "Initializing Git repository..."
    git init
    git config user.email "chimedis@havanminh.com"
    git config user.name "Chimedis Bot"
fi

# Setup backend
echo ""
echo "Setting up backend..."
cd backend

cp .env.example .env

cat > .env << ENVEOF
PORT=3000
NODE_ENV=development
GOOGLE_SHEETS_ID=$GOOGLE_SHEETS_ID
GOOGLE_CREDENTIALS_JSON=./credentials.json
WEBHOOK_SECRET=chimedis-webhook-secret
ENVEOF

# Create credentials.json if not exists
if [ ! -f credentials.json ]; then
    echo "$GOOGLE_CREDENTIALS_JSON" > credentials.json
    echo "✓ credentials.json created"
fi

echo "Installing dependencies..."
npm install

echo "Building API from Google Sheets..."
npm run build

if [ -f public/data/terms.json ]; then
    TERM_COUNT=$(grep -o '"id"' public/data/terms.json | wc -l)
    echo -e "${GREEN}✓ API built successfully ($TERM_COUNT terms)${NC}"
else
    echo -e "${RED}✗ Build failed - check credentials.json${NC}"
fi

cd ..

# ===== STEP 5: Git Commit & Push =====

echo ""
echo -e "${BLUE}STEP 5: Committing & Pushing to GitHub${NC}"

git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

git add .
git commit -m "Initial commit: Chimedis production setup" || echo "Nothing to commit"

echo "Pushing to GitHub..."
git branch -M main
git push -u origin main

echo -e "${GREEN}✓ Code pushed to GitHub${NC}"

# ===== STEP 6: Show Summary =====

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✨ SETUP COMPLETE!${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo ""

echo "📍 Repository: $REPO_URL"
echo "📍 GitHub Actions: https://github.com/$GITHUB_USERNAME/$REPO_NAME/actions"
echo "📍 GitHub Secrets: https://github.com/$GITHUB_USERNAME/$REPO_NAME/settings/secrets/actions"
echo ""

echo -e "${YELLOW}Next Steps:${NC}"
echo ""
echo "1️⃣  Verify GitHub Secrets are set:"
echo "   → Settings > Secrets and variables > Actions"
echo "   → Should see: GOOGLE_SHEETS_ID, GOOGLE_CREDENTIALS_JSON, etc."
echo ""
echo "2️⃣  Monitor initial deployment:"
echo "   → Actions tab > Check workflow status"
echo "   → Wait for 'Deploy Chimedis' workflow to complete"
echo ""
echo "3️⃣  Check API:"
echo "   → Once deployed: https://[your-domain]/health"
echo "   → Should return: { status: 'ok' }"
echo ""
echo "4️⃣  Check PWA:"
echo "   → https://[your-cloudflare-domain]"
echo "   → Should load Chimedis app"
echo ""
echo "5️⃣  Test auto-sync:"
echo "   → Edit a term in Google Sheets"
echo "   → Wait max 1 hour for sync-sheets.yml to run"
echo "   → Or manually trigger: /api/build-now?secret=chimedis-webhook-secret"
echo ""

echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🎉 Chimedis is ready to serve!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

echo "For questions:"
echo "  📧 Email: tmh2388@gmail.com"
echo "  🐙 GitHub: https://github.com/tmh2388/chimedis-web"
echo ""
