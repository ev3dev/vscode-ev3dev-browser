#!/bin/bash

# deps:
# npm install -g browserify
# npm install -g nexe@beta
#
# apt install upx-ucl
# -or-
# brew install upx

set -e

platform=$(node -e 'console.log(process.platform)')
out=native/$platform/helper

mkdir -p $(dirname $out)
browserify --node --exclude weak out/src/native-helper/helper.js | nexe --output $out
strip $out
upx $out
