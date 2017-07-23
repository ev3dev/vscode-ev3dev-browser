// This implements the interface from the 'bonjour' npm package using the
// avahi-browse command. Not all features are implemented.

import * as avahi from 'avahi-dbus';
import * as bonjour from 'bonjour';
import * as bonjour2 from '../bonjour';
import * as dbus from 'dbus-native';
import * as events from 'events';
import * as vscode from 'vscode';

let connected = false;

const bus = dbus.systemBus();
bus.connection.on('connect', () => connected = true);
bus.connection.on('error', err => connected = false);
bus.connection.on('end', () => connected = false);
const avahiDaemon = new avahi.Daemon(bus);

export function isPresent(): boolean {
    return connected;
}

export function getInstance(): bonjour2.Bonjour {
    if (!isPresent()) {
        throw 'Not present';
    }
    return new Avahi();
}

class Avahi implements bonjour2.Bonjour {
    private destroyOps = new Array<()=>void>();

    // interface method implementation
    public find(options: bonjour.BrowserOptions, onUp?: (service: bonjour.Service) => void): bonjour.Browser {
        const browser = new AvahiBrowser(this, options);
        if (onUp) {
            browser.on('up', onUp);
        }
        return browser;
    }

    // interface method implementation
    public destroy(): void {
        this.destroyOps.forEach(op => op());
        this.destroyOps.length = 0;
    }

    /**
     * Adds an operation to be performed when destroy() is called.
     * @param op operation to add
     * @return the op argument
     */
    pushDestroyOp(op: ()=>void): ()=>void {
        this.destroyOps.push(op);
        return op;
    }

    /**
     * Removes an operation that was added with pushDestroyOp()
     * @param op the operation to remove
     */
    popDestroyOp(op: ()=>void): void {
        let i = this.destroyOps.findIndex(v => v == op);
        if (i >= 0) {
            this.destroyOps.splice(i, 1);
        }
    }
}

class AvahiBrowser extends events.EventEmitter implements bonjour.Browser {
    private browser: any;
    private destroyOp: ()=>void;
    readonly services: bonjour.Service[] = new Array<bonjour.Service>();

    constructor(private avahi: Avahi, private options: bonjour.BrowserOptions) {
        super();
    }

    start(): void {
        if (this.destroyOp) {
            throw 'Already started';
        }
        this.destroyOp = this.avahi.pushDestroyOp(() => this.stop());
        const type = `_${this.options.type}._${this.options.protocol || 'tcp'}`;
        avahiDaemon.ServiceBrowserNew(avahi.IF_UNSPEC, avahi.PROTO_UNSPEC, type, '', 0,
            (err, browser) => {
                if (!this.destroyOp) {
                    // service was stopped before callback
                    return;
                }
                if (err) {
                    vscode.window.showErrorMessage(`Error while starting avahi browser: ${err.message}`);
                    return;
                }
                this.browser = browser;
                browser.on('ItemNew', (iface, protocol, name, type, domain, flags) => {
                    const service = this.getOrCreateService(name, type, domain);
                    // the native js bonjour does not consider iface and protocol variations as separate
                    // services, so we have to do some funny things to get them grouped together
                    service.pushPending(`${iface}.${protocol}`);
                    avahiDaemon.ResolveService(iface, protocol, name, type, domain, avahi.PROTO_UNSPEC, 0,
                        (err, iface, protocol, name, type, domain, host, aprotocol, addr, port, txt, flags) => {
                            if (err) {
                                vscode.window.showErrorMessage(`Error resolving avahi service: ${err.message}`);
                                return;
                            }
                            service.host = host;
                            service.addresses.push(addr);
                            service.port = Number(port);
                            service.txt = AvahiBrowser.parseText(txt);
                            if (service.popPending(`${iface}.${protocol}`)) {
                                // don't emit the 'up' event until we are sure we are completely resolved
                                this.emit('up', service);
                            }
                        });
                });
                browser.on('ItemRemove', (iface, protocol, name, type, domain, flags) => {
                    const i = this.services.findIndex(s => s.fqdn == `${name}.${type}.${domain}`);
                    if (i >= 0) {
                        const [service] = this.services.splice(i, 1);
                        this.emit('down', service);
                    }
                });
            });
    }

    update(): void {
        throw 'Not implemented';
    }

    stop(): void {
        if (!this.destroyOp) {
            throw 'Not started';
        }
        if (this.browser) {
            this.browser.Free();
            this.browser = undefined;
        }
    }

    private getOrCreateService(name: string, type: string, domain: string): AvahiService {
        let service = <AvahiService> this.services.find(s => s.fqdn == `${name}.${type}.${domain}`);
        if (service) {
            return service;
        }

        service = new AvahiService(name, type, domain);
        this.services.push(service);
        return service;
    }

    private static parseText(txt?: Uint8Array[]): Object {
        const result = new Object();
        if (!txt) {
            return result;
        }
        txt.forEach(v => {
            const [key, value] = v.toString().split(/=/);
            result[key] = value;
        });
        return result;
    }
}

class AvahiService extends events.EventEmitter implements bonjour.Service {
    private pending: string[] = new Array<string>();
    public addresses: string[] = new Array<string>();
    public subtypes: string[];
    public protocol: string;
    public host: string;
    public port: number;
    public fqdn: string;
    public txt: Object;
    public published: boolean;

    constructor(
        public name: string,
        public type: string,
        public domain: string) {
            super();
            this.fqdn = `${name}.${type}.${domain}`;
            [this.type, this.protocol] = type.split('.');
            // remove leading '_'
            this.type = this.type.slice(1);
            this.protocol = this.protocol.slice(1);
        }

    stop(cb: () => any): void {
        throw 'Not implemented';
    }

    start(): void {
        throw 'Not implemented';
    }

    pushPending(id: string): void {
        this.pending.push(id);
    }

    // returns true if no more pending
    popPending(id: string): boolean {
        const i = this.pending.findIndex(v => v == id);
        if (i < 0) {
            throw 'id not found';
        }
        this.pending.splice(i, 1);

        return this.pending.length == 0;
    }
}
