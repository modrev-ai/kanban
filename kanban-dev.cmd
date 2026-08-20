@echo off
setlocal EnableDelayedExpansion
title Kanban DEV - http://127.0.0.1:4173

rem ---------------------------------------------------------------------------
rem  Launches a local DEV instance of the most recent dev release: runtime on
rem  3484, Vite web UI on 4173, with hot reload. Double-click, or run from a
rem  terminal.
rem
rem  On start it:
rem    - fetches origin and checks out the newest vX.Y.Z.R-dev release tag
rem      (falling back to origin/dev when no dev release exists yet)
rem    - frees ports 3484 and 4173 by terminating whatever is listening on them
rem    - refreshes dependencies when the checked-out RELEASE has changed, not
rem      when package.json changes - those are decoupled, and package.json stays
rem      on one version across many releases
rem
rem  Flags: --rebuild / -r     force a dependency refresh
rem         --no-sync          use the current checkout as-is
rem                            (--no-branch-check is accepted as an alias)
rem         --force-sync       check out the release even over local changes
rem
rem  For a production release from main, use kanban-prod.cmd.
rem ---------------------------------------------------------------------------

set "TARGET_BRANCH=dev"
set "CHANNEL=dev"

cd /d "%~dp0"

set "FORCE=0"
set "NO_SYNC=0"
set "FORCE_SYNC=0"
for %%a in (%*) do (
	if /i "%%~a"=="--rebuild" set "FORCE=1"
	if /i "%%~a"=="-r" set "FORCE=1"
	if /i "%%~a"=="--no-sync" set "NO_SYNC=1"
	if /i "%%~a"=="--no-branch-check" set "NO_SYNC=1"
	if /i "%%~a"=="--force-sync" set "FORCE_SYNC=1"
)

echo.
echo  ==================================================
echo    Kanban  -  DEV release  (hot reload)
echo  ==================================================
echo.

call :require_node
if errorlevel 1 goto :fail

call :sync_release "%TARGET_BRANCH%" "%CHANNEL%"
if errorlevel 1 goto :fail

call :free_port 3484 runtime
call :free_port 4173 "web UI"

call :sync_deps
if errorlevel 1 goto :fail

echo    Runtime : http://127.0.0.1:3484
echo    Web UI  : http://127.0.0.1:4173     ^<-- open this one
echo.
if "%DETACHED%"=="1" (
	rem The launcher runs a RELEASE, so the checkout is detached. Hot reload invites
	rem editing, and edits committed here would sit on no branch at all.
	echo    Sources are watched; edits reload automatically - but this is a detached
	echo    HEAD at !RELEASE_ID!, so anything you commit here is on no branch.
	echo    Run this with --no-sync to develop on "dev" instead.
) else (
	echo    Sources are watched; edits reload automatically.
)
echo    Press Ctrl+C to stop.
echo.

call npm run dev:full
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

:sync_release
rem Puts the checkout on the newest release for this channel, so a local run is
rem exactly what was last released rather than whatever the branch tip happens
rem to be. Checks out the tag detached, so no local branch is ever moved or
rem reset and unpushed commits cannot be lost.
set "WANT=%~1"
set "CHAN=%~2"
if "%NO_SYNC%"=="1" (
	echo    Release sync skipped ^(--no-sync^); using the current checkout.
	echo.
	exit /b 0
)
where git >nul 2>&1
if errorlevel 1 (
	echo    WARNING: git is not on PATH; skipping the release sync.
	echo.
	exit /b 0
)
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
	echo    WARNING: not a git checkout; skipping the release sync.
	echo.
	exit /b 0
)

echo    Fetching releases from origin...
git fetch --force --tags --prune origin
if errorlevel 1 (
	echo    WARNING: could not reach origin; using what is already checked out.
	echo.
	exit /b 0
)

rem Uncommitted work on tracked files would be disturbed by the checkout.
rem -uno, not --untracked-files=no: for /f silently captures nothing from the
rem long form, so the guard would never fire.
set "DIRTY="
for /f "delims=" %%d in ('git status --porcelain -uno 2^>nul') do set "DIRTY=1"
if defined DIRTY if not "%FORCE_SYNC%"=="1" (
	echo    ERROR: you have uncommitted changes to tracked files.
	echo.
	echo           This launcher checks out the latest !CHAN! release, which would
	echo           disturb them. Commit or stash first, pass --force-sync to
	echo           discard them, or --no-sync to run the current checkout.
	exit /b 1
)

set "CO_FLAGS=--detach"
if "%FORCE_SYNC%"=="1" set "CO_FLAGS=--detach --force"

set "REL_TAG="
for /f "delims=" %%t in ('node scripts\latest-release-tag.mjs !CHAN! 2^>nul') do set "REL_TAG=%%t"

if not defined REL_TAG (
	echo    No !CHAN! release tag exists yet - falling back to origin/!WANT!.
	git checkout !CO_FLAGS! "origin/!WANT!"
	if errorlevel 1 (
		echo    ERROR: could not check out origin/!WANT!.
		exit /b 1
	)
	set "HEADSHA="
	for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "HEADSHA=%%h"
	set "RELEASE_ID=origin/!WANT!@!HEADSHA!"
	set "DETACHED=1"
	echo    Running origin/!WANT! @ !HEADSHA!
	echo.
	exit /b 0
)

git checkout !CO_FLAGS! "refs/tags/!REL_TAG!"
if errorlevel 1 (
	echo    ERROR: could not check out !REL_TAG!.
	exit /b 1
)
set "RELEASE_ID=!REL_TAG!"
set "DETACHED=1"
echo    Running release !REL_TAG!
echo    ^(detached HEAD - run "git checkout !WANT!" to go back to developing^)
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

:sync_deps
call :resolve_release_id

set "DEP_VERSION="
if exist "node_modules\.kanban-release" set /p DEP_VERSION=<"node_modules\.kanban-release"

set "DO_SYNC=0"
set "REASON="
if not exist "node_modules\.package-lock.json" ( set "DO_SYNC=1" & set "REASON=dependencies not installed" )
if "!DO_SYNC!"=="0" if not exist "web-ui\node_modules" ( set "DO_SYNC=1" & set "REASON=web-ui dependencies not installed" )
if "!DO_SYNC!"=="0" if not "!DEP_VERSION!"=="!RELEASE_ID!" (
	set "DO_SYNC=1"
	set "REASON=release changed: !DEP_VERSION! -^> !RELEASE_ID!"
)
if "%FORCE%"=="1" ( set "DO_SYNC=1" & set "REASON=--rebuild requested" )

if "!DO_SYNC!"=="0" (
	echo    Dependencies are current for !RELEASE_ID!.
	echo.
	exit /b 0
)

echo    Installing dependencies ^(!REASON!^).
echo    The first run takes a few minutes; later refreshes are quick...
echo.
rem npm ci, not npm install: it installs exactly the lockfile the release was
rem cut from, and leaves package-lock.json untouched. `npm install` can rewrite
rem the lockfile, which would dirty the tree and block the next release sync.
call npm ci
if errorlevel 1 exit /b 1
call npm ci --prefix web-ui
if errorlevel 1 exit /b 1
>"node_modules\.kanban-release" echo !RELEASE_ID!
echo.
echo    Dependencies ready ^(!RELEASE_ID!^).
echo.
exit /b 0

:fail
echo.
echo    Startup failed. The error is above.
echo.
pause
exit /b 1


:resolve_release_id
rem The staleness stamp keys on WHICH RELEASE is checked out, not on the
rem package.json version. Those are now decoupled: release.yml derives tags from
rem git (v1.0.4.1-dev) while package.json stays at its npm version (1.0.3-modrev)
rem across every one of them. Keying on package.json meant the stamp never
rem changed, so dependencies were never refreshed and - worse - prod never
rem rebuilt, silently serving a stale dist forever.
if defined RELEASE_ID exit /b 0
rem sync was skipped, so fall back to whatever is actually checked out.
for /f "delims=" %%h in ('git describe --tags --always 2^>nul') do set "RELEASE_ID=%%h"
if not defined RELEASE_ID set "RELEASE_ID=unknown"
exit /b 0

:done
endlocal
