// This file is compiled to a stand-alone executable using nexe (see build-native.{sh,bat}).
// We do this so users don't have to install node on their system in order to
// use this extension. Since nexe creates a rather large executable for a simple
// program, we combine all of our helper programs into one executable.

import { run as runShell } from './shell';

const command = process.argv[1];

switch(command) {
case 'shell':
    const port = parseInt(process.argv[2]);
    runShell(port);
    break;
default:
    console.error(`unknown command '${command}'`);
    process.exit(1);
    break;
}
