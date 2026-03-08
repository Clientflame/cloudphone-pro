@echo off
REM ============================================================
REM CloudPhone Pro — Release Script (Windows)
REM Usage: scripts\release.bat [patch|minor|major]
REM ============================================================

setlocal enabledelayedexpansion

set BUMP_TYPE=%1
if "%BUMP_TYPE%"=="" set BUMP_TYPE=patch

echo.
echo ======================================
echo   CloudPhone Pro Release Script
echo ======================================
echo.

REM Validate bump type
if not "%BUMP_TYPE%"=="patch" if not "%BUMP_TYPE%"=="minor" if not "%BUMP_TYPE%"=="major" (
    echo Error: Invalid bump type '%BUMP_TYPE%'. Use: patch, minor, or major
    exit /b 1
)

REM Get current version
for /f "tokens=*" %%i in ('node -p "require('./package.json').version"') do set CURRENT_VERSION=%%i
echo Current version: v%CURRENT_VERSION%

REM Bump version
echo Bumping %BUMP_TYPE% version...
call npm version %BUMP_TYPE% --no-git-tag-version

REM Get new version
for /f "tokens=*" %%i in ('node -p "require('./package.json').version"') do set NEW_VERSION=%%i
echo New version:     v%NEW_VERSION%
echo.

REM Confirm
set /p CONFIRM="Release v%NEW_VERSION%? (y/N): "
if /i not "%CONFIRM%"=="y" (
    echo Aborted.
    REM Revert the version bump
    call npm version %CURRENT_VERSION% --no-git-tag-version --allow-same-version
    exit /b 0
)

REM Commit and tag
echo Creating commit and tag...
git add package.json package-lock.json
git commit -m "release: v%NEW_VERSION%"
git tag -a "v%NEW_VERSION%" -m "CloudPhone Pro v%NEW_VERSION%"

REM Push
echo Pushing to remote...
git push origin HEAD
git push origin "v%NEW_VERSION%"

echo.
echo ======================================
echo   Release v%NEW_VERSION% pushed!
echo.
echo   GitHub Actions will now:
echo   1. Build the Windows installer
echo   2. Upload to GitHub Releases
echo   3. Generate release notes
echo.
echo   Existing users will auto-update.
echo ======================================

endlocal
