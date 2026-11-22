@echo off
setlocal
cd /d "%~dp0"
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>&1
if not errorlevel 1 (
  node apps\desktop\server.mjs
  goto finished
)
set "GRALTITUDE_ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "GRALTITUDE_ARCH=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "GRALTITUDE_ARCH=arm64"
set "GRALTITUDE_HASH=86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6"
if "%GRALTITUDE_ARCH%"=="arm64" set "GRALTITUDE_HASH=172e320db179ce416fc012b96b9917dacfb442beb081de57c4deaed7b5a24644"
set "GRALTITUDE_NODE=%LOCALAPPDATA%\Graltitude\v24.22.3\%GRALTITUDE_ARCH%\node.exe"
if exist "%GRALTITUDE_NODE%" goto launch
echo Downloading the Graltitude runtime for this computer...
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $dest=$env:GRALTITUDE_NODE; $dir=Split-Path $dest; [void][IO.Directory]::CreateDirectory($dir); $tmp=Join-Path $dir ([guid]::NewGuid().ToString()); try { Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/dist/v24.22.3/win-'+$env:GRALTITUDE_ARCH+'/node.exe') -OutFile $tmp; if ((Get-FileHash -Algorithm SHA256 $tmp).Hash -ne $env:GRALTITUDE_HASH) {throw 'Runtime download failed verification'}; Move-Item -LiteralPath $tmp -Destination $dest } finally {if (Test-Path $tmp) {Remove-Item -LiteralPath $tmp}}"
if errorlevel 1 goto failed
:launch
"%GRALTITUDE_NODE%" apps\desktop\server.mjs
:finished
if not errorlevel 1 exit /b 0
:failed
pause
exit /b 1
