import * as compareVersions from 'compare-versions';
import * as events from "events";
import { Socket } from 'net';
import * as readline from 'readline';
import * as ssh2 from 'ssh2';
import * as Observable from 'zen-observable';

const minBrickdVersion = '1.0.0';
const maxBrickdVersion = '2.0.0';

enum BrickdConnectionState {
    start,
    handshake,
    watchPower,
    ok,
    bad
}

/**
 * Connection to a brickd server.
 */
export class Brickd extends events.EventEmitter {
    public constructor(private channel: ssh2.ClientChannel) {
        super();
        const reader = readline.createInterface(channel);
        const observable = new Observable<string>(observer => {
            reader.on('line', line => {
                observer.next(line);
            }).on('close', () => {
                observer.complete();
            });
        });

        let state = BrickdConnectionState.start;
        observable.forEach(line => {
            const [m1, ...m2] = line.split(/ /);

            // emit messages
            if (m1 == "MSG") {
                this.emit('message', m2.join(' '));
                return;
            }

            // everything else is handled from state machine
            switch (state) {
            case BrickdConnectionState.start:
                if (m1 == "BRICKD") {
                    const version = m2[1];
                    if (compareVersions(version, minBrickdVersion) < 0) {
                        state = BrickdConnectionState.bad;
                        this.emit('error', new Error('Brickd version is too old.'));
                        break;
                    }
                    if (compareVersions(version, maxBrickdVersion) >= 0) {
                        state = BrickdConnectionState.bad;
                        this.emit('error', new Error('Brickd version is too new.'));
                        break;
                    }
                    state = BrickdConnectionState.handshake;
                    channel.write('YOU ARE A ROBOT\n');
                }
                else {
                    state = BrickdConnectionState.bad;
                    this.emit('error', new Error('Brickd server did not send expected welcome message.'));
                }
                break;
            case BrickdConnectionState.handshake:
                if (m1 == "OK") {
                    state = BrickdConnectionState.watchPower;
                    channel.write("WATCH POWER\n");
                }
                else if (m1 == "BAD") {
                    state = BrickdConnectionState.bad;
                    this.emit('error', new Error("Brickd handshake failed."));
                }
                break;
            case BrickdConnectionState.watchPower:
                if (m1 == "OK") {
                    state = BrickdConnectionState.ok;
                }
                else {
                    state = BrickdConnectionState.bad;
                    this.emit('error', new Error("Brickd failed to register for power events."));
                }
                break;
            }
        });
    }
}
