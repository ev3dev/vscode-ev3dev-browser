#!/bin/bash

# deps:
# npm install -g browserify
# npm install -g nexe@beta
#
# apt install upx-ucl
# -or-
# brew install upx

platform=$(node -e 'console.log(process.platform)')
out=native/$platform/shell

browserify --node --exclude weak out/src/shell.js | nexe --output $out
strip $out
upx $out
