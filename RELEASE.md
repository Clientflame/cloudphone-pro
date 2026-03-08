# CloudPhone Pro — Release & Auto-Update Guide

This document covers how to set up GitHub Releases auto-publishing and OTA auto-updates for CloudPhone Pro.

---

## Prerequisites

Before your first release, complete these one-time setup steps.

### 1. Create the GitHub Repository

```bash
# Initialize git (if not already done)
cd cloudphone-desktop
git init
git add .
git commit -m "initial commit: CloudPhone Pro v2.1.0"

# Create the repo on GitHub (via CLI or web UI)
gh repo create cloudphone-pro --private --source=. --push
```

### 2. Configure the Update Source (In-App)

As of v2.5.0, the GitHub owner/repo is configured at runtime through the app UI — no need to edit `package.json`.

1. Open CloudPhone Pro
2. Go to **Settings > Updates**
3. Enter your GitHub **Owner / Org** and **Repository Name**
4. (Optional) Add a **GitHub Access Token** for private repos
5. Click **Save Config**
6. Click **Check Now** to verify

The `package.json` publish config uses `GH_OWNER` and `GH_REPO` environment variables as defaults for CI builds.

### 3. Configure the GitHub Token

The GitHub Actions workflow uses the built-in `GITHUB_TOKEN` automatically. No additional secrets are required for public repositories.

For **private repositories**, the built-in token already has write access to releases within the same repo.

---

## How to Release a New Version

There are three ways to publish a release. Choose whichever fits your workflow.

### Option A: Release Script (Recommended)

The release script bumps the version, commits, tags, and pushes — then GitHub Actions builds and publishes automatically.

**On macOS/Linux:**
```bash
./scripts/release.sh patch   # 2.1.0 → 2.1.1
./scripts/release.sh minor   # 2.1.0 → 2.2.0
./scripts/release.sh major   # 2.1.0 → 3.0.0

# Preview without making changes
./scripts/release.sh patch --dry-run
```

**On Windows:**
```cmd
scripts\release.bat patch
scripts\release.bat minor
scripts\release.bat major
```

### Option B: Manual Tag Push

```bash
# 1. Bump version in package.json
npm version patch              # or minor / major

# 2. Push the commit and tag
git push origin main --tags
```

GitHub Actions detects the `v*` tag and triggers the build-and-release workflow.

### Option C: Manual Workflow Dispatch

1. Go to **Actions** tab in your GitHub repository
2. Select the **Build & Release** workflow
3. Click **Run workflow**
4. Choose whether to publish to GitHub Releases
5. Click **Run workflow**

This is useful for testing the build pipeline without creating a version tag.

---

## What Happens During a Release

When you push a tag like `v2.2.0`, the following sequence runs automatically:

```
Tag pushed (v2.2.0)
    │
    ▼
GitHub Actions: build-windows
    ├── Checkout code
    ├── Install dependencies (npm ci)
    ├── Build Windows NSIS installer
    ├── Upload to GitHub Releases
    └── Upload build artifacts
    │
    ▼
GitHub Actions: create-release-notes
    ├── Generate changelog from git commits
    └── Update release description with install instructions
    │
    ▼
GitHub Release published
    ├── CloudPhone-Pro-Setup-2.2.0.exe (installer)
    ├── CloudPhone-Pro-Setup-2.2.0.exe.blockmap (differential update)
    └── latest.yml (auto-update manifest)
```

---

## Auto-Update Flow

CloudPhone Pro uses `electron-updater` to check for updates from GitHub Releases.

### How It Works

1. On app launch (after 3 seconds), the app checks `latest.yml` from your GitHub Releases
2. If a newer version exists, it downloads the update in the background
3. A dialog prompts the user: **"Restart Now"** or **"Later"**
4. If "Later", the update installs silently on the next app quit
5. The app also checks every 30 minutes while running

### Update Configuration (main.js)

```javascript
autoUpdater.autoDownload = true;          // Download automatically
autoUpdater.autoInstallOnAppQuit = true;  // Install on quit
autoUpdater.allowPrerelease = false;      // Ignore pre-releases
autoUpdater.allowDowngrade = false;       // Never downgrade
```

### Differential Updates

The `.blockmap` file enables differential updates. Instead of downloading the full 75MB installer, users only download the changed blocks (typically 1-5MB). This is handled automatically by electron-updater.

### Private Repository Updates

If your repo is private, users can add their GitHub Personal Access Token in **Settings > Updates > Access Token**. The token needs `repo` scope.

For enterprise deployments, you can also use a generic server provider by modifying `configureUpdateFeed()` in `main.js`.

---

## Release Checklist

Use this checklist before every release:

- [ ] All features tested locally (`npm start`)
- [ ] Version bumped in `package.json`
- [ ] `build.publish.owner` and `build.publish.repo` are correct
- [ ] No uncommitted changes (`git status` is clean)
- [ ] On `main` branch
- [ ] Previous CI build passed
- [ ] Tag pushed (`git push origin --tags`)
- [ ] GitHub Actions build completed successfully
- [ ] Release page has the installer attached
- [ ] Tested auto-update from a previous version

---

## Troubleshooting

### Build fails with "Cannot find electron"

```bash
npm ci   # Clean install all dependencies
```

### Release not appearing on GitHub

Check that:
1. The tag starts with `v` (e.g., `v2.2.0`)
2. The `GITHUB_TOKEN` has `contents: write` permission
3. The `owner` and `repo` in `package.json` match your actual repository

### Auto-update not detecting new version

1. Verify `latest.yml` exists in the GitHub Release assets
2. Check that the version in `latest.yml` is higher than the installed version
3. Look at the app's console log for `[AutoUpdate]` messages
4. Ensure the app is not running in dev mode (`npm start` skips updates)

### SmartScreen warning on Windows

This happens because the installer is not code-signed. To fix:
1. Purchase a code signing certificate (DigiCert, Sectigo, etc.)
2. Add to `package.json`:
   ```json
   "win": {
     "certificateFile": "path/to/certificate.pfx",
     "certificatePassword": "your-password"
   }
   ```
3. Or set environment variables in GitHub Actions:
   ```yaml
   env:
     CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
     CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}
   ```

---

## Version History

| Version | Date | Notes |
|---------|------|-------|
| 2.5.0 | 2026-03-07 | GitHub auto-update UI, runtime-configurable update feed, improved CI/CD |
| 2.4.2 | 2026-03-07 | Fix ERR_SOCKET_DGRAM_NOT_RUNNING crash, safe SIP send wrappers |
| 2.4.1 | 2026-03-07 | Fix blank screen (RTP audio batching), auto-register on startup |
| 2.4.0 | 2026-03-07 | Fix SIP persistence, audio playback scheduling, SIP debug console |
| 2.1.0 | 2026-03-07 | Multi-line SIP, queue agent, CRM click-to-call, native notifications |
| 2.0.0 | 2026-03-07 | Full commercial feature set |
| 1.1.0 | 2026-03-07 | Audio device selection, call recording |
| 1.0.0 | 2026-03-07 | Initial release with SIP, RTP, electron-store |
