@echo off
cd /d "%~dp0"
set "FAMILY_TREE_WRITE=1"
node mcp\server.cjs --http
if errorlevel 1 pause
