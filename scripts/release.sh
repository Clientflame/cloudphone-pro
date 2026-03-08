#!/bin/bash
# ============================================================
# CloudPhone Pro — Release Script
# Usage: ./scripts/release.sh [patch|minor|major] [--dry-run]
# ============================================================

set -euo pipefail

BUMP_TYPE="${1:-patch}"
DRY_RUN="${2:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   CloudPhone Pro Release Script      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# Validate bump type
if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo -e "${RED}Error: Invalid bump type '$BUMP_TYPE'. Use: patch, minor, or major${NC}"
  exit 1
fi

# Ensure we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "master" ]]; then
  echo -e "${YELLOW}Warning: You are on branch '$CURRENT_BRANCH', not main/master.${NC}"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Ensure working directory is clean
if [[ -n $(git status --porcelain) ]]; then
  echo -e "${RED}Error: Working directory is not clean. Commit or stash changes first.${NC}"
  git status --short
  exit 1
fi

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "Current version: ${YELLOW}v${CURRENT_VERSION}${NC}"

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
echo -e "New version:     ${GREEN}v${NEW_VERSION}${NC}"
echo ""

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo -e "${YELLOW}[DRY RUN] Would bump to v${NEW_VERSION} and push tag.${NC}"
  exit 0
fi

# Confirm
read -p "Release v${NEW_VERSION}? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Bump version in package.json
echo -e "${CYAN}Bumping version in package.json...${NC}"
npm version "$BUMP_TYPE" --no-git-tag-version

# Commit and tag
echo -e "${CYAN}Creating commit and tag...${NC}"
git add package.json package-lock.json
git commit -m "release: v${NEW_VERSION}"
git tag -a "v${NEW_VERSION}" -m "CloudPhone Pro v${NEW_VERSION}"

# Push
echo -e "${CYAN}Pushing to remote...${NC}"
git push origin "$CURRENT_BRANCH"
git push origin "v${NEW_VERSION}"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Release v${NEW_VERSION} pushed successfully!         ║${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║  GitHub Actions will now:                    ║${NC}"
echo -e "${GREEN}║  1. Build the Windows installer              ║${NC}"
echo -e "${GREEN}║  2. Upload to GitHub Releases                ║${NC}"
echo -e "${GREEN}║  3. Generate release notes                   ║${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║  Existing users will auto-update.            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
