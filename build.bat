@echo off
echo ========================================
echo   VSCode Code Reviewer Plugin Builder
echo ========================================
echo.

cd /d "%~dp0"

echo [1/4] Checking Node.js...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)
node --version
echo.

echo [2/4] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to install dependencies!
    pause
    exit /b 1
)
echo.

echo [3/4] Compiling TypeScript...
call npm run compile
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to compile!
    pause
    exit /b 1
)
echo.

echo [4/4] Packaging VSIX...
call npm install -g vsce
call vsce package
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to package!
    pause
    exit /b 1
)
echo.

echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo The .vsix file has been generated.
echo You can install it in VSCode:
echo   1. Press Ctrl+Shift+X
echo   2. Click "..." menu
echo   3. Select "Install from VSIX"
echo.
pause