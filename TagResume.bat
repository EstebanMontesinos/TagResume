@echo off
title TagResume - AI Resume Optimizer
cd /d "%~dp0"

echo.
echo  ================================================
echo   TagResume - AI Resume Optimizer
echo  ================================================
echo.
echo  Starting server...
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed.
    echo  Please install it from https://nodejs.org
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo  Installing dependencies for first time setup...
    call npm install
    echo.
)

:: Check if .env exists
if not exist ".env" (
    echo  ERROR: .env file not found.
    echo  Please create a .env file with your ANTHROPIC_API_KEY and MONGODB_URI.
    pause
    exit /b 1
)

:: Open browser after 2 second delay
echo  Opening TagResume at http://localhost:3000
echo  Close this window to stop the server.
echo.
start "" cmd /c "timeout /t 2 >nul && start http://localhost:3000"

:: Start the server (keeps this window open)
node server.js

pause
