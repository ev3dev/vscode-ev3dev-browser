@echo off

rem deps:
rem npm install -g browserify
rem npm install -g nexe@beta
rem
rem choco install upx

set out=native\win32\helper.exe

browserify --node --exclude weak out/src/helper.js | nexe --output %out% --vcBuild ia32
upx %out%
