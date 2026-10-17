@echo off
if exist "%~dp0release-webview2\PawShift-0.3.3\PawShift.exe" (
  start "" "%~dp0release-webview2\PawShift-0.3.3\PawShift.exe"
) else (
  echo PawShift has not been built. Run npm run package:dir first.
  pause
)
