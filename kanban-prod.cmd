@echo off
setlocal EnableDelayedExpansion
title Kanban PROD - http://127.0.0.1:4174

rem ---------------------------------------------------------------------------
rem  Launches a local PRODUCTION instance: the real bundle, served from dist on a
rem  single port, 4174.
rem
rem  This is not "dev on another port". The built runtime serves the bundled web
rem  UI itself (see src/server/assets.ts), so there is no Vite and no watcher --
rem  one process, one URL, the same shape as the deployed server.
rem
rem  Rebuilds only when the version in package.json differs from the version that
rem  produced the current dist, or when dist is missing. Pass --rebuild to force.
rem
rem  For hot-reload development, use kanban-dev.cmd.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

set "FORCE=0"
for %%a in (%*) do (
	if /i "%%~a"=="--rebuild" set "FORCE=1"
	if /i "%%~a"=="-r" set "FORCE=1"
)

echo.
echo  ==================================================
echo    Kanban  -  PROD instance  (production build)
echo  ==================================================
echo.

call :require_node
if errorlevel 1 goto :fail

call :require_deps
if errorlevel 1 goto :fail

call :warn_port 4174 app

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

:warn_port
netstat -ano | findstr ":%~1 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
	echo    WARNING: port %~1 ^(%~2^) is already in use.
	echo             Another instance is probably running, so startup may fail.
	echo.
)
exit /b 0

:fail
echo.
echo    Startup failed. The error is above.
echo.
pause
exit /b 1

:done
endlocal
