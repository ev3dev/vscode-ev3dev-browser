#!/bin/bash

# deps:
# npm install -g browserify
# npm install -g nexe@beta
#
# apt install upx-ucl
# -or-
# brew install upx

platform=$(node -e 'console.log(process.platform)')
out=native/$platform/helper

browserify --node --exclude weak out/src/helper.js | nexe --output $out
strip $out
upx $out
