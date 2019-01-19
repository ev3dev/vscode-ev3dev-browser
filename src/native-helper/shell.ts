// This is a simple client that pipes a TTY to extension.ts so that we can
// use the shell() function of the 'ssh2' module in an VS Code terminal.
//
// Basic flow is like this:
// - When extension.ts connects to a device, it starts a dnode server
// - When extension.ts executes the ev3devBrowser.deviceTreeItem.openSshTerminal
//   command, it runs shell.ts (passing the port as an argument)
// - shell.ts connects to the server
// - when the connection is complete, the 'remote' event call the remote
//   shell() method.
// - This starts a new shell via the 'ssh2' module.
// - stdin, stdout and stderr from the remote shell() are connected to the same
//   in the shell.ts node process.

import { dnode } from 'dnode';
import * as ssh2 from 'ssh2';

export interface Shell {
    shell(
        ttyOptions: ssh2.PseudoTtyOptions,
        dataOut: (data: string) => void,
        dataErr: (data: string) => void,
        ready: (resize: (rows: number, cols: number) => void, dataIn: (data: string) => void) => void,
        exit: () => void
    ): void;
}

/**
 * Run the shell helper.
 * @param port The TCP port to connect to.
 */
export function run(port: number): void {

    const d = dnode({}, { weak: false }).connect(port);
    d.on<Shell>('remote', remote => {
        remote.shell({
            // ttyOptions
            rows: process.stdout.rows,
            cols: process.stdout.columns,
            term: process.env['TERM'] || 'xterm-256color'
        }, dataOut => {
            // dataOut callback
            process.stdout.write(new Buffer(dataOut, 'base64'));
        }, dataErr => {
            // dataErr callback
            process.stderr.write(new Buffer(dataErr, 'base64'));
        }, (resize, dataIn) => {
            // ready callback
            process.stdout.on('resize', () => {
                resize(process.stdout.rows || 0, process.stdout.columns || 0);
            });
            // terminal selection with mouse and scrolling don't work unless we
            // call resize() here for some reason.
            resize(process.stdout.rows || 0, process.stdout.columns || 0);
            if (process.stdin.setRawMode) {
                process.stdin.setRawMode(true);
            }
            process.stdin.on('data', data => {
                dataIn(data.toString('base64'));
            });
        }, () => {
            // exit callback
            d.end();
            if (process.stdin.setRawMode) {
                process.stdin.setRawMode(false);
            }
            process.exit();
        });
    });
}

if (require.main === module) {
    const port = parseInt(process.argv[process.argv.length - 1]);
    run(port);
}
