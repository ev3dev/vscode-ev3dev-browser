@echo off

rem deps:
rem npm install -g browserify
rem npm install -g nexe@beta
rem
rem choco install upx

set out=native\win32\helper.exe

if not exist native\win32 mkdir native\win32
browserify --node --exclude weak out/src/native-helper/helper.js | nexe --output %out% --vcBuild ia32
upx %out%
