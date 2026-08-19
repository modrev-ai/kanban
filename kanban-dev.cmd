@echo off
setlocal EnableDelayedExpansion
title Kanban DEV - http://127.0.0.1:4173

rem ---------------------------------------------------------------------------
rem  Launches a local DEV instance: runtime on 3484, Vite web UI on 4173,
rem  with hot reload. Double-click this file, or run it from a terminal.
rem
rem  There is nothing to "build" here -- the runtime runs from source under
rem  tsx watch and the web UI is served by Vite. The equivalent staleness check
rem  is the installed dependency tree, so this refreshes dependencies when the
rem  version in package.json differs from the one they were installed for.
rem  Pass --rebuild to force a refresh.
rem
rem  For a real production build, use kanban-prod.cmd.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

set "FORCE=0"
for %%a in (%*) do (
	if /i "%%~a"=="--rebuild" set "FORCE=1"
	if /i "%%~a"=="-r" set "FORCE=1"
)

echo.
echo  ==================================================
echo    Kanban  -  DEV instance  (hot reload)
echo  ==================================================
echo.

call :require_node
if errorlevel 1 goto :fail

call :sync_deps
if errorlevel 1 goto :fail

call :warn_port 3484 runtime
call :warn_port 4173 "web UI"

echo    Runtime : http://127.0.0.1:3484
echo    Web UI  : http://127.0.0.1:4173     ^<-- open this one
echo.
echo    Sources are watched; edits reload automatically.
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

:sync_deps
set "PKG_VERSION="
for /f "delims=" %%v in ('node -p "require('./package.json').version" 2^>nul') do set "PKG_VERSION=%%v"
if not defined PKG_VERSION (
	echo    ERROR: could not read the version from package.json.
	exit /b 1
)

set "DEP_VERSION="
if exist "node_modules\.kanban-dev-version" set /p DEP_VERSION=<"node_modules\.kanban-dev-version"

set "DO_SYNC=0"
set "REASON="
if not exist "node_modules\.package-lock.json" ( set "DO_SYNC=1" & set "REASON=dependencies not installed" )
if not exist "web-ui\node_modules" ( set "DO_SYNC=1" & set "REASON=web-ui dependencies not installed" )
if "!DO_SYNC!"=="0" if not "!DEP_VERSION!"=="!PKG_VERSION!" (
	set "DO_SYNC=1"
	set "REASON=version changed: !DEP_VERSION! -> !PKG_VERSION!"
)
if "%FORCE%"=="1" ( set "DO_SYNC=1" & set "REASON=--rebuild requested" )

if "!DO_SYNC!"=="0" (
	echo    Dependencies are current for version !PKG_VERSION!.
	echo.
	exit /b 0
)

echo    Installing dependencies ^(!REASON!^).
echo    The first run takes a few minutes; later refreshes are quick...
echo.
call npm install
if errorlevel 1 exit /b 1
call npm --prefix web-ui install
if errorlevel 1 exit /b 1
>"node_modules\.kanban-dev-version" echo !PKG_VERSION!
echo.
echo    Dependencies ready ^(version !PKG_VERSION!^).
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
