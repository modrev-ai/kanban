@echo off
setlocal EnableDelayedExpansion
title Kanban PROD - http://127.0.0.1:4174

rem ---------------------------------------------------------------------------
rem  Launches a local PRODUCTION instance from the "main" branch: the real
rem  bundle, served from dist on a single port, 4174.
rem
rem  This is not "dev on another port". The built runtime serves the bundled web
rem  UI itself (see src/server/assets.ts), so there is no Vite and no watcher --
rem  one process, one URL, the same shape as the deployed server.
rem
rem  On start it:
rem    - checks out and fast-forwards "main" (refuses if you have uncommitted work)
rem    - frees port 4174 by terminating whatever is listening on it
rem    - rebuilds only when the package.json version differs from the version that
rem      produced the current dist, or when dist is missing
rem
rem  Flags: --rebuild / -r        force a rebuild
rem         --no-branch-check     build from the current branch instead of "main"
rem
rem  For hot-reload development from "dev", use kanban-dev.cmd.
rem ---------------------------------------------------------------------------

set "TARGET_BRANCH=main"

cd /d "%~dp0"

set "FORCE=0"
set "NO_BRANCH_CHECK=0"
set "FORCE_SYNC=0"
for %%a in (%*) do (
	if /i "%%~a"=="--rebuild" set "FORCE=1"
	if /i "%%~a"=="-r" set "FORCE=1"
	if /i "%%~a"=="--no-branch-check" set "NO_BRANCH_CHECK=1"
	if /i "%%~a"=="--force-sync" set "FORCE_SYNC=1"
)

echo.
echo  ==================================================
echo    Kanban  -  PROD instance  (production build)
echo  ==================================================
echo.

call :require_node
if errorlevel 1 goto :fail

call :sync_branch "%TARGET_BRANCH%"
if errorlevel 1 goto :fail

call :free_port 4174 app

call :require_deps
if errorlevel 1 goto :fail

rem --- is the existing dist stale? -------------------------------------------
set "PKG_VERSION="
for /f "delims=" %%v in ('node -p "require('./package.json').version" 2^>nul') do set "PKG_VERSION=%%v"
if not defined PKG_VERSION (
	echo    ERROR: could not read the version from package.json.
	goto :fail
)

set "BUILT_VERSION="
if exist "dist\.build-version" set /p BUILT_VERSION=<"dist\.build-version"

set "DO_BUILD=0"
set "REASON="
if not exist "dist\cli.js" ( set "DO_BUILD=1" & set "REASON=no existing build" )
if "!DO_BUILD!"=="0" if not exist "dist\web-ui\index.html" ( set "DO_BUILD=1" & set "REASON=bundled web UI missing" )
if "!DO_BUILD!"=="0" if not "!BUILT_VERSION!"=="!PKG_VERSION!" (
	set "DO_BUILD=1"
	set "REASON=version changed: !BUILT_VERSION! -> !PKG_VERSION!"
)
if "%FORCE%"=="1" ( set "DO_BUILD=1" & set "REASON=--rebuild requested" )

if "!DO_BUILD!"=="0" (
	echo    Build is up to date for version !PKG_VERSION! - skipping rebuild.
	echo    Use --rebuild to force one.
	echo.
	goto :skip_build
)

echo    Rebuilding ^(!REASON!^).
echo    This takes a minute or two...
echo.
call npm run build
if errorlevel 1 goto :fail

rem A build that exits 0 without producing dist is still a failure. Catch it
rem here, rather than letting the stamp write emit a cryptic path error.
if not exist "dist\cli.js" (
	echo    ERROR: the build reported success but dist\cli.js is missing.
	goto :fail
)

rem Stamp the version that produced this dist. Written after the build, because
rem `npm run clean` deletes dist at the start of it.
>"dist\.build-version" echo !PKG_VERSION!
echo.
echo    Build complete ^(version !PKG_VERSION!^).
echo.

:skip_build
echo    URL: http://127.0.0.1:4174
echo.
echo    Serving the bundled web UI from dist\web-ui.
echo    No Vite, no watcher - relaunch after a version bump to pick up changes.
echo    Press Ctrl+C to stop.
echo.

call npm run prod:serve
if errorlevel 1 goto :fail
goto :done

rem ---------------------------------------------------------------------------

:require_node
where node >nul 2>&1
if errorlevel 1 (
	echo    ERROR: Node.js was not found on PATH.
	echo    Install Node.js 22 or newer from https://nodejs.org and try again.
	exit /b 1
)
set "NODE_MAJOR="
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
	echo    ERROR: could not determine the installed Node.js version.
	exit /b 1
)
if !NODE_MAJOR! LSS 22 (
	echo    ERROR: Node.js 22 or newer is required ^(see engines.node in package.json^).
	echo    Found version:
	node --version
	exit /b 1
)
exit /b 0

:sync_branch
rem Makes the checkout match what is currently on the GitHub remote for this
rem launcher's branch, so a local run builds exactly what the branch deploys.
rem
rem Fetches origin, then hard-syncs the local branch to origin/<branch>. Two
rem things are deliberately refused rather than destroyed:
rem   - modified tracked files (uncommitted work)
rem   - local commits not on origin (they would be discarded by the sync)
rem Untracked files are ignored: they do not block a checkout, and this repo
rem normally carries some. --force-sync overrides both refusals.
set "WANT=%~1"
if "%NO_BRANCH_CHECK%"=="1" (
	echo    Branch sync skipped ^(--no-branch-check^); using the current checkout.
	echo.
	exit /b 0
)
where git >nul 2>&1
if errorlevel 1 (
	echo    WARNING: git is not on PATH; skipping the branch sync.
	echo.
	exit /b 0
)
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
	echo    WARNING: not a git checkout; skipping the branch sync.
	echo.
	exit /b 0
)

echo    Fetching "!WANT!" from origin...
git fetch --prune origin "!WANT!"
if errorlevel 1 (
	echo    WARNING: could not reach origin; continuing with the local copy of "!WANT!".
	echo.
	git rev-parse --verify --quiet "!WANT!" >nul 2>&1
	if errorlevel 1 exit /b 0
	git checkout "!WANT!" >nul 2>&1
	exit /b 0
)

git rev-parse --verify --quiet "origin/!WANT!" >nul 2>&1
if errorlevel 1 (
	echo    ERROR: origin has no branch named "!WANT!".
	exit /b 1
)

rem Uncommitted work on tracked files: refuse, never stash or discard.
rem -uno, not --untracked-files=no: for /f silently captures nothing from the
rem long form, so the guard would never fire.
set "DIRTY="
for /f "delims=" %%d in ('git status --porcelain -uno 2^>nul') do set "DIRTY=1"
if defined DIRTY if not "%FORCE_SYNC%"=="1" (
	echo    ERROR: you have uncommitted changes to tracked files.
	echo.
	echo           This launcher builds what is currently on origin/!WANT!, which
	echo           would discard them. Commit or stash first, or pass --force-sync
	echo           to discard, or --no-branch-check to build the current checkout.
	exit /b 1
)

rem Local commits that origin does not have would be dropped by the sync.
set "AHEAD=0"
for /f "delims=" %%c in ('git rev-list --count origin/!WANT!..!WANT! 2^>nul') do set "AHEAD=%%c"
if not "!AHEAD!"=="0" if not "%FORCE_SYNC%"=="1" (
	echo    ERROR: local "!WANT!" has !AHEAD! commit^(s^) that origin does not.
	echo.
	echo           Syncing to origin/!WANT! would discard them. Push them first, or
	echo           pass --force-sync to discard, or --no-branch-check to build the
	echo           current checkout.
	exit /b 1
)

set "CUR="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "CUR=%%b"
if /i not "!CUR!"=="!WANT!" echo    Switching branch: "!CUR!" -^> "!WANT!"

git checkout -B "!WANT!" "origin/!WANT!"
if errorlevel 1 (
	echo    ERROR: could not sync "!WANT!" to origin/!WANT!.
	exit /b 1
)
set "HEADSHA="
for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "HEADSHA=%%h"
echo    Building origin/!WANT! @ !HEADSHA!
echo.
exit /b 0

:free_port
rem Terminates whatever is LISTENING on the given port, so startup cannot fail
rem with EADDRINUSE. Skips the system PIDs 0 and 4.
set "P=%~1"
set "PLABEL=%~2"
set "FREED=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":!P! " ^| findstr "LISTENING" 2^>nul') do (
	if not "%%a"=="0" if not "%%a"=="4" (
		set "PNAME="
		for /f "tokens=1 delims=," %%n in ('tasklist /fi "PID eq %%a" /fo csv /nh 2^>nul') do set "PNAME=%%~n"
		echo    Port !P! ^(!PLABEL!^) in use by PID %%a !PNAME! - terminating.
		taskkill /F /PID %%a >nul 2>&1
		if errorlevel 1 (
			echo    WARNING: could not terminate PID %%a. Stop it manually, or rerun as Administrator.
		) else (
			set "FREED=1"
		)
	)
)
if "!FREED!"=="1" (
	rem Let Windows release the socket before we bind it again.
	ping -n 2 127.0.0.1 >nul 2>&1
	echo    Port !P! freed.
	echo.
)
exit /b 0

:require_deps
if exist "node_modules\.package-lock.json" if exist "web-ui\node_modules" exit /b 0
echo    Installing dependencies. First run only; this takes a few minutes...
echo.
call npm install
if errorlevel 1 exit /b 1
call npm --prefix web-ui install
if errorlevel 1 exit /b 1
echo.
echo    Dependencies installed.
echo.
exit /b 0

:fail
echo.
echo    Startup failed. The error is above.
echo.
pause
exit /b 1

:done
endlocal
