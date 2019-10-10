// This implements the interface from the 'bonjour' npm package using the
// avahi-browse command. Not all features are implemented.

import * as avahi from 'avahi-dbus';
import * as dbus from 'dbus-native';
import * as events from 'events';

import * as dnssd from '../dnssd';


let cachedDaemon: avahi.Daemon;

async function getDaemon(): Promise<avahi.Daemon> {
    if (cachedDaemon) {
        return Promise.resolve(cachedDaemon);
    }

    return new Promise((resolve, reject) => {
        const bus = dbus.systemBus();
        bus.connection.on('connect', () => {
            const daemon = new avahi.Daemon(bus);
            daemon.GetAPIVersion((err, _version) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(cachedDaemon = daemon);
                }
            });
        });
        bus.connection.on('error', err => {
            reject(err);
        });
    });
}

export async function getInstance(): Promise<dnssd.Client> {
    const daemon = await getDaemon();
    return new AvahiClient(daemon);
}

class AvahiClient implements dnssd.Client {
    private destroyOps = new Array<() => void>();

    constructor(readonly daemon: avahi.Daemon) {
    }

    public browse(options: dnssd.BrowseOptions): Promise<dnssd.Browser> {
        return new Promise((resolve, reject) => {
            const browser = new AvahiBrowser(this, options);
            browser.once('ready', () => {
                browser.removeAllListeners('error');
                resolve(browser);
            });
            browser.once('error', err => {
                browser.removeAllListeners('ready');
                reject(err);
            });
        });
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
    pushDestroyOp(op: () => void): () => void {
        this.destroyOps.push(op);
        return op;
    }

    /**
     * Removes an operation that was added with pushDestroyOp()
     * @param op the operation to remove
     */
    popDestroyOp(op: () => void): void {
        let i = this.destroyOps.findIndex(v => v === op);
        if (i >= 0) {
            this.destroyOps.splice(i, 1);
        }
    }
}

class AvahiBrowser extends events.EventEmitter implements dnssd.Browser {
    private browser: avahi.ServiceBrowser | undefined;
    private readonly services: AvahiService[] = new Array<AvahiService>();

    constructor(client: AvahiClient, private options: dnssd.BrowseOptions) {
        super();
        const proto = this.options.ipv === 'IPv6' ? avahi.PROTO_INET6 : avahi.PROTO_INET;
        const type = `_${this.options.service}._${this.options.transport || 'tcp'}`;
        client.daemon.ServiceBrowserNew(avahi.IF_UNSPEC, proto, type, '', 0, (err, browser) => {
            if (err) {
                this.emit('error', err);
                return;
            }
            this.browser = browser;
            browser.on('ItemNew', (iface, protocol, name, type, domain, flags) => {
                client.daemon.ResolveService(iface, protocol, name, type, domain, protocol, 0,
                    (err, iface, protocol, name, type, domain, host, aprotocol, addr, port, txt, flags) => {
                        if (err) {
                            // This was probably something in the cache that timed out
                            // because it is no longer connected.
                            return;
                        }
                        const service = new AvahiService(iface, protocol, name, type, domain, host, aprotocol, addr, port, txt, flags);
                        this.services.push(service);
                        this.emit('added', service);
                    });
            });
            browser.on('ItemRemove', (iface, protocol, name, type, domain, flags) => {
                const i = this.services.findIndex(s => s.match(iface, protocol, name, type, domain));
                if (i >= 0) {
                    const [service] = this.services.splice(i, 1);
                    this.emit('removed', service);
                }
            });
            browser.on('Failure', error => {
                this.emit('error', new Error(error));
            });
            this.emit('ready');
        });
    }

    destroy(): void {
        this.removeAllListeners();
        if (this.browser) {
            this.browser.Free(err => console.log(err));
            this.browser = undefined;
        }
    }

}

class AvahiService implements dnssd.Service {
    public readonly service: string;
    public readonly transport: 'tcp' | 'udp';
    public readonly ipv: 'IPv4' | 'IPv6';
    public readonly txt: dnssd.TxtRecords;

    constructor(
        public readonly iface: number,
        private readonly protocol: number,
        public readonly name: string,
        private readonly type: string,
        public readonly domain: string,
        public readonly host: string,
        aprotocol: number,
        public readonly address: string,
        public readonly port: number,
        txt: Uint8Array[],
        flags: number) {
        const [service, transport] = type.split('.');
        // remove leading '_'
        this.service = service.slice(1);
        this.transport = <'tcp' | 'udp'>transport.slice(1);
        this.ipv = protocol === avahi.PROTO_INET6 ? 'IPv6' : 'IPv4';
        this.txt = AvahiService.parseText(txt);
    }

    match(iface: number, protocol: number, name: string, type: string, domain: string): boolean {
        return this.iface === iface && this.protocol === protocol &&
            this.name === name && this.type === type && this.domain === domain;
    }

    private static parseText(txt?: Uint8Array[]): dnssd.TxtRecords {
        const result = <dnssd.TxtRecords>new Object();
        if (txt) {
            txt.forEach(v => {
                const [key, value] = v.toString().split(/=/);
                result[key] = value;
            });
        }
        return result;
    }
}
