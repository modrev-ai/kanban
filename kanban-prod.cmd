@echo off
setlocal EnableDelayedExpansion
title Kanban PROD - http://127.0.0.1:4174

rem ---------------------------------------------------------------------------
rem  Launches a local PRODUCTION instance: builds the real bundle, then serves it
rem  from dist on a single port, 4174.
rem
rem  This is not "dev on another port". The built runtime serves the bundled web
rem  UI itself (see src/server/assets.ts), so there is no Vite and no watcher --
rem  one process, one URL, the same shape as the deployed server.
rem
rem  For hot-reload development, use kanban-dev.cmd.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

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

set "DO_BUILD=1"
if not exist "dist\cli.js" goto :do_build
if not exist "dist\web-ui\index.html" goto :do_build

echo    An existing production build was found in dist\.
set "ANSWER="
set /p ANSWER=   Rebuild it before starting? [y/N]: 
if /i not "!ANSWER!"=="y" set "DO_BUILD=0"
echo.

:do_build
if "!DO_BUILD!"=="0" goto :skip_build
echo    Building the production bundle. This takes a minute or two...
echo.
call npm run build
if errorlevel 1 goto :fail
echo.
echo    Build complete.
echo.

:skip_build
echo    URL: http://127.0.0.1:4174
echo.
echo    Serving the bundled web UI from dist\web-ui.
echo    No Vite, no watcher - restart this launcher to pick up code changes.
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
