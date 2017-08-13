// This is a simple client that pipes a TTY to extension.ts so that we can
// use the shell() function of the 'ssh2' module in an VS Code terminal.
//
// Basic flow is like this:
// - When extension.ts connects to a device, it starts a dnode server
// - When extension.ts executes the ev3devBrowser.openSshTerminal command, it
//   runs shell.ts (passing the port as an argument)
// - shell.ts connects to the server
// - when the connection is complete, the 'remote' event call the remote
//   shell() method.
// - This starts a new shell via the 'ssh2' module.
// - stdin, stdout and stderr from the remote shell() are connected to the same
//   in the shell.ts node process.

'use strict'

import * as dnode from 'dnode';

const port = parseInt(process.argv[2]);

const d = dnode({}, { weak: false }).connect(port);
d.on('remote', remote => {
    remote.shell({
        // ttyOptions
        rows: process.stdout.rows,
        cols: process.stdout.columns,
        term: process.env['TERM']
    }, dataOut => {
        // dataOut callback
        process.stdout.write(new Buffer(dataOut, 'base64'));
    }, dataErr => {
        // dataErr callback
        process.stderr.write(new Buffer(dataErr, 'base64'));
    }, (resize, dataIn) => {
        // ready callback
        process.stdout.on('resize', () => {
            resize(process.stdout.rows, process.stdout.columns);
        });
        // terminal selection with mouse and scrolling don't work unless we
        // call resize() here for some reason.
        resize(process.stdout.rows, process.stdout.columns);
        process.stdin.setRawMode(true);
        process.stdin.on('data', data => {
            dataIn(data.toString('base64'));
        });
    }, () => {
        // exit callback
        d.end();
        process.stdin.setRawMode(false);
        process.exit();
    });
});
