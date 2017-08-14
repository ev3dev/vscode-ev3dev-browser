#!/bin/bash

# deps:
# npm install -g browserify
# npm install -g nexe@beta
# apt install upx-ucl

out=native/linux/shell

browserify --node --exclude weak out/src/shell.js | nexe --output $out
strip $out
upx $out
