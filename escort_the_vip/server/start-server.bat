@echo off
cd /d "%~dp0"

echo [%date% %time%] Building server...
call npm run build
if %errorlevel% neq 0 (
    echo [%date% %time%] Build failed! Exiting.
    exit /b 1
)

echo [%date% %time%] Starting Colyseus server...
node dist/main.js
